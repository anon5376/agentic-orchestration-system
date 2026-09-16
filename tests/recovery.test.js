import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';

const PROMPT = 'Recovery objective with success criteria and a bounded scope.';
const DEAD_PID = 2147483647;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function newEngine(dataDir = mkdtempSync(join(tmpdir(), 'aos-recovery-'))) {
  const aos = new AosEngine({ dataDir, concurrency: 3 });
  aos.load();
  return aos;
}

function slowWorker(aos, { delayMs = 150, onExecute = null } = {}) {
  aos.workers.set('local', {
    id: 'local',
    async execute(task, ctx) {
      if (onExecute) await onExecute(task, ctx);
      await sleep(delayMs);
      return { status: 'succeeded', summary: `${task.key} done` };
    },
  });
}

function planOf(keys, deps = [], extra = {}) {
  return {
    tasks: keys.map((key) => ({ id: key, key, title: `Task ${key}`, kind: 'research', worker: 'local', ...extra })),
    dependencies: deps.map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId })),
  };
}

function lease(overrides = {}) {
  const now = Date.now();
  return {
    attempt: 1,
    driverId: 'other-engine',
    driverPid: process.pid,
    host: hostname(),
    workerPid: null,
    workerPgid: null,
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    leaseUntil: new Date(now + 60_000).toISOString(),
    ttlMs: 60_000,
    ...overrides,
  };
}

// Marks the run's first task as running under the given lease, as a crashed driver would leave it.
function leaveRunning(aos, run, leaseRecord, extra = {}) {
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  Object.assign(task, { status: 'running', attempts: 1, lease: leaseRecord, ...extra });
  aos.save();
  return task;
}

test('a running task with a live, unexpired lease from another driver is left alone', async () => {
  const a = newEngine();
  slowWorker(a);
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A']) });
  const run = a.startRun({ goalId: goal.id });
  const task = leaveRunning(a, run, lease());

  const b = newEngine(a.store.dataDir);
  slowWorker(b);
  assert.equal(b.recoverOrphans(), 0);
  const result = await b.advanceRun(run.id, { untilIdle: true });
  assert.equal(result.executed, 0);
  assert.equal(b.getTask(task.id).status, 'running');
  assert.equal(b.getRun(run.id).status, 'running');
  assert.equal(b.store.readEventLog().some((event) => event.type === 'task.requeued'), false);
});

test('a dead driver or an expired lease is requeued once with attempt accounting, and fails when retries are exhausted', async () => {
  const a = newEngine();
  slowWorker(a);
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A']) });
  const run = a.startRun({ goalId: goal.id });
  const task = leaveRunning(a, run, lease({ driverId: 'dead', driverPid: DEAD_PID }));

  const b = newEngine(a.store.dataDir);
  slowWorker(b);
  assert.equal(b.getTask(task.id).status, 'ready');
  assert.equal(b.getTask(task.id).attempts, 1);
  assert.equal(b.getTask(task.id).lease, null);
  const requeued = b.store.readEventLog().filter((event) => event.type === 'task.requeued' && event.taskId === task.id);
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].payload.reason, 'driver process dead');
  await b.advanceRun(run.id, { untilIdle: true });
  assert.equal(b.getTask(task.id).status, 'succeeded');
  assert.equal(b.getTask(task.id).attempts, 2);
  assert.equal(b.getRun(run.id).status, 'completed');

  const c = newEngine();
  slowWorker(c);
  const expiredGoal = c.createGoal({ prompt: PROMPT, plan: planOf(['A']) });
  const expiredRun = c.startRun({ goalId: expiredGoal.id });
  const expired = leaveRunning(c, expiredRun, lease({ leaseUntil: new Date(Date.now() - 1000).toISOString() }));
  const d = newEngine(c.store.dataDir);
  assert.equal(d.getTask(expired.id).status, 'ready');
  const reasons = d.store.readEventLog().filter((event) => event.type === 'task.requeued').map((event) => event.payload.reason);
  assert.deepEqual(reasons, ['lease expired']);

  const e = newEngine();
  slowWorker(e);
  const exhaustedGoal = e.createGoal({ prompt: PROMPT, plan: planOf(['A'], [], { maxRetries: 0 }) });
  const exhaustedRun = e.startRun({ goalId: exhaustedGoal.id });
  const exhausted = leaveRunning(e, exhaustedRun, lease({ driverId: 'dead', driverPid: DEAD_PID }));
  const f = newEngine(e.store.dataDir);
  assert.equal(f.getTask(exhausted.id).status, 'failed');
  assert.equal(f.getTask(exhausted.id).attempts, 1);
  assert.equal(f.getRun(exhaustedRun.id).status, 'failed');
  const failed = f.store.readEventLog().find((event) => event.type === 'task.failed' && event.taskId === exhausted.id);
  assert.equal(failed.payload.orphaned, true);
});

test('restart reaps a recorded live worker process group and requeues the task', async () => {
  const a = newEngine();
  slowWorker(a);
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A']) });
  const run = a.startRun({ goalId: goal.id });
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.unref();
  await sleep(50);
  assert.equal(isAlive(child.pid), true);
  const task = leaveRunning(a, run, lease({ driverId: 'dead', driverPid: DEAD_PID, workerPid: child.pid, workerPgid: child.pid }));

  const b = newEngine(a.store.dataDir);
  await Promise.race([exited, sleep(6000)]);
  await sleep(20);
  assert.equal(isAlive(child.pid), false, 'worker process group was killed on restart');
  assert.equal(b.getTask(task.id).status, 'ready');
  const reaped = b.store.readEventLog().find((event) => event.type === 'worker.reaped' && event.taskId === task.id);
  assert.ok(reaped, 'worker.reaped event recorded');
  assert.equal(reaped.payload.pgid, child.pid);
});

test('an attempt records the worker process, keeps its lease fresh, and clears it on settlement', async () => {
  const a = newEngine();
  let seen = null;
  a.workers.set('local', {
    id: 'local',
    async execute(task, ctx) {
      ctx.recordWorkerProcess({ pid: process.pid, pgid: process.pid });
      ctx.heartbeat();
      seen = { ...a.getTask(task.id).lease };
      await sleep(20);
      return { status: 'succeeded', summary: 'ok' };
    },
  });
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A']) });
  const run = a.startRun({ goalId: goal.id });
  await a.advanceRun(run.id, { untilIdle: true });
  const task = a.state.tasks.find((item) => item.runId === run.id);
  assert.equal(seen.attempt, 1);
  assert.equal(seen.driverPid, process.pid);
  assert.equal(seen.driverId, a.driverId);
  assert.equal(seen.workerPid, process.pid);
  assert.equal(seen.workerPgid, process.pid);
  assert.ok(Date.parse(seen.leaseUntil) > Date.now(), 'lease expiry is in the future during the attempt');
  assert.equal(task.lease, null);
  assert.equal(task.status, 'succeeded');
});

test('a write from another engine during a live drive is not lost', async () => {
  const a = newEngine();
  slowWorker(a, { delayMs: 300 });
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A', 'B'], [['B', 'A']]) });
  const run = a.startRun({ goalId: goal.id });
  const driving = a.advanceRun(run.id, { untilIdle: true });
  await sleep(100);

  const b = newEngine(a.store.dataDir);
  const side = b.createGoal({ prompt: `${PROMPT} Side write during the drive.` });
  await driving;

  assert.equal(a.getRun(run.id).status, 'completed');
  assert.ok(a.state.goals.some((item) => item.id === side.id), 'the driving engine reloaded the side write');
  const c = newEngine(a.store.dataDir);
  assert.ok(c.state.goals.some((item) => item.id === side.id), 'the side write survived the drive');
  assert.equal(c.getRun(run.id).status, 'completed');
  assert.ok(c.state.tasks.filter((item) => item.runId === run.id).every((item) => item.status === 'succeeded'));
});

test('two engines driving the same run do not double-dispatch a task', async () => {
  const a = newEngine();
  const b = newEngine(a.store.dataDir);
  const calls = [];
  for (const engine of [a, b]) {
    engine.workers.set('local', {
      id: 'local',
      async execute(task) {
        calls.push(task.key);
        await sleep(150);
        return { status: 'succeeded', summary: `${task.key} done` };
      },
    });
  }
  const goal = a.createGoal({ prompt: PROMPT, plan: planOf(['A', 'B', 'C']) });
  const run = a.startRun({ goalId: goal.id, maxConcurrency: 3 });
  b.sync();
  await Promise.all([a.advanceRun(run.id, { untilIdle: true }), b.advanceRun(run.id, { untilIdle: true })]);

  const c = newEngine(a.store.dataDir);
  const tasks = c.state.tasks.filter((item) => item.runId === run.id);
  assert.deepEqual(tasks.map((item) => item.attempts), [1, 1, 1]);
  assert.deepEqual([...calls].sort(), ['A', 'B', 'C']);
  assert.equal(c.getRun(run.id).status, 'completed');
  const dispatched = c.store.readEventLog().filter((event) => event.type === 'worker.dispatched' && event.runId === run.id);
  assert.equal(dispatched.length, 3);
});

test('a waiting task survives restart and concurrent engines answer it once', async () => {
  const a = newEngine();
  a.workers.set('local', {
    id: 'local',
    async execute(task) {
      return task.attempts === 1
        ? { status: 'awaiting_user', questions: [{ prompt: 'Choose the bounded source set.' }] }
        : { status: 'succeeded', summary: 'resumed' };
    },
  });
  const goal = a.createGoal({
    prompt: PROMPT,
    plan: { tasks: [{ id: 'ask', key: 'ask', title: 'Ask operator', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const run = a.startRun({ goalId: goal.id });
  await a.advanceRun(run.id, { untilIdle: true });
  const waiting = a.state.tasks.find((task) => task.runId === run.id);
  const questionId = waiting.questions[0].id;
  const beforeRestart = a.store.readEventLog();
  const preWaitCursor = beforeRestart.find((event) => event.type === 'task.started' && event.taskId === waiting.id)?.cursor;
  assert.equal(typeof preWaitCursor, 'number');

  const reloaded = newEngine(a.store.dataDir);
  assert.equal(reloaded.getRun(run.id).status, 'awaiting_user');
  assert.equal(reloaded.getTask(waiting.id).status, 'awaiting_user');
  assert.deepEqual(reloaded.getTask(waiting.id).wait, waiting.wait);
  assert.equal(reloaded.store.readEventLog().length, beforeRestart.length);

  const barrier = join(a.store.dataDir, 'answer-barrier');
  const readyDir = join(barrier, 'ready');
  const release = join(barrier, 'release');
  writeFileSync(join(a.store.dataDir, 'answer-child.mjs'), `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { AosEngine } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'engine/engine.js')).href)};
    const dataDir = process.argv[2];
    const taskId = process.argv[3];
    const questionId = process.argv[4];
    const barrier = process.argv[5];
    const readyDir = join(barrier, 'ready');
    mkdirSync(readyDir, { recursive: true });
    writeFileSync(join(readyDir, String(process.pid)), 'ready');
    while (!existsSync(join(barrier, 'release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const engine = new AosEngine({ dataDir });
    engine.load();
    try {
      engine.answerTaskQuestions(taskId, [{ id: questionId, answer: 'Published bounded sources.' }]);
      process.stdout.write('ok\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, message: error.message }) + '\\n');
      process.exitCode = 1;
    }
  `);
  const childPath = join(a.store.dataDir, 'answer-child.mjs');
  const launch = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, a.store.dataDir, waiting.id, questionId, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const children = [launch(), launch()];
  for (let i = 0; i < 200 && (!existsSync(readyDir) || readdirCount(readyDir) < 2); i += 1) await sleep(5);
  assert.equal(readdirCount(readyDir), 2, 'both answer engines reached the barrier');
  writeFileSync(release, 'go');
  const results = await Promise.all(children);
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  assert.ok(results.every((result) => result.stdout.includes('ok')));

  const after = newEngine(a.store.dataDir);
  const answered = after.getTask(waiting.id);
  assert.equal(answered.questions[0].answer, 'Published bounded sources.');
  assert.equal(answered.status, 'ready');
  assert.equal(after.getRun(run.id).status, 'running');
  const events = after.store.readEventLog().filter((event) => event.taskId === waiting.id);
  assert.equal(events.filter((event) => event.type === 'task.questions_answered').length, 1);
  assert.equal(events.filter((event) => event.type === 'task.resumed').length, 1);
  const replay = after.store.replay({ after: preWaitCursor, limit: 500 });
  assert.equal(replay.resyncRequired, false);
  const replayTypes = replay.events.filter((event) => event.taskId === waiting.id).map((event) => event.type);
  assert.ok(replayTypes.includes('task.awaiting_user'));
  assert.ok(replayTypes.includes('task.questions_answered'));
  assert.ok(replayTypes.includes('task.resumed'));
  after.workers.set('local', {
    id: 'local',
    async execute() { return { status: 'succeeded', summary: 'resumed' }; },
  });
  await after.advanceRun(run.id, { untilIdle: true });
  assert.equal(after.getTask(waiting.id).status, 'succeeded');
  assert.equal(after.getTask(waiting.id).attempts, 2);
  assert.equal(after.getRun(run.id).status, 'completed');
});

function readdirCount(path) {
  try {
    return readdirSync(path).length;
  } catch {
    return 0;
  }
}
