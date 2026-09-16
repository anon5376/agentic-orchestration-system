import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { CODEX_AUTH_PATH } from '../engine/codex.js';
import { executeCommand } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';

const PROMPT = 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim with explicit uncertainty. Scope excludes clinical deployment.';

function runtime(overrides = {}) {
  return {
    provider: 'codex',
    authPath: CODEX_AUTH_PATH,
    verified: true,
    threadId: 'thread-lead-api',
    requested: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
    effective: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only', modelProvider: 'openai' },
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.010Z',
    durationMs: 10,
    usage: { input_tokens: 10, output_tokens: 5 },
    spawned: false,
    injected: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function planFor(task) {
  return {
    title: 'API lead plan',
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
  };
}

function planner(outputs = []) {
  let index = 0;
  return {
    calls: [],
    async preflight() {
      return {
        checkedAt: '2026-01-01T00:00:00.000Z',
        login: 'Logged in using ChatGPT',
        authPath: CODEX_AUTH_PATH,
        cliVersion: 'codex-cli test',
        model: { slug: 'gpt-5.6-luna', efforts: ['max'], upgrade: null },
        requested: { model: 'gpt-5.6-luna', effort: 'max' },
      };
    },
    async execute(task, ctx) {
      this.calls.push({ task, ctx });
      if (ctx.outputKind !== 'lead') return { status: 'succeeded', summary: 'worker complete' };
      const selected = outputs[index] || {};
      index += 1;
      const status = selected.status || 'succeeded';
      const result = {
        task_nonce: task.nonce,
        status,
        questions: selected.questions || [],
        plan: status === 'succeeded' ? (selected.plan || planFor(task)) : null,
        rationale: selected.rationale || 'Bounded API proposal.',
        summary: selected.summary || 'A bounded API proposal.',
      };
      return { status, runtime: selected.runtime || runtime({ threadId: `thread-lead-api-${index}` }), result };
    },
  };
}

function engineWithPlanner(dataDir, leadPlanner) {
  const engine = new AosEngine({
    dataDir,
    execution: { mode: 'codex', codex: { repoRoot: dataDir } },
    leadPlanner,
  });
  engine.load();
  engine.workers.set('codex', leadPlanner);
  return engine;
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return { status: response.status, body: await response.json() };
}

test('lead HTTP and CLI doors share idempotency, clarification, acceptance, and concise reads', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-api-'));
  const lead = planner([
    { status: 'needs_clarification', questions: [{ prompt: 'Which source boundary should constrain the plan?' }] },
    {},
    {},
  ]);
  const engine = engineWithPlanner(dataDir, lead);
  const { listen, close, server } = createAosServer({ engine, host: '127.0.0.1', port: 0, operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await executeCommand(engine, `goal create "${PROMPT}" --planning-mode lead --request-id api-1 --context docs/sources.md`);
    assert.equal(created.ok, true);
    const goalId = created.lines[0].split(' ')[1];
    const proposalId = created.lines[2].split(' ')[1];
    assert.ok(created.lines.some((line) => line.includes('needs_clarification')));
    assert.equal(created.lines.some((line) => line.includes(PROMPT)), false);

    const repeated = await request(base, '/api/v1/goals', {
      method: 'POST',
      body: JSON.stringify({ projectId: engine.defaultProject().id, prompt: PROMPT, contextPaths: ['docs/sources.md'], planningMode: 'lead', requestId: 'api-1' }),
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.idempotent, true);
    assert.equal(repeated.body.goal.id, goalId);
    assert.equal(repeated.body.proposal.id, proposalId);

    const answered = await request(base, `/api/v1/goals/${goalId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ answers: [{ id: repeated.body.proposal.questions[0].id, answer: 'Published interface studies only.' }] }),
    });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.status, 'lead_revision_ready');

    const revised = await executeCommand(engine, `goal plan ${goalId} --request-id api-2 --derived-from ${proposalId}`);
    assert.equal(revised.ok, true);
    const revisedId = revised.lines[2].split(' ')[1];
    assert.ok(revised.lines.some((line) => line.includes('awaiting_approval')));

    const list = await request(base, `/api/v1/goals/${goalId}/lead-plans?status=proposed`);
    assert.equal(list.status, 200);
    assert.equal(list.body.plans.length, 1);
    assert.equal(list.body.plans[0].id, revisedId);
    const shown = await request(base, `/api/v1/lead-plans/${revisedId}`);
    assert.equal(shown.status, 200);
    assert.equal(shown.body.id, revisedId);
    assert.equal(JSON.stringify(shown.body).includes(PROMPT), false);

    const accepted = await request(base, `/api/v1/lead-plans/${revisedId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ actor: 'operator-test' }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.proposal.status, 'accepted');
    assert.equal(accepted.body.goal.status, 'planned');

    const started = await request(base, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ goalId }),
    });
    assert.equal(started.status, 201);
    assert.equal(started.body.goalId, goalId);

    const plans = await executeCommand(engine, `goal plans ${goalId}`);
    assert.equal(plans.ok, true);
    assert.ok(plans.lines.some((line) => line.includes(revisedId)));
    const show = await executeCommand(engine, `lead-plan show ${revisedId}`);
    assert.equal(show.ok, true);
    assert.ok(show.lines.some((line) => line === `status    accepted`));
    assert.equal(show.lines.some((line) => line.includes(PROMPT)), false);
  } finally {
    await close();
  }
});

test('lead HTTP and CLI reject unsupported modes and missing request ids, and reject produces no runnable plan', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-lead-api-errors-'));
  const engine = engineWithPlanner(dataDir, planner([{}, {}]));
  const { listen, close, server } = createAosServer({ engine, host: '127.0.0.1', port: 0, operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unsupported = await request(base, '/api/v1/goals', {
      method: 'POST',
      body: JSON.stringify({ prompt: PROMPT, planningMode: 'local' }),
    });
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.body.code, 'lead_planning_mode_invalid');

    const missing = await request(base, '/api/v1/goals', {
      method: 'POST',
      body: JSON.stringify({ prompt: PROMPT, planningMode: 'lead' }),
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'lead_plan_request_id_required');
    assert.equal(engine.state.goals.filter((goal) => goal.planningMode === 'lead').length, 0);

    const cliUnsupported = await executeCommand(engine, `goal create "${PROMPT}" --planning-mode local --request-id cli-bad`);
    assert.equal(cliUnsupported.ok, false);
    assert.match(cliUnsupported.lines[0], /planning-mode must be/);
    const cliMissing = await executeCommand(engine, `goal create "${PROMPT}" --planning-mode lead`);
    assert.equal(cliMissing.ok, false);
    assert.match(cliMissing.lines[0], /requestId must be/);

    const created = await request(base, '/api/v1/goals', {
      method: 'POST',
      body: JSON.stringify({ prompt: PROMPT, planningMode: 'lead', requestId: 'reject-api-1' }),
    });
    assert.equal(created.status, 201);
    const rejected = await request(base, `/api/v1/lead-plans/${created.body.proposal.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ actor: 'operator-test', reason: 'scope changed' }),
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.proposal.status, 'rejected');
    assert.equal(rejected.body.goal.plan, null);
    const start = await request(base, '/api/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ goalId: created.body.goal.id }),
    });
    assert.equal(start.status, 409);
    assert.equal(start.body.code, 'goal_not_planned');
  } finally {
    await close();
  }
});
