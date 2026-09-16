import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OperatorGateRequiredError,
  ResourceBudgetError,
  ResourceGovernor,
  UnknownCostError,
} from '../engine/resources.js';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AosEngine } from '../engine/engine.js';

function makeGovernor(limits = {}) {
  let now = 1_700_000_000_000;
  const state = {};
  const governor = new ResourceGovernor({ state, limits, clock: () => now, idFactory: (prefix) => `${prefix}-${++makeGovernor.sequence}` });
  return { governor, state, advance: (milliseconds) => { now += milliseconds; } };
}
makeGovernor.sequence = 0;

test('reserve sums all token classes, enforces provider/project/run capacity, and is idempotent', () => {
  const { governor, state } = makeGovernor({
    provider: { codex: { tokens: 100 } },
    project: { projectA: { tokens: 150 } },
    run: { runA: { tokens: 120, usd: 5, timeMs: 10_000 } },
  });
  const reservation = governor.reserve({
    attemptId: 'attempt-1', providerId: 'codex', projectId: 'projectA', runId: 'runA',
    inputTokens: 10, cachedTokens: 20, outputTokens: 30, reasoningTokens: 40,
    usd: 1, timeMs: 2_000,
  });
  assert.equal(reservation.reserved.tokens, 100);
  assert.deepEqual(reservation.tokenComponents, { input: 10, cached: 20, output: 30, reasoning: 40 });
  assert.equal(state.resourceReservations.length, 1);
  assert.equal(state.resourceReceipts.length, 1);
  const retry = governor.reserve({
    attemptId: 'attempt-1', providerId: 'codex', projectId: 'projectA', runId: 'runA',
    inputTokens: 10, cachedTokens: 20, outputTokens: 30, reasoningTokens: 40,
    usd: 1, timeMs: 2_000,
  });
  assert.equal(retry.idempotent, true);
  assert.equal(state.resourceReservations.length, 1);
  assert.equal(state.resourceReceipts.length, 1);
  assert.throws(() => governor.reserve({
    attemptId: 'attempt-2', providerId: 'codex', projectId: 'projectA', runId: 'runA', tokens: 1, usd: 1, timeMs: 1,
  }), (error) => error instanceof ResourceBudgetError && error.details.dimension === 'tokens');
});

test('finite USD ceilings reject unknown cost and retain the active reservation', () => {
  const { governor, state } = makeGovernor({ run: { runA: { usd: 5, timeMs: 10_000 } } });
  const reservation = governor.reserve({ attemptId: 'attempt-2', projectId: 'projectA', runId: 'runA', tokens: 2, usd: 1, timeMs: 100 });
  assert.throws(() => governor.settle(reservation.attemptId, { tokens: 2, timeMs: 100 }), (error) => error instanceof UnknownCostError
    && error.details.dimension === 'usd'
    && error.details.limit === 5
    && typeof error.details.remediation === 'string');
  assert.equal(governor.get(reservation.attemptId).status, 'active');
  assert.equal(state.resourceReceipts.length, 1);
});

test('settlement releases unused reservation, records usage once, and release/recover are terminal', () => {
  const { governor, state, advance } = makeGovernor({ run: { runA: { tokens: 100, usd: 5, timeMs: 10_000 } } });
  const reservation = governor.reserve({ attemptId: 'attempt-3', runId: 'runA', tokens: 20, usd: 2, timeMs: 4_000 });
  advance(1_000);
  const settled = governor.settle(reservation.id, { inputTokens: 1, cachedTokens: 2, outputTokens: 3, reasoningTokens: 4, usd: 1, timeMs: 900 });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.consumed.tokens, 10);
  assert.equal(settled.released.tokens, 10);
  assert.equal(state.resourceReceipts.length, 2);
  const retry = governor.settle(reservation.id, { tokens: 10, usd: 1, timeMs: 900 });
  assert.equal(retry.idempotent, true);
  assert.equal(state.resourceReceipts.length, 2);
  assert.throws(() => governor.release(reservation.id), /terminal reservation/);

  const released = governor.reserve({ attemptId: 'attempt-4', runId: 'runA', tokens: 5, usd: 1, timeMs: 100 });
  const releaseResult = governor.release(released.attemptId, { reason: 'operator cancelled' });
  assert.equal(releaseResult.status, 'released');
  assert.equal(governor.release(released.attemptId).idempotent, true);

  const recoverable = governor.reserve({ attemptId: 'attempt-5', runId: 'runA', tokens: 5, usd: 1, timeMs: 100, ttlMs: 100 });
  advance(200);
  const recovered = governor.recover({ attemptId: recoverable.attemptId });
  assert.equal(recovered.status, 'recovered');
  assert.equal(state.resourceReceipts.length, 6);
  assert.equal(governor.recover({ attemptId: recoverable.attemptId }).idempotent, true);
});

test('operator gate is typed and carries remediation details', () => {
  const { governor } = makeGovernor({ run: { runA: { tokens: { limit: 1, gate: true } } } });
  governor.reserve({ attemptId: 'gate-1', runId: 'runA', tokens: 1 });
  assert.throws(() => governor.reserve({ attemptId: 'gate-2', runId: 'runA', tokens: 1 }), (error) => error instanceof OperatorGateRequiredError
    && error.code === 'operator_gate_required'
    && error.details.limit === 1
    && error.details.consumed === 0
    && error.details.reserved === 1
    && typeof error.details.remediation === 'string');
});

test('engine reserves before workspace claim, gates a finite ceiling, and resumes after an operator raises it', async () => {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-resources-engine-')) });
  aos.load();
  const projectId = aos.defaultProject().id;
  aos.settings.set('budget.tokens', 1, { scope: 'project', scopeId: projectId });
  const goal = aos.createGoal({ projectId, prompt: 'Use a bounded local task.', plan: {
    title: 'resource gate', tasks: [{ id: 'limited', title: 'Limited', kind: 'research', worker: 'local', budget: { tokens: 2, timeMs: 1000 } }], dependencies: [],
  } });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = aos.getRunTree(run.id).tasks[0];
  assert.equal(task.status, 'awaiting_user');
  assert.equal(task.wait.code, 'budget_exceeded');
  assert.equal(existsSync(join(aos.store.workspacesDir, run.id, task.id)), false);
  assert.equal(aos.state.resourceReservations.length, 0);
  aos.settings.set('budget.tokens', 3, { scope: 'project', scopeId: projectId });
  aos.answerTaskQuestions(task.id, [{ id: task.questions.at(-1).id, answer: 'raised token ceiling to three' }]);
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getTask(task.id).status, 'succeeded');
  assert.equal(aos.state.resourceReservations.length, 1);
  assert.equal(aos.state.resourceReservations[0].status, 'settled');
  assert.equal(aos.state.resourceReceipts.length, 2);
});

test('settlement records an attested overage terminally instead of leaving an active reservation', () => {
  const { governor } = makeGovernor({ run: { runA: { tokens: 10, usd: 5, timeMs: 100 } } });
  const reservation = governor.reserve({ attemptId: 'overage', runId: 'runA', tokens: 5, usd: 1, timeMs: 50 });
  const settled = governor.settle(reservation.id, { inputTokens: 8, outputTokens: 4, usd: 1, timeMs: 60 });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.consumed.tokens, 12);
});

test('verified runtime usage is settled exactly and a workspace claim failure does not leak an active reservation', async () => {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-resources-settle-')) });
  aos.load();
  const projectId = aos.defaultProject().id;
  aos.workers.set('local', { id: 'local', execute: async () => ({ status: 'succeeded', summary: 'ok', runtime: { verified: true, usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 4 }, durationMs: 7 } }) });
  const goal = aos.createGoal({ projectId, prompt: 'Measure usage.', plan: { title: 'usage', tasks: [{ id: 'one', title: 'One', kind: 'research', worker: 'local', budget: { tokens: 100, usd: 2, timeMs: 100 } }], dependencies: [] } });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.state.resourceReservations[0].consumed.tokens, 10);
  assert.equal(aos.state.resourceReservations[0].consumed.timeMs, 7);
  assert.equal(aos.state.resourceReservations[0].consumed.usd, 2);

  const secondGoal = aos.createGoal({ projectId, prompt: 'Fail workspace.', plan: { title: 'workspace', tasks: [{ id: 'two', title: 'Two', kind: 'research', worker: 'local', budget: { tokens: 1, usd: 1, timeMs: 10 } }], dependencies: [] } });
  const secondRun = aos.startRun({ goalId: secondGoal.id });
  const task = aos.getRunTree(secondRun.id).tasks[0];
  const dir = join(aos.store.workspacesDir, secondRun.id, task.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'OWNER'), JSON.stringify({ agentId: 'other', taskId: 'other', runId: 'other' }));
  await aos.advanceRun(secondRun.id, { untilIdle: true });
  const reservation = aos.state.resourceReservations.at(-1);
  assert.equal(aos.getTask(task.id).status, 'failed');
  assert.equal(reservation.status, 'settled');
});
