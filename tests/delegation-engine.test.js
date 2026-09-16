import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';

const PROMPT = 'Determine whether delayed feedback destabilises coupling. Success is bounded. Scope excludes deployment.';

function makeEngine({ gates = null, maxChildren = 2, maxDepth = 1, parentBudget = null, childTemplates = ['default-worker'], extraTemplates = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-delegation-'));
  const aos = new AosEngine({ dataDir, concurrency: 2 });
  aos.load();
  for (const template of extraTemplates) aos.templates.create(template);
  aos.templates.create({
    id: 'delegating-parent',
    name: 'Delegating parent',
    config: {
      preset: { id: 'general-worker' },
      harness: { id: 'local' },
      ...(parentBudget ? { budget: parentBudget } : {}),
      delegation: { mayDelegate: true, maxChildren, maxDepth, childTemplates },
    },
  });
  const goal = aos.createGoal({
    prompt: PROMPT,
    plan: {
      title: 'Delegation test',
      tasks: [{ id: 'P', key: 'P', title: 'Parent', kind: 'research', templateId: 'delegating-parent', brief: 'Delegate bounded child checks.' }],
      dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 2 });
  if (gates) aos.settings.patchRun(run.id, { key: 'approvals.humanGates', value: gates });
  return { aos, run, dataDir };
}

function child(id, extra = {}) {
  return { id, key: id, title: `Child ${id}`, kind: 'research', brief: `Bounded work for ${id}.`, templateId: 'default-worker', templateVersion: 1, ...extra };
}

function driveWith(aos, run, delegation) {
  aos.workers.get('local').execute = async (task) => {
    if (task.planTaskId === 'P') return { status: 'succeeded', summary: 'Parent complete', result: { delegation } };
    return { status: 'succeeded', summary: `${task.planTaskId} complete` };
  };
  return aos.advanceRun(run.id, { untilIdle: true });
}

test('authorized two-child delegation creates immutable v2 and children runnable after parent', async () => {
  const { aos, run } = makeEngine();
  const v1 = structuredClone(aos.state.planVersions.find((item) => item.runId === run.id));
  await driveWith(aos, run, { tasks: [child('C1'), child('C2')], dependencies: [] });

  assert.equal(aos.getRun(run.id).plan.version, 2);
  assert.deepEqual(aos.state.planVersions.find((item) => item.version === 1 && item.runId === run.id), v1);
  const v2 = aos.state.planVersions.find((item) => item.runId === run.id && item.version === 2);
  assert.equal(v2.immutable, true);
  const tasks = aos.state.tasks.filter((item) => item.runId === run.id);
  const parent = tasks.find((item) => item.planTaskId === 'P');
  const children = tasks.filter((item) => ['C1', 'C2'].includes(item.planTaskId));
  assert.equal(parent.status, 'succeeded');
  assert.equal(children.length, 2);
  assert.ok(children.every((item) => item.status === 'succeeded'));
  assert.ok(children.every((item) => item.parentId === parent.id));
  assert.ok(children.every((item) => aos.state.dependencies.some((dep) => dep.taskId === item.id && dep.dependsOnTaskId === parent.id)));
  assert.deepEqual(aos.state.delegationReceipts.map((item) => item.status), ['accepted']);
  assert.deepEqual(aos.store.readEventLog().filter((item) => item.runId === run.id && item.type.startsWith('delegation.')).map((item) => item.type), ['delegation.proposed', 'delegation.accepted']);
});

test('on_expansion records awaiting approval without mutating the plan', async () => {
  const { aos, run } = makeEngine({ gates: ['on_expansion'] });
  const before = {
    plan: structuredClone(aos.state.planVersions.filter((item) => item.runId === run.id)),
    taskIds: aos.state.tasks.filter((item) => item.runId === run.id).map((item) => item.id),
    dependencies: structuredClone(aos.state.dependencies.filter((item) => item.runId === run.id)),
  };
  await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });

  assert.equal(aos.getRun(run.id).plan.version, 1);
  assert.deepEqual(aos.state.planVersions.filter((item) => item.runId === run.id), before.plan);
  assert.deepEqual(aos.state.tasks.filter((item) => item.runId === run.id).map((item) => item.id), before.taskIds);
  assert.deepEqual(aos.state.dependencies.filter((item) => item.runId === run.id), before.dependencies);
  assert.equal(aos.state.delegationReceipts[0].status, 'awaiting_approval');
  assert.deepEqual(aos.store.readEventLog().filter((item) => item.runId === run.id && item.type.startsWith('delegation.')).map((item) => item.type), ['delegation.proposed', 'delegation.awaiting_approval']);
});

test('pending expansion remains gated and approval applies the stored candidate exactly once', async () => {
  const { aos, run } = makeEngine({ gates: ['on_expansion'] });
  await driveWith(aos, run, { tasks: [child('C1'), child('C2')], dependencies: [] });

  const pending = aos.listDelegationExpansions(run.id).find((item) => item.status === 'awaiting_approval');
  assert.ok(pending);
  assert.equal(aos.getRun(run.id).status, 'awaiting_approval');
  assert.equal(aos.state.planVersions.filter((item) => item.runId === run.id).length, 1);
  assert.ok(pending.candidatePatch);
  assert.equal(typeof pending.candidateFingerprint, 'string');
  assert.equal('runtime' in pending.candidatePatch, false);
  assert.equal('session' in pending.candidatePatch, false);

  const accepted = aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'approve', requestId: 'approve-1' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.decidedBy, 'operator');
  assert.equal(accepted.requestId, 'approve-1');
  assert.equal(aos.getRun(run.id).plan.version, 2);
  assert.equal(aos.state.planVersions.filter((item) => item.runId === run.id).length, 2);
  assert.deepEqual(aos.state.tasks.filter((item) => item.runId === run.id && ['C1', 'C2'].includes(item.planTaskId)).map((item) => item.status), ['ready', 'ready']);

  const replay = aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'approve', requestId: 'approve-1' });
  assert.deepEqual(replay, accepted);
  assert.equal(aos.state.planVersions.filter((item) => item.runId === run.id).length, 2);
  assert.throws(
    () => aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'reject', requestId: 'approve-1' }),
    (error) => error.code === 'delegation_decision_conflict',
  );
});

test('rejecting a pending expansion is durable and leaves the graph unchanged', async () => {
  const { aos, run } = makeEngine({ gates: ['on_expansion'] });
  await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });
  const pending = aos.listDelegationExpansions(run.id)[0];
  const before = {
    versions: structuredClone(aos.state.planVersions.filter((item) => item.runId === run.id)),
    tasks: structuredClone(aos.state.tasks.filter((item) => item.runId === run.id)),
    dependencies: structuredClone(aos.state.dependencies.filter((item) => item.runId === run.id)),
  };

  const rejected = aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'reject', requestId: 'reject-1' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decidedBy, 'operator');
  assert.equal(aos.getRun(run.id).status, 'completed');
  assert.deepEqual(aos.state.planVersions.filter((item) => item.runId === run.id), before.versions);
  assert.deepEqual(aos.state.tasks.filter((item) => item.runId === run.id), before.tasks);
  assert.deepEqual(aos.state.dependencies.filter((item) => item.runId === run.id), before.dependencies);
  assert.deepEqual(aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'reject', requestId: 'reject-1' }), rejected);
});

test('stale pending expansion is durable and cannot rebase or mutate the graph', async () => {
  const { aos, run } = makeEngine({ gates: ['on_expansion'] });
  await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });
  const pending = aos.listDelegationExpansions(run.id)[0];

  // Exercise the existing CAS seam to advance the plan while the expansion is
  // pending. The public patch path remains closed at the approval gate.
  aos.transact(() => { aos.getRun(run.id).status = 'running'; });
  aos.plans.patch(run.id, {
    id: 'operator-stale',
    baseVersion: 1,
    reason: 'Advance the base plan for stale-approval coverage.',
    additions: { tasks: [child('X')], dependencies: [] },
  });
  aos.transact(() => {
    const fresh = aos.getRun(run.id);
    fresh.status = 'awaiting_approval';
    const added = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'X');
    if (added) added.status = 'ready';
  });
  const beforeDecision = {
    versions: structuredClone(aos.state.planVersions.filter((item) => item.runId === run.id)),
    tasks: structuredClone(aos.state.tasks.filter((item) => item.runId === run.id)),
    dependencies: structuredClone(aos.state.dependencies.filter((item) => item.runId === run.id)),
  };

  const stale = aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'approve', requestId: 'stale-1' });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.decision, 'stale');
  assert.equal(stale.errorCode, 'delegation_stale');
  assert.equal(aos.getRun(run.id).plan.version, 2);
  assert.deepEqual(aos.state.planVersions.filter((item) => item.runId === run.id), beforeDecision.versions);
  assert.deepEqual(aos.state.tasks.filter((item) => item.runId === run.id), beforeDecision.tasks);
  assert.deepEqual(aos.state.dependencies.filter((item) => item.runId === run.id), beforeDecision.dependencies);
  const reloaded = new AosEngine({ dataDir: aos.store.dataDir, concurrency: 2 });
  reloaded.load();
  assert.equal(reloaded.listDelegationExpansions(run.id)[0].status, 'stale');
});

test('child template pins survive edits and mismatched or omitted versions reject', async (t) => {
  await t.test('approval uses the pinned version after a template edit', async () => {
    const { aos, run } = makeEngine({ gates: ['on_expansion'] });
    const parent = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P');
    assert.equal(parent.delegation.childTemplateVersions['default-worker'], 1);
    await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });
    aos.templates.edit('default-worker', { config: { budget: { tokens: 1 } } });
    assert.equal(aos.templates.get('default-worker').version, 2);

    const pending = aos.listDelegationExpansions(run.id)[0];
    const accepted = aos.decideDelegationExpansion({ receiptId: pending.id, decision: 'approve', requestId: 'pin-1' });
    assert.equal(accepted.status, 'accepted');
    const childTask = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'C1');
    assert.equal(childTask.templateVersion, 1);
    assert.equal(childTask.config.templateVersion, 1);
    assert.equal(childTask.budget.tokens, 60_000);
  });

  for (const [label, version] of [['mismatched', 2], ['omitted', undefined]]) {
    await t.test(`${label} child template version rejects`, async () => {
      const { aos, run } = makeEngine();
      const proposed = child('C1');
      if (version === undefined) delete proposed.templateVersion;
      else proposed.templateVersion = version;
      await driveWith(aos, run, { tasks: [proposed], dependencies: [] });
      const parent = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P');
      assert.equal(parent.status, 'failed');
      assert.equal(aos.state.delegationReceipts[0].status, 'rejected');
      assert.equal(aos.getRun(run.id).plan.version, 1);
      assert.equal(aos.state.tasks.filter((item) => item.runId === run.id && item.planTaskId === 'C1').length, 0);
    });
  }
});

test('unlimited delegation is always pending for operator pacing', async (t) => {
  for (const limits of [{ maxChildren: null }, { maxDepth: null }]) {
    await t.test(JSON.stringify(limits), async () => {
      const { aos, run } = makeEngine(limits);
      await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });
      const receipt = aos.listDelegationExpansions(run.id)[0];
      assert.equal(receipt.status, 'awaiting_approval');
      assert.equal(receipt.approvalGate, 'unbounded_delegation');
      assert.equal(aos.getRun(run.id).status, 'awaiting_approval');
      assert.equal(aos.getRun(run.id).plan.version, 1);
    });
  }
});

test('secret-like content in a child brief rejects before candidate persistence', async () => {
  const { aos, run } = makeEngine();
  const secret = `sk-${'a'.repeat(24)}`;
  await driveWith(aos, run, {
    tasks: [child('C1', { brief: `Do not persist ${secret} in this bounded task.` })],
    dependencies: [],
  });

  const parent = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P');
  const receipt = aos.state.delegationReceipts[0];
  assert.equal(parent.status, 'failed');
  assert.equal(parent.errorCode, 'delegation_secret_content');
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.errorCode, 'delegation_secret_content');
  assert.equal(receipt.candidatePatch, null);
  assert.equal(JSON.stringify(aos.state).includes(secret), false);
  assert.equal(aos.store.readEventLog().filter((item) => item.runId === run.id).some((item) => JSON.stringify(item).includes(secret)), false);
});

test('secret-like nested property names reject before normalization or persistence', async () => {
  const { aos, run } = makeEngine();
  const secret = `sk-${'b'.repeat(24)}`;
  await driveWith(aos, run, {
    tasks: [child('C1', { budget: { [secret]: 1 } })],
    dependencies: [],
  });

  const parent = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P');
  const receipt = aos.state.delegationReceipts[0];
  assert.equal(parent.status, 'failed');
  assert.equal(parent.errorCode, 'delegation_secret_content');
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.errorCode, 'delegation_secret_content');
  assert.equal(receipt.candidatePatch, null);
  assert.equal(JSON.stringify(aos.state).includes(secret), false);
  assert.equal(aos.store.readEventLog().filter((item) => item.runId === run.id).some((item) => JSON.stringify(item).includes(secret)), false);
});

test('unlimited ancestry keeps approved finite-template children operator-paced', async () => {
  const recursiveChild = {
    id: 'recursive-child',
    name: 'Recursive child',
    config: {
      preset: { id: 'general-worker' },
      harness: { id: 'local' },
      budget: { tokens: 10_000 },
      delegation: { mayDelegate: true, maxChildren: 1, maxDepth: 1, childTemplates: ['recursive-child'] },
    },
  };
  const { aos, run } = makeEngine({
    maxChildren: null,
    maxDepth: null,
    childTemplates: ['recursive-child'],
    extraTemplates: [recursiveChild],
  });
  const parentProposal = { tasks: [child('C1', { templateId: 'recursive-child' })], dependencies: [] };
  const grandchildProposal = { tasks: [child('G1', { templateId: 'recursive-child' })], dependencies: [] };
  aos.workers.get('local').execute = async (task) => {
    if (task.planTaskId === 'P') return { status: 'succeeded', summary: 'Parent complete', result: { delegation: parentProposal } };
    if (task.planTaskId === 'C1') return { status: 'succeeded', summary: 'Child complete', result: { delegation: grandchildProposal } };
    return { status: 'succeeded', summary: `${task.planTaskId} complete` };
  };

  await aos.advanceRun(run.id, { untilIdle: true });
  let receipts = aos.listDelegationExpansions(run.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'awaiting_approval');
  assert.equal(receipts[0].approvalGate, 'unbounded_delegation');
  assert.equal(aos.getRun(run.id).plan.version, 1);

  const first = aos.decideDelegationExpansion({ receiptId: receipts[0].id, decision: 'approve', requestId: 'recursive-1' });
  assert.equal(first.status, 'accepted');
  assert.equal(aos.getRun(run.id).plan.version, 2);
  const childTask = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'C1');
  assert.equal(childTask.operatorPaced, true);
  assert.equal(childTask.delegation.operatorPaced, true);
  assert.deepEqual(childTask.delegation.childTemplateVersions, { 'recursive-child': 1 });

  await aos.advanceRun(run.id, { untilIdle: true });
  receipts = aos.listDelegationExpansions(run.id);
  const second = receipts.find((item) => item.parentPlanTaskId === 'C1');
  assert.ok(second);
  assert.equal(second.status, 'awaiting_approval');
  assert.equal(second.approvalGate, 'operator_paced_delegation');
  assert.equal(aos.getRun(run.id).plan.version, 2);
  assert.equal(aos.state.tasks.some((item) => item.runId === run.id && item.planTaskId === 'G1'), false);

  const acceptedSecond = aos.decideDelegationExpansion({ receiptId: second.id, decision: 'approve', requestId: 'recursive-2' });
  assert.equal(acceptedSecond.status, 'accepted');
  assert.equal(aos.getRun(run.id).plan.version, 3);
  const grandchild = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'G1');
  assert.equal(grandchild.operatorPaced, true);
  assert.equal(grandchild.delegation.operatorPaced, true);
});

test('delegated child budgets are bounded in aggregate by the parent budget', async (t) => {
  await t.test('over-budget proposal is rejected without a plan version', async () => {
    const { aos, run } = makeEngine({ parentBudget: { tokens: 100_000 } });
    await driveWith(aos, run, { tasks: [child('C1'), child('C2')], dependencies: [] });
    assert.equal(aos.getRun(run.id).plan.version, 1);
    assert.equal(aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P').status, 'failed');
    assert.equal(aos.state.delegationReceipts[0].status, 'rejected');
  });

  await t.test('lower requested budgets can fit the same parent ceiling', async () => {
    const { aos, run } = makeEngine({ parentBudget: { tokens: 100_000 } });
    await driveWith(aos, run, { tasks: [child('C1', { budget: { tokens: 50_000 } }), child('C2', { budget: { tokens: 50_000 } })], dependencies: [] });
    assert.equal(aos.getRun(run.id).plan.version, 2);
    const budgets = aos.state.tasks.filter((item) => item.runId === run.id && ['C1', 'C2'].includes(item.planTaskId)).map((item) => item.budget.tokens);
    assert.deepEqual(budgets, [50_000, 50_000]);
    assert.equal(budgets.reduce((sum, value) => sum + value, 0), 100_000);
  });
});

test('forged, unpermitted, over-fanout, and cyclic proposals fail closed with zero plan mutation', async (t) => {
  const cases = [
    ['forged field', { tasks: [child('C', { worker: 'codex' })], dependencies: [] }, 'delegation_unknown_field'],
    ['unpermitted template', { tasks: [child('C', { templateId: 'default-researcher' })], dependencies: [] }, 'delegation_authority'],
    ['over fanout', { tasks: [child('C1'), child('C2'), child('C3')], dependencies: [] }, 'delegation_authority'],
    ['cyclic siblings', { tasks: [child('C1', { dependencies: ['C2'] }), child('C2', { dependencies: ['C1'] })], dependencies: [] }, 'delegation_cycle'],
  ];
  for (const [label, proposal, code] of cases) {
    await t.test(label, async () => {
      const { aos, run } = makeEngine();
      const before = {
        plan: structuredClone(aos.state.planVersions.filter((item) => item.runId === run.id)),
        tasks: structuredClone(aos.state.tasks.filter((item) => item.runId === run.id)),
        dependencies: structuredClone(aos.state.dependencies.filter((item) => item.runId === run.id)),
      };
      await driveWith(aos, run, proposal);
      const parent = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'P');
      assert.equal(parent.status, 'failed');
      assert.equal(parent.errorCode, code);
      assert.deepEqual(aos.state.planVersions.filter((item) => item.runId === run.id), before.plan);
      assert.deepEqual(aos.state.tasks.filter((item) => item.runId === run.id).map((item) => ({ planTaskId: item.planTaskId, status: item.status })), [{ planTaskId: 'P', status: 'failed' }]);
      assert.deepEqual(aos.state.dependencies.filter((item) => item.runId === run.id), before.dependencies);
      assert.equal(aos.state.delegationReceipts.length, 1);
      assert.equal(aos.state.delegationReceipts[0].status, 'rejected');
    });
  }
});

test('accepted and rejected delegation receipts survive reload and duplicate result identity is stable', async () => {
  const { aos, run, dataDir } = makeEngine();
  await driveWith(aos, run, { tasks: [child('C1')], dependencies: [] });
  const accepted = structuredClone(aos.state.delegationReceipts[0]);
  const reloaded = new AosEngine({ dataDir, concurrency: 2 });
  reloaded.load();
  assert.deepEqual(reloaded.state.delegationReceipts, [accepted]);
  assert.equal(reloaded.state.planVersions.filter((item) => item.runId === run.id).length, 2);
  assert.equal(new Set(reloaded.state.delegationReceipts.map((item) => item.idempotencyKey)).size, 1);
});
