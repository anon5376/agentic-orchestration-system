import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_HARNESS_PROTOCOL,
  EXTERNAL_HARNESS_SANDBOX,
  ExternalHarnessConfigError,
  ExternalHarnessPreflightError,
  ExternalHarnessWorker,
  preflightExternalHarness,
  resolveExternalHarnessConfig,
  sanitizedExternalHarnessEnv,
} from '../engine/external-harness.js';

const FIXTURE = resolve('tests/fixtures/external-harness-fixture.mjs');
const FAKE_TOKEN = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';

function config(overrides = {}) {
  const { fixtureMode = 'success', argv: overrideArgv, ...rest } = overrides;
  return {
    enabled: true,
    bin: process.execPath,
    argv: overrideArgv || [FIXTURE, `--fixture-mode=${fixtureMode}`],
    provider: 'opencode',
    model: 'fixture-model',
    authType: 'external_cli_session',
    sessionMode: 'ephemeral',
    maxConcurrency: 1,
    // Node's test runner executes files concurrently; ordinary protocol tests
    // must not treat scheduler contention as a wrapper timeout. Timeout cases
    // below set their own 1-second bound.
    timeoutMs: 5_000,
    killGraceMs: 50,
    maxOutputBytes: 128 * 1024,
    ...rest,
  };
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    key: 'FIXTURE',
    title: 'Bounded fixture task',
    kind: 'research',
    attempts: 1,
    nonce: 'task-nonce-1',
    brief: 'Return one bounded result from the fixture harness.',
    ...overrides,
  };
}

function context(signal = null) {
  const writes = new Map();
  const workspace = mkdtempSync(join(tmpdir(), 'aos-external-harness-workspace-'));
  return {
    run: { id: 'run-1' },
    goal: { prompt: 'Exercise the external harness boundary without external actions.' },
    dependencies: [],
    signal,
    workspace: {
      dir: workspace,
      write(path, value) {
        writes.set(path, value);
        return path;
      },
    },
    writes,
  };
}

function errorWithoutSecret(secret) {
  return (error) => {
    assert.ok(error instanceof ExternalHarnessConfigError);
    assert.equal(String(error.message).includes(secret), false);
    return true;
  };
}

test('external harness config is explicit and rejects secret-like fields and argv', () => {
  assert.throws(() => resolveExternalHarnessConfig(), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig({}), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig(config({ bin: null })), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig(config({ provider: '' })), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig(config({ argv: '--not-an-array' })), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig(config({ maxConcurrency: 17 })), ExternalHarnessConfigError);
  assert.throws(() => resolveExternalHarnessConfig(config({ apiKey: FAKE_TOKEN })), errorWithoutSecret(FAKE_TOKEN));
  assert.throws(() => resolveExternalHarnessConfig(config({ oauthToken: FAKE_TOKEN })), errorWithoutSecret(FAKE_TOKEN));
  assert.throws(() => resolveExternalHarnessConfig(config({ argv: ['--api-key', FAKE_TOKEN] })), errorWithoutSecret(FAKE_TOKEN));
  assert.throws(() => resolveExternalHarnessConfig(config({ argv: ['--token', 'fixture-token-value'] })), /argv|token|secret/i);

  const normalized = resolveExternalHarnessConfig(config());
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.bin, process.execPath);
  assert.deepEqual(normalized.argv, [FIXTURE, '--fixture-mode=success']);
  assert.equal(normalized.provider, 'opencode');
  assert.equal(normalized.sandbox, EXTERNAL_HARNESS_SANDBOX);
});

test('sanitized external environment drops API and operator credentials', () => {
  const safe = sanitizedExternalHarnessEnv({
    PATH: '/bin',
    HOME: '/tmp/home',
    OPENAI_API_KEY: FAKE_TOKEN,
    ANTHROPIC_API_KEY: FAKE_TOKEN,
    AOS_OPERATOR_TOKEN: FAKE_TOKEN,
    EXTERNAL_HARNESS_FIXTURE_MODE: 'success',
  });
  assert.equal(safe.env.PATH, '/bin');
  assert.equal(safe.env.HOME, '/tmp/home');
  assert.equal(safe.env.OPENAI_API_KEY, undefined);
  assert.equal(safe.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(safe.env.AOS_OPERATOR_TOKEN, undefined);
  assert.ok(safe.stripped.includes('OPENAI_API_KEY'));
  assert.ok(safe.stripped.includes('AOS_OPERATOR_TOKEN'));
});

test('fixed argv is passed directly and shell syntax is not executed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aos-external-harness-argv-'));
  const marker = join(dir, 'shell-was-executed');
  const payload = `$(touch ${marker})`;
  await preflightExternalHarness(config({ argv: [FIXTURE, '--fixture-mode=success', payload] }));
  assert.equal(existsSync(marker), false);
});

test('preflight requires an exact protocol and fixed runtime policy', async () => {
  const expected = config();
  const receipt = await preflightExternalHarness(expected);
  assert.equal(receipt.protocol, EXTERNAL_HARNESS_PROTOCOL);
  assert.equal(receipt.ready, true);
  assert.equal(receipt.provider, expected.provider);
  assert.equal(receipt.model, expected.model);
  assert.equal(receipt.sandbox, EXTERNAL_HARNESS_SANDBOX);
  assert.equal(receipt.authType, expected.authType);
  assert.equal(receipt.sessionMode, expected.sessionMode);
  assert.equal(receipt.attestation, 'external_harness_protocol');
  assert.equal(receipt.verified, false);

  for (const mode of ['preflight-bad-protocol', 'preflight-bad-nonce', 'preflight-bad-model']) {
    await assert.rejects(preflightExternalHarness(config({ fixtureMode: mode })), (error) => error instanceof ExternalHarnessPreflightError);
  }

  await assert.rejects(
    preflightExternalHarness(config({ fixtureMode: 'preflight-bad-auth', authType: 'none', sessionMode: 'none' })),
    (error) => error instanceof ExternalHarnessPreflightError,
  );
});

test('preflight fails closed for a missing executable, capped output, malformed JSON, and provider rejection', async () => {
  await assert.rejects(
    preflightExternalHarness(config({ bin: 'aos-fixture-does-not-exist' })),
    (error) => error instanceof ExternalHarnessPreflightError && error.code === 'adapter_unavailable',
  );
  await assert.rejects(
    preflightExternalHarness(config({ fixtureMode: 'oversize', maxOutputBytes: 1_024 })),
    (error) => error instanceof ExternalHarnessPreflightError && error.code === 'adapter_output_oversize',
  );
  await assert.rejects(
    preflightExternalHarness(config({ fixtureMode: 'invalid-json' })),
    (error) => error instanceof ExternalHarnessPreflightError && error.code === 'adapter_result_invalid',
  );
  await assert.rejects(
    preflightExternalHarness(config({ fixtureMode: 'nonzero' })),
    (error) => error instanceof ExternalHarnessPreflightError && error.code === 'adapter_provider_rejected',
  );
});

test('execute returns a self-reported receipt and keeps the provider session reference in runtime.threadId only', async () => {
  const ctx = context();
  const worker = new ExternalHarnessWorker(config());
  const result = await worker.execute(task(), ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.runtime.attestation, 'external_harness_protocol');
  assert.equal(result.runtime.verified, false);
  assert.equal(result.runtime.threadId, 'fixture-session-opaque-001');
  assert.equal(result.runtime.requested.model, 'fixture-model');
  assert.equal(result.runtime.effective.model, 'fixture-model');
  assert.equal(result.result.status, 'succeeded');
  assert.equal(JSON.stringify(result.result).includes('fixture-session-opaque-001'), false);
  assert.equal(JSON.stringify(ctx.writes.get('artifact.json')).includes('fixture-session-opaque-001'), false);
  assert.ok(ctx.writes.has('attempt-1/runtime.json'));
});

test('execute refuses substitution, nonce mismatch, and unexpected delegation', async (t) => {
  await t.test('model substitution', async () => {
    const ctx = context();
    const result = await new ExternalHarnessWorker(config({ fixtureMode: 'bad-model' })).execute(task(), ctx);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_substitution_detected');
    assert.equal(result.runtime.threadId, null);
  });

  await t.test('nonce mismatch', async () => {
    const ctx = context();
    const result = await new ExternalHarnessWorker(config({ fixtureMode: 'bad-nonce' })).execute(task(), ctx);
    assert.equal(result.status, 'failed');
    assert.ok(['adapter_substitution_detected', 'adapter_result_invalid'].includes(result.code));
    assert.equal(result.runtime.threadId, null);
  });

  await t.test('delegation is not part of this adapter protocol', async () => {
    const ctx = context();
    const result = await new ExternalHarnessWorker(config({ fixtureMode: 'delegation' })).execute(task(), ctx);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_result_invalid');
    assert.equal(result.runtime.threadId, null);
  });

  await t.test('session mode none rejects a supplied provider session id', async () => {
    const ctx = context();
    const result = await new ExternalHarnessWorker(config({ fixtureMode: 'none-session', authType: 'none', sessionMode: 'none' })).execute(task(), ctx);
    assert.equal(result.status, 'failed');
    assert.ok(['adapter_substitution_detected', 'adapter_result_invalid'].includes(result.code));
    assert.equal(result.runtime.threadId, null);
  });
});

test('execute redacts provider output before returning or persisting it', async () => {
  const ctx = context();
  const result = await new ExternalHarnessWorker(config({ fixtureMode: 'token' })).execute(task(), ctx);
  assert.ok(['succeeded', 'failed'].includes(result.status));
  if (result.status === 'failed') assert.equal(result.code, 'adapter_secret_content');
  assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  assert.equal(JSON.stringify([...ctx.writes.values()]).includes(FAKE_TOKEN), false);
});

test('execute does not report success or artifact names when durable result writes fail', async () => {
  const ctx = context();
  const write = ctx.workspace.write;
  ctx.workspace.write = (path, value) => {
    if (path === 'artifact.json' || path.endsWith('/runtime.json')) throw new Error('fixture persistence fault');
    return write(path, value);
  };
  const result = await new ExternalHarnessWorker(config()).execute(task(), ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'adapter_artifact_write_failed');
  assert.equal(result.runtime.artifact, null);
  assert.equal(result.artifacts.includes('artifact.json'), false);
  assert.equal(result.artifacts.some((path) => path.endsWith('/runtime.json')), false);
});

test('timeout and AbortSignal are surfaced as typed adapter outcomes', async (t) => {
  await t.test('timeout', async () => {
    const ctx = context();
    const result = await new ExternalHarnessWorker(config({ fixtureMode: 'sleep', timeoutMs: 1_000 })).execute(task(), ctx);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_timeout');
    assert.equal(result.runtime.timedOut, true);
  });

  await t.test('abort', async () => {
    const controller = new AbortController();
    const ctx = context(controller.signal);
    const pending = new ExternalHarnessWorker(config({ fixtureMode: 'sleep', timeoutMs: 1_000 })).execute(task(), ctx);
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.ok(['cancelled', 'adapter_aborted'].includes(result.code));
    assert.equal(result.runtime.cancelled, true);
  });
});
