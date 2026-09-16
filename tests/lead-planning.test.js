import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { CODEX_AUTH_PATH } from '../engine/codex.js';
import { LEAD_PLAN_STATUS } from '../engine/lead-planning.js';

const PROMPT = 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim with explicit uncertainty. Scope excludes clinical deployment.';

function runtime(overrides = {}) {
  return {
    provider: 'codex',
    authPath: CODEX_AUTH_PATH,
    verified: true,
    threadId: 'thread-lead-test',
    requested: { model: 'gpt-5.6-terra', effort: 'max', sandbox: 'read-only' },
    effective: { model: 'gpt-5.6-terra', effort: 'max', sandbox: 'read-only', modelProvider: 'openai' },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.010Z',
    durationMs: 10,
    usage: { input_tokens: 10, output_tokens: 5 },
    spawned: true,
    injected: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function planOutput(task, overrides = {}) {
  return {
    task_nonce: task.nonce,
    status: 'succeeded',
    questions: [],
    plan: {
      title: 'Lead bounded plan',
      tasks: [{
        id: 'research',
        key: 'research',
        title: 'Read bounded sources',
        kind: 'research',
        worker: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        sandbox: 'read-only',
        brief: 'Read only the supplied sources.',
        budget: { tokens: 100, usd: 1, timeMs: 1000 },
      }],
      dependencies: [],
    },
    rationale: 'The graph is bounded and reviewable.',
    summary: 'A single bounded research task.',
    ...overrides,
  };
}

function planner(outputs = [], { preflight = null, missingPreflight = false, wait = null } = {}) {
  let index = 0;
  const calls = [];
  const worker = {
    id: 'codex',
    calls,
    async preflight(config = {}) {
      if (missingPreflight) return null;
      const model = config.model || 'gpt-5.6-terra';
      const effort = config.effort || 'max';
      return preflight || {
        checkedAt: '2026-01-01T00:00:00.000Z',
        login: 'Logged in using ChatGPT',
        authPath: CODEX_AUTH_PATH,
        cliVersion: 'codex-cli test',
        model: { slug: model, efforts: ['max'], upgrade: null },
        requested: { model, effort },
        strippedEnv: ['OPENAI_API_KEY'],
        disabledFeatures: ['multi_agent'],
      };
    },
    async execute(task, ctx) {
      calls.push({ task, ctx });
      if (ctx.outputKind !== 'lead') return { status: 'succeeded', summary: 'worker complete' };
      if (wait) await wait();
      const selected = typeof outputs === 'function' ? outputs(index, task, ctx) : outputs[index] || outputs.at(-1) || {};
      index += 1;
      const output = selected.output || Object.fromEntries(Object.entries(selected).filter(([key]) => !['runtime', 'rawResult', 'resultStatus'].includes(key)));
      const result = selected.rawResult || planOutput(task, output);
      return {
        status: selected.resultStatus || output.status || 'succeeded',
        runtime: selected.runtime === undefined ? runtime({ threadId: `thread-lead-${index}` }) : selected.runtime,
        result,
      };
    },
  };
  return worker;
}

function engineWithPlanner(dataDir, leadPlanner) {
  const engine = new AosEngine({
    dataDir,
    execution: { mode: 'codex', codex: { repoRoot: dataDir } },
    leadPlanner,
  });
  engine.load();
  // The injected planner also acts as the task adapter for the run-start test.
  engine.workers.set('codex', leadPlanner);
  return engine;
}

function shell(engine) {
  return engine.createLeadGoalShell({ prompt: PROMPT, contextPaths: ['docs/sources.md'] });
}

test('lead creation makes a genuine planning shell and accepted provenance is required to run', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-shell-'));
  const lead = planner([{}]);
  const engine = engineWithPlanner(dataDir, lead);
  const shellGoal = shell(engine);
  assert.equal(shellGoal.status, 'planning');
  assert.equal(shellGoal.plan, null);
  assert.equal(shellGoal.planningMode, 'lead');
  assert.equal(shellGoal.questions.length, 0);

  const generated = await engine.planGoal({ goalId: shellGoal.id, requestId: 'shell-1' });
  assert.equal(generated.proposal.status, LEAD_PLAN_STATUS.proposed);
  assert.equal(engine.getGoal(shellGoal.id).plan, null);
  assert.throws(() => engine.startRun({ goalId: shellGoal.id }), (error) => error.code === 'goal_not_planned' && error.statusCode === 409);

  const accepted = engine.acceptLeadPlan(generated.proposal.id);
  assert.equal(accepted.goal.status, 'planned');
  assert.equal(accepted.goal.planProvenance.proposalId, generated.proposal.id);
  const run = engine.startRun({ goalId: shellGoal.id });
  const finished = await engine.advanceRun(run.id, { untilIdle: true });
  assert.equal(finished.run.status, 'completed');

  const tampered = engine.getGoal(shellGoal.id);
  tampered.plan.tasks[0].title = 'tampered';
  engine.state.goals.find((goal) => goal.id === shellGoal.id).plan = tampered.plan;
  assert.throws(() => engine.startRun({ goalId: shellGoal.id }), (error) => error.code === 'goal_not_planned');
});

test('rejecting a lead proposal leaves the shell non-runnable with no fallback plan', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-reject-'));
  const engine = engineWithPlanner(dataDir, planner([{}]));
  const result = await engine.createLeadGoalProposal({ prompt: PROMPT, contextPaths: [], requestId: 'reject-1' });
  const rejected = engine.rejectLeadPlan(result.proposal.id, { reason: 'Needs a different scope' });
  assert.equal(rejected.proposal.status, LEAD_PLAN_STATUS.rejected);
  assert.equal(rejected.goal.status, 'planning');
  assert.equal(rejected.goal.plan, null);
  assert.throws(() => engine.startRun({ goalId: rejected.goal.id }), (error) => error.code === 'goal_not_planned' && error.statusCode === 409);
});

test('lead creation reserves request identity before shell creation and is idempotent across engines', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-create-request-'));
  const engineA = engineWithPlanner(dataDir, planner([{}]));
  const input = { prompt: PROMPT, contextPaths: ['docs/sources.md'], requestId: 'create-request-1' };
  const first = await engineA.createLeadGoalProposal(input);
  const repeated = await engineA.createLeadGoalProposal(input);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.goal.id, first.goal.id);
  assert.equal(repeated.proposal.id, first.proposal.id);
  assert.equal(engineA.state.goals.filter((goal) => goal.planningMode === 'lead').length, 1);
  assert.equal(engineA.state.leadPlans.length, 1);
  assert.equal(engineA.state.leadPlanCreationRequests.length, 1);
  assert.equal(engineA.state.leadPlanCreationRequests[0].goalId, first.goal.id);
  assert.equal(engineA.state.leadPlanCreationRequests[0].proposalId, first.proposal.id);
  assert.equal(Object.hasOwn(first.proposal, 'input'), true);
  assert.equal(Object.hasOwn(first.proposal, 'prompt'), false);
  assert.equal(first.proposal.input.contextCount, 1);
  assert.equal(first.proposal.input.contextIds.length, 1);
  assert.equal(Object.hasOwn(first.proposal.input, 'prompt'), false);
  assert.equal(Object.hasOwn(first.proposal.input, 'contextPaths'), false);
  assert.equal(Object.hasOwn(first.proposal.input, 'questions'), false);
  assert.equal(JSON.stringify(first.proposal).includes(PROMPT), false);
  assert.equal(JSON.stringify(first.proposal).includes('docs/sources.md'), false);

  await assert.rejects(
    engineA.createLeadGoalProposal({ prompt: 'A different objective', contextPaths: input.contextPaths, requestId: input.requestId }),
    (error) => error.code === 'lead_plan_creation_mismatch' && error.statusCode === 409,
  );
  assert.equal(engineA.state.goals.filter((goal) => goal.planningMode === 'lead').length, 1);

  const engineB = engineWithPlanner(dataDir, planner([]));
  const concurrent = await engineB.createLeadGoalProposal(input);
  assert.equal(concurrent.idempotent, true);
  assert.equal(concurrent.goal.id, first.goal.id);
  assert.equal(concurrent.proposal.id, first.proposal.id);

  engineA.acceptLeadPlan(first.proposal.id);
  await assert.rejects(
    engineA.planGoal({ goalId: first.goal.id, requestId: 'create-request-fresh' }),
    (error) => error.code === 'lead_plan_already_accepted' && error.statusCode === 409,
  );
});

test('clarification answers only reach lead_revision_ready; a derived request creates a new immutable proposal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-revision-'));
  const lead = planner([
    { output: { status: 'needs_clarification', questions: [{ prompt: 'Which source boundary should constrain the plan?', reason: 'Two supplied scopes are plausible.' }], plan: null } },
    {},
  ]);
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  const first = await engine.planGoal({ goalId: goal.id, requestId: 'revision-1' });
  const firstBefore = structuredClone(first.proposal);
  assert.equal(first.proposal.status, LEAD_PLAN_STATUS.needs_clarification);
  assert.deepEqual(engine.getGoal(goal.id).questions.map(({ answer, ...question }) => question), first.proposal.questions);

  const answered = engine.answerQuestions(goal.id, [{ id: first.proposal.questions[0].id, answer: 'Published interface studies only.' }]);
  assert.equal(answered.status, 'lead_revision_ready');
  assert.equal(lead.calls.filter((call) => call.ctx.outputKind === 'lead').length, 1, 'answering the shell does not call the model');
  assert.deepEqual(engine.getLeadPlan(first.proposal.id), firstBefore, 'the clarification proposal remains immutable');

  const revised = await engine.planGoal({ goalId: goal.id, requestId: 'revision-2', derivedFromProposalId: first.proposal.id });
  assert.equal(revised.proposal.status, LEAD_PLAN_STATUS.proposed);
  assert.equal(revised.proposal.derivedFromProposalId, first.proposal.id);
  assert.equal(engine.state.leadPlans.length, 2);
  assert.equal(lead.calls.length, 2);
  assert.match(lead.calls[1].ctx.planningPrompt, /Published interface studies only/);
  assert.deepEqual(revised.proposal.input.questionIds, [first.proposal.questions[0].id]);
  assert.deepEqual(revised.proposal.input.answeredQuestionIds, [first.proposal.questions[0].id]);
  assert.equal(revised.proposal.input.answeredCount, 1);
});

test('lead answers require the active clarification proposal and reject malformed or stale submissions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-answer-guard-'));
  const lead = planner([
    { output: { status: 'needs_clarification', questions: [{ prompt: 'Which boundary?', reason: 'Scope is ambiguous.' }], plan: null } },
    {},
  ]);
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  const first = await engine.planGoal({ goalId: goal.id, requestId: 'answer-guard-1' });
  const questionId = first.proposal.questions[0].id;
  assert.throws(() => engine.answerLeadPlanQuestions(first.proposal.id, []), (error) => error.code === 'lead_plan_answers_invalid' && error.statusCode === 400);
  assert.throws(() => engine.answerLeadPlanQuestions(first.proposal.id, [{ id: 'missing', answer: 'x' }]), (error) => error.code === 'lead_plan_question_not_found' && error.statusCode === 404);
  assert.throws(() => engine.answerLeadPlanQuestions(first.proposal.id, [{ id: questionId, answer: 'x', extra: true }]), (error) => error.code === 'lead_plan_answers_invalid' && error.statusCode === 400);
  const answered = engine.answerLeadPlanQuestions(first.proposal.id, [{ id: questionId, answer: 'Published only.' }]);
  assert.equal(answered.status, 'lead_revision_ready');
  const second = await engine.planGoal({ goalId: goal.id, requestId: 'answer-guard-2', derivedFromProposalId: first.proposal.id });
  assert.throws(() => engine.answerLeadPlanQuestions(first.proposal.id, [{ id: questionId, answer: 'Published only.' }]), (error) => error.code === 'lead_plan_not_active' && error.statusCode === 409);
  assert.throws(() => engine.answerLeadPlanQuestions(second.proposal.id, [{ id: 'stale', answer: 'x' }]), (error) => error.code === 'lead_plan_questions_unavailable' && error.statusCode === 409);
  assert.throws(() => engine.answerQuestions(goal.id, [{ id: questionId, answer: 'Published only.' }]), (error) => error.code === 'lead_plan_questions_unavailable' && error.statusCode === 409);
});

test('request ids are idempotent, mismatches and active requests are rejected', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-request-'));
  const engine = engineWithPlanner(dataDir, planner([{}]));
  const goal = shell(engine);
  const first = await engine.planGoal({ goalId: goal.id, requestId: 'request-1' });
  const repeat = await engine.planGoal({ goalId: goal.id, requestId: 'request-1' });
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.proposal.id, first.proposal.id);
  await assert.rejects(engine.planGoal({ goalId: goal.id, requestId: 'request-1', derivedFromProposalId: first.proposal.id }), (error) => error.code === 'lead_plan_request_mismatch' && error.statusCode === 409);
  await assert.rejects(engine.planGoal({ goalId: goal.id, requestId: 'request-2' }), (error) => error.code === 'lead_plan_request_active' && error.statusCode === 409);

  let release;
  const activeLead = planner([], { wait: () => new Promise((resolve) => { release = resolve; }) });
  const activeDir = mkdtempSync(join(tmpdir(), 'aos-lead-active-'));
  const activeEngine = engineWithPlanner(activeDir, activeLead);
  const activeGoal = shell(activeEngine);
  const pending = activeEngine.planGoal({ goalId: activeGoal.id, requestId: 'active-1' });
  for (let index = 0; index < 200 && (!activeEngine.state.leadPlans.length || !release); index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function');
  const samePending = await activeEngine.planGoal({ goalId: activeGoal.id, requestId: 'active-1' });
  assert.equal(samePending.idempotent, true);
  await assert.rejects(activeEngine.planGoal({ goalId: activeGoal.id, requestId: 'active-2' }), (error) => error.code === 'lead_plan_request_active');
  release({});
  await pending;
});

test('accept/reject is compare-and-set: exactly one decision wins across stale engines', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-cas-'));
  const engineA = engineWithPlanner(dataDir, planner([{}]));
  const goal = shell(engineA);
  const proposal = await engineA.planGoal({ goalId: goal.id, requestId: 'cas-1' });
  const engineB = engineWithPlanner(dataDir, planner([]));
  const [accepted, rejected] = await Promise.allSettled([
    Promise.resolve().then(() => engineA.acceptLeadPlan(proposal.proposal.id)),
    Promise.resolve().then(() => engineB.rejectLeadPlan(proposal.proposal.id)),
  ]);
  assert.equal([accepted, rejected].filter((result) => result.status === 'fulfilled').length, 1);
  const loser = [accepted, rejected].find((result) => result.status === 'rejected');
  assert.equal(loser.reason.code, 'lead_plan_decision_conflict');
  const reloaded = engineWithPlanner(dataDir, planner([]));
  assert.equal(reloaded.getLeadPlan(proposal.proposal.id).status, LEAD_PLAN_STATUS.accepted);
});

test('missing preflight, login, and runtime attestation fail closed and retain only a redacted receipt', async () => {
  const cases = [
    { name: 'preflight', options: { missingPreflight: true }, code: 'lead_planner_preflight_invalid' },
    { name: 'login', options: { preflight: { login: 'Logged in using API key', model: { slug: 'gpt-5.6-terra' }, requested: { model: 'gpt-5.6-terra', effort: 'max' } } }, code: 'lead_planner_auth_invalid' },
    { name: 'runtime', options: {}, output: { runtime: null }, code: 'lead_planner_unverified' },
  ];
  for (const item of cases) {
    const dataDir = mkdtempSync(join(tmpdir(), `aos-lead-${item.name}-`));
    const lead = planner(item.output ? [item.output] : [{}], item.options);
    const engine = engineWithPlanner(dataDir, lead);
    const goal = shell(engine);
    await assert.rejects(engine.planGoal({ goalId: goal.id, requestId: `${item.name}-1` }), (error) => error.code === item.code);
    assert.equal(engine.getLeadPlan(engine.state.leadPlans[0].id).status, LEAD_PLAN_STATUS.failed);
    assert.equal(engine.listProviders().find((provider) => provider.id === 'codex').readiness.status, item.name === 'runtime' ? 'available' : 'unavailable');
    assert.throws(() => engine.startRun({ goalId: goal.id }), (error) => error.code === 'goal_not_planned');
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-receipt-'));
  const lead = planner([{ runtime: runtime({ command: ['secret'], cwd: '/secret', stdout: 'secret', stderr: 'secret', usage: { input_tokens: 4, note: 'Bearer sk-12345678901234567890' } }) }]);
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  const result = await engine.planGoal({ goalId: goal.id, requestId: 'receipt-1' });
  assert.equal(result.proposal.runtime.provider, 'codex');
  assert.equal(result.proposal.runtime.authPath, CODEX_AUTH_PATH);
  assert.equal(result.proposal.runtime.threadId, 'thread-lead-test');
  assert.equal(result.proposal.runtime.usage.input_tokens, 4);
  assert.match(result.proposal.runtime.usage.note, /\[redacted/);
  for (const key of ['command', 'cwd', 'transcript', 'stdout', 'stderr']) assert.equal(Object.hasOwn(result.proposal.runtime, key), false);
  assert.equal(Object.hasOwn(result.proposal, 'error'), false);
});

test('verified lead execution may persist explicit usage-unavailable evidence', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-usage-unavailable-'));
  const lead = planner([{ runtime: runtime({ usage: null, usageUnavailable: true }) }]);
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  const result = await engine.planGoal({ goalId: goal.id, requestId: 'usage-unavailable-1' });
  assert.equal(result.proposal.runtime.usage, null);
  assert.equal(result.proposal.runtime.usageUnavailable, true);

  const missingDataDir = mkdtempSync(join(tmpdir(), 'aos-lead-usage-missing-'));
  const missing = engineWithPlanner(missingDataDir, planner([{ runtime: runtime({ usage: null }) }]));
  const missingGoal = shell(missing);
  await assert.rejects(missing.planGoal({ goalId: missingGoal.id, requestId: 'usage-missing-1' }), (error) => error.code === 'lead_planner_unverified');
});

test('lead plan schema rejects forbidden capabilities, unknown budget keys, and hierarchy depth over four', async () => {
  const cases = [
    { name: 'capabilities', task: { capabilities: [] }, code: 'lead_plan_invalid' },
    { name: 'budget', task: { budget: { tokens: 1, dollars: 2 } }, code: 'lead_plan_invalid' },
    { name: 'adopt-gate', task: { id: 'adopt', key: 'adopt', title: 'Adopt', kind: 'adopt', worker: 'engine', requiresApproval: false }, code: 'lead_plan_policy' },
    { name: 'depth', task: { id: 'fifth', key: 'fifth', parentId: 'fourth', title: 'Fifth', kind: 'research', worker: 'codex' }, code: 'lead_plan_depth' },
  ];
  for (const item of cases) {
    const dataDir = mkdtempSync(join(tmpdir(), `aos-lead-schema-${item.name}-`));
    const lead = planner([{}]);
    const engine = engineWithPlanner(dataDir, lead);
    const goal = shell(engine);
    const base = planOutput({ nonce: 'placeholder' }).plan;
    if (item.name === 'depth') {
      base.tasks = [
        { id: 'root', key: 'root', title: 'Root', kind: 'research', worker: 'codex' },
        { id: 'second', key: 'second', parentId: 'root', title: 'Second', kind: 'research', worker: 'codex' },
        { id: 'third', key: 'third', parentId: 'second', title: 'Third', kind: 'research', worker: 'codex' },
        { id: 'fourth', key: 'fourth', parentId: 'third', title: 'Fourth', kind: 'research', worker: 'codex' },
        item.task,
      ];
    } else Object.assign(base.tasks[0], item.task);
    lead.execute = async (task, ctx) => ({ status: 'succeeded', runtime: runtime(), result: planOutput(task, { plan: base }) });
    await assert.rejects(engine.planGoal({ goalId: goal.id, requestId: `${item.name}-1` }), (error) => error.code === item.code);
    assert.equal(engine.state.leadPlans[0].status, LEAD_PLAN_STATUS.failed);
    assert.equal(engine.getGoal(goal.id).plan, null);
  }
});

test('non-succeeded lead output must carry a literal null plan', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-null-plan-'));
  const lead = planner([{ output: { status: 'needs_clarification', questions: [{ prompt: 'Need one boundary.' }], plan: planOutput({ nonce: 'ignored' }).plan } }]);
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  await assert.rejects(engine.planGoal({ goalId: goal.id, requestId: 'null-plan-1' }), (error) => error.code === 'lead_plan_invalid' && error.statusCode === 409);
  assert.equal(engine.getLeadPlan(engine.state.leadPlans[0].id).status, LEAD_PLAN_STATUS.failed);
  assert.equal(engine.getGoal(goal.id).plan, null);
});

test('restart marks a generating proposal interrupted and never retries or applies the late result', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-restart-'));
  let release;
  const lead = planner([], { wait: () => new Promise((resolve) => { release = resolve; }) });
  const engine = engineWithPlanner(dataDir, lead);
  const goal = shell(engine);
  const generation = engine.planGoal({ goalId: goal.id, requestId: 'restart-1' });
  for (let index = 0; index < 200 && (!engine.state.leadPlans.length || !release); index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function');
  assert.equal(engine.state.leadPlans[0].status, LEAD_PLAN_STATUS.generating);

  const restarted = new AosEngine({ dataDir, execution: { mode: 'codex', codex: { repoRoot: dataDir } } });
  restarted.load();
  assert.equal(restarted.getLeadPlan(engine.state.leadPlans[0].id).status, LEAD_PLAN_STATUS.interrupted);
  assert.throws(() => restarted.startRun({ goalId: goal.id }), (error) => error.code === 'goal_not_planned');

  release({});
  const late = await generation;
  assert.equal(late.proposal.status, LEAD_PLAN_STATUS.interrupted);
  assert.equal(restarted.getLeadPlan(engine.state.leadPlans[0].id).status, LEAD_PLAN_STATUS.interrupted);
});
