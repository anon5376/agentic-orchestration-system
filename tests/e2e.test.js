import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { executeCommand, loadEngineFromEnv } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';

const PROMPT = 'Determine whether delayed feedback destabilises bidirectional nerve-interface coupling, and propose the next experiment. Success is a bounded claim with an explicit uncertainty. Scope excludes clinical deployment.';

test('end-to-end: goal, plan, deterministic workers, persist, synthesize, retrospective, approval, reload', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-e2e-'));
  const aos = new AosEngine({ dataDir, concurrency: 2 });
  aos.load();

  const goal = aos.createGoal({ prompt: PROMPT, contextPaths: ['docs/notes.md'] });
  assert.ok(goal.plan.tasks.length >= 6);
  aos.answerQuestions(goal.id, goal.questions.map((question) => ({
    id: question.id,
    answer: 'Use published interface studies; accept a bounded claim.',
  })));

  const run = aos.startRun({ goalId: goal.id });
  const advanced = await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(advanced.run.status, 'awaiting_approval');
  assert.ok(aos.getDecision(run.id), 'synthesis decision missing');
  const retro = aos.getRetrospective(run.id);
  assert.ok(retro, 'retrospective missing');
  assert.ok(retro.whatFailed);
  assert.ok(retro.why);
  assert.ok(retro.shouldImprove);
  const proposal = aos.getProposal(retro.proposalId);
  assert.equal(proposal.status, 'proposed');

  const reloaded = new AosEngine({ dataDir, concurrency: 2 });
  reloaded.load();
  assert.equal(reloaded.getRun(run.id).status, 'awaiting_approval');
  assert.ok(reloaded.getDecision(run.id));
  assert.equal(reloaded.getProposal(proposal.id).status, 'proposed');
  assert.equal(reloaded.store.readEventLog().length, aos.store.readEventLog().length);

  reloaded.approveProposal(proposal.id);
  const finished = await reloaded.advanceRun(run.id, { untilIdle: true });
  assert.equal(finished.run.status, 'completed');
  assert.equal(reloaded.getProposal(proposal.id).status, 'approved');
  const adopt = reloaded.state.tasks.find((item) => item.runId === run.id && item.kind === 'adopt');
  assert.equal(adopt.status, 'succeeded');

  const again = new AosEngine({ dataDir });
  again.load();
  assert.equal(again.getRun(run.id).status, 'completed');
  assert.equal(again.getProposal(proposal.id).status, 'approved');
});

test('CLI and HTTP operate on the same store', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-iface-'));
  const aos = loadEngineFromEnv({ dataDir });
  const created = await executeCommand(aos, `goal create "${PROMPT}"`);
  assert.equal(created.ok, true);
  const goalId = created.lines[0].split(' ')[1];
  const started = await executeCommand(aos, `run start ${goalId}`);
  const runId = started.lines[0].split(' ')[1];
  await executeCommand(aos, `advance ${runId}`);
  const tree = await executeCommand(aos, `tree ${runId}`);
  assert.ok(tree.lines.some((line) => line.includes('awaiting_approval') || line.includes('succeeded')));
  const decision = await executeCommand(aos, `decision ${runId}`);
  assert.ok(decision.lines.some((line) => line.startsWith('decision ')));
  const improvements = await executeCommand(aos, `improvements ${runId}`);
  const proposalId = improvements.lines[0].split(' ')[0];
  const approved = await executeCommand(aos, `approve ${proposalId}`);
  assert.equal(approved.ok, true);

  const httpEngine = new AosEngine({ dataDir });
  httpEngine.load();
  const { listen, close, server } = createAosServer({ engine: httpEngine, port: 0, host: '127.0.0.1' });
  await listen();
  const addr = server.address();
  const snapshot = await fetch(`http://127.0.0.1:${addr.port}/api/v1/snapshot`).then((res) => res.json());
  assert.equal(snapshot.run.status, 'completed');
  assert.ok(Array.isArray(snapshot.runs));
  assert.ok(snapshot.runs.length >= 1);
  for (const run of snapshot.runs) {
    assert.equal(typeof run, 'object');
    assert.notEqual(run, null);
    assert.notEqual(run, '[cycle]');
    assert.equal(typeof run.id, 'string');
    assert.ok(run.id.length > 0);
    assert.equal(typeof run.status, 'string');
    assert.ok(run.status.length > 0);
  }
  assert.equal(snapshot.runs[0].id, snapshot.run.id);
  const health = await fetch(`http://127.0.0.1:${addr.port}/health`).then((res) => res.json());
  assert.equal(health.ok, true);
  const missing = await fetch(`http://127.0.0.1:${addr.port}/api/v1/runs/run_missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Unknown run: run_missing', code: 'not_found', details: { label: 'run', id: 'run_missing' } });
  await close();
});

test('CLI and HTTP expose the persisted clarification gate', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-clarify-iface-'));
  const aos = loadEngineFromEnv({ dataDir });
  const created = await executeCommand(aos, 'goal create "Look into this"');
  const goalId = created.lines[0].split(' ')[1];
  assert.ok(created.lines.includes('status  awaiting_user'));

  const required = aos.getGoal(goalId).questions.filter((question) => question.required);
  for (const question of required) {
    const answered = await executeCommand(aos, `goal answer ${goalId} ${question.id} "Answer for ${question.code}"`);
    assert.equal(answered.ok, true);
  }
  assert.equal(aos.getGoal(goalId).status, 'planned');

  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1' });
  await listen();
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const ambiguous = await fetch(`${base}/api/v1/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Look into this' }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  assert.equal(ambiguous.status, 201);
  assert.equal(ambiguous.body.status, 'awaiting_user');

  const blocked = await fetch(`${base}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goalId: ambiguous.body.id }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /awaiting user input/);
  assert.equal(blocked.body.code, 'goal_awaiting_user');
  assert.equal(blocked.body.details.goalId, ambiguous.body.id);
  assert.deepEqual(blocked.body.details.questionIds, ambiguous.body.questions.filter((question) => question.required).map((question) => question.id));

  const answers = ambiguous.body.questions
    .filter((question) => question.required)
    .map((question) => ({ id: question.id, answer: `Answer for ${question.code}` }));
  const ready = await fetch(`${base}/api/v1/goals/${ambiguous.body.id}/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'planned');

  const started = await fetch(`${base}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goalId: ambiguous.body.id }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  assert.equal(started.status, 201);
  assert.equal(started.body.status, 'running');
  await close();
});

test('aos binary help exits 0', async () => {
  const result = await runBin(['help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /aos goal create/);
});

function runBin(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/aos.mjs', ...args], { cwd: join(import.meta.dirname, '..') });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
