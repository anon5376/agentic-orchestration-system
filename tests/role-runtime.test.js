import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { CODEX_AUTH_PATH } from '../engine/codex.js';
import { MANAGER_ROLE_TASK_LIMIT } from '../engine/role-runtime.js';

const PROMPT = 'Assess one bounded research question with explicit success criteria and no deployment work.';

function engine(options = {}) {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-role-runtime-')), concurrency: 1, ...options });
  aos.load();
  return aos;
}

function task(id, presetId, worker = 'local') {
  return {
    id,
    key: id,
    title: `Task ${id}`,
    kind: 'research',
    worker,
    presetId,
    brief: 'Keep this task bounded and read-only.',
  };
}

function goal(aos, tasks) {
  return aos.createGoal({
    prompt: PROMPT,
    plan: { title: 'Role runtime plan', tasks, dependencies: [] },
  });
}

test('Codex tasks bind resolved manager and worker roles to exact runtime profiles', () => {
  const aos = engine();
  const template = aos.templates.create({
    id: 'template-only-manager',
    name: 'Template-only manager',
    description: 'A manager template that leaves model choice to the role policy.',
    config: {
      preset: { id: 'branch-manager' },
      harness: { id: 'codex' },
    },
  });
  const configuredGoal = goal(aos, [
    {
      id: 'manager',
      key: 'manager',
      title: 'Template manager',
      kind: 'research',
      templateId: template.id,
      templateVersion: template.version,
      brief: 'Coordinate a bounded evidence branch.',
    },
    task('worker', 'general-worker', 'codex'),
  ]);

  const run = aos.startRun({ goalId: configuredGoal.id, maxConcurrency: 1 });
  const manager = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'manager');
  const worker = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'worker');

  assert.deepEqual(manager.roleRuntime, {
    version: 1,
    role: 'branch-manager',
    class: 'manager',
    presetId: 'branch-manager',
    presetVersion: 1,
    requested: { model: 'gpt-5.6-terra', effort: 'max' },
  });
  assert.equal(manager.model, 'gpt-5.6-terra');
  assert.equal(manager.effort, 'max');
  assert.equal(worker.roleRuntime.class, 'worker');
  assert.deepEqual(worker.roleRuntime.requested, { model: 'gpt-5.6-luna', effort: 'max' });
  assert.equal(worker.model, 'gpt-5.6-luna');
  assert.equal(aos.state.agents.find((item) => item.id === manager.agentId).role, 'branch-manager');
  assert.deepEqual(run.roleRuntimePolicy.profiles, {
    manager: { model: 'gpt-5.6-terra', effort: 'max' },
    worker: { model: 'gpt-5.6-luna', effort: 'max' },
  });
  assert.equal(run.roleRuntimePolicy.logicalWorkerFanout, 'unbounded_by_role_policy');
});

test('manager-role count is capped per run while worker cardinality remains logically unbounded', () => {
  const aos = engine();
  const overLimitGoal = goal(aos, Array.from({ length: MANAGER_ROLE_TASK_LIMIT + 1 }, (_, index) => task(`manager-${index + 1}`, 'branch-manager')));
  assert.throws(
    () => aos.startRun({ goalId: overLimitGoal.id }),
    (error) => error.code === 'manager_role_limit' && error.statusCode === 409 && error.details.limit === MANAGER_ROLE_TASK_LIMIT,
  );
  assert.equal(aos.state.runs.length, 0, 'the rejected manager plan never creates a run');

  const workerGoal = goal(aos, Array.from({ length: MANAGER_ROLE_TASK_LIMIT + 1 }, (_, index) => task(`worker-${index + 1}`, 'general-worker', 'codex')));
  const workerRun = aos.startRun({ goalId: workerGoal.id, maxConcurrency: 1 });
  assert.equal(workerRun.maxConcurrency, 1, 'logical fan-out does not claim simultaneous physical execution');
  assert.equal(aos.state.tasks.filter((item) => item.runId === workerRun.id).length, MANAGER_ROLE_TASK_LIMIT + 1);
});

test('append-only plan patches cannot exceed the existing run manager-role limit', () => {
  const aos = engine();
  const configuredGoal = goal(aos, Array.from({ length: MANAGER_ROLE_TASK_LIMIT - 1 }, (_, index) => task(`manager-${index + 1}`, 'branch-manager')));
  const run = aos.startRun({ goalId: configuredGoal.id });
  const accepted = aos.plans.patch(run.id, {
    id: 'manager-seven',
    baseVersion: 1,
    reason: 'Add the last permitted manager branch.',
    additions: { tasks: [task('manager-7', 'branch-manager')], dependencies: [] },
  });
  assert.equal(accepted.plan.version, 2);
  const before = aos.state.tasks.filter((item) => item.runId === run.id).length;

  assert.throws(
    () => aos.plans.patch(run.id, {
      id: 'manager-eight',
      baseVersion: 2,
      reason: 'This must be rejected.',
      additions: { tasks: [task('manager-8', 'branch-manager')], dependencies: [] },
    }),
    (error) => error.code === 'manager_role_limit' && error.statusCode === 409 && error.details.existing === MANAGER_ROLE_TASK_LIMIT,
  );
  assert.equal(aos.state.tasks.filter((item) => item.runId === run.id).length, before, 'the rejected patch is atomic');
  assert.equal(aos.getRun(run.id).plan.version, 2);
});

test('delegation rejects an eighth manager role without materializing a child', async () => {
  const aos = engine();
  aos.templates.create({
    id: 'manager-child',
    name: 'Manager child',
    description: 'A manager branch selected only through a bounded delegation proposal.',
    config: { preset: { id: 'branch-manager' }, harness: { id: 'local' } },
  });
  const parent = aos.templates.create({
    id: 'delegating-manager',
    name: 'Delegating manager',
    description: 'A manager that may propose one manager child.',
    config: {
      preset: { id: 'branch-manager' },
      harness: { id: 'local' },
      delegation: { mayDelegate: true, maxChildren: 1, maxDepth: 1, childTemplates: ['manager-child'] },
    },
  });
  const configuredGoal = goal(aos, [
    {
      id: 'parent',
      key: 'parent',
      title: 'Delegating manager',
      kind: 'research',
      templateId: parent.id,
      templateVersion: parent.version,
      brief: 'Propose exactly one bounded manager child.',
    },
    ...Array.from({ length: MANAGER_ROLE_TASK_LIMIT - 1 }, (_, index) => task(`manager-${index + 1}`, 'branch-manager')),
  ]);
  const run = aos.startRun({ goalId: configuredGoal.id, maxConcurrency: 1 });
  aos.workers.get('local').execute = async (runtimeTask) => {
    if (runtimeTask.planTaskId !== 'parent') return { status: 'succeeded', summary: 'manager complete' };
    return {
      status: 'succeeded',
      summary: 'delegating manager complete',
      result: {
        delegation: {
          tasks: [{
            id: 'manager-child-8',
            key: 'manager-child-8',
            title: 'Eighth manager',
            kind: 'research',
            brief: 'A bounded manager child that must be refused at the run limit.',
            templateId: 'manager-child',
            templateVersion: 1,
          }],
          dependencies: [],
        },
      },
    };
  };

  await aos.advanceRun(run.id, { untilIdle: true });
  const receipt = aos.listDelegationExpansions(run.id)[0];
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.errorCode, 'manager_role_limit');
  assert.equal(aos.getRun(run.id).plan.version, 1);
  assert.equal(aos.state.tasks.some((item) => item.runId === run.id && item.planTaskId === 'manager-child-8'), false);
});

test('a manager retry keeps one role slot and preserves its task-bound fault receipt', async () => {
  const aos = engine({
    execution: {
      mode: 'mixed',
      codex: { model: 'gpt-5.6-luna', effort: 'max', repoRoot: process.cwd() },
    },
  });
  aos.workers.set('codex', {
    id: 'codex',
    async preflight(config = {}) {
      return {
        checkedAt: new Date().toISOString(),
        login: 'Logged in using ChatGPT',
        authPath: CODEX_AUTH_PATH,
        model: { slug: config.model, efforts: [config.effort], upgrade: null },
        requested: { model: config.model, effort: config.effort },
      };
    },
    async execute() {
      return { status: 'succeeded', summary: 'retry completed' };
    },
  });
  const configuredGoal = goal(aos, [{
    ...task('manager-retry', 'branch-manager', 'codex'),
    injectFault: { attempt: 1, holdMs: 0, error: 'retry once' },
  }]);
  const run = aos.startRun({ goalId: configuredGoal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const manager = aos.state.tasks.find((item) => item.runId === run.id && item.planTaskId === 'manager-retry');
  const firstRuntime = JSON.parse(readFileSync(join(aos.store.workspacePath(run.id, manager.id), 'attempt-1', 'runtime.json'), 'utf8'));

  assert.equal(manager.status, 'succeeded');
  assert.equal(manager.attempts, 2);
  assert.equal(aos.state.tasks.filter((item) => item.runId === run.id && item.roleRuntime?.class === 'manager').length, 1);
  assert.deepEqual(firstRuntime.requested, { model: 'gpt-5.6-terra', effort: 'max', sandbox: 'read-only' });
  assert.equal(firstRuntime.profile.model, 'gpt-5.6-terra');
  assert.equal(firstRuntime.profile.effort, 'max');
});
