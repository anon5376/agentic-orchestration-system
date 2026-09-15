import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { analyzeRun, buildTimeline, detectViolations, replayMetrics, replaySchedule } from '../engine/metrics.js';
import { validatePlan } from '../engine/intake.js';
import { buildReviewJob, buildSchedulerJob } from '../bench/scheduler-job.js';

const PROMPT = 'Synthetic scheduler objective with success criteria and a bounded scope.';

// Test worker whose delay and planned failures come from a side table keyed by task key.
function engineWithTimedWorker({ concurrency = 2, behavior = new Map() } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-sched-'));
  const aos = new AosEngine({ dataDir, concurrency });
  aos.load();
  const calls = [];
  aos.workers.set('timed', {
    id: 'timed',
    async execute(task, ctx) {
      const { delayMs = 5, failAttempts = [] } = behavior.get(task.key) || {};
      calls.push({ key: task.key, attempt: task.attempts, running: aos.state.tasks.filter((item) => item.runId === ctx.run.id && item.status === 'running').length });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failAttempts.includes(task.attempts)) return { status: 'failed', error: `planned failure ${task.attempts}` };
      return { status: 'succeeded', summary: `${task.key} done` };
    },
  });
  return { aos, calls, behavior };
}

function timedTask(key, extra = {}) {
  return { id: key, key, title: `Task ${key}`, kind: 'research', worker: 'timed', ...extra };
}

function keyOf(aos, taskId) {
  return aos.state.tasks.find((task) => task.id === taskId)?.key;
}

test('a finished task frees its slot immediately instead of waiting for the batch', async () => {
  const behavior = new Map([['A', { delayMs: 250 }], ['B', { delayMs: 10 }], ['C', { delayMs: 10 }], ['D', { delayMs: 10 }]]);
  const { aos } = engineWithTimedWorker({ behavior });
  const plan = { tasks: ['A', 'B', 'C', 'D'].map((key) => timedTask(key)), dependencies: [] };
  const goal = aos.createGoal({ prompt: PROMPT, plan });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 2 });
  await aos.advanceRun(run.id, { untilIdle: true });
  const events = aos.store.readEventLog().filter((event) => event.runId === run.id);
  const index = (type, key) => events.findIndex((event) => event.type === type && keyOf(aos, event.taskId) === key);
  assert.ok(index('worker.dispatched', 'C') < index('task.completed', 'A'), 'C should start while A is still running');
  assert.ok(index('worker.dispatched', 'D') < index('task.completed', 'A'), 'D should start while A is still running');
  const analysis = analyzeRun({ dataDir: aos.store.dataDir, runId: run.id });
  assert.deepEqual(analysis.violations, []);
  assert.equal(analysis.metrics.peakConcurrency, 2);
});

test('randomised DAG keeps dependency order, cap, and attempt accounting under retries', async () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const behavior = new Map();
  const { aos, calls } = engineWithTimedWorker({ behavior });
  const tasks = [];
  const dependencies = [];
  for (let i = 0; i < 30; i += 1) {
    behavior.set(`T${i}`, { delayMs: 1 + Math.floor(random() * 12), failAttempts: random() < 0.2 ? [1] : [] });
    tasks.push(timedTask(`T${i}`, { dependencyPolicy: random() < 0.3 ? 'all_terminal' : 'all_succeeded' }));
    for (let j = 0; j < i; j += 1) {
      if (random() < 0.12) dependencies.push({ taskId: `T${i}`, dependsOnTaskId: `T${j}` });
    }
  }
  const goal = aos.createGoal({ prompt: PROMPT, plan: { tasks, dependencies } });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 3 });
  await Promise.all([aos.advanceRun(run.id, { untilIdle: true }), aos.advanceRun(run.id, { untilIdle: true })]);
  assert.equal(aos.getRun(run.id).status, 'completed');
  assert.ok(Math.max(...calls.map((call) => call.running)) <= 3);
  const analysis = analyzeRun({ dataDir: aos.store.dataDir, runId: run.id });
  assert.deepEqual(analysis.violations, []);
  const planned = [...behavior.values()].filter((item) => item.failAttempts.length).length;
  assert.ok(planned > 0);
  assert.equal(analysis.metrics.retries.total, planned);
  assert.ok(analysis.metrics.peakConcurrency <= 3);
});

test('injected faults are deterministic, retryable, and never reach the worker', async () => {
  const { aos, calls } = engineWithTimedWorker();
  const plan = {
    tasks: [timedTask('A', { injectFault: { attempt: 1, holdMs: 20, error: 'injected A' } }), timedTask('B')],
    dependencies: [{ taskId: 'B', dependsOnTaskId: 'A' }],
  };
  const goal = aos.createGoal({ prompt: PROMPT, plan });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const a = aos.state.tasks.find((task) => task.runId === run.id && task.key === 'A');
  assert.equal(a.status, 'succeeded');
  assert.equal(a.attempts, 2);
  assert.deepEqual(calls.filter((call) => call.key === 'A').map((call) => call.attempt), [2]);
  const runtime = JSON.parse(readFileSync(join(a.workspace, 'attempt-1', 'runtime.json'), 'utf8'));
  assert.equal(runtime.spawned, false);
  assert.equal(runtime.injected, true);
  const retried = aos.store.readEventLog().find((event) => event.runId === run.id && event.type === 'task.retried');
  assert.equal(retried.payload.injected, true);
  assert.equal(retried.payload.retryable, true);
  const metrics = analyzeRun({ dataDir: aos.store.dataDir, runId: run.id }).metrics;
  assert.deepEqual(metrics.retries, { total: 1, injected: 1, organic: 0, faultsInjected: 1 });
  assert.throws(() => validatePlan({ tasks: [timedTask('X', { maxRetries: 0, injectFault: { attempt: 1 } })] }), /not be retryable/);
});

test('unknown workers fail closed instead of falling back to the local worker', async () => {
  const { aos } = engineWithTimedWorker();
  let localCalls = 0;
  const local = aos.workers.get('local');
  local.execute = async () => {
    localCalls += 1;
    return { status: 'succeeded', summary: 'should not run' };
  };
  const goal = aos.createGoal({ prompt: PROMPT, plan: { tasks: [timedTask('A', { worker: 'nonexistent' })], dependencies: [] } });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  assert.equal(task.status, 'failed');
  assert.equal(task.attempts, 1);
  assert.match(task.error, /refusing to fall back/);
  assert.equal(localCalls, 0);
});

test('plan validation rejects cycles, unknown references and duplicate keys', () => {
  assert.throws(() => validatePlan({ tasks: [timedTask('A'), timedTask('B')], dependencies: [{ taskId: 'A', dependsOnTaskId: 'B' }, { taskId: 'B', dependsOnTaskId: 'A' }] }), /cycle/);
  assert.throws(() => validatePlan({ tasks: [timedTask('A')], dependencies: [{ taskId: 'A', dependsOnTaskId: 'Z' }] }), /unknown task/);
  assert.throws(() => validatePlan({ tasks: [timedTask('A'), { ...timedTask('B'), key: 'A' }] }), /Duplicate plan task key/);
});

test('violation detectors flag early dispatch, cap overrun and unapproved gates', () => {
  const run = { id: 'run_x', maxConcurrency: 1, status: 'completed', execution: { mode: 'local' } };
  const tasks = [
    { id: 't_a', key: 'A', status: 'succeeded', attempts: 1, dependencyPolicy: 'all_succeeded' },
    { id: 't_b', key: 'B', status: 'succeeded', attempts: 1, dependencyPolicy: 'all_succeeded' },
    { id: 't_g', key: 'G', status: 'succeeded', attempts: 1, requiresApproval: true },
  ];
  const deps = [{ taskId: 't_b', dependsOnTaskId: 't_a' }];
  const event = (index, type, taskId, payload = {}) => ({ id: `e${index}`, index, ts: new Date(1_000 + index).toISOString(), type, runId: 'run_x', taskId, payload });
  const events = [
    event(0, 'worker.dispatched', 't_a', { attempt: 1 }),
    event(1, 'worker.dispatched', 't_b', { attempt: 1 }),
    event(2, 'task.completed', 't_a', { attempt: 1 }),
    event(3, 'task.completed', 't_b', { attempt: 1 }),
    event(4, 'worker.dispatched', 't_g', { attempt: 1 }),
    event(5, 'task.completed', 't_g', { attempt: 1 }),
  ];
  const timeline = buildTimeline({ run, tasks, events });
  const types = detectViolations({ run, tasks, deps, events, allEvents: events, timeline, manifest: { entries: [], strayWorkspaces: [] }, workers: [] }).map((item) => item.type);
  assert.ok(types.includes('dependency_order'));
  assert.ok(types.includes('concurrency_cap'));
  assert.ok(types.includes('approval_gate'));
});

test('trace replay shows batch dispatch losing to slot refill on uneven durations', () => {
  const tasks = [
    { key: 'A', attempts: [10] },
    { key: 'B', attempts: [1] },
    { key: 'C', attempts: [1] },
    { key: 'D', attempts: [1] },
  ];
  assert.equal(replaySchedule({ tasks, dependencies: [], cap: 2, policy: 'pool' }).makespan, 10);
  assert.equal(replaySchedule({ tasks, dependencies: [], cap: 2, policy: 'batch' }).makespan, 11);
  assert.equal(replaySchedule({ tasks, dependencies: [], cap: 1, policy: 'pool' }).makespan, 13);
  const chained = replaySchedule({ tasks: [{ key: 'A', attempts: [1, 2] }, { key: 'B', attempts: [3] }], dependencies: [{ task: 'B', dependsOn: 'A' }], cap: 4 });
  assert.equal(chained.makespan, 6);
});

test('proving job has 24+ tasks in four branches, two injected faults and one approval gate', () => {
  const plan = buildSchedulerJob({ repoRoot: '/repo', jobSpecPath: '/out/job-spec.json' });
  const valid = validatePlan(plan);
  assert.ok(valid.tasks.length >= 24);
  assert.deepEqual([...new Set(plan.tasks.map((task) => task.branch))].filter((branch) => branch !== 'root').sort(), ['adversarial', 'benchmark', 'execution', 'repository']);
  assert.deepEqual(plan.tasks.filter((task) => task.injectFault).map((task) => task.key), ['R2', 'E5']);
  assert.deepEqual(plan.tasks.filter((task) => task.requiresApproval).map((task) => task.key), ['G']);
  assert.ok(plan.tasks.filter((task) => !task.requiresApproval).every((task) => task.worker === 'codex'));
  const deps = plan.dependencies.map((dep) => ({ task: dep.taskId, dependsOn: dep.dependsOnTaskId }));
  const unit = plan.tasks.map((task) => ({ key: task.key, attempts: task.requiresApproval ? [] : [1] }));
  assert.deepEqual([1, 2, 4, 0].map((cap) => replaySchedule({ tasks: unit, dependencies: deps, cap }).makespan), [27, 16, 12, 10]);
  const review = validatePlan(buildReviewJob({ outDir: '/out', liveLevel: 4 }));
  assert.equal(review.tasks.length, 5);
  assert.equal(review.tasks.some((task) => task.requiresApproval || task.injectFault), false);
  assert.match(review.tasks[0].brief, /not separate live runs/);
});

test('replayed schedules report blocked time and pass the live-run detectors', () => {
  const tasks = [
    { key: 'A', attempts: [4] },
    { key: 'B', attempts: [1, 2] },
    { key: 'C', attempts: [1] },
    { key: 'G', attempts: [] },
  ];
  const dependencies = [{ task: 'C', dependsOn: 'A' }, { task: 'C', dependsOn: 'B' }, { task: 'G', dependsOn: 'C' }];
  const one = replayMetrics({ tasks, dependencies, cap: 1 });
  assert.equal(one.makespanMs, 8);
  assert.deepEqual(one.dispatchOrder, ['A#1', 'B#1', 'B#2', 'C#1']);
  assert.deepEqual(one.blockedMs, { dependencyWait: 7, slotWait: 4, retryWait: 0 });
  assert.deepEqual(one.violations, []);
  const two = replayMetrics({ tasks, dependencies, cap: 2 });
  assert.equal(two.makespanMs, 5);
  assert.equal(two.peakConcurrency, 2);
  assert.deepEqual(two.violations, []);
  assert.equal(replayMetrics({ tasks, dependencies, cap: 2, policy: 'batch' }).makespanMs, 7);
});
