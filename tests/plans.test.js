import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';

const PROMPT = 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim. Scope excludes deployment.';

function engine(options = {}) {
  const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'aos-plans-'));
  const aos = new AosEngine({ dataDir, concurrency: 2, ...options });
  aos.load();
  return aos;
}

function singleTaskEngine(options = {}) {
  const aos = engine(options);
  const goal = aos.createGoal({
    prompt: PROMPT,
    plan: { title: 'single', tasks: [{ id: 'A', key: 'A', title: 'First', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  return { aos, goal };
}

function addition(id = 'B', extra = {}) {
  return { id, key: id, title: `Task ${id}`, kind: 'research', worker: 'local', ...extra };
}

test('startRun writes an immutable v1 plan snapshot and GET-shaped history', () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: PROMPT });
  const originalPlan = structuredClone(goal.plan);
  const run = aos.startRun({ goalId: goal.id });
  const snapshot = aos.state.planVersions.find((item) => item.runId === run.id);

  assert.equal(run.plan.version, 1);
  assert.match(run.plan.id, /^plan_/);
  assert.equal(snapshot.immutable, true);
  assert.equal(snapshot.status, 'complete');
  assert.deepEqual(snapshot.tasks, originalPlan.tasks);
  assert.ok(aos.state.tasks.filter((task) => task.runId === run.id).every((task) => task.planVersion === 1));
  assert.deepEqual(aos.getGoal(goal.id).plan, originalPlan, 'goal plan stays unchanged');
  const view = aos.plans.get(run.id);
  assert.deepEqual(view.current, run.plan);
  assert.deepEqual(view.history, [{
    id: snapshot.id,
    version: 1,
    createdAt: snapshot.createdAt,
    createdBy: 'engine',
    source: 'startRun',
    patchId: null,
    taskCount: snapshot.tasks.length,
    dependencyCount: snapshot.dependencies.length,
  }]);
  assert.deepEqual(view.patches, []);
});

test('operator patch is append-only, idempotent, and materializes one dependent deterministic task', async () => {
  const { aos, goal } = singleTaskEngine();
  const run = aos.startRun({ goalId: goal.id });
  const v1 = structuredClone(aos.state.planVersions[0]);
  const patch = {
    id: 'expand-1',
    baseVersion: 1,
    reason: 'independent check',
    actor: 'agent-forged',
    additions: {
      tasks: [addition('B')],
      dependencies: [{ taskId: 'B', dependsOn: 'A' }],
    },
  };
  const receipt = aos.plans.patch(run.id, patch);
  assert.equal(receipt.patch.actor, 'operator');
  assert.equal(aos.getRun(run.id).plan.version, 2);
  assert.deepEqual(aos.state.planVersions[0], v1, 'v1 remains unchanged');
  assert.equal(aos.state.planVersions.length, 2);
  assert.equal(aos.state.planPatches.length, 1);
  const materialized = aos.state.tasks.filter((task) => task.runId === run.id);
  assert.equal(materialized.length, 2);
  assert.equal(materialized.find((task) => task.planTaskId === 'A').planVersion, 1);
  assert.equal(materialized.find((task) => task.planTaskId === 'B').planVersion, 2);
  assert.equal(aos.state.dependencies.filter((dep) => dep.runId === run.id).length, 1);

  const again = aos.plans.patch(run.id, patch);
  assert.deepEqual(again, receipt.patch, 'same patch body returns its receipt');
  const beforeMismatch = {
    versions: structuredClone(aos.state.planVersions),
    patches: structuredClone(aos.state.planPatches),
    tasks: structuredClone(aos.state.tasks),
    dependencies: structuredClone(aos.state.dependencies),
    events: structuredClone(aos.store.readEventLog()),
  };
  assert.throws(() => aos.plans.patch(run.id, { ...patch, reason: 'different body' }), (error) => error.code === 'plan_patch_id_mismatch' && error.statusCode === 409);
  assert.deepEqual(aos.state.planVersions, beforeMismatch.versions);
  assert.deepEqual(aos.state.planPatches, beforeMismatch.patches);
  assert.deepEqual(aos.state.tasks, beforeMismatch.tasks);
  assert.deepEqual(aos.state.dependencies, beforeMismatch.dependencies);
  assert.deepEqual(aos.store.readEventLog(), beforeMismatch.events);
  assert.equal(aos.state.planVersions.length, 2);
  assert.equal(aos.state.tasks.filter((task) => task.runId === run.id).length, 2);

  await aos.advanceRun(run.id, { untilIdle: true });
  const tasks = aos.state.tasks.filter((task) => task.runId === run.id);
  assert.ok(tasks.every((task) => task.status === 'succeeded'));
  assert.equal(tasks.find((task) => task.planTaskId === 'B').attempts, 1);

  const reloaded = engine({ dataDir: aos.store.dataDir });
  assert.deepEqual(reloaded.getRun(run.id).plan, { id: run.plan.id, version: 2 });
  assert.equal(reloaded.state.planVersions.length, 2);
  assert.equal(reloaded.state.planPatches.length, 1);
});

test('patch validation is typed and atomic for duplicate ids, cycles, stale versions, and terminal runs', () => {
  const { aos, goal } = singleTaskEngine();
  const run = aos.startRun({ goalId: goal.id });
  const before = {
    versions: structuredClone(aos.state.planVersions),
    patches: structuredClone(aos.state.planPatches),
    tasks: structuredClone(aos.state.tasks),
    dependencies: structuredClone(aos.state.dependencies),
    events: structuredClone(aos.store.readEventLog()),
  };
  const patch = (body) => ({ id: `bad-${Math.random().toString(16).slice(2)}`, baseVersion: 1, reason: 'reject me', additions: { tasks: [addition('B')], dependencies: [], ...body } });

  assert.throws(() => aos.plans.patch(run.id, patch({ tasks: [addition('A')] })), (error) => error.code === 'plan_duplicate_task_id' && error.statusCode === 409);
  assert.throws(() => aos.plans.patch(run.id, patch({ dependencies: [{ taskId: 'B', dependsOnTaskId: 'B' }] })), (error) => error.code === 'plan_cycle' && error.statusCode === 409);
  assert.throws(() => aos.plans.patch(run.id, { ...patch({}), baseVersion: 2 }), (error) => error.code === 'plan_version_conflict' && error.statusCode === 409);
  assert.deepEqual(aos.state.planVersions, before.versions);
  assert.deepEqual(aos.state.planPatches, before.patches);
  assert.deepEqual(aos.state.tasks, before.tasks);
  assert.deepEqual(aos.state.dependencies, before.dependencies);
  assert.deepEqual(aos.store.readEventLog(), before.events);

  aos.transact(() => { aos.getRun(run.id).status = 'completed'; });
  assert.throws(() => aos.plans.patch(run.id, { id: 'terminal', baseVersion: 1, reason: 'too late', additions: { tasks: [addition('C')], dependencies: [] } }), (error) => error.code === 'run_terminal' && error.statusCode === 409);
  assert.equal(aos.state.planVersions.length, 1);
});

test('finite ceilings reject over-capacity and unbounded additions without mutation', () => {
  const { aos, goal } = singleTaskEngine();
  const run = aos.startRun({ goalId: goal.id });
  aos.transact(() => {
    run.ceilings = { tasks: 2, unlimited: false };
    run.policies = { depth: { max: 2, unlimited: false } };
  });
  assert.throws(() => aos.plans.patch(run.id, { id: 'over-cap', baseVersion: 1, reason: 'over cap', additions: { tasks: [addition('B'), addition('C')], dependencies: [] } }), (error) => error.code === 'plan_ceiling' && error.statusCode === 409);
  assert.throws(() => aos.plans.patch(run.id, { id: 'unbounded', baseVersion: 1, reason: 'unbounded', additions: { tasks: [addition('C', { mayDelegate: true, delegation: { maxChildren: null, maxDepth: null, unlimited: true } })], dependencies: [] } }), (error) => error.code === 'plan_unbounded' && error.statusCode === 409);
  assert.equal(aos.state.planVersions.length, 1);
  assert.equal(aos.state.planPatches.length, 0);
  assert.equal(aos.state.tasks.filter((task) => task.runId === run.id).length, 1);
});

test('finite token, USD, and time ceilings require provable aggregate task budgets atomically', () => {
  const dimensions = [
    ['tokens', 200, 100, 150],
    ['usd', 2, 1, 1.5],
    ['timeMs', 2_000, 1_000, 1_500],
  ];
  for (const [dimension, ceiling, baseBudget, addedBudget] of dimensions) {
    const aos = engine();
    const goal = aos.createGoal({
      prompt: PROMPT,
      plan: { title: `budget-${dimension}`, tasks: [addition('A', { budget: { [dimension]: baseBudget } })], dependencies: [] },
    });
    const run = aos.startRun({ goalId: goal.id });
    aos.transact(() => { aos.getRun(run.id).ceilings = { [dimension]: ceiling, unlimited: false }; });
    const before = {
      versions: structuredClone(aos.state.planVersions),
      patches: structuredClone(aos.state.planPatches),
      tasks: structuredClone(aos.state.tasks),
      dependencies: structuredClone(aos.state.dependencies),
      events: structuredClone(aos.store.readEventLog()),
    };
    assert.throws(() => aos.plans.patch(run.id, {
      id: `missing-${dimension}`,
      baseVersion: 1,
      reason: 'missing effective budget',
      additions: { tasks: [addition('missing')], dependencies: [] },
    }), (error) => error.code === 'plan_unbounded' && error.statusCode === 409);
    assert.deepEqual(aos.state.planVersions, before.versions);
    assert.deepEqual(aos.state.planPatches, before.patches);
    assert.deepEqual(aos.state.tasks, before.tasks);
    assert.deepEqual(aos.state.dependencies, before.dependencies);
    assert.deepEqual(aos.store.readEventLog(), before.events);

    assert.throws(() => aos.plans.patch(run.id, {
      id: `over-${dimension}`,
      baseVersion: 1,
      reason: 'aggregate budget exceeds ceiling',
      additions: { tasks: [addition('over', { budget: { [dimension]: addedBudget } })], dependencies: [] },
    }), (error) => error.code === 'plan_ceiling' && error.statusCode === 409 && error.details.dimension === dimension);
    assert.deepEqual(aos.state.planVersions, before.versions);
    assert.deepEqual(aos.state.planPatches, before.patches);
    assert.deepEqual(aos.state.tasks, before.tasks);
    assert.deepEqual(aos.state.dependencies, before.dependencies);
    assert.deepEqual(aos.store.readEventLog(), before.events);
  }
});

test('live Codex patch refuses a non-Codex addition without changing the run', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-live-plans-'));
  const aos = engine({ dataDir, execution: { mode: 'codex', codex: { model: 'gpt-5.6-luna', effort: 'max', maxConcurrency: 1 } } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: { title: 'live', tasks: [{ id: 'A', title: 'Live task', kind: 'research', worker: 'codex' }], dependencies: [] } });
  const run = aos.startRun({ goalId: goal.id });
  assert.throws(() => aos.plans.patch(run.id, { id: 'bad-live', baseVersion: 1, reason: 'wrong harness', additions: { tasks: [addition('B')], dependencies: [] } }), (error) => error.code === 'plan_live_codex_invalid' && error.statusCode === 409);
  assert.equal(aos.state.planVersions.length, 1);
  assert.equal(aos.state.planPatches.length, 0);
});

test('same-store engines race one base version and commit exactly one patch', async () => {
  const { aos, goal } = singleTaskEngine();
  const run = aos.startRun({ goalId: goal.id });
  const other = engine({ dataDir: aos.store.dataDir });
  const beforeEvents = aos.store.readEventLog().length;
  const makePatch = (id, taskId) => ({
    id,
    baseVersion: 1,
    reason: `concurrent ${id}`,
    additions: { tasks: [addition(taskId)], dependencies: [] },
  });
  const results = await Promise.allSettled([
    Promise.resolve().then(() => aos.plans.patch(run.id, makePatch('race-a', 'B'))),
    Promise.resolve().then(() => other.plans.patch(run.id, makePatch('race-b', 'C'))),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'plan_version_conflict');
  assert.equal(rejected.reason.statusCode, 409);
  const reloaded = engine({ dataDir: aos.store.dataDir });
  assert.equal(reloaded.state.planVersions.filter((item) => item.runId === run.id).length, 2);
  assert.equal(reloaded.state.planPatches.filter((item) => item.runId === run.id).length, 1);
  assert.equal(reloaded.state.tasks.filter((item) => item.runId === run.id).length, 2);
  assert.equal(reloaded.store.readEventLog().slice(beforeEvents).filter((event) => event.type === 'plan.patched').length, 1);
});

test('HTTP plan read exposes the pointer, compact history, immutable selection, and patch receipt', async () => {
  const { aos, goal } = singleTaskEngine();
  const run = aos.startRun({ goalId: goal.id });
  const service = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const initial = await fetch(`${base}/api/v1/runs/${run.id}/plan?version=1`).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.current, { id: run.plan.id, version: 1 });
    assert.equal(initial.body.snapshot.version, 1);
    assert.equal(initial.body.history.length, 1);
    const patched = await fetch(`${base}/api/v1/runs/${run.id}/plan/patches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'http-expand', baseVersion: 1, reason: 'HTTP operator expansion', additions: { tasks: [addition('B')], dependencies: [{ taskId: 'B', dependsOn: 'A' }] }, actor: 'agent' }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(patched.status, 201);
    assert.equal(patched.body.run.plan.version, 2);
    assert.equal(patched.body.patch.actor, 'operator');
    const selected = await fetch(`${base}/api/v1/runs/${run.id}/plan?version=1`).then((response) => response.json());
    assert.equal(selected.snapshot.version, 1);
    assert.equal(selected.history.length, 2);
    assert.equal(selected.patches[0].id, 'http-expand');
  } finally {
    await service.close();
  }
});
