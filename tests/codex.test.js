import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import {
  CODEX_DISABLED_FEATURES,
  buildCodexArgs,
  redactText,
  resolveCodexConfig,
  sanitizedChildEnv,
  verifySession,
} from '../engine/codex.js';
import { analyzeRun } from '../engine/metrics.js';

// Stand-in for the real CLI, used only by these tests. It answers the preflight
// commands, writes a session record like Codex does, and follows [[fake:...]]
// directives embedded in a task brief.
const FAKE_CODEX = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, apiKeyVisible: Boolean(process.env.OPENAI_API_KEY), pid: process.pid }) + '\n');
}
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
if (args[0] === 'login') {
  console.log(process.env.FAKE_CODEX_LOGIN === 'apikey' ? 'Logged in using an API key' : 'Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] === 'debug') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-luna', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }], upgrade: null }] }));
  process.exit(0);
}
const opt = (flag) => args[args.indexOf(flag) + 1];
const effort = args.find((arg, i) => args[i - 1] === '-c' && arg.startsWith('model_reasoning_effort=')).split('=')[1].replace(/"/g, '');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const directive = (name) => {
    const match = prompt.match(new RegExp('\\[\\[fake:' + name + '(?:=([^\\]]+))?\\]\\]'));
    return match ? (match[1] ?? true) : null;
  };
  const nonce = (prompt.match(/AOS task nonce: (\S+)/) || [])[1];
  const attempt = Number((prompt.match(/attempt (\d+)\)/) || [])[1]);
  const threadId = 'fake-' + process.pid + '-' + Date.now();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'session_meta', payload: { id: threadId, cli_version: '0.0.0-fake', source: 'exec', model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: directive('model') || opt('-m'), effort: directive('effort') || effort, sandbox_policy: { type: 'read-only' }, approval_policy: 'never' } },
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'pro', primary: { used_percent: 3 } } } },
  ];
  fs.writeFileSync(path.join(dir, 'rollout-fake-' + threadId + '.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  console.error('debug header Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'eyJ' + 'abcdefghij' + '.' + 'klmnopqrst' + '.' + 'uvwxyz0123' } }));
  const finish = () => {
    if (directive('fail')) {
      console.log(JSON.stringify({ type: 'turn.failed', error: { message: directive('fail') } }));
      process.exit(1);
    }
    const body = {
      task_nonce: directive('wrong-nonce') ? 'aos-another-task' : nonce,
      summary: 'fake summary for attempt ' + attempt,
      findings: [{ kind: 'supported', claim: 'fake claim', evidence: ['engine/engine.js:1'], confidence: 0.7 }],
      risks: [],
      confidence: 0.7,
      decision: prompt.includes('decision is required') ? { recommendation: 'ship it', objection: 'one sample', confidence: 0.6 } : null,
      retrospective: prompt.includes('retrospective is required')
        ? { what_failed: 'nothing', why: 'fake', should_improve: 'more samples', proposals: [{ title: 'Replicate runs', change: 'Run each level three times', rationale: 'variance', risk: 'cost' }] }
        : null,
    };
    fs.writeFileSync(opt('-o'), JSON.stringify(body));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 } }));
    process.exit(0);
  };
  if (Number(directive('hang-attempt')) === attempt) { setInterval(() => {}, 1000); return; }
  setTimeout(finish, Number(directive('delay') || 5));
});
`;

function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-fake-codex-'));
  const bin = join(dir, 'codex');
  const shebang = process.execPath.includes(' ') ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  writeFileSync(bin, `${shebang}\n${FAKE_CODEX}`);
  chmodSync(bin, 0o755);
  const codexHome = join(dir, 'home');
  const log = join(dir, 'invocations.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  return {
    bin,
    codexHome,
    invocations: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

function liveEngine(fake, codex = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-live-'));
  const aos = new AosEngine({ dataDir, execution: { mode: 'codex', codex: { codexBin: fake.bin, codexHome: fake.codexHome, repoRoot: dataDir, killGraceMs: 200, ...codex } } });
  aos.load();
  return aos;
}

function livePlan(briefs = {}) {
  const task = (key, extra = {}) => ({ id: key, key, title: `Task ${key}`, kind: 'research', worker: 'codex', brief: `Do ${key}. ${briefs[key] || ''}`, ...extra });
  return {
    title: 'fake live plan',
    tasks: [
      task('A'),
      task('B'),
      task('C'),
      task('D', { kind: 'synthesis', dependencyPolicy: 'all_terminal' }),
      task('E', { kind: 'retrospective', dependencyPolicy: 'all_terminal' }),
      { id: 'G', key: 'G', title: 'Gate', kind: 'adopt', worker: 'engine', requiresApproval: true },
    ],
    dependencies: [
      { taskId: 'B', dependsOnTaskId: 'A' },
      { taskId: 'C', dependsOnTaskId: 'A' },
      { taskId: 'D', dependsOnTaskId: 'B' },
      { taskId: 'D', dependsOnTaskId: 'C' },
      { taskId: 'E', dependsOnTaskId: 'D' },
      { taskId: 'G', dependsOnTaskId: 'E' },
    ],
  };
}

function byKey(aos, runId, key) {
  return aos.state.tasks.find((task) => task.runId === runId && task.key === key);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('live config only accepts gpt-5.6-luna at effort max and at most four workers', () => {
  assert.deepEqual(
    { model: resolveCodexConfig({}).model, effort: resolveCodexConfig({}).effort, cap: resolveCodexConfig({}).maxConcurrency },
    { model: 'gpt-5.6-luna', effort: 'max', cap: 4 },
  );
  assert.throws(() => resolveCodexConfig({ model: 'gpt-5.6-sol' }), /not allowlisted/);
  assert.throws(() => resolveCodexConfig({ effort: 'xhigh' }), /not allowlisted/);
  assert.throws(() => resolveCodexConfig({ maxConcurrency: 5 }), /1 to 4/);
  assert.throws(() => resolveCodexConfig({ maxConcurrency: 0 }), /1 to 4/);
});

test('codex exec arguments pin model, effort, read-only sandbox and disable other-model features', () => {
  const config = resolveCodexConfig({});
  const args = buildCodexArgs(config, { cwd: '/ws', lastMessagePath: '/ws/last.json', schemaPath: '/ws/schema.json' });
  const pair = (flag, value) => args.some((arg, index) => arg === flag && args[index + 1] === value);
  assert.equal(args[0], 'exec');
  assert.ok(pair('-m', 'gpt-5.6-luna'));
  assert.ok(pair('-c', 'model_reasoning_effort="max"'));
  assert.ok(pair('-c', 'forced_login_method="chatgpt"'));
  assert.ok(pair('--sandbox', 'read-only'));
  assert.ok(pair('-C', '/ws'));
  for (const flag of ['--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
  for (const feature of ['multi_agent', 'guardian_approval', 'image_generation', 'apps', 'memories']) assert.ok(pair('--disable', feature), feature);
  assert.equal(CODEX_DISABLED_FEATURES.length, args.filter((arg) => arg === '--disable').length);
  for (const banned of ['--dangerously-bypass-approvals-and-sandbox', '--oss', '--profile', '-p', '--full-auto']) assert.equal(args.includes(banned), false, banned);
  assert.equal(args.at(-1), '-');
});

test('child environment drops API keys and redaction masks credentials', () => {
  const { env, stripped } = sanitizedChildEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y', OPENAI_BASE_URL: 'z', GITHUB_ACCESS_TOKEN: 't' }, {});
  assert.deepEqual(stripped, ['CODEX_API_KEY', 'GITHUB_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.OPENAI_API_KEY, undefined);
  const jwt = ['eyJ', 'abcdefghij', '.', 'klmnopqrst', '.', 'uvwxyz0123'].join('');
  const key = ['sk', '-', 'a'.repeat(24)].join('');
  const text = redactText(`${jwt} ${key} Bearer ${'b'.repeat(30)} "refresh_token": "${'r'.repeat(20)}"`);
  for (const secret of [jwt, key, 'b'.repeat(30), 'r'.repeat(20)]) assert.equal(text.includes(secret), false);
});

test('session verification separates substitution from missing evidence', () => {
  const config = resolveCodexConfig({});
  const good = { found: true, models: ['gpt-5.6-luna'], efforts: ['max'], modelProvider: 'openai', sandboxes: ['read-only'] };
  assert.equal(verifySession(good, config).ok, true);
  assert.equal(verifySession({ ...good, models: ['gpt-5.6-sol'] }, config).mismatch.length, 1);
  assert.equal(verifySession({ ...good, efforts: ['xhigh'] }, config).mismatch.length, 1);
  const missing = verifySession({ found: false }, config);
  assert.equal(missing.ok, false);
  assert.equal(missing.mismatch.length, 0);
});

test('live run executes codex workers with verified runtime evidence and no violations', async () => {
  const fake = fakeCodex();
  process.env.OPENAI_API_KEY = 'must-not-reach-worker';
  try {
    const aos = liveEngine(fake);
    const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan() });
    const run = aos.startRun({ goalId: goal.id, maxConcurrency: 2 });
    const result = await aos.advanceRun(run.id, { untilIdle: true });
    assert.equal(result.run.status, 'awaiting_approval');
    for (const key of ['A', 'B', 'C', 'D', 'E']) {
      const task = byKey(aos, run.id, key);
      assert.equal(task.status, 'succeeded', key);
      const runtime = JSON.parse(readFileSync(join(task.workspace, 'attempt-1', 'runtime.json'), 'utf8'));
      assert.equal(runtime.verified, true);
      assert.deepEqual(runtime.requested, { model: 'gpt-5.6-luna', effort: 'max' });
      assert.equal(runtime.effective.model, 'gpt-5.6-luna');
      assert.equal(runtime.effective.effort, 'max');
      assert.equal(runtime.effective.planType, 'pro');
      assert.match(runtime.threadId, /^fake-/);
      assert.ok(runtime.strippedEnv.includes('OPENAI_API_KEY'));
      const artifact = JSON.parse(readFileSync(join(task.workspace, 'artifact.json'), 'utf8'));
      assert.equal(artifact.nonce, task.nonce);
      const captured = readFileSync(join(task.workspace, 'attempt-1', 'stderr.txt'), 'utf8') + readFileSync(join(task.workspace, 'attempt-1', 'stdout.jsonl'), 'utf8');
      assert.equal(captured.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false);
      assert.equal(captured.includes('klmnopqrst.uvwxyz0123'), false);
    }
    assert.equal(byKey(aos, run.id, 'G').status, 'awaiting_approval');
    assert.equal(aos.getDecision(run.id).source, 'worker');
    const retro = aos.getRetrospective(run.id);
    assert.equal(aos.getProposal(retro.proposalId).status, 'proposed');
    const execs = fake.invocations().filter((item) => item.args[0] === 'exec');
    assert.equal(execs.length, 5);
    assert.ok(execs.every((item) => !item.apiKeyVisible));
    const analysis = analyzeRun({ dataDir: aos.store.dataDir, runId: run.id });
    assert.deepEqual(analysis.violations, []);
    assert.equal(analysis.metrics.artifacts.complete, 5);
    assert.ok(analysis.metrics.peakConcurrency <= 2);
    assert.equal(analysis.metrics.workers.verified, 5);
    const snapshot = aos.snapshot();
    assert.deepEqual(snapshot.telemetry.tokens, {
      input_tokens: 50,
      cached_input_tokens: 10,
      output_tokens: 25,
      reasoning_output_tokens: 5,
    });
    assert.equal(snapshot.telemetry.spawned, 5);
    assert.equal(snapshot.telemetry.verified, 5);
    const publicRuntime = snapshot.telemetry.workers.find((item) => item.taskId === byKey(aos, run.id, 'A').id).runtime.at(-1);
    assert.deepEqual(publicRuntime.usage, {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 5,
      reasoning_output_tokens: 1,
    });
    assert.equal(publicRuntime.effective.model, 'gpt-5.6-luna');
    assert.equal(publicRuntime.effective.effort, 'max');
    assert.equal(publicRuntime.verified, true);
    const codexProvider = snapshot.providers.find((item) => item.id === 'codex');
    assert.equal(codexProvider.configured, true);
    assert.equal(codexProvider.liveExecutionEnabled, true);
    assert.equal(codexProvider.readiness.status, 'available');
    assert.ok(codexProvider.readiness.checkedAt);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('live run fails closed before spawning workers when the login is not ChatGPT', async () => {
  const fake = fakeCodex();
  process.env.FAKE_CODEX_LOGIN = 'apikey';
  try {
    const aos = liveEngine(fake);
    const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan() });
    const run = aos.startRun({ goalId: goal.id });
    await aos.advanceRun(run.id, { untilIdle: true });
    assert.equal(aos.getRun(run.id).status, 'failed');
    assert.match(aos.getRun(run.id).error.reason, /not logged in with a ChatGPT account/);
    assert.equal(aos.getRun(run.id).error.details.command, 'codex login status');
    assert.equal(fake.invocations().filter((item) => item.args[0] === 'exec').length, 0);
    assert.ok(aos.state.tasks.filter((task) => task.runId === run.id).every((task) => task.status === 'cancelled'));
    const codexProvider = aos.listProviders().find((item) => item.id === 'codex');
    assert.equal(codexProvider.configured, true);
    assert.equal(codexProvider.liveExecutionEnabled, false);
    assert.equal(codexProvider.readiness.status, 'unavailable');
    assert.ok(codexProvider.readiness.checkedAt);
  } finally {
    delete process.env.FAKE_CODEX_LOGIN;
  }
});

test('a substituted model aborts the run without retrying', async () => {
  const fake = fakeCodex();
  const aos = liveEngine(fake);
  const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan({ A: '[[fake:model=gpt-5.6-sol]]' }) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = byKey(aos, run.id, 'A');
  assert.equal(task.status, 'failed');
  assert.equal(task.attempts, 1);
  assert.match(task.error, /session model gpt-5.6-sol != requested gpt-5.6-luna/);
  assert.equal(aos.getRun(run.id).status, 'failed');
  assert.equal(byKey(aos, run.id, 'B').status, 'cancelled');
  const types = analyzeRun({ dataDir: aos.store.dataDir, runId: run.id }).violations.map((item) => item.type);
  assert.ok(types.includes('worker_substitution_detected'));
  assert.ok(types.includes('run_aborted'));
});

test('a timed-out worker is killed and retried, and a cross-wired nonce is refused', async () => {
  const fake = fakeCodex();
  const aos = liveEngine(fake, { timeoutMs: 1500 });
  const plan = livePlan({ A: '[[fake:hang-attempt=1]]' });
  const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = byKey(aos, run.id, 'A');
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attempts, 2);
  assert.equal(task.runtime[0].timedOut, true);
  const hung = fake.invocations().filter((item) => item.args[0] === 'exec')[0];
  assert.equal(alive(hung.pid), false);

  const wrong = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan({ A: '[[fake:wrong-nonce]]' }) });
  const second = aos.startRun({ goalId: wrong.id });
  await aos.advanceRun(second.id, { untilIdle: true });
  assert.equal(byKey(aos, second.id, 'A').status, 'failed');
  assert.equal(aos.getRun(second.id).status, 'failed');
  assert.ok(aos.store.readEventLog().some((event) => event.runId === second.id && event.type === 'isolation.violation'));
});

test('cancelling a live run stops the codex process and discards its result', async () => {
  const fake = fakeCodex();
  const aos = liveEngine(fake, { timeoutMs: 60_000 });
  const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan({ A: '[[fake:hang-attempt=1]]' }) });
  const run = aos.startRun({ goalId: goal.id });
  const driving = aos.advanceRun(run.id, { untilIdle: true });
  for (let i = 0; i < 200 && !aos.store.readEventLog().some((event) => event.type === 'worker.thread'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const active = aos.snapshot();
  assert.equal(active.telemetry.active, 1);
  assert.equal(active.telemetry.workers.find((worker) => worker.taskId === byKey(aos, run.id, 'A').id).model, 'gpt-5.6-luna');
  assert.ok(active.telemetry.workers.find((worker) => worker.taskId === byKey(aos, run.id, 'A').id).threadId);
  aos.cancelRun(run.id);
  await driving;
  assert.equal(byKey(aos, run.id, 'A').status, 'cancelled');
  assert.equal(aos.getRun(run.id).status, 'cancelled');
  const hung = fake.invocations().find((item) => item.args[0] === 'exec');
  assert.equal(alive(hung.pid), false);
  assert.ok(aos.store.readEventLog().some((event) => event.runId === run.id && event.type === 'worker.result_discarded'));
});

test('live mode refuses non-codex worker plans and concurrency above four', () => {
  const fake = fakeCodex();
  const aos = liveEngine(fake);
  const local = aos.createGoal({
    prompt: 'Fake live objective with success criteria and a bounded scope.',
    plan: { tasks: [{ id: 'L', key: 'L', title: 'Local task', kind: 'research', worker: 'local' }], dependencies: [] },
  });
  assert.throws(() => aos.startRun({ goalId: local.id }), /refuses task "Local task" on worker "local"/);
  const goal = aos.createGoal({ prompt: 'Fake live objective with success criteria and a bounded scope.', plan: livePlan() });
  assert.throws(() => aos.startRun({ goalId: goal.id, maxConcurrency: 5 }), /capped at 4/);
  assert.equal(aos.startRun({ goalId: goal.id }).maxConcurrency, 2);
  const intake = aos.createGoal({ prompt: 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim. Scope excludes clinical work.' });
  assert.ok(intake.plan.tasks.every((task) => (task.kind === 'adopt' ? task.worker === 'engine' : task.worker === 'codex')));
  assert.equal(aos.listProviders().find((item) => item.id === 'codex').configured, true);
  assert.equal(aos.listProviders().find((item) => item.id === 'codex').liveExecutionEnabled, false);
  assert.equal(aos.listProviders().find((item) => item.id === 'codex').readiness.status, 'unverified');
  assert.equal(aos.listProviders().find((item) => item.id === 'local').liveExecutionEnabled, false);
});
