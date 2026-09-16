import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AosEngine } from '../engine/engine.js';
import { fingerprint } from '../engine/ids.js';

function setup({ dataDir = mkdtempSync(join(tmpdir(), 'aos-effect-claims-')), clock = () => Date.now() } = {}) {
  const aos = new AosEngine({ dataDir, clock });
  aos.load();
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create({
    id: 'workspace-writer',
    kind: 'tool',
    name: 'Workspace writer',
    description: 'Deterministic test-only task workspace writer contract.',
    source: { type: 'generated', reference: 'aos.workspace-writer-test-v1' },
    permissions: ['filesystem_write'],
    test: { required: true, protocol: 'operator_receipt', description: 'Fixture apply and rollback passed.' },
  });
  aos.capabilities.recordTest(capability.id, capability.version, {
    requestId: 'workspace-writer-test-v1', status: 'passed', summary: 'Fixture apply and rollback passed.',
  });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project', scopeId: projectId, permissions: ['filesystem_write'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });
  const goal = aos.createGoal({
    projectId,
    prompt: 'Apply one deterministic change inside the task workspace and preserve a rollback receipt.',
    plan: {
      title: 'Effect claim fixture',
      tasks: [{
        id: 'write', title: 'Write fixture', kind: 'implementation', worker: 'local',
        capabilities: { tools: [capability.reference] },
      }],
      dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  const identity = {
    projectId,
    runId: run.id,
    taskId: task.id,
    attempt: 1,
    capabilityReference: capability.reference,
    capabilityFingerprint: capability.fingerprint,
    inputFingerprint: fingerprint('bounded input'),
    effectType: 'workspace_write',
    isolationMode: 'task_workspace',
    isolationFingerprint: fingerprint(`workspace:${run.id}:${task.id}`),
    rollbackPlanFingerprint: fingerprint('restore previous fixture bytes'),
  };
  return { aos, dataDir, capability, run, task, identity };
}

test('effect execution requires exact prior approval and persists one terminal receipt', () => {
  const { aos, dataDir, identity } = setup();
  assert.throws(
    () => aos.effects.claim({ ...identity, approvalId: 'eap_missing', ownerId: 'engine-a', requestId: 'claim-a' }),
    (error) => error.code === 'effect_approval_mismatch',
  );
  const approval = aos.effects.approve({ ...identity, requestId: 'approve-a', actor: 'operator' });
  const claim = aos.effects.claim({ ...identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-a' });
  const done = aos.effects.complete(claim.id, {
    ownerId: 'engine-a', fence: claim.fence, status: 'succeeded', receiptFingerprint: fingerprint('applied bytes'),
  });
  assert.equal(done.claim.status, 'succeeded');
  assert.equal(done.receipt.actionFingerprint, approval.actionFingerprint);
  const replay = aos.effects.claim({ ...identity, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-replay' });
  assert.equal(replay.id, claim.id);
  assert.equal(replay.idempotent, true);
  assert.equal(aos.state.effectReceipts.length, 1);
  assert.equal(JSON.stringify(aos.state.effectClaims).includes('bounded input'), false);

  const reloaded = new AosEngine({ dataDir });
  reloaded.load();
  assert.equal(reloaded.effects.get(claim.id).status, 'succeeded');
  assert.equal(reloaded.state.effectReceipts.length, 1);
});

test('cross-engine claims fence active owners and recover an expired lease', () => {
  let now = Date.now();
  const clock = () => now;
  const seeded = setup({ clock });
  const approval = seeded.aos.effects.approve({ ...seeded.identity, requestId: 'approve-race', actor: 'operator' });
  const first = seeded.aos.effects.claim({
    ...seeded.identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-a', leaseMs: 1_000,
  });
  const secondEngine = new AosEngine({ dataDir: seeded.dataDir, clock });
  secondEngine.load();
  assert.throws(
    () => secondEngine.effects.claim({ ...seeded.identity, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-b' }),
    (error) => error.code === 'effect_claim_conflict',
  );

  now += 1_001;
  assert.equal(secondEngine.effects.recoverExpired(), 1);
  const recovered = secondEngine.effects.claim({
    ...seeded.identity, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-b', leaseMs: 1_000,
  });
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.fence, first.fence + 1);
  assert.equal(recovered.recovered, true);
  assert.throws(
    () => seeded.aos.effects.complete(first.id, {
      ownerId: 'engine-a', fence: first.fence, status: 'succeeded', receiptFingerprint: fingerprint('stale'),
    }),
    (error) => ['effect_claim_owner_mismatch', 'effect_claim_fence_mismatch'].includes(error.code),
  );
  const completed = secondEngine.effects.complete(recovered.id, {
    ownerId: 'engine-b', fence: recovered.fence, status: 'succeeded', receiptFingerprint: fingerprint('fresh'),
  });
  assert.equal(completed.receipt.fence, 2);
});

test('rollback is explicit, fingerprinted, durable, and idempotent', () => {
  const { aos, dataDir, identity } = setup();
  const approval = aos.effects.approve({ ...identity, requestId: 'approve-rollback', actor: 'operator' });
  const claim = aos.effects.claim({ ...identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-rollback' });
  aos.effects.complete(claim.id, {
    ownerId: 'engine-a', fence: claim.fence, status: 'succeeded', receiptFingerprint: fingerprint('applied'),
  });
  const rolledBack = aos.effects.rollback(claim.id, {
    requestId: 'rollback-a', actor: 'operator', receiptFingerprint: fingerprint('restored'),
  });
  assert.equal(rolledBack.claim.status, 'rolled_back');
  assert.equal(rolledBack.receipt.rollbackPlanFingerprint, identity.rollbackPlanFingerprint);
  const replay = aos.effects.rollback(claim.id, {
    requestId: 'rollback-a', actor: 'operator', receiptFingerprint: fingerprint('restored'),
  });
  assert.equal(replay.idempotent, true);
  assert.equal(aos.state.effectRollbackReceipts.length, 1);

  const reloaded = new AosEngine({ dataDir });
  reloaded.load();
  assert.equal(reloaded.effects.get(claim.id).status, 'rolled_back');
  assert.equal(reloaded.state.effectRollbackReceipts.length, 1);
});

test('rollback request replay rejects a changed actor or receipt fingerprint', () => {
  const { aos, identity } = setup();
  const approval = aos.effects.approve({ ...identity, requestId: 'approve-rollback-conflict', actor: 'operator' });
  const claim = aos.effects.claim({ ...identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-rollback-conflict' });
  aos.effects.complete(claim.id, {
    ownerId: 'engine-a', fence: claim.fence, status: 'succeeded', receiptFingerprint: fingerprint('applied-conflict'),
  });
  aos.effects.rollback(claim.id, {
    requestId: 'rollback-conflict', actor: 'operator', receiptFingerprint: fingerprint('restored-conflict'),
  });
  assert.throws(
    () => aos.effects.rollback(claim.id, {
      requestId: 'rollback-conflict', actor: 'another-operator', receiptFingerprint: fingerprint('restored-conflict'),
    }),
    (error) => error.code === 'effect_rollback_request_conflict',
  );
  assert.throws(
    () => aos.effects.rollback(claim.id, {
      requestId: 'rollback-conflict', actor: 'operator', receiptFingerprint: fingerprint('different-restoration'),
    }),
    (error) => error.code === 'effect_rollback_request_conflict',
  );
});

test('approval and completion fail closed after capability policy changes', () => {
  const { aos, capability, identity } = setup();
  const approval = aos.effects.approve({ ...identity, requestId: 'approve-revoke', actor: 'operator' });
  const claim = aos.effects.claim({ ...identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-revoke' });
  aos.capabilities.setState(capability.id, capability.version, 'revoked', { reason: 'operator revoked before effect completion' });
  assert.throws(
    () => aos.effects.complete(claim.id, {
      ownerId: 'engine-a', fence: claim.fence, status: 'succeeded', receiptFingerprint: fingerprint('must not land'),
    }),
    (error) => error.code === 'capability_revoked',
  );
  assert.equal(aos.state.effectReceipts.length, 0);
  assert.equal(aos.effects.get(claim.id).status, 'claimed');
});
