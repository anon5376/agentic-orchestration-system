import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import {
  buildClaudeArgs,
  resolveClaudeConfig,
  sanitizedClaudeEnv,
} from '../engine/claude.js';

const FAKE_CLAUDE = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const opt = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === '--version') { console.log('2.1.267 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  console.log(JSON.stringify(process.env.FAKE_CLAUDE_AUTH === 'logged-out'
    ? { loggedIn: false, authMethod: 'none' }
    : { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const nonce = (prompt.match(/AOS task nonce: (\S+)/) || [])[1];
  const schema = JSON.parse(opt('--json-schema'));
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args,
    schemaType: schema.type,
    promptHasNonce: Boolean(nonce),
    anthropicKeyVisible: Boolean(process.env.ANTHROPIC_API_KEY),
    openaiKeyVisible: Boolean(process.env.OPENAI_API_KEY),
    operatorTokenVisible: Boolean(process.env.AOS_OPERATOR_TOKEN),
  }) + '\n');
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'fake-claude-session',
    structured_output: {
      task_nonce: nonce,
      status: 'succeeded',
      summary: 'fake Claude result',
      findings: [{ kind: 'supported', claim: 'bounded result', evidence: ['prompt'], confidence: 0.8 }],
      risks: [],
      confidence: 0.8,
      decision: null,
      retrospective: null,
      memory_writes: [],
    },
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 7,
    },
    modelUsage: {
      'claude-opus-5': { inputTokens: 11, outputTokens: 7 },
      'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1 },
    },
    total_cost_usd: 0.02,
  }));
});
`;

function fakeClaude() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-fake-claude-'));
  const bin = join(dir, 'claude');
  const shebang = process.execPath.includes(' ') ? '#!/usr/bin/env node' : `#!${process.execPath}`;
  writeFileSync(bin, `${shebang}\n${FAKE_CLAUDE}`);
  chmodSync(bin, 0o755);
  const log = join(dir, 'invocations.jsonl');
  process.env.FAKE_CLAUDE_LOG = log;
  return {
    bin,
    invocations: () => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [],
  };
}

function mixedEngine(fake) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-mixed-'));
  const engine = new AosEngine({
    dataDir,
    execution: {
      mode: 'mixed',
      adapters: {
        local: { enabled: true },
        claude: {
          enabled: true,
          claudeBin: fake.bin,
          repoRoot: dataDir,
          model: 'opus',
          effort: 'max',
          maxConcurrency: 1,
          timeoutMs: 10_000,
          killGraceMs: 100,
        },
      },
    },
  });
  engine.load();
  return engine;
}

function twoProviderPlan() {
  return {
    title: 'mixed providers',
    tasks: [
      { id: 'local', key: 'LOCAL', title: 'Local task', kind: 'research', worker: 'local' },
      { id: 'claude', key: 'CLAUDE', title: 'Claude task', kind: 'research', worker: 'claude', model: 'opus', effort: 'max' },
    ],
    dependencies: [],
  };
}

test('Claude adapter pins the safe account-session invocation and strips unrelated secrets', () => {
  const config = resolveClaudeConfig({});
  const schema = { type: 'object' };
  const args = buildClaudeArgs(config, { schema });
  const pair = (flag, value) => args.some((arg, index) => arg === flag && args[index + 1] === value);
  assert.ok(pair('--model', 'opus'));
  assert.ok(pair('--effort', 'max'));
  assert.ok(pair('--permission-mode', 'plan'));
  assert.ok(pair('--permission-prompts', 'none'));
  assert.ok(pair('--tools', 'Read,Glob,Grep'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), schema);
  for (const flag of ['--print', '--restricted', '--safe-mode', '--strict-mcp-config', '--no-chrome']) assert.ok(args.includes(flag), flag);

  const { env, stripped } = sanitizedClaudeEnv({
    HOME: '/account-home',
    CLAUDE_CONFIG_DIR: '/claude-account',
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    AOS_OPERATOR_TOKEN: 'secret',
  });
  assert.equal(env.HOME, '/account-home');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/claude-account');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(stripped, ['ANTHROPIC_API_KEY', 'AOS_OPERATOR_TOKEN', 'OPENAI_API_KEY']);
});

test('mixed execution runs local and Claude tasks without substitution or public session leakage', async () => {
  const fake = fakeClaude();
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-worker';
  process.env.OPENAI_API_KEY = 'must-not-reach-worker';
  process.env.AOS_OPERATOR_TOKEN = 'must-not-reach-worker';
  try {
    const engine = mixedEngine(fake);
    const goal = engine.createGoal({ prompt: 'Run two bounded tasks with explicit provider assignments.', plan: twoProviderPlan() });
    const run = engine.startRun({ goalId: goal.id, maxConcurrency: 2 });
    const result = await engine.advanceRun(run.id, { untilIdle: true });
    assert.equal(result.run.status, 'completed');
    const tasks = engine.getRunTree(run.id).tasks;
    assert.deepEqual(tasks.map((task) => [task.key, task.status]), [['LOCAL', 'succeeded'], ['CLAUDE', 'succeeded']]);

    const snapshot = engine.snapshot();
    const claude = snapshot.telemetry.workers.find((worker) => worker.taskCode === 'CLAUDE');
    const runtime = claude.runtime.at(-1);
    assert.equal(runtime.verified, true);
    assert.equal(runtime.effective.model, 'opus');
    assert.equal(runtime.effective.modelProvider, 'claude-opus-5');
    assert.deepEqual(runtime.usage, {
      input_tokens: 11,
      cached_input_tokens: 5,
      output_tokens: 7,
      reasoning_output_tokens: 0,
    });
    assert.ok(claude.profile.fingerprint);
    assert.equal(snapshot.harnessSessions.length, 1);
    assert.equal(snapshot.harnessSessions[0].referenceStored, true);
    assert.equal(JSON.stringify(snapshot).includes('fake-claude-session'), false);

    const invocation = fake.invocations()[0];
    assert.equal(invocation.schemaType, 'object');
    assert.equal(invocation.promptHasNonce, true);
    assert.equal(invocation.anthropicKeyVisible, false);
    assert.equal(invocation.openaiKeyVisible, false);
    assert.equal(invocation.operatorTokenVisible, false);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AOS_OPERATOR_TOKEN;
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('a failed Claude preflight does not block local work or claim a Claude workspace', async () => {
  const fake = fakeClaude();
  process.env.FAKE_CLAUDE_AUTH = 'logged-out';
  try {
    const engine = mixedEngine(fake);
    const goal = engine.createGoal({ prompt: 'Keep explicit provider assignments when one provider is unavailable.', plan: twoProviderPlan() });
    const run = engine.startRun({ goalId: goal.id, maxConcurrency: 2 });
    await engine.advanceRun(run.id, { untilIdle: true });
    const tasks = engine.getRunTree(run.id).tasks;
    const local = tasks.find((task) => task.key === 'LOCAL');
    const claude = tasks.find((task) => task.key === 'CLAUDE');
    assert.equal(local.status, 'succeeded');
    assert.equal(claude.status, 'failed');
    assert.equal(claude.errorCode, 'adapter_auth_unavailable');
    assert.equal(claude.workspace, null);
    assert.equal(fake.invocations().length, 0);
    assert.ok(engine.store.readEventLog().some((event) => event.type === 'provider.preflight_failed' && event.payload.provider === 'claude'));
  } finally {
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test('concurrency races defer automatically instead of asking the operator', async () => {
  const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-capacity-defer-')) });
  engine.load();
  engine.defaultProject().maxConcurrency = 1;
  engine.save();
  let release;
  let started;
  const released = new Promise((resolve) => { release = resolve; });
  const didStart = new Promise((resolve) => { started = resolve; });
  engine.workers.set('local', {
    id: 'local',
    async execute(task) {
      if (task.key === 'HOLD') {
        started();
        await released;
      }
      return { status: 'succeeded', summary: task.key };
    },
  });
  const makeGoal = (key) => engine.createGoal({
    prompt: `Run ${key} within one project slot.`,
    plan: { title: key, tasks: [{ id: key, key, title: key, kind: 'research', worker: 'local' }], dependencies: [] },
  });
  const first = engine.startRun({ goalId: makeGoal('HOLD').id });
  const second = engine.startRun({ goalId: makeGoal('NEXT').id });
  const firstDrive = engine.advanceRun(first.id, { untilIdle: true });
  await didStart;
  const secondDrive = engine.advanceRun(second.id, { untilIdle: true });
  for (let i = 0; i < 50 && !engine.store.readEventLog().some((event) => event.runId === second.id && event.type === 'resource.deferred'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const deferred = engine.getRunTree(second.id).tasks[0];
  assert.equal(deferred.status, 'ready');
  assert.equal(deferred.questions.length, 0);
  assert.ok(engine.store.readEventLog().some((event) => event.runId === second.id && event.type === 'resource.deferred'));
  release();
  await Promise.all([firstDrive, secondDrive]);
  assert.equal(engine.getRun(first.id).status, 'completed');
  assert.equal(engine.getRun(second.id).status, 'completed');
});
