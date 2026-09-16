import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PoolRunner, assertLoopbackPoolUrl } from '../engine/pool-runner.js';

function claimFor(dataDir, input, overrides = {}) {
  const runId = 'run-test';
  const taskId = 'task-test';
  const profile = {
    provider: 'codex', model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only',
    authPathKind: 'external_cli_session', maxConcurrency: 4, timeoutMs: 1_000,
    fingerprint: input.profileFingerprint,
  };
  return {
    claimId: 'claim-test', claimRequestId: input.requestId, ownerId: input.ownerId,
    protocol: input.protocol, leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    runId, projectId: 'project-test', goalId: 'goal-test', taskId, agentId: 'agent-test',
    attempt: 1, nonce: 'nonce-test', worker: 'codex', provider: 'codex', profile, providerProfile: profile,
    goal: { id: 'goal-test', projectId: 'project-test', prompt: 'Research the bounded question.', contextPaths: [] },
    run: { id: runId, projectId: 'project-test', goalId: 'goal-test', status: 'running' },
    task: {
      id: taskId, key: 'T1', title: 'Bounded task', kind: 'research', branch: 'root', brief: 'Do the work.',
      dependencyPolicy: 'all_succeeded', attempts: 1, nonce: 'nonce-test', timeoutMs: 1_000,
      readPaths: [], mayDelegate: false, questions: [],
    },
    dependencies: [], systemPrompt: null,
    workspace: resolve(dataDir, 'workspaces', runId, taskId),
    workspacePath: resolve(dataDir, 'workspaces', runId, taskId),
    stagedMcpFile: null, capabilityMounts: [], budget: {}, sandbox: 'read-only', readPaths: [],
    ...overrides,
  };
}

test('pool runner executes one claimed adapter task and submits the fenced nonce receipt', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-pool-runner-'));
  const calls = [];
  const client = {
    async claim(input) { calls.push(['claim', input]); return claimFor(dataDir, input); },
    async heartbeat(claimId, input) { calls.push(['heartbeat', claimId, input]); return { claimId }; },
    async complete(claimId, input) { calls.push(['complete', claimId, input]); return { status: 'succeeded' }; },
  };
  const worker = {
    id: 'codex',
    config: { model: 'gpt-5.6-luna', effort: 'max', maxConcurrency: 4, timeoutMs: 1_000, repoRoot: process.cwd() },
    async execute(task, ctx) {
      ctx.recordWorkerProcess({ pid: 123, pgid: 123 });
      ctx.workspace.write('artifact.json', { ok: true });
      return {
        status: 'succeeded', summary: 'done', result: { summary: 'done' },
        runtime: {
          provider: 'codex', verified: true,
          requested: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
          effective: { model: 'gpt-5.6-luna', effort: 'max', sandbox: 'read-only' },
          threadId: 'thread-test',
        },
      };
    },
  };
  const runner = new PoolRunner({ client, worker, dataDir, ownerId: 'pool-owner', heartbeatMs: 1_000, requestIdFactory: () => 'request-test' });
  const result = await runner.runOnce({ runId: 'run-test' });

  assert.equal(result.status, 'succeeded');
  assert.equal(calls[0][1].protocol, 'provider-adapter-v1');
  assert.equal(calls[0][1].profileFingerprint, runner.profile.fingerprint);
  assert.ok(calls.some(([kind, , body]) => kind === 'heartbeat' && body.workerPid === 123 && body.workerPgid === 123));
  const completed = calls.find(([kind]) => kind === 'complete');
  assert.equal(completed[2].result.task_nonce, 'nonce-test');
  assert.equal(completed[2].result.runtime.threadId, 'thread-test');
});

test('pool runner aborts on a stalled heartbeat and does not submit completion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-pool-runner-abort-'));
  let heartbeats = 0;
  let completed = false;
  const client = {
    async claim(input) { return claimFor(dataDir, input); },
    async heartbeat() {
      heartbeats += 1;
      if (heartbeats > 1) return new Promise(() => {});
      return {};
    },
    async complete() { completed = true; return {}; },
  };
  const worker = {
    id: 'codex',
    config: { model: 'gpt-5.6-luna', effort: 'max', maxConcurrency: 4, timeoutMs: 1_000 },
    async execute(_task, ctx) {
      ctx.recordWorkerProcess({ pid: 456, pgid: 456 });
      await new Promise((resolvePromise) => ctx.signal.addEventListener('abort', resolvePromise, { once: true }));
      return { status: 'cancelled', error: 'aborted' };
    },
  };
  const runner = new PoolRunner({ client, worker, dataDir, ownerId: 'pool-owner', heartbeatMs: 1_000, requestIdFactory: () => 'request-abort' });
  await assert.rejects(() => runner.runOnce(), (error) => error.code === 'pool_heartbeat_timeout');
  assert.equal(completed, false);
});

test('pool runner rejects claim identifiers before resolving a workspace path', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-pool-runner-path-'));
  let executed = false;
  const client = {
    async claim(input) { return claimFor(dataDir, input, { runId: '../escape' }); },
    async heartbeat() { return {}; },
    async complete() { return {}; },
  };
  const worker = {
    id: 'codex',
    config: { model: 'gpt-5.6-luna', effort: 'max', maxConcurrency: 4, timeoutMs: 1_000 },
    async execute() { executed = true; return { status: 'failed' }; },
  };
  const runner = new PoolRunner({ client, worker, dataDir, ownerId: 'pool-owner', heartbeatMs: 1_000, requestIdFactory: () => 'request-path' });
  await assert.rejects(() => runner.runOnce(), (error) => error.code === 'pool_input_invalid');
  assert.equal(executed, false);
});

test('pool targets are loopback HTTP only', () => {
  assert.equal(assertLoopbackPoolUrl('http://127.0.0.1:7740').origin, 'http://127.0.0.1:7740');
  assert.throws(() => assertLoopbackPoolUrl('https://example.com'), (error) => error.code === 'pool_target_invalid');
  assert.throws(() => assertLoopbackPoolUrl('http://127.0.0.2:7740'), (error) => error.code === 'pool_target_invalid');
});
