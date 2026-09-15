import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';

function engine(prefix = 'aos-store-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const aos = new AosEngine({ dataDir });
  aos.load();
  return aos;
}

function goalPrompt(owner, index) {
  return `${owner} goal ${index}. Success is a persisted record. Scope is this concurrency test only.`;
}

test('two processes create goals in one store without losing either process writes', async () => {
  const aos = engine('aos-store-concurrent-');
  const count = 5;
  const moduleUrl = new URL('../engine/engine.js', import.meta.url).href;
  const script = `
    import { AosEngine } from ${JSON.stringify(moduleUrl)};
    const dataDir = process.argv[1];
    const count = Number(process.argv[2]);
    const aos = new AosEngine({ dataDir });
    aos.load();
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      const ids = [];
      for (let index = 0; index < count; index += 1) {
        ids.push(aos.createGoal({ prompt: 'child goal ' + index + '. Success is a persisted record. Scope is this concurrency test only.' }).id);
      }
      process.stdout.write(JSON.stringify(ids) + '\\n');
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, aos.store.dataDir, String(count)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('READY\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`child exited ${code ?? signal}: ${stderr}`)));
  });

  await ready;
  child.stdin.end('go\n');
  const parentGoalIds = [];
  for (let index = 0; index < count; index += 1) {
    parentGoalIds.push(aos.createGoal({ prompt: goalPrompt('parent', index) }).id);
  }
  await exited;

  const childGoalIds = JSON.parse(stdout.trim().split('\n').at(-1));
  const reloaded = new AosEngine({ dataDir: aos.store.dataDir });
  reloaded.load();
  const storedGoalIds = new Set(reloaded.state.goals.map((goal) => goal.id));
  const eventGoalIds = new Set(reloaded.store.readEventLog()
    .filter((event) => event.type === 'goal.created')
    .map((event) => event.payload.goalId));

  assert.equal(reloaded.state.goals.length, count * 2);
  for (const id of [...parentGoalIds, ...childGoalIds]) {
    assert.ok(storedGoalIds.has(id), `state is missing ${id}`);
    assert.ok(eventGoalIds.has(id), `event log is missing ${id}`);
  }
});

test('a dead-pid lock is removed and the waiting mutation proceeds', () => {
  const aos = engine('aos-store-dead-lock-');
  writeFileSync(aos.store.lockPath, '2147483647', 'utf8');

  const goal = aos.createGoal({ prompt: goalPrompt('dead-lock', 0) });

  assert.equal(aos.getGoal(goal.id).id, goal.id);
  assert.equal(existsSync(aos.store.lockPath), false);
});

test('a non-numeric lock older than two seconds is treated as stale', () => {
  const aos = engine('aos-store-old-lock-');
  writeFileSync(aos.store.lockPath, 'incomplete-owner', 'utf8');
  const old = new Date(Date.now() - 3000);
  utimesSync(aos.store.lockPath, old, old);

  const goal = aos.createGoal({ prompt: goalPrompt('old-lock', 0) });

  assert.equal(aos.getGoal(goal.id).id, goal.id);
  assert.equal(existsSync(aos.store.lockPath), false);
});

test('transact releases the lock when the mutation throws', () => {
  const aos = engine('aos-store-throw-');
  const expected = new Error('injected transaction failure');

  assert.throws(() => aos.transact(() => { throw expected; }), (error) => error === expected);
  assert.equal(existsSync(aos.store.lockPath), false);
  assert.doesNotThrow(() => aos.createGoal({ prompt: goalPrompt('after-throw', 0) }));
  assert.equal(existsSync(aos.store.lockPath), false);
});

test('transact reloads a stale store during an active drive and keeps working by id', () => {
  const aos = engine('aos-store-active-drive-');
  const diskState = JSON.parse(readFileSync(aos.store.statePath, 'utf8'));
  diskState.goals.push({ id: 'goal_external', projectId: aos.defaultProject().id });
  writeFileSync(aos.store.statePath, `${JSON.stringify(diskState)}\n`, 'utf8');
  const future = new Date(Date.now() + 3000);
  utimesSync(aos.store.statePath, future, future);
  aos.drivers.set('run_active', Promise.resolve());

  const localGoal = aos.createGoal({ prompt: goalPrompt('active-drive', 0) });

  aos.drivers.delete('run_active');
  assert.equal(aos.state.goals.some((goal) => goal.id === 'goal_external'), true, 'external write was reloaded under the lock');
  assert.equal(aos.getGoal(localGoal.id).id, localGoal.id);
  const reloaded = new AosEngine({ dataDir: aos.store.dataDir });
  reloaded.load();
  assert.deepEqual(
    reloaded.state.goals.map((goal) => goal.id).filter((id) => id === 'goal_external' || id === localGoal.id).sort(),
    ['goal_external', localGoal.id].sort(),
  );
});
