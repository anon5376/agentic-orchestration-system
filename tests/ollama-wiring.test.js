import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AosEngine, resolveExecution } from '../engine/engine.js';
import { dispatch, executionFromEnv } from '../engine/cli.js';
import { DisabledLiveWorker, createWorkerRegistry } from '../engine/workers.js';
import { assertProviderDispatchable } from '../engine/provider-contracts.js';

const MODEL = 'llama3.2';
const BASE_URL = 'http://127.0.0.1:11434';
const PROMPT = 'Evaluate this bounded local model assignment. Success is a recorded result. Scope excludes external actions.';

function preflightResult(model = MODEL, baseUrl = BASE_URL) {
  return {
    provider: 'ollama',
    checkedAt: '2026-09-16T00:00:00.000Z',
    baseUrl,
    requested: { model },
    model,
    modelListed: true,
    verified: false,
    attestation: 'local_response',
  };
}

function bulkTask(overrides = {}) {
  return {
    id: 'ollama-bulk',
    key: 'OLLAMA-BULK',
    title: 'Bounded Ollama bulk task',
    kind: 'bulk',
    worker: 'ollama',
    model: MODEL,
    sandbox: 'read_only',
    mayDelegate: false,
    budget: { tokens: 100, timeMs: 1_000 },
    ...overrides,
  };
}

function makeEngine({ preflight = preflightResult(), usage = { input_tokens: 12, output_tokens: 7 }, execute = null } = {}) {
  const engine = new AosEngine({
    dataDir: mkdtempSync(join(tmpdir(), 'aos-ollama-wiring-')),
    execution: {
      mode: 'mixed',
      adapters: {
        local: { enabled: true },
        ollama: { enabled: true, model: MODEL, baseUrl: BASE_URL, maxConcurrency: 2, timeoutMs: 10_000 },
      },
    },
  });
  engine.load();
  const calls = { preflight: 0, execute: 0 };
  engine.workers.set('ollama', {
    id: 'ollama',
    label: 'Fake Ollama',
    async preflight() {
      calls.preflight += 1;
      if (typeof preflight === 'function') return preflight();
      return preflight;
    },
    async execute(task, context) {
      calls.execute += 1;
      if (execute) return execute(task, context);
      return {
        status: 'succeeded',
        summary: 'fake Ollama result',
        runtime: {
          provider: 'ollama',
          verified: false,
          attestation: 'local_response',
          requested: { model: MODEL },
          effective: { model: MODEL, source: 'ollama_response_model', attestation: 'local_response' },
          usage,
          durationMs: 7,
        },
      };
    },
  });
  return { engine, calls };
}

function createGoal(engine, task = bulkTask()) {
  return engine.createGoal({
    projectId: engine.defaultProject().id,
    prompt: PROMPT,
    plan: { title: 'Ollama wiring', tasks: [task], dependencies: [] },
  });
}

test('Ollama env activation is explicit, bounded, and inert while disabled', () => {
  const disabled = executionFromEnv({
    AOS_EXECUTION: 'mixed',
    AOS_OLLAMA_ENABLED: '0',
    AOS_OLLAMA_MODEL: '\\u0000invalid-while-disabled',
    AOS_OLLAMA_TOKEN: 'must-not-be-read',
  });
  assert.equal(disabled.mode, 'mixed');
  assert.equal(disabled.adapters.ollama.enabled, false);
  assert.equal(JSON.stringify(disabled).includes('must-not-be-read'), false);

  const local = executionFromEnv({
    AOS_EXECUTION: 'local',
    AOS_OLLAMA_ENABLED: '1',
    AOS_OLLAMA_MODEL: '',
  });
  assert.deepEqual(local, { mode: 'local' });

  assert.throws(
    () => executionFromEnv({ AOS_EXECUTION: 'mixed', AOS_OLLAMA_ENABLED: '1' }),
    (error) => error.code === 'adapter_config_invalid' && /exact model name/.test(error.message),
  );
  assert.throws(
    () => executionFromEnv({
      AOS_EXECUTION: 'mixed',
      AOS_OLLAMA_ENABLED: '1',
      AOS_OLLAMA_MODEL: MODEL,
      AOS_OLLAMA_API_KEY: 'do-not-leak',
    }),
    (error) => error.code === undefined && !error.message.includes('do-not-leak'),
  );

  const enabled = executionFromEnv({
    AOS_EXECUTION: 'mixed',
    AOS_OLLAMA_ENABLED: '1',
    AOS_OLLAMA_MODEL: MODEL,
    AOS_OLLAMA_BASE_URL: 'http://127.0.0.1:11435',
    AOS_OLLAMA_MAX_CONCURRENCY: '2',
    AOS_OLLAMA_TIMEOUT_MS: '60000',
  });
  assert.deepEqual(enabled.adapters.ollama, {
    enabled: true,
    model: MODEL,
    baseUrl: 'http://127.0.0.1:11435',
    maxConcurrency: 2,
    timeoutMs: 60_000,
    maxResponseBytes: 1_048_576,
    maxPromptBytes: 262_144,
  });
  const resolved = resolveExecution(enabled);
  assert.deepEqual(resolved.ollama, {
    enabled: true,
    model: MODEL,
    baseUrl: 'http://127.0.0.1:11435',
    maxConcurrency: 2,
    timeoutMs: 60_000,
    maxResponseBytes: 1_048_576,
    maxPromptBytes: 262_144,
  });
  assert.equal(Object.hasOwn(resolved.ollama, 'token'), false);

  const genericEnvelope = executionFromEnv({
    AOS_EXECUTION: 'mixed',
    AOS_ADAPTERS: JSON.stringify({ local: { enabled: true }, ollama: { enabled: true, model: MODEL } }),
  });
  assert.equal(genericEnvelope.adapters.ollama.enabled, false);
});

test('worker registry mounts Ollama only from a resolved explicit config', () => {
  const configured = createWorkerRegistry({
    ollama: { enabled: true, model: MODEL, baseUrl: BASE_URL, maxConcurrency: 1, timeoutMs: 1_000 },
  });
  assert.equal(configured.get('ollama').id, 'ollama');
  assert.equal(configured.get('ollama').label, 'Ollama (loopback HTTP)');

  const disabled = createWorkerRegistry();
  assert.ok(disabled.get('ollama') instanceof DisabledLiveWorker);
  assert.equal(disabled.get('ollama').id, 'ollama');
  assert.ok(createWorkerRegistry({ ollama: { model: MODEL } }).get('ollama') instanceof DisabledLiveWorker);
});

test('provider contract reports no auth, loopback transport, local attestation, and configured quota', async () => {
  const { engine } = makeEngine();
  let provider = engine.listProviders().find((item) => item.id === 'ollama');
  assert.equal(provider.authType, 'none');
  assert.equal(provider.configured, true);
  assert.equal(provider.adapterMounted, true);
  assert.equal(provider.liveExecutionEnabled, false);
  assert.equal(provider.contract.auth.boundary, 'none');
  assert.equal(provider.contract.transport.scope, 'loopback');
  assert.equal(provider.contract.transport.baseUrl, BASE_URL);
  assert.equal(provider.contract.attestation.strength, 'local_response_observed');
  assert.equal(provider.contract.attestation.externalIdentity, false);
  assert.equal(provider.contract.quota.maxConcurrency, 2);
  assert.ok(provider.contract.limitations.some((item) => /not external identity/.test(item)));
  assert.throws(() => assertProviderDispatchable(provider), (error) => error.code === 'adapter_disabled');

  await engine.preflightOllama();
  provider = engine.listProviders().find((item) => item.id === 'ollama');
  assert.equal(provider.readiness.status, 'available');
  assert.equal(provider.readiness.model, MODEL);
  assert.equal(provider.liveExecutionEnabled, true);
  assert.equal(provider.contract.dispatch.runnable, true);
  assert.doesNotThrow(() => assertProviderDispatchable(provider));

  const lines = await dispatch(engine, ['live', 'preflight', 'ollama']);
  assert.ok(lines.some((line) => line.includes('transport loopback-local')));
  assert.ok(lines.some((line) => line.includes('model     ' + MODEL)));
  assert.ok(lines.some((line) => line.includes('attestation=local-response-observed')));
});

test('unavailable preflight refuses before workspace claim and never falls back', async () => {
  const { engine, calls } = makeEngine({
    preflight: () => {
      throw Object.assign(new Error('local daemon unavailable'), { code: 'adapter_unavailable' });
    },
  });
  const goal = createGoal(engine);
  const run = engine.startRun({ goalId: goal.id });
  await engine.advanceRun(run.id, { untilIdle: true });
  const task = engine.getRunTree(run.id).tasks[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.workspace, null);
  assert.equal(calls.execute, 0);
  assert.equal(engine.state.resourceReservations.length, 0);
  assert.equal(engine.getRun(run.id).preflight.providers.ollama.status, 'unavailable');
  assert.ok(engine.store.readEventLog().some((event) => event.type === 'worker.refused' && event.payload.code === 'adapter_disabled'));
});

test('plan binding rejects model, sandbox, delegation, and role incompatibilities before run creation', () => {
  const cases = [
    [bulkTask({ model: 'other-model' }), /must use configured ollama runtime/],
    [bulkTask({ sandbox: 'host-process' }), (error) => error.code === 'plan_ollama_sandbox_invalid'],
    [bulkTask({ mayDelegate: true }), (error) => error.code === 'plan_ollama_delegation_invalid'],
    [bulkTask({ kind: 'research' }), (error) => error.code === 'plan_ollama_role_invalid'],
  ];
  for (const [task, expected] of cases) {
    const { engine } = makeEngine();
    const goal = createGoal(engine, task);
    assert.throws(() => engine.startRun({ goalId: goal.id }), expected);
    assert.equal(engine.state.runs.length, 0);
    assert.equal(engine.state.tasks.length, 0);
  }

  const { engine } = makeEngine();
  const goal = createGoal(engine);
  const run = engine.startRun({ goalId: goal.id });
  assert.equal(run.execution.adapters.ollama.model, MODEL);
  assert.equal(engine.getRunTree(run.id).tasks[0].model, MODEL);
});

test('dynamic plan patches reject an invalid Ollama child atomically before tasks or workspaces change', () => {
  const { engine } = makeEngine();
  const projectId = engine.defaultProject().id;
  engine.settings.set('execution.allowedHarnesses', ['local', 'codex', 'claude', 'ollama'], { scope: 'project', scopeId: projectId });
  const goal = engine.createGoal({
    projectId,
    prompt: PROMPT,
    plan: {
      title: 'Patch base',
      tasks: [{ id: 'base', title: 'Base local task', kind: 'research', worker: 'local' }],
      dependencies: [],
    },
  });
  const run = engine.startRun({ goalId: goal.id });
  const beforeTasks = structuredClone(engine.state.tasks.filter((task) => task.runId === run.id));
  const workspaceRoot = join(engine.store.workspacesDir, run.id);
  const beforeWorkspaceEntries = existsSync(workspaceRoot) ? readdirSync(workspaceRoot).sort() : [];

  assert.throws(
    () => engine.plans.patch(run.id, {
      id: 'bad-ollama-child',
      baseVersion: 1,
      reason: 'reject delegating Ollama child',
      additions: {
        tasks: [{
          id: 'child',
          title: 'Invalid Ollama child',
          kind: 'bulk',
          worker: 'ollama',
          model: MODEL,
          mayDelegate: true,
          delegation: { maxChildren: 1, maxDepth: 1 },
        }],
        dependencies: [],
      },
    }),
    (error) => error.code === 'plan_ollama_delegation_invalid',
  );
  assert.equal(engine.getRun(run.id).plan.version, 1);
  assert.deepEqual(engine.state.tasks.filter((task) => task.runId === run.id), beforeTasks);
  const afterWorkspaceEntries = existsSync(workspaceRoot) ? readdirSync(workspaceRoot).sort() : [];
  assert.deepEqual(afterWorkspaceEntries, beforeWorkspaceEntries);
});

test('Ollama reservations and receipts preserve provider provenance and supplied counters without USD invention', async () => {
  const { engine, calls } = makeEngine({
    usage: { input_tokens: 12, output_tokens: 7 },
  });
  const goal = createGoal(engine);
  const run = engine.startRun({ goalId: goal.id });
  await engine.advanceRun(run.id, { untilIdle: true });
  const task = engine.getRunTree(run.id).tasks[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(calls.execute, 1);
  assert.ok(task.workspace);
  assert.ok(existsSync(task.workspace));
  assert.deepEqual(task.runtime.at(-1).usage, { input_tokens: 12, output_tokens: 7 });

  const reservation = engine.state.resourceReservations.at(-1);
  assert.equal(reservation.providerId, 'ollama');
  assert.equal(reservation.request.worker, 'ollama');
  assert.equal(reservation.status, 'settled');
  assert.equal(reservation.consumed.tokens, 19);
  assert.equal(reservation.consumed.usd, null);
  const receipts = engine.state.resourceReceipts.filter((item) => item.reservationId === reservation.id);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((receipt) => receipt.providerId === 'ollama'));
  assert.equal(receipts.at(-1).usage.totalTokens, 19);
  assert.equal(receipts.at(-1).usage.costUsd, null);
});
