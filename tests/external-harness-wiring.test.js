import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AosEngine } from '../engine/engine.js';
import { dispatch } from '../engine/cli.js';
import { assertExternalHarnessTaskAdmission, assertProviderDispatchable } from '../engine/provider-contracts.js';

const FIXTURE = resolve('tests/fixtures/external-harness-fixture.mjs');
const MODEL = 'fixture-model';
const PROMPT = 'Exercise one bounded external harness task. Success is a stored result. Scope excludes external actions.';

function externalConfig(mode = 'success') {
  return {
    enabled: true,
    bin: process.execPath,
    argv: [FIXTURE, `--fixture-mode=${mode}`],
    provider: 'opencode',
    model: MODEL,
    authType: 'external_cli_session',
    sessionMode: 'ephemeral',
    maxConcurrency: 1,
    timeoutMs: 10_000,
    killGraceMs: 50,
    maxOutputBytes: 128 * 1024,
  };
}

function makeEngine({ mode = 'success' } = {}) {
  const engine = new AosEngine({
    dataDir: mkdtempSync(join(tmpdir(), 'aos-external-harness-wiring-')),
    execution: {
      mode: 'mixed',
      adapters: {
        local: { enabled: true },
        command: externalConfig(mode),
      },
    },
  });
  engine.load();
  return engine;
}

function task(overrides = {}) {
  return {
    id: 'external-task',
    key: 'EXTERNAL',
    title: 'Bounded external harness task',
    kind: 'research',
    worker: 'command',
    model: MODEL,
    sandbox: 'host_process',
    mayDelegate: false,
    delegation: { maxChildren: 0, maxDepth: 0 },
    budget: { tokens: 10, timeMs: 1_000 },
    ...overrides,
  };
}

function goal(engine, planned = task()) {
  return engine.createGoal({
    projectId: engine.defaultProject().id,
    prompt: PROMPT,
    plan: { title: 'External harness wiring', tasks: [planned], dependencies: [] },
  });
}

test('command compatibility id is disabled in local mode and cannot claim a workspace', async () => {
  const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-external-harness-local-')) });
  engine.load();
  const provider = engine.listProviders().find((item) => item.id === 'command');
  assert.equal(provider.configured, false);
  assert.equal(provider.liveExecutionEnabled, false);
  assert.equal(provider.contract.dispatch.runnable, false);

  const planned = engine.createGoal({
    prompt: PROMPT,
    plan: { title: 'Disabled command', tasks: [{ id: 'disabled', title: 'Disabled command', kind: 'research', worker: 'command' }], dependencies: [] },
  });
  const run = engine.startRun({ goalId: planned.id });
  await engine.advanceRun(run.id, { untilIdle: true });
  const result = engine.getRunTree(run.id).tasks[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'adapter_auth_unavailable');
  assert.equal(result.workspace, null);
});

test('command adapter envelope refuses a second config source or credential-like field', () => {
  const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';
  assert.throws(
    () => new AosEngine({
      dataDir: mkdtempSync(join(tmpdir(), 'aos-external-harness-envelope-')),
      execution: {
        mode: 'mixed',
        adapters: {
          command: { enabled: true, config: externalConfig(), apiKey: secret },
        },
      },
    }),
    (error) => error.code === 'adapter_config_invalid' && !String(error.message).includes(secret),
  );
});

test('configured external harness becomes runnable only after exact preflight and preserves an AOS-owned session mapping', async () => {
  const engine = makeEngine();
  let provider = engine.listProviders().find((item) => item.id === 'command');
  assert.equal(provider.configured, true);
  assert.equal(provider.liveExecutionEnabled, false);
  assert.equal(provider.contract.dispatch.runnable, false);
  assert.equal(provider.contract.transport.shell, false);
  assert.equal(provider.contract.sandbox.isolation, false);
  assert.ok(provider.contract.limitations.some((item) => /not a native provider integration/.test(item)));
  assert.throws(() => assertProviderDispatchable(provider), (error) => error.code === 'adapter_auth_unavailable');

  await engine.preflightCommand();
  provider = engine.listProviders().find((item) => item.id === 'command');
  assert.equal(provider.readiness.status, 'available');
  assert.equal(provider.liveExecutionEnabled, true);
  assert.equal(provider.contract.runtime.requested.model, MODEL);
  assert.equal(provider.contract.runtime.requested.sandbox, 'host_process');
  assert.equal(provider.contract.attestation.strength, 'self_reported_protocol');
  assert.equal(provider.contract.attestation.externalIdentity, false);
  assert.doesNotThrow(() => assertProviderDispatchable(provider));

  const lines = await dispatch(engine, ['live', 'preflight', 'command']);
  assert.ok(lines.some((line) => line.includes('shell=false')));
  assert.ok(lines.some((line) => line.includes('identity=not-verified')));

  const run = engine.startRun({ goalId: goal(engine).id });
  await engine.advanceRun(run.id, { untilIdle: true });
  const result = engine.getRunTree(run.id).tasks[0];
  assert.equal(result.status, 'succeeded');
  assert.ok(result.workspace && existsSync(result.workspace));
  assert.match(result.sessionId, /^hss_/);
  assert.equal(JSON.stringify(result).includes('fixture-session-opaque-001'), false);
  assert.equal(result.runtime.at(-1).verified, false);
  assert.equal(result.runtime.at(-1).requested.authType, 'external_cli_session');
});

test('external harness preflight failure and task admission fail closed before workspace claim', async (t) => {
  await t.test('preflight mismatch', async () => {
    const engine = makeEngine({ mode: 'preflight-bad-model' });
    const run = engine.startRun({ goalId: goal(engine).id });
    await engine.advanceRun(run.id, { untilIdle: true });
    const result = engine.getRunTree(run.id).tasks[0];
    assert.equal(result.status, 'failed');
    assert.equal(result.workspace, null);
    assert.equal(engine.getRun(run.id).preflight.providers.command.status, 'unavailable');
  });

  const cases = [
    [task({ model: 'other-model' }), /must use configured command runtime/],
    [task({ sandbox: 'read_only' }), (error) => error.code === 'plan_external_harness_sandbox_invalid'],
    [task({ mayDelegate: true, delegation: { maxChildren: 1, maxDepth: 1 } }), (error) => error.code === 'plan_external_harness_delegation_invalid'],
    [task({ capabilities: { skills: ['unmounted-skill'] } }), (error) => error.code === 'plan_external_harness_capability_invalid'],
  ];
  for (const [planned, expected] of cases) {
    const engine = makeEngine();
    const item = goal(engine, planned);
    assert.throws(() => engine.startRun({ goalId: item.id }), expected);
    assert.equal(engine.state.runs.length, 0);
    assert.equal(engine.state.tasks.length, 0);
  }
});

test('external-harness admission rejects legacy commands, supplied sessions, fallbacks, and capability execution directly', () => {
  const base = task();
  for (const [patch, code] of [
    [{ command: 'echo unsafe' }, 'plan_external_harness_legacy_command'],
    [{ sessionId: 'resume-me' }, 'plan_external_harness_session_unsupported'],
    [{ config: { effective: { harness: { fallback: [{ id: 'local' }] } } }, fallback: undefined }, 'plan_external_harness_fallback_invalid'],
    [{ capabilityExecution: true }, 'plan_external_harness_capability_invalid'],
  ]) {
    assert.throws(
      () => assertExternalHarnessTaskAdmission({ ...base, ...patch }, { ...base, ...patch }),
      (error) => error.code === code,
    );
  }
});
