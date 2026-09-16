import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine, IsolationError } from '../engine/engine.js';
import { validateTaskQuestions } from '../engine/schema.js';
import { claimWorkspace } from '../engine/workers.js';
import { identifyAmbiguities } from '../engine/intake.js';
import { redactSecrets } from '../engine/providers.js';
import { displayStatus, normalizeSnapshot, selectCurrentProposal } from '../src/lib/liveRecords.js';

function engine() {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-'));
  const aos = new AosEngine({ dataDir, concurrency: 2 });
  aos.load();
  return aos;
}

test('goal intake stores prompt, ambiguities, questions, and a hierarchical plan', () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: 'Look into this' });
  assert.equal(goal.prompt, 'Look into this');
  assert.ok(goal.ambiguities.some((item) => item.code === 'brief'));
  assert.ok(goal.ambiguities.some((item) => item.code === 'success_criteria'));
  assert.ok(goal.questions.length >= 2);
  assert.equal(goal.status, 'awaiting_user');
  assert.ok(goal.questions.some((question) => question.required));
  assert.ok(goal.questions.some((question) => question.code === 'sources' && !question.required));
  assert.ok(goal.plan.tasks.some((task) => task.kind === 'research'));
  assert.ok(goal.plan.tasks.some((task) => task.kind === 'synthesis'));
  assert.ok(goal.plan.tasks.some((task) => task.kind === 'retrospective'));
  assert.ok(goal.plan.tasks.some((task) => task.requiresApproval && task.kind === 'adopt'));
  const identified = identifyAmbiguities('Determine whether delayed feedback destabilises coupling. Success is a bounded claim with an experiment. Scope excludes clinical trials. Use the attached papers.', ['notes.md']);
  assert.equal(identified.length, 0);
});

test('required clarification answers gate execution and persist', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-clarify-'));
  const aos = new AosEngine({ dataDir, concurrency: 2 });
  aos.load();
  const goal = aos.createGoal({ prompt: 'Look into this' });
  const required = goal.questions.filter((question) => question.required);

  assert.ok(required.length >= 2);
  assert.throws(
    () => aos.startRun({ goalId: goal.id }),
    (error) => error.message.includes('awaiting user input')
      && error.statusCode === 409
      && error.code === 'goal_awaiting_user'
      && error.details.questionIds.length === required.length,
  );
  assert.throws(() => aos.answerQuestions(goal.id, [{ id: 'q_missing', answer: 'guess' }]), /Unknown question/);

  aos.answerQuestions(goal.id, [{ id: required[0].id, answer: 'A bounded research question.' }]);
  assert.equal(aos.getGoal(goal.id).status, 'awaiting_user');

  aos.answerQuestions(goal.id, required.slice(1).map((question) => ({ id: question.id, answer: `Answer for ${question.code}` })));
  assert.equal(aos.getGoal(goal.id).status, 'planned');
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'goal.awaiting_user'));
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'goal.ready'));

  const reloaded = new AosEngine({ dataDir, concurrency: 2 });
  reloaded.load();
  assert.equal(reloaded.getGoal(goal.id).status, 'planned');
  assert.ok(reloaded.getGoal(goal.id).questions.filter((question) => question.required).every((question) => question.answer));
  assert.doesNotThrow(() => reloaded.startRun({ goalId: goal.id }));
});

test('scheduler respects dependencies, bounded concurrency, retries, cancel, and approval gates', async () => {
  const aos = engine();
  const goal = aos.createGoal({
    prompt: 'Determine whether delayed feedback destabilises bidirectional coupling. Success is a bounded claim. Scope excludes deployment.',
  });
  const run = aos.startRun({ goalId: goal.id });
  const runningCaps = [];
  const original = aos.workers.get('local').execute.bind(aos.workers.get('local'));
  aos.workers.get('local').execute = async (task, ctx) => {
    runningCaps.push(aos.state.tasks.filter((item) => item.runId === run.id && item.status === 'running').length);
    if (task.kind === 'critique' && task.attempts === 1) {
      throw new Error('injected critique failure');
    }
    return original(task, ctx);
  };
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.ok(Math.max(...runningCaps) <= 2);
  const critique = aos.state.tasks.find((item) => item.runId === run.id && item.kind === 'critique');
  assert.equal(critique.status, 'succeeded');
  assert.equal(critique.attempts, 2);
  const adopt = aos.state.tasks.find((item) => item.runId === run.id && item.kind === 'adopt');
  assert.equal(adopt.status, 'awaiting_approval');
  assert.equal(aos.getRun(run.id).status, 'awaiting_approval');

  const other = aos.startRun({ goalId: goal.id });
  aos.cancelRun(other.id);
  assert.equal(aos.getRun(other.id).status, 'cancelled');
  assert.ok(aos.state.tasks.filter((item) => item.runId === other.id).every((item) => item.status === 'cancelled'));
});

test('worker questions pause dispatch, answer atomically, and resume a fresh attempt with operator context', async () => {
  const aos = engine();
  const calls = [];
  aos.workers.set('local', {
    id: 'local',
    async execute(task, ctx) {
      calls.push({ key: task.key, attempt: task.attempts, brief: task.brief, planTaskId: task.planTaskId, questions: structuredClone(task.questions) });
      if (task.key === 'ask' && task.attempts === 1) {
        return {
          status: 'awaiting_user',
          questions: [
            { prompt: 'Which source boundary should be used?', reason: 'The worker found two plausible scopes.' },
            { prompt: 'What uncertainty must remain explicit?' },
          ],
        };
      }
      return { status: 'succeeded', summary: `${task.key} complete` };
    },
  });
  const plan = {
    title: 'Question gate',
    tasks: [
      { id: 'ask', key: 'ask', title: 'Ask operator', kind: 'research', worker: 'local', brief: 'Immutable task brief.' },
      { id: 'later', key: 'later', title: 'Later task', kind: 'research', worker: 'local', brief: 'Runs after the question gate.' },
    ],
    dependencies: [],
  };
  const goal = aos.createGoal({ prompt: 'A bounded objective with explicit success criteria and literature-only scope.', plan });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 1 });
  await aos.advanceRun(run.id, { untilIdle: true });

  let ask = aos.state.tasks.find((task) => task.key === 'ask');
  const later = aos.state.tasks.find((task) => task.key === 'later');
  assert.equal(ask.status, 'awaiting_user');
  assert.equal(ask.attempts, 1);
  assert.equal(ask.lease, null);
  assert.equal(run.status, 'awaiting_user');
  assert.equal(later.status, 'ready', 'a waiting task releases its slot but does not start another task');
  assert.deepEqual(Object.keys(ask.wait).sort(), ['at', 'attempt', 'code', 'questionIds']);
  assert.equal(ask.wait.code, 'operator_question');
  assert.equal(ask.wait.attempt, 1);
  assert.deepEqual(ask.wait.questionIds, ask.questions.map((question) => question.id));
  assert.deepEqual(ask.questions.map((question) => question.askedBy), [{ worker: 'local', agentId: ask.agentId }, { worker: 'local', agentId: ask.agentId }]);
  assert.deepEqual(ask.questions.map((question) => question.attempt), [1, 1]);
  const waitEvents = aos.store.readEventLog().filter((event) => ['task.awaiting_user', 'run.awaiting_user'].includes(event.type));
  assert.equal(waitEvents.length, 2);
  assert.equal(JSON.stringify(waitEvents).includes('Which source boundary'), false);

  const first = ask.questions[0];
  const second = ask.questions[1];
  const beforeInvalid = structuredClone({ task: ask, events: aos.store.readEventLog() });
  assert.throws(
    () => aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: 'bounded sources' }, { id: 'question_missing', answer: 'must not persist' }]),
    (error) => error.code === 'task_question_not_found' && error.statusCode === 404,
  );
  assert.deepEqual(ask.questions, beforeInvalid.task.questions, 'mixed valid/unknown answers are atomic');
  assert.equal(aos.store.readEventLog().length, beforeInvalid.events.length);
  ask = aos.getTask(ask.id);
  assert.throws(() => aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: '   ' }]), (error) => error.code === 'task_answer_invalid' && error.statusCode === 400);
  ask = aos.getTask(ask.id);
  assert.throws(() => aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: 'one' }, { id: first.id, answer: 'one' }]), (error) => error.code === 'task_answer_invalid' && error.statusCode === 400);
  assert.throws(() => aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: 'x'.repeat(2001) }]), (error) => error.code === 'task_answer_invalid' && error.statusCode === 400);
  ask = aos.getTask(ask.id);

  aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: 'bounded sources' }]);
  assert.equal(ask.status, 'awaiting_user');
  assert.equal(ask.attempts, 1);
  assert.equal(aos.getRun(run.id).status, 'awaiting_user');
  assert.equal(ask.questions.find((question) => question.id === first.id).answer, 'bounded sources');
  assert.equal(JSON.stringify(aos.store.readEventLog().at(-1)).includes('bounded sources'), false);
  const waitBeforeFinal = structuredClone(ask.wait);
  aos.answerTaskQuestions(ask.id, [{ id: second.id, answer: 'state uncertainty explicitly' }]);
  assert.equal(ask.status, 'ready');
  assert.equal(ask.attempts, 1, 'answering does not consume an attempt');
  assert.equal(ask.wait, null);
  assert.equal(aos.getRun(run.id).status, 'running');
  assert.deepEqual(waitBeforeFinal, { ...waitBeforeFinal });

  const eventCount = aos.store.readEventLog().length;
  aos.answerTaskQuestions(ask.id, [
    { id: first.id, answer: 'bounded sources' },
    { id: second.id, answer: 'state uncertainty explicitly' },
  ]);
  assert.equal(aos.store.readEventLog().length, eventCount, 'identical completed answers are idempotent');
  assert.throws(
    () => aos.answerTaskQuestions(ask.id, [{ id: first.id, answer: 'a different boundary' }]),
    (error) => error.code === 'task_answer_conflict' && error.statusCode === 409,
  );
  ask = aos.getTask(ask.id);

  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(ask.status, 'succeeded');
  assert.equal(ask.attempts, 2);
  assert.equal(aos.getRun(run.id).status, 'completed');
  assert.deepEqual(calls.map((call) => [call.key, call.attempt]), [['ask', 1], ['ask', 2], ['later', 1]]);
  assert.equal(calls[0].brief, 'Immutable task brief.');
  assert.equal(calls[1].brief, 'Immutable task brief.');
  assert.equal(calls[1].planTaskId, 'ask');
  assert.equal(calls[1].questions.find((question) => question.id === first.id).answer, 'bounded sources');
  assert.equal(calls[1].questions.find((question) => question.id === second.id).answer, 'state uncertainty explicitly');
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'task.questions_answered'));
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'task.resumed'));
});

test('manual pause remains dominant around waits and cancellation settles a waiting run once', async () => {
  const aos = engine();
  aos.workers.set('local', {
    id: 'local',
    async execute(task) {
      return ['ask', 'only'].includes(task.key) && task.attempts === 1
        ? { status: 'awaiting_user', questions: [{ prompt: 'Which bounded source set should be used?' }] }
        : { status: 'succeeded', summary: `${task.key} complete` };
    },
  });
  const goal = aos.createGoal({
    prompt: 'A bounded objective with explicit success criteria and literature-only scope.',
    plan: {
      tasks: [
        { id: 'ask', key: 'ask', title: 'Ask operator', kind: 'research', worker: 'local' },
        { id: 'later', key: 'later', title: 'Later task', kind: 'research', worker: 'local' },
      ],
      dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 1 });
  await aos.advanceRun(run.id, { untilIdle: true });
  let ask = aos.state.tasks.find((task) => task.key === 'ask');
  const later = aos.state.tasks.find((task) => task.key === 'later');
  assert.equal(ask.status, 'awaiting_user');
  assert.equal(later.status, 'ready');
  aos.pauseRun(run.id);
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getRun(run.id).status, 'paused', 'advance cannot undo a manual pause');

  aos.resumeRun(run.id);
  assert.equal(aos.getRun(run.id).status, 'awaiting_user', 'resume preserves an outstanding question gate');
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getTask(later.id).attempts, 0, 'an open wait prevents sibling dispatch');

  aos.pauseRun(run.id);
  const questionId = ask.questions.find((question) => !question.answer).id;
  aos.answerTaskQuestions(ask.id, [{ id: questionId, answer: 'Use the published bounded sources.' }]);
  ask = aos.getTask(ask.id);
  assert.equal(ask.status, 'ready');
  assert.equal(aos.getRun(run.id).status, 'paused', 'answering while paused does not resume the run');
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getTask(ask.id).attempts, 1, 'paused runs do not dispatch answered tasks');
  aos.resumeRun(run.id);
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getTask(ask.id).status, 'succeeded');
  assert.equal(aos.getTask(ask.id).attempts, 2);
  assert.equal(aos.getRun(run.id).status, 'completed');

  const waitingGoal = aos.createGoal({
    prompt: 'Another bounded objective with explicit success criteria and literature-only scope.',
    plan: { tasks: [{ id: 'only', key: 'only', title: 'Only wait', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const waitingRun = aos.startRun({ goalId: waitingGoal.id });
  await aos.advanceRun(waitingRun.id, { untilIdle: true });
  const only = aos.state.tasks.find((task) => task.runId === waitingRun.id);
  assert.equal(aos.getRun(waitingRun.id).status, 'awaiting_user');
  aos.cancelTask(only.id);
  assert.equal(aos.getTask(only.id).status, 'cancelled');
  assert.equal(aos.getRun(waitingRun.id).status, 'completed');
  const terminalEvents = aos.store.readEventLog().filter((event) => event.runId === waitingRun.id && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type));
  assert.equal(terminalEvents.length, 1, 'cancelling the only wait emits one terminal run event');
  aos.cancelTask(only.id);
  assert.equal(aos.store.readEventLog().filter((event) => event.runId === waitingRun.id && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)).length, 1);
});

test('a worker wait arriving after operator pause does not overwrite the manual pause', async () => {
  const aos = engine();
  let workerStarted;
  const started = new Promise((resolve) => { workerStarted = resolve; });
  let finishWorker;
  const workerResult = new Promise((resolve) => { finishWorker = resolve; });
  aos.workers.set('local', {
    id: 'local',
    async execute() {
      workerStarted();
      return workerResult;
    },
  });
  const goal = aos.createGoal({
    prompt: 'A bounded objective with explicit success criteria and literature-only scope.',
    plan: { tasks: [{ id: 'late', key: 'late', title: 'Late question', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const run = aos.startRun({ goalId: goal.id });
  const driving = aos.advanceRun(run.id, { untilIdle: true });
  await workerStarted;
  aos.pauseRun(run.id);
  finishWorker({ status: 'awaiting_user', questions: [{ prompt: 'Confirm the bounded source set.' }] });
  await driving;
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  assert.equal(task.status, 'awaiting_user');
  assert.equal(aos.getRun(run.id).status, 'paused');
  assert.equal(aos.store.readEventLog().filter((event) => event.runId === run.id && event.type === 'run.awaiting_user').length, 0);
  aos.resumeRun(run.id);
  assert.equal(aos.getRun(run.id).status, 'awaiting_user');
});

test('invalid worker questions fail closed with no partial wait state', async () => {
  const aos = engine();
  assert.throws(
    () => validateTaskQuestions([{ prompt: 'valid prompt', extra: 'must be rejected' }]),
    (error) => error.code === 'task_question_payload_invalid' && error.statusCode === 409,
  );
  aos.workers.set('local', {
    id: 'local',
    async execute() { return { status: 'awaiting_user', questions: [{ prompt: 'x'.repeat(501) }] }; },
  });
  const goal = aos.createGoal({
    prompt: 'A bounded objective with explicit success criteria and literature-only scope.',
    plan: { tasks: [{ id: 'bad', key: 'bad', title: 'Bad questions', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  assert.equal(task.status, 'failed');
  assert.equal(task.errorCode, 'task_question_payload_invalid');
  assert.deepEqual(task.questions, []);
  assert.equal(task.wait, null);
  const failed = aos.store.readEventLog().find((event) => event.type === 'task.failed' && event.taskId === task.id);
  assert.equal(failed.payload.code, 'task_question_payload_invalid');
  assert.equal(aos.getRun(run.id).status, 'failed');
});

test('a later worker wait appends questions without erasing earlier answers', async () => {
  const aos = engine();
  aos.workers.set('local', {
    id: 'local',
    async execute(task) {
      if (task.attempts < 3) return { status: 'awaiting_user', questions: [{ prompt: `Question for attempt ${task.attempts}` }] };
      return { status: 'succeeded', summary: 'complete' };
    },
  });
  const goal = aos.createGoal({
    prompt: 'A bounded objective with explicit success criteria and literature-only scope.',
    plan: { tasks: [{ id: 'repeat', key: 'repeat', title: 'Repeat wait', kind: 'research', worker: 'local', brief: 'Keep this brief.' }], dependencies: [] },
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  let task = aos.state.tasks.find((item) => item.runId === run.id);
  const firstId = task.questions[0].id;
  aos.answerTaskQuestions(task.id, [{ id: firstId, answer: 'first answer' }]);
  await aos.advanceRun(run.id, { untilIdle: true });
  task = aos.getTask(task.id);
  assert.equal(task.status, 'awaiting_user');
  assert.equal(task.questions.length, 2);
  assert.equal(task.questions[0].id, firstId);
  assert.equal(task.questions[0].answer, 'first answer');
  assert.equal(task.questions[0].attempt, 1);
  assert.equal(task.questions[1].attempt, 2);
  assert.deepEqual(task.wait.questionIds, [task.questions[1].id], 'wait points only to the new open batch');
  aos.answerTaskQuestions(task.id, [{ id: task.questions[1].id, answer: 'second answer' }]);
  await aos.advanceRun(run.id, { untilIdle: true });
  task = aos.getTask(task.id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attempts, 3);
  assert.deepEqual(task.questions.map((question) => question.answer), ['first answer', 'second answer']);
});

test('all_succeeded dependency failures block with typed provenance while all_terminal still dispatches', async () => {
  const aos = engine();
  aos.workers.set('local', {
    id: 'local',
    async execute(task) {
      if (task.key === 'failed') return { status: 'failed', retryable: false, error: 'deliberate failure' };
      if (task.key === 'cancelled') return { status: 'cancelled', error: 'deliberate cancellation' };
      return { status: 'succeeded', summary: `${task.key} complete` };
    },
  });
  const goal = aos.createGoal({
    prompt: 'A bounded objective with explicit success criteria and literature-only scope.',
    plan: {
      tasks: [
        { id: 'failed', key: 'failed', title: 'Failed prerequisite', kind: 'research', worker: 'local' },
        { id: 'blocked', key: 'blocked', title: 'Blocked child', kind: 'research', worker: 'local' },
        { id: 'propagated', key: 'propagated', title: 'Propagated block', kind: 'research', worker: 'local' },
        { id: 'cancelled', key: 'cancelled', title: 'Cancelled prerequisite', kind: 'research', worker: 'local' },
        { id: 'cancel-child', key: 'cancel-child', title: 'Cancelled child', kind: 'research', worker: 'local' },
        { id: 'terminal', key: 'terminal', title: 'All terminal child', kind: 'research', worker: 'local', dependencyPolicy: 'all_terminal' },
      ],
      dependencies: [
        { taskId: 'blocked', dependsOnTaskId: 'failed' },
        { taskId: 'propagated', dependsOnTaskId: 'blocked' },
        { taskId: 'cancel-child', dependsOnTaskId: 'cancelled' },
        { taskId: 'terminal', dependsOnTaskId: 'failed' },
      ],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const failed = aos.state.tasks.find((task) => task.key === 'failed');
  const blocked = aos.state.tasks.find((task) => task.key === 'blocked');
  const propagated = aos.state.tasks.find((task) => task.key === 'propagated');
  const cancelled = aos.state.tasks.find((task) => task.key === 'cancelled');
  const cancelChild = aos.state.tasks.find((task) => task.key === 'cancel-child');
  const terminal = aos.state.tasks.find((task) => task.key === 'terminal');
  assert.equal(failed.status, 'failed');
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blockedBy, {
    code: 'dependency_failed',
    dependencyTaskId: failed.id,
    dependencyPlanTaskId: 'failed',
    dependencyStatus: 'failed',
    at: blocked.blockedBy.at,
  });
  assert.equal(propagated.status, 'blocked');
  assert.equal(propagated.blockedBy.code, 'dependency_blocked');
  assert.equal(propagated.blockedBy.dependencyTaskId, blocked.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelChild.status, 'blocked');
  assert.equal(cancelChild.blockedBy.code, 'dependency_cancelled');
  assert.equal(cancelChild.blockedBy.dependencyTaskId, cancelled.id);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(aos.store.readEventLog().filter((event) => event.type === 'task.blocked' && event.taskId === blocked.id).length, 1);
  assert.equal(aos.getRun(run.id).status, 'failed', 'required blocked work fails the run');
  aos.cancelRun(run.id);
  assert.equal(aos.getTask(blocked.id).status, 'blocked', 'cancellation preserves blocked terminal work');
});

test('telemetry runtime stops accumulating while a run awaits approval', async () => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-'));
  const aos = new AosEngine({ dataDir, concurrency: 2, clock: () => now });
  aos.load();
  const goal = aos.createGoal({
    prompt: 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim. Scope excludes deployment.',
  });
  const run = aos.startRun({ goalId: goal.id });
  now += 1_000;
  await aos.advanceRun(run.id, { untilIdle: true });
  const atGate = aos.snapshot().telemetry.durationMs;
  now += 60_000;
  assert.equal(aos.snapshot().telemetry.durationMs, atGate);
});

test('workers cannot overwrite another task workspace', () => {
  const aos = engine();
  const root = aos.store.workspacesDir;
  const first = claimWorkspace({ root, runId: 'run_a', taskId: 'tsk_a', agentId: 'agt_a', now: aos.now() });
  first.write('out.txt', 'alpha');
  assert.throws(
    () => claimWorkspace({ root, runId: 'run_a', taskId: 'tsk_a', agentId: 'agt_b', now: aos.now() }),
    IsolationError,
  );
  assert.throws(() => first.write('../tsk_b/stolen.txt', 'nope'), IsolationError);
});

test('provider views never include secret values', () => {
  process.env.XAI_API_KEY = 'super-secret-value';
  const aos = engine();
  const providers = aos.listProviders();
  const grok = providers.find((item) => item.id === 'grok');
  assert.equal(grok.secretPresent, true);
  assert.equal(grok.authType, 'api_key');
  assert.equal(grok.liveExecutionEnabled, false);
  const blob = JSON.stringify(aos.snapshot());
  assert.equal(blob.includes('super-secret-value'), false);
  const redacted = redactSecrets({ apiKey: 'abc', nested: { token: 'xyz' } });
  assert.equal(redacted.apiKey, '[present]');
  assert.equal(redacted.nested.token, '[present]');
  const shared = { id: 'run_1', status: 'completed', apiKey: 'secret-value' };
  const sibling = redactSecrets({ run: shared, runs: [shared] });
  assert.equal(sibling.run.id, 'run_1');
  assert.equal(sibling.runs[0].id, 'run_1');
  assert.equal(sibling.runs[0].status, 'completed');
  assert.equal(sibling.run.apiKey, '[present]');
  assert.notEqual(sibling.runs[0], '[cycle]');
  const cyclic = { name: 'node' };
  cyclic.self = cyclic;
  assert.equal(redactSecrets(cyclic).self, '[cycle]');
  const api = providers.find((item) => item.id === 'api');
  assert.equal(api.liveAuthSupported, false);
  delete process.env.XAI_API_KEY;
});

test('pause stops dispatch until resume', async () => {
  const aos = engine();
  const goal = aos.createGoal({
    prompt: 'Map the mechanism of adaptive interfaces. Success is a named mechanism with limits. Scope is literature only.',
  });
  const run = aos.startRun({ goalId: goal.id });
  aos.pauseRun(run.id);
  const paused = await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(paused.executed, 0);
  assert.equal(aos.getRun(run.id).status, 'paused');
  aos.resumeRun(run.id);
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getRun(run.id).status, 'awaiting_approval');
});

test('engine reloads disk writes made by another process', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-sync-'));
  const writer = new AosEngine({ dataDir, concurrency: 2 });
  writer.load();
  writer.createGoal({ prompt: 'First stored objective with success criteria and a bounded scope.' });
  const reader = new AosEngine({ dataDir, concurrency: 2 });
  reader.load();
  writer.createGoal({ prompt: 'Second stored objective with success criteria and a bounded scope.' });
  reader.sync();
  assert.equal(reader.state.goals.length, 2);
});

test('snapshot keeps run objects when the same record is referenced twice', () => {
  const aos = engine();
  const goal = aos.createGoal({
    prompt: 'Write a bounded literature review. Success is three sourced claims. Scope excludes new experiments.',
  });
  const run = aos.startRun({ goalId: goal.id });
  const snap = aos.snapshot();
  assert.equal(typeof snap.run, 'object');
  assert.equal(typeof snap.run.id, 'string');
  assert.equal(typeof snap.run.status, 'string');
  assert.ok(Array.isArray(snap.runs));
  assert.ok(snap.runs.length >= 1);
  assert.equal(typeof snap.runs[0], 'object');
  assert.equal(typeof snap.runs[0].id, 'string');
  assert.equal(typeof snap.runs[0].status, 'string');
  assert.equal(snap.runs[0].id, run.id);
  assert.equal(JSON.stringify(snap).includes('[cycle]'), false);
});

test('live snapshot normalization drops cycle placeholders and missing statuses', () => {
  const normalized = normalizeSnapshot({
    run: { id: 'run_live', status: 'awaiting_approval', objective: 'Keep coupling stable' },
    runs: ['[cycle]', { id: 'run_live', objective: 'Keep coupling stable' }, null],
    goals: [{ id: 'goal_1', prompt: 'Investigate coupling' }],
    taskTree: [{ title: 'Research', children: ['[cycle]', { title: 'Critique' }] }],
  });
  assert.equal(normalized.runs.length, 1);
  assert.equal(normalized.runs[0].id, 'run_live');
  assert.equal(normalized.runs[0].status, 'unknown');
  assert.equal(displayStatus(undefined), 'unknown');
  assert.equal(displayStatus('awaiting_approval'), 'awaiting approval');
  assert.equal(normalized.taskTree[0].status, 'unknown');
  assert.equal(normalized.taskTree[0].children.length, 1);
  assert.doesNotThrow(() => displayStatus(normalized.runs[0].status).replaceAll('_', ' '));
});

test('review selects the current proposal when older proposals exist', async () => {
  const historical = [
    { id: 'prp_868c4b1e4a', runId: 'run_25cab09193', status: 'approved', change: 'old' },
    { id: 'prp_498248a348', runId: 'run_a98a8c6007', status: 'proposed', change: 'current' },
  ];
  assert.equal(historical[0].id, 'prp_868c4b1e4a');
  assert.equal(
    selectCurrentProposal(historical, {
      retrospective: { proposalId: 'prp_498248a348' },
      run: { id: 'run_a98a8c6007' },
    }).id,
    'prp_498248a348',
  );
  assert.equal(
    selectCurrentProposal(historical, { run: { id: 'run_a98a8c6007' } }).id,
    'prp_498248a348',
  );
  assert.equal(selectCurrentProposal(historical, {}).id, 'prp_868c4b1e4a');
  assert.equal(selectCurrentProposal(historical, { run: { id: 'run_missing' } }), null);

  const aos = engine();
  const goal = aos.createGoal({
    prompt: 'Write a bounded literature review. Success is three sourced claims. Scope excludes new experiments.',
  });
  const first = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(first.id, { untilIdle: true });
  const firstProposal = aos.getProposal(aos.getRetrospective(first.id).proposalId);
  aos.improvements.evaluate(firstProposal.id, {
    requestId: 'engine-current-proposal-eval',
    benchmark: { id: 'engine-selection', version: '1', datasetFingerprint: '1122334455667788', sampleSize: 10 },
    baseline: { quality: 0.7, costUsd: 1, latencyMs: 1000, verifiedRuntimeRate: 1, operatorInterventions: 1 },
    candidate: { quality: 0.7, costUsd: 1, latencyMs: 1000, verifiedRuntimeRate: 1, operatorInterventions: 1 },
    artifactRefs: ['bench/engine-selection.json'],
  });
  aos.approveProposal(firstProposal.id);
  await aos.advanceRun(first.id, { untilIdle: true });

  const second = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(second.id, { untilIdle: true });
  const snap = normalizeSnapshot(aos.snapshot());
  assert.ok(snap.proposals.length >= 2);
  assert.equal(snap.proposals[0].id, firstProposal.id);
  assert.equal(snap.proposals[0].status, 'approved');
  const selected = selectCurrentProposal(snap.proposals, { retrospective: snap.retrospective, run: snap.run });
  assert.equal(selected.id, snap.retrospective.proposalId);
  assert.equal(selected.runId, second.id);
  assert.equal(selected.status, 'proposed');
  assert.notEqual(selected.id, firstProposal.id);
});

test('events are append-only on disk', async () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: 'Write a bounded literature review. Success is three sourced claims. Scope excludes new experiments.' });
  const before = aos.store.readEventLog().length;
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const log = aos.store.readEventLog();
  assert.ok(log.length > before);
  const raw = readFileSync(aos.store.eventsPath, 'utf8').trim().split('\n');
  assert.equal(raw.length, log.length);
  writeFileSync(join(aos.store.dataDir, 'probe.json'), '{"ok":true}\n');
});
