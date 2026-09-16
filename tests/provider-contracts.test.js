import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { assertProviderDispatchable } from '../engine/provider-contracts.js';

function localEngine() {
  const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-provider-contract-')) });
  engine.load();
  return engine;
}

test('provider contracts expose bounded adapter truth and gate dispatch centrally', () => {
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'provider-contract-secret-value';
  const engine = localEngine();
  const providers = engine.listProviders();
  const local = providers.find((item) => item.id === 'local');
  const claude = providers.find((item) => item.id === 'claude');

  assert.equal(local.contract.schemaVersion, 1);
  assert.equal(local.contract.adapter.implementation.mounted, true);
  assert.equal(local.contract.dispatch.runnable, true);
  assert.equal(local.contract.quota.signal, 'unknown');
  assert.equal(local.contract.sandbox.enforcedBy, 'aos_path_boundary');
  assert.doesNotThrow(() => assertProviderDispatchable(local));

  assert.equal(claude.contract.adapter.implementation.mounted, true);
  assert.equal(claude.contract.dispatch.runnable, false);
  assert.throws(
    () => assertProviderDispatchable(claude),
    (error) => error.code === 'adapter_auth_unavailable' && error.statusCode === 409,
  );
  assert.equal(JSON.stringify(providers).includes('provider-contract-secret-value'), false);
  if (originalKey === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = originalKey;
});

test('provider contracts reject contradictory auth and do not project stored session or note data', () => {
  const engine = localEngine();
  const local = engine.state.providers.find((item) => item.id === 'local');
  local.auth = { type: 'api_key', session: 'session-secret-value', secretEnv: 'LOCAL_SECRET' };
  local.note = 'note-secret-value';
  local.configured = true;
  local.liveExecutionEnabled = true;

  const view = engine.listProviders().find((item) => item.id === 'local');
  const json = JSON.stringify(view);
  assert.equal(view.contract.auth.consistent, false);
  assert.equal(view.contract.auth.verified, false);
  assert.equal(json.includes('session-secret-value'), false);
  assert.equal(json.includes('note-secret-value'), false);
  assert.throws(
    () => assertProviderDispatchable(view),
    (error) => error.code === 'adapter_auth_unavailable' && error.statusCode === 409,
  );
  const modelView = engine.modelControl.snapshot().providers.find((item) => item.id === 'local');
  assert.equal(modelView.runnable, false);
  assert.equal(modelView.status, 'auth_unverified');
});

test('live Codex contract binds the verified runtime and configured quota', async () => {
  const execution = {
    mode: 'codex',
    codex: {
      bin: 'codex',
      repoRoot: process.cwd(),
      model: 'gpt-5.6-luna',
      effort: 'max',
      maxConcurrency: 4,
      timeoutMs: 30_000,
      run: async () => ({ status: 'failed' }),
    },
  };
  const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-provider-contract-live-')), execution });
  engine.load();
  engine.providerReadiness.codex = {
    status: 'available',
    checkedAt: '2026-09-16T00:00:00.000Z',
    model: 'gpt-5.6-luna',
    effort: 'max',
  };

  const codex = engine.listProviders().find((item) => item.id === 'codex');
  assert.deepEqual(codex.contract.runtime.requested, {
    model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only',
  });
  assert.deepEqual(codex.contract.runtime.effective, codex.contract.runtime.requested);
  assert.equal(codex.contract.auth.boundary, 'external_cli_session');
  assert.equal(codex.contract.attestation.strength, 'verified_runtime_receipt');
  assert.equal(codex.contract.cancellation.confirmation, 'process_exit');
  assert.equal(codex.contract.quota.maxConcurrency, 4);
  assert.doesNotThrow(() => assertProviderDispatchable(codex));
});

test('unready mounted adapters fail before a task workspace is claimed', async () => {
  const engine = localEngine();
  const goal = engine.createGoal({
    prompt: 'Inspect one bounded mechanism. Success is a concise result. Scope excludes external actions.',
    plan: {
      title: 'Pending adapter refusal',
      tasks: [{ id: 'claude-only', title: 'Unavailable Claude task', kind: 'research', worker: 'claude' }],
      dependencies: [],
    },
  });
  const run = engine.startRun({ goalId: goal.id });
  await engine.advanceRun(run.id, { untilIdle: true });
  const task = engine.getRunTree(run.id).tasks[0];

  assert.equal(task.status, 'failed');
  assert.equal(task.errorCode, 'adapter_auth_unavailable');
  assert.equal(task.workspace, null);
  assert.ok(engine.store.readEventLog().some((event) => event.type === 'worker.refused' && event.payload.code === 'adapter_auth_unavailable'));
});
