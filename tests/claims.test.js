import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';

const PROMPT = 'A bounded pool claim objective with success criteria, source scope, and explicit limits.';

function engine(options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'aos-claims-'));
  const aos = new AosEngine({ dataDir, concurrency: 2, ...options });
  aos.load();
  return aos;
}

function plan(tasks) {
  return { title: 'pool claims', tasks, dependencies: [] };
}

function task(id, worker = 'local', extra = {}) {
  return { id, key: id, title: `Task ${id}`, kind: 'research', worker, ...extra };
}

function writeCodexSession(codexHome, threadId) {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const dir = join(codexHome, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'session_meta', payload: { id: threadId, cli_version: 'test', source: 'exec', model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-luna', effort: 'max', sandbox_policy: { type: 'read-only' }, approval_policy: 'never' } },
  ];
  writeFileSync(join(dir, `rollout-test-${threadId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('concurrent pool claims are idempotent and expose one bounded live claim', async () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('A', 'local', { presetId: 'general-worker' })]) });
  const run = aos.startRun({ goalId: goal.id });

  const [first, second] = await Promise.all([
    aos.claimPoolTask({ worker: 'local', ownerId: 'worker-1', requestId: 'request-1', runId: run.id }),
    aos.claimPoolTask({ worker: 'local', ownerId: 'worker-1', requestId: 'request-1', runId: run.id }),
  ]);

  assert.equal(first.claimId, second.claimId);
  assert.equal(first.taskId, second.taskId);
  assert.equal(first.attempt, 1);
  assert.equal(first.worker, 'local');
  assert.equal(first.providerProfile.provider, 'local');
  assert.ok(first.systemPrompt.includes(first.nonce));
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'credentials'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'session'), false);

  const claimed = aos.getTask(first.taskId);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.lease.executorKind, 'pool');
  assert.equal(claimed.lease.claimId, first.claimId);
  assert.equal(claimed.lease.claimRequestId, 'request-1');
  assert.equal(claimed.lease.ownerId, 'worker-1');
  const events = aos.store.readEventLog().filter((event) => event.taskId === first.taskId);
  assert.equal(events.filter((event) => event.type === 'task.claimed').length, 1);
  assert.equal(events.filter((event) => event.type === 'worker.dispatched').length, 1);
  assert.equal(events.filter((event) => event.type === 'task.started').length, 1);
});

test('pool claims select the exact worker and enforce project/run capacity', () => {
  const aos = engine();
  aos.workers.set('worker-a', { id: 'worker-a', async execute() { return { status: 'succeeded' }; } });
  aos.workers.set('worker-b', { id: 'worker-b', async execute() { return { status: 'succeeded' }; } });
  aos.defaultProject().maxConcurrency = 1;
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('A', 'worker-a'), task('B', 'worker-b')]) });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 2 });

  const b = aos.claimPoolTask({ worker: 'worker-b', ownerId: 'owner', requestId: 'b-request', runId: run.id });
  assert.equal(aos.getTask(b.taskId).key, 'B');
  assert.throws(
    () => aos.claimPoolTask({ worker: 'worker-a', ownerId: 'owner', requestId: 'a-request', runId: run.id }),
    (error) => error.code === 'resource_capacity_exhausted' && error.details.scope === 'project',
  );
  assert.equal(aos.state.tasks.find((item) => item.key === 'A').status, 'ready');

  aos.completePoolClaim(b.claimId, { ownerId: 'owner', attempt: b.attempt, result: { task_nonce: b.nonce, status: 'succeeded', summary: 'B complete' } });
  const a = aos.claimPoolTask({ worker: 'worker-a', ownerId: 'owner', requestId: 'a-request', runId: run.id });
  assert.equal(aos.getTask(a.taskId).key, 'A');
  assert.equal(a.worker, 'worker-a');
});

test('pool heartbeat and completion are fenced, nonce-bound, and settle resources once', () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('A', 'local', { budget: { tokens: 5, timeMs: 100 } })]) });
  const run = aos.startRun({ goalId: goal.id });
  const claim = aos.claimPoolTask({ worker: 'local', ownerId: 'owner-1', requestId: 'request-1', runId: run.id });

  assert.throws(() => aos.heartbeatPoolClaim(claim.claimId, { ownerId: 'other', attempt: claim.attempt }), (error) => error.code === 'pool_claim_owner_mismatch');
  assert.throws(() => aos.heartbeatPoolClaim(claim.claimId, { ownerId: 'owner-1', attempt: 2 }), (error) => error.code === 'pool_claim_attempt_mismatch');
  assert.throws(() => aos.completePoolClaim(claim.claimId, { ownerId: 'other', attempt: claim.attempt, result: { status: 'succeeded', task_nonce: claim.nonce } }), (error) => error.code === 'pool_claim_owner_mismatch');
  assert.throws(() => aos.completePoolClaim(claim.claimId, { ownerId: 'owner-1', attempt: claim.attempt, result: { status: 'succeeded' } }), (error) => error.code === 'pool_result_nonce_mismatch');
  assert.equal(aos.state.resourceReservations[0].status, 'active');

  const done = aos.completePoolClaim(claim.claimId, {
    ownerId: 'owner-1',
    attempt: claim.attempt,
    result: { task_nonce: claim.nonce, status: 'succeeded', summary: 'complete', runtime: { durationMs: 3 } },
  });
  assert.equal(done.status, 'succeeded');
  assert.equal(aos.state.resourceReservations[0].status, 'settled');
  assert.equal(aos.state.resourceReceipts.length, 2);
  assert.throws(() => aos.completePoolClaim(claim.claimId, { ownerId: 'owner-1', attempt: claim.attempt, result: { task_nonce: claim.nonce, status: 'succeeded' } }), (error) => error.code === 'pool_claim_stale');
  assert.equal(aos.state.resourceReceipts.length, 2);
});

test('pool completion fails closed when a claimed capability is revoked', () => {
  const aos = engine();
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create({
    id: 'pool-bounded-echo',
    kind: 'tool',
    name: 'Pool bounded echo',
    description: 'A claim-time capability used to verify completion revalidation.',
    source: { type: 'generated', reference: 'aos.bounded-echo-v1' },
    permissions: ['filesystem_read'],
    test: { required: true, protocol: 'schema_check', description: 'Bounded adapter contract.' },
  });
  aos.capabilities.recordTest(capability.id, capability.version, {
    requestId: 'pool-capability-test', status: 'passed', summary: 'passed',
  });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project', scopeId: projectId, permissions: ['filesystem_read'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });
  const goal = aos.createGoal({
    projectId,
    prompt: PROMPT,
    plan: plan([task('A', 'local', { capabilities: { tools: [capability.reference] } })]),
  });
  const run = aos.startRun({ goalId: goal.id });
  const claim = aos.claimPoolTask({ worker: 'local', ownerId: 'owner', requestId: 'revoked-request', runId: run.id });
  aos.capabilities.setState(capability.id, capability.version, 'revoked', { reason: 'revoked after claim' });

  const refused = aos.completePoolClaim(claim.claimId, {
    ownerId: 'owner', attempt: claim.attempt,
    result: { task_nonce: claim.nonce, status: 'succeeded', summary: 'must not land' },
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.status, 'failed');
  assert.equal(aos.getTask(claim.taskId).errorCode, 'capability_revoked');
  assert.equal(aos.getTask(claim.taskId).output, null);
  assert.equal(aos.getTask(claim.taskId).lease, null);
  assert.equal(aos.state.resourceReservations[0].status, 'settled');
});

test('expired pool claims recover without local inflight and cancellation clears a fenced lease after settlement', () => {
  let now = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-claims-recovery-'));
  const aos = engine({ dataDir, clock: () => now });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('expired', 'local', { timeoutMs: 1, budget: { tokens: 1, timeMs: 1 } })]) });
  const run = aos.startRun({ goalId: goal.id });
  const claim = aos.claimPoolTask({ worker: 'local', ownerId: 'remote-owner', requestId: 'expired-request', runId: run.id });
  const restarted = engine({ dataDir, clock: () => now });
  assert.equal(restarted.getTask(claim.taskId).status, 'running', 'a live pool lease is not tied to local inflight');

  now += 62_000;
  assert.equal(restarted.recoverOrphans(), 1);
  assert.equal(restarted.getTask(claim.taskId).status, 'ready');
  assert.equal(restarted.getTask(claim.taskId).lease, null);
  assert.equal(restarted.state.resourceReservations[0].status, 'settled');
  assert.throws(() => restarted.completePoolClaim(claim.claimId, { ownerId: 'remote-owner', attempt: claim.attempt, result: { task_nonce: claim.nonce, status: 'succeeded' } }), (error) => error.code === 'pool_claim_stale');

  const cancelled = engine();
  const cancelledGoal = cancelled.createGoal({ prompt: PROMPT, plan: plan([task('cancelled', 'local', { budget: { tokens: 1, timeMs: 10 } })]) });
  const cancelledRun = cancelled.startRun({ goalId: cancelledGoal.id });
  const cancelledClaim = cancelled.claimPoolTask({ worker: 'local', ownerId: 'owner', requestId: 'cancel-request', runId: cancelledRun.id });
  cancelled.cancelTask(cancelledClaim.taskId);
  assert.equal(cancelled.getTask(cancelledClaim.taskId).status, 'cancelled');
  assert.equal(cancelled.getTask(cancelledClaim.taskId).lease, null);
  assert.equal(cancelled.state.resourceReservations.at(-1).status, 'settled');
  assert.throws(() => cancelled.completePoolClaim(cancelledClaim.claimId, { ownerId: 'owner', attempt: cancelledClaim.attempt, result: { task_nonce: cancelledClaim.nonce, status: 'succeeded' } }), (error) => error.code === 'pool_claim_stale');
});

test('provider-adapter claims skip unsupported tasks and require an exact verified receipt', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'aos-pool-codex-home-'));
  const aos = engine({
    execution: {
      mode: 'mixed',
      adapters: {
        local: { enabled: true },
        codex: { enabled: true, model: 'gpt-5.6-luna', effort: 'max', repoRoot: process.cwd(), codexHome },
      },
    },
  });
  aos.providerReadiness.codex = { status: 'available', checkedAt: new Date().toISOString(), model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' };
  const goal = aos.createGoal({
    prompt: PROMPT,
    plan: plan([
      task('delegating', 'codex', { mayDelegate: true }),
      task('bounded', 'codex'),
    ]),
  });
  const run = aos.startRun({ goalId: goal.id });
  assert.throws(() => aos.claimPoolTask({
    worker: 'codex', ownerId: 'adapter-owner', requestId: 'adapter-mismatch', runId: run.id,
    protocol: 'provider-adapter-v1', profileFingerprint: '0'.repeat(16),
  }), (error) => error.code === 'pool_claim_profile_mismatch');
  assert.equal(aos.state.tasks.filter((item) => item.runId === run.id && item.status === 'running').length, 0);
  const claim = aos.claimPoolTask({
    worker: 'codex', ownerId: 'adapter-owner', requestId: 'adapter-request', runId: run.id, protocol: 'provider-adapter-v1',
    profileFingerprint: aos.executionSummary().adapters.codex.profile.fingerprint,
  });

  assert.equal(aos.state.tasks.find((item) => item.key === 'delegating').status, 'ready');
  assert.equal(aos.getTask(claim.taskId).key, 'bounded');
  assert.equal(claim.protocol, 'provider-adapter-v1');
  assert.equal(claim.task.attempts, 1);
  assert.equal(claim.task.nonce, claim.nonce);
  assert.equal(claim.task.mayDelegate, false);
  assert.ok(claim.leaseUntil);

  const refused = aos.completePoolClaim(claim.claimId, {
    ownerId: 'adapter-owner', attempt: claim.attempt,
    result: {
      task_nonce: claim.nonce,
      status: 'succeeded',
      summary: 'forged',
      runtime: {
        provider: 'codex', verified: true,
        requested: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
        effective: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
        threadId: 'thread-forged',
      },
    },
  });
  assert.equal(refused.refused, true);
  assert.equal(refused.errorCode, 'pool_adapter_receipt_invalid');
  assert.equal(aos.getTask(claim.taskId).status, 'failed');
  assert.equal(aos.getTask(claim.taskId).output, null);
});

test('provider-adapter completion accepts the existing adapter receipt shape', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'aos-pool-codex-home-'));
  const aos = engine({
    execution: {
      mode: 'mixed',
      adapters: { codex: { enabled: true, model: 'gpt-5.6-luna', effort: 'max', repoRoot: process.cwd(), codexHome } },
    },
  });
  aos.providerReadiness.codex = { status: 'available', checkedAt: new Date().toISOString(), model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' };
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('bounded', 'codex')]) });
  const run = aos.startRun({ goalId: goal.id });
  const claim = aos.claimPoolTask({
    worker: 'codex', ownerId: 'adapter-owner', requestId: 'adapter-valid', runId: run.id, protocol: 'provider-adapter-v1',
    profileFingerprint: aos.executionSummary().adapters.codex.profile.fingerprint,
  });
  writeCodexSession(codexHome, 'thread-valid');
  const completed = aos.completePoolClaim(claim.claimId, {
    ownerId: 'adapter-owner', attempt: claim.attempt,
    result: {
      task_nonce: claim.nonce,
      status: 'succeeded',
      summary: 'verified',
      result: { summary: 'verified', findings: [], risks: [], confidence: 0.8, decision: null, retrospective: null, memory_writes: [] },
      runtime: {
        provider: 'codex', verified: true,
        requested: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
        effective: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
        threadId: 'thread-valid',
      },
    },
  });
  assert.equal(completed.status, 'succeeded');
  assert.ok(aos.getTask(claim.taskId).sessionId);
  assert.equal(aos.getTask(claim.taskId).runtime.at(-1).verified, true);
});

test('public HTTP state exposes only the sanitized live pool execution lease', async () => {
  let now = Date.parse('2026-09-16T00:00:00.000Z');
  const aos = engine({
    clock: () => now,
    execution: {
      mode: 'mixed',
      adapters: {
        codex: { enabled: true, model: 'gpt-5.6-luna', effort: 'max', repoRoot: process.cwd(), codexHome: mkdtempSync(join(tmpdir(), 'aos-telemetry-codex-home-')) },
      },
    },
  });
  aos.providerReadiness.codex = { status: 'available', checkedAt: new Date(now).toISOString(), model: 'gpt-5.6-luna', effort: 'max' };
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan([task('A', 'codex')]) });
  const run = aos.startRun({ goalId: goal.id });
  assert.equal(aos.snapshot().telemetry.workers.find((item) => item.taskCode === 'A').execution, null);
  const claim = aos.claimPoolTask({
    worker: 'codex', ownerId: 'telemetry-owner', requestId: 'telemetry-request', runId: run.id,
    protocol: 'provider-adapter-v1', profileFingerprint: aos.executionSummary().adapters.codex.profile.fingerprint,
  });
  aos.heartbeatPoolClaim(claim.claimId, { ownerId: 'telemetry-owner', attempt: claim.attempt, workerPid: 4321, workerPgid: 4322 });

  const taskLease = aos.getTask(claim.taskId).lease;
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = await fetch(`${base}/api/v1/snapshot`).then((response) => response.json());
  const tree = await fetch(`${base}/api/v1/runs/${run.id}/tree`).then((response) => response.json());
  const taskView = await fetch(`${base}/api/v1/tasks/${claim.taskId}`).then((response) => response.json());
  const worker = snapshot.telemetry.workers.find((item) => item.taskId === claim.taskId);
  assert.deepEqual(worker.execution, {
    kind: 'pool',
    claimId: claim.claimId,
    ownerId: 'telemetry-owner',
    protocol: 'provider-adapter-v1',
    heartbeatAt: taskLease.heartbeatAt,
    leaseUntil: taskLease.leaseUntil,
    leaseState: 'live',
    workerPid: 4321,
    workerPgid: 4322,
  });
  for (const forbidden of ['host', 'driverId', 'claimRequestId', 'prompt', 'credentials', 'profile', 'sessionId', 'threadId']) {
    assert.equal(Object.hasOwn(worker.execution, forbidden), false, `execution telemetry must omit ${forbidden}`);
  }
  for (const publicTask of [
    snapshot.tasks.find((item) => item.id === claim.taskId),
    tree.tasks.find((item) => item.id === claim.taskId),
    tree.roots.find((item) => item.id === claim.taskId),
    taskView,
  ]) {
    for (const privateField of ['lease', 'nonce', 'runtime']) {
      assert.equal(Object.hasOwn(publicTask, privateField), false, `public task must omit ${privateField}`);
    }
  }

  now = Date.parse(taskLease.leaseUntil) + 1;
  assert.equal(aos.snapshot().telemetry.workers.find((item) => item.taskId === claim.taskId).execution.leaseState, 'expired');
  await close();
});
