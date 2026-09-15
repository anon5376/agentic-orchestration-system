import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine, IsolationError } from '../engine/engine.js';
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
