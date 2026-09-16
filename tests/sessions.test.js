import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';
import { dispatch } from '../engine/cli.js';

function engine(options = {}) {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-sessions-')), ...options });
  aos.load();
  return aos;
}

function runScope(aos, projectId = aos.defaultProject().id) {
  const goal = aos.createGoal({
    projectId,
    prompt: 'Inspect one bounded local input. Success is one recorded result. Scope excludes network access.',
    plan: { title: 'Session scope', tasks: [{ id: 'one', title: 'Inspect input', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.getRunTree(run.id).tasks[0];
  const agent = aos.state.agents.find((item) => item.taskId === task.id);
  return { projectId, run, task, agent };
}

test('harness sessions keep provider references private and enforce exact scope', () => {
  const aos = engine();
  const scope = runScope(aos);
  assert.throws(() => aos.sessions.capture({
    provider: 'codex', harnessReference: 'unscoped-thread-1', projectId: scope.projectId,
  }), (error) => error.code === 'harness_session_scope_invalid');
  const session = aos.sessions.capture({
    provider: 'codex',
    harnessReference: '019fab12-3456-7890-abcd-0123456789ab',
    projectId: scope.projectId,
    runId: scope.run.id,
    taskId: scope.task.id,
    agentId: scope.agent.id,
    roleId: 'research',
    attempt: 1,
  });

  assert.match(session.id, /^hss_/);
  assert.equal(session.referenceStored, true);
  assert.equal(JSON.stringify(session).includes('019fab12-3456'), false);
  assert.equal(aos.sessions.resolve(session.id, {
    projectId: scope.projectId, runId: scope.run.id, taskId: scope.task.id, agentId: scope.agent.id, attempt: 1,
  }).harnessReference, '019fab12-3456-7890-abcd-0123456789ab');

  const otherProject = aos.createProject({ name: 'Other project' });
  assert.throws(() => aos.sessions.resolve(session.id, { projectId: otherProject.id }), (error) => error.code === 'harness_session_scope_denied');
  const otherScope = runScope(aos, otherProject.id);
  assert.throws(() => aos.sessions.capture({
    provider: 'codex', harnessReference: '019fab12-3456-7890-abcd-0123456789ab', projectId: otherScope.projectId,
    runId: otherScope.run.id, taskId: otherScope.task.id, agentId: otherScope.agent.id, attempt: 1,
  }), (error) => error.code === 'harness_session_scope_conflict');

  const reset = aos.sessions.reset(session.id, { reason: 'operator requested a clean context' });
  assert.equal(reset.status, 'reset');
  assert.equal(reset.referenceStored, false);
  assert.equal(aos.state.harnessSessions[0].harnessReference, null);
  assert.throws(() => aos.sessions.resolve(session.id, { projectId: scope.projectId }), (error) => error.code === 'harness_session_inactive');
  assert.throws(() => aos.sessions.capture({ provider: 'codex', harnessReference: 'sk-123456789012345678901234', projectId: scope.projectId }), (error) => error.code === 'invalid_input');
});

test('session retention removes expired provider references but preserves audit metadata', () => {
  let time = Date.parse('2026-09-16T00:00:00.000Z');
  const aos = engine({ clock: () => time });
  const scope = runScope(aos);
  const session = aos.sessions.capture({
    provider: 'codex', harnessReference: 'thread-retention-1', projectId: scope.projectId,
    runId: scope.run.id, taskId: scope.task.id, agentId: scope.agent.id, attempt: 1, retentionDays: 1,
  });
  time += 86_400_001;
  assert.deepEqual(aos.sessions.runRetention(), { expired: 1 });
  const expired = aos.sessions.get(session.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.referenceStored, false);
  assert.equal(aos.state.harnessSessions[0].harnessReference, null);
});

test('worker runtime references are bound to the task session scope', async () => {
  const aos = engine();
  aos.workers.set('local', {
    id: 'local',
    async execute() {
      return {
        status: 'succeeded',
        summary: 'Bound one provider session.',
        runtime: { attempt: 1, provider: 'local', threadId: 'local-runtime-session-1', spawned: true, verified: true },
      };
    },
  });
  const scope = runScope(aos);
  await aos.advanceRun(scope.run.id, { untilIdle: true });
  const task = aos.getTask(scope.task.id);
  assert.match(task.sessionId, /^hss_/);
  assert.equal(task.runtime[0].sessionId, task.sessionId);
  const session = aos.sessions.get(task.sessionId);
  assert.equal(session.taskId, task.id);
  assert.equal(session.agentId, scope.agent.id);
  assert.equal(JSON.stringify(aos.snapshot()).includes('local-runtime-session-1'), false, 'public state exposes the AOS session id, not the provider reference');
});

test('a worker cannot attach another task session by returning its AOS id', async () => {
  const aos = engine();
  const projectId = aos.defaultProject().id;
  const goal = aos.createGoal({
    projectId,
    prompt: 'Run two bounded local tasks. Success is two isolated results. Scope excludes network access.',
    plan: {
      title: 'Session injection guard',
      tasks: [
        { id: 'first', title: 'First task', kind: 'research', worker: 'local' },
        { id: 'second', title: 'Second task', kind: 'research', worker: 'local' },
      ],
      dependencies: [{ taskId: 'second', dependsOnTaskId: 'first' }],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  let firstSessionId = null;
  aos.workers.set('local', {
    id: 'local',
    async execute(task) {
      if (task.planTaskId === 'first') {
        return { status: 'succeeded', summary: 'First complete.', runtime: { attempt: 1, provider: 'local', threadId: 'isolated-thread-first', verified: true } };
      }
      return { status: 'succeeded', summary: 'Second complete.', runtime: { attempt: 1, provider: 'local', sessionId: firstSessionId, verified: true } };
    },
  });
  await aos.advanceRun(run.id, { steps: 1 });
  const first = aos.getRunTree(run.id).tasks.find((item) => item.planTaskId === 'first');
  firstSessionId = first.sessionId;
  await aos.advanceRun(run.id, { untilIdle: true });
  const second = aos.getRunTree(run.id).tasks.find((item) => item.planTaskId === 'second');
  assert.match(firstSessionId, /^hss_/);
  assert.equal(second.sessionId ?? null, null);
  assert.equal(second.runtime[0].sessionId, null);
  assert.equal(aos.sessions.list().length, 1);
});

test('a retry never inherits the previous attempt session', async () => {
  const aos = engine();
  let calls = 0;
  aos.workers.set('local', {
    id: 'local',
    async execute() {
      calls += 1;
      if (calls === 1) {
        return {
          status: 'failed', retryable: true, error: 'retry once',
          runtime: { attempt: 1, provider: 'local', threadId: 'retry-thread-attempt-one', verified: true },
        };
      }
      return { status: 'succeeded', summary: 'Second attempt complete.', runtime: { attempt: 2, provider: 'local', verified: true } };
    },
  });
  const scope = runScope(aos);
  await aos.advanceRun(scope.run.id, { untilIdle: true });
  const task = aos.getTask(scope.task.id);
  assert.equal(task.runtime.length, 2);
  assert.match(task.runtime[0].sessionId, /^hss_/);
  assert.equal(task.runtime[1].sessionId, null);
  assert.equal(task.sessionId, null);
  assert.equal(aos.sessions.list()[0].attempt, 1);
});

test('HTTP and CLI expose the same redacted session records and reset action', async () => {
  const aos = engine();
  const scope = runScope(aos);
  const session = aos.sessions.capture({
    provider: 'codex', harnessReference: 'thread-interface-1', projectId: scope.projectId,
    runId: scope.run.id, taskId: scope.task.id, agentId: scope.agent.id, attempt: 1,
  });
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const listed = await fetch(`${base}/sessions?projectId=${scope.projectId}`).then((response) => response.json());
    assert.equal(listed[0].id, session.id);
    assert.equal(JSON.stringify(listed).includes('thread-interface-1'), false);

    const cli = JSON.parse((await dispatch(aos, ['session', 'show', session.id])).join('\n'));
    assert.equal(cli.id, session.id);
    assert.equal(Object.hasOwn(cli, 'harnessReference'), false);

    const response = await fetch(`${base}/sessions/${session.id}/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'HTTP reset' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'reset');
  } finally {
    await close();
  }
});
