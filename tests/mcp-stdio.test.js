import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  McpStdioRuntime,
  STAGED_TEXT_READER_INPUT_SCHEMA,
  STAGED_TEXT_READER_REFERENCE,
} from '../engine/mcp-stdio.js';
import {
  BUILTIN_MCP_STAGED_TEXT_RUNTIME,
  BUILTIN_MCP_STAGED_TEXT_SOURCE,
} from '../engine/capabilities.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'mcp-stdio-server.mjs');
const SCOPE = Object.freeze({
  projectId: 'prj_mcp',
  runId: 'run_mcp',
  taskId: 'tsk_mcp',
  agentId: 'agt_mcp',
  invocationId: 'inv_mcp',
  attempt: 1,
  harnessSessionId: null,
});

function workspace(text = 'staged hello') {
  const dir = mkdtempSync(join(tmpdir(), 'aos-mcp-stdio-'));
  writeFileSync(join(dir, 'declared.txt'), text, 'utf8');
  return dir;
}

function mount(overrides = {}) {
  return {
    reference: 'staged-reader@1',
    id: 'staged-reader',
    version: 1,
    kind: 'mcp',
    fingerprint: 'mount-fingerprint-1',
    runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME },
    adapter: { ...BUILTIN_MCP_STAGED_TEXT_SOURCE },
    permissions: ['filesystem_read'],
    ...overrides,
  };
}

function runtime(mode = null) {
  return new McpStdioRuntime(mode ? { testServerModule: FIXTURE, testServerMode: mode } : {});
}

async function failure(mode, overrides = {}) {
  const dir = workspace();
  await assert.rejects(
    () => runtime(mode).execute({
      mount: mount(),
      scope: SCOPE,
      workspaceDir: dir,
      stagedFile: 'declared.txt',
      idempotencyKey: `mcp-${mode}-${Math.random()}`,
      timeoutMs: 500,
      ...overrides,
    }),
    (error) => {
      assert.equal(error.retryable, false);
      assert.ok(error.receipt);
      assert.equal(error.receipt.installation, 'aos.staged-text-reader');
      assert.equal(error.receipt.version, 1);
      assert.equal(error.receipt.protocol, '2024-11-05');
      assert.equal(error.receipt.tool, 'aos.read_staged_text');
      assert.equal(error.receipt.effect, 'read_only');
      return true;
    },
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPid(path) {
  for (let index = 0; index < 100; index += 1) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8').trim().split('\n').at(-1));
    await wait(2);
  }
  return null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('shipped stdio MCP completes the exact lifecycle and replays only the exact read', async () => {
  const dir = workspace('staged hello');
  const args = {
    mount: mount(), scope: SCOPE, workspaceDir: dir, stagedFile: 'declared.txt', idempotencyKey: 'mcp-happy', timeoutMs: 500,
  };
  const reader = runtime();
  const first = await reader.execute(args);
  assert.equal(first.output, 'staged hello');
  assert.equal(first.receipt.installation, 'aos.staged-text-reader');
  assert.equal(first.receipt.version, 1);
  assert.equal(first.receipt.protocol, '2024-11-05');
  assert.equal(first.receipt.tool, 'aos.read_staged_text');
  assert.equal(first.receipt.effect, 'read_only');
  assert.deepEqual(first.receipt.scope, SCOPE);
  assert.equal(first.receipt.exitCode, 0);
  assert.equal(first.receipt.signal, null);
  assert.equal(first.receipt.errorCode, null);
  assert.deepEqual(first.receipt.fingerprints.output.length, 16);
  assert.equal(JSON.stringify(first.receipt).includes('staged hello'), false);
  assert.equal(JSON.stringify(first.receipt).includes('declared.txt'), false);
  const replay = await reader.execute(args);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.output, 'staged hello');
  writeFileSync(join(dir, 'declared.txt'), 'changed', 'utf8');
  await assert.rejects(() => reader.execute(args), (error) => error.code === 'capability_idempotency_conflict');
  assert.equal(STAGED_TEXT_READER_REFERENCE, 'aos.staged-text-reader@1');
  assert.deepEqual(STAGED_TEXT_READER_INPUT_SCHEMA.required, ['stagedFile']);
});

test('protocol negotiation, ids, lists, malformed lines, and duplicate responses fail closed', async () => {
  for (const [mode, code] of [
    ['wrong-version', 'capability_protocol_version'],
    ['wrong-id', 'capability_protocol_id'],
    ['list-drift', 'capability_tool_list_drift'],
    ['malformed', 'capability_protocol_malformed'],
    ['duplicate', 'capability_protocol_id'],
    ['unsolicited', 'capability_protocol_id'],
  ]) {
    const dir = workspace();
    await assert.rejects(
      () => runtime(mode).execute({ mount: mount(), scope: SCOPE, workspaceDir: dir, stagedFile: 'declared.txt', idempotencyKey: `mcp-${mode}`, timeoutMs: 500 }),
      (error) => error.code === code && error.retryable === false && !JSON.stringify(error).includes('not-json'),
    );
  }
});

test('stdout, stderr, tool output, and secret-like content remain bounded and redacted', async () => {
  for (const [mode, code] of [
    ['oversized-stdout', 'capability_stdout_oversize'],
    ['oversized-stderr', 'capability_stderr_oversize'],
    ['oversized-output', 'capability_output_oversize'],
    ['secret-output', 'capability_secret_content'],
  ]) {
    const dir = workspace();
    await assert.rejects(
      () => runtime(mode).execute({ mount: mount(), scope: SCOPE, workspaceDir: dir, stagedFile: 'declared.txt', idempotencyKey: `mcp-bound-${mode}`, timeoutMs: 500 }),
      (error) => error.code === code
        && error.retryable === false
        && !JSON.stringify(error).includes('fixture-secret-value')
        && !JSON.stringify(error).includes('oooo'),
    );
  }
});

test('workspace containment, regular-file, symlink, and staged-file limits are enforced before spawn', async () => {
  const dir = workspace();
  const outside = join(dir, '..', 'outside-mcp.txt');
  writeFileSync(outside, 'outside', 'utf8');
  const args = { mount: mount(), scope: SCOPE, workspaceDir: dir, idempotencyKey: 'mcp-path', timeoutMs: 500 };
  await assert.rejects(() => runtime().execute({ ...args, stagedFile: '../outside-mcp.txt' }), (error) => error.code === 'capability_staged_file_invalid');
  await assert.rejects(() => runtime().execute({ ...args, stagedFile: 'nested/declared.txt' }), (error) => error.code === 'capability_staged_file_invalid');
  writeFileSync(join(dir, 'large.txt'), Buffer.alloc(64 * 1024 + 1, 0x61));
  await assert.rejects(() => runtime().execute({ ...args, stagedFile: 'large.txt', idempotencyKey: 'mcp-large' }), (error) => error.code === 'capability_staged_file_oversize');
  try {
    symlinkSync('declared.txt', join(dir, 'link.txt'));
    await assert.rejects(() => runtime().execute({ ...args, stagedFile: 'link.txt', idempotencyKey: 'mcp-link' }), (error) => error.code === 'capability_staged_file_symlink');
  } finally {
    try { unlinkSync(join(dir, 'link.txt')); } catch { /* no symlink on this platform */ }
  }
});

test('timeout and cancellation terminate and reap a hostile child', async () => {
  const timeoutDir = workspace();
  const timeoutPidPath = join(timeoutDir, 'mcp-hostile-child.pid');
  const timeoutPromise = runtime('timeout').execute({ mount: mount(), scope: SCOPE, workspaceDir: timeoutDir, stagedFile: 'declared.txt', idempotencyKey: 'mcp-timeout', timeoutMs: 40 });
  const timeoutRejection = assert.rejects(timeoutPromise, (error) => error.code === 'capability_timed_out' && error.retryable === false && Boolean(error.receipt.signal));
  const timeoutPid = await waitForPid(timeoutPidPath);
  await timeoutRejection;
  assert.equal(alive(timeoutPid), false);

  const cancelDir = workspace();
  const cancelPidPath = join(cancelDir, 'mcp-hostile-child.pid');
  const controller = new AbortController();
  const cancelPromise = runtime('cancel').execute({ mount: mount(), scope: SCOPE, workspaceDir: cancelDir, stagedFile: 'declared.txt', idempotencyKey: 'mcp-cancel', timeoutMs: 500, signal: controller.signal });
  const cancelPid = await waitForPid(cancelPidPath);
  controller.abort();
  await assert.rejects(cancelPromise, (error) => error.code === 'capability_cancelled' && error.retryable === false && Boolean(error.receipt.signal));
  assert.equal(alive(cancelPid), false);
});

test('mount runtime/source are engine-owned and process configuration cannot be supplied by a mount', async () => {
  const dir = workspace();
  const base = { mount: mount(), scope: SCOPE, workspaceDir: dir, stagedFile: 'declared.txt', idempotencyKey: 'mcp-mount', timeoutMs: 500 };
  await assert.rejects(() => runtime().execute({ ...base, mount: mount({ adapter: { type: 'builtin', reference: 'evil', command: 'sh', argv: ['-c', 'echo secret'], env: { TOKEN: 'secret' } } }) }), (error) => error.code === 'capability_mount_mismatch');
  await assert.rejects(() => runtime().execute({ ...base, mount: mount({ runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME, command: 'sh', argv: ['-c', 'echo secret'] } }) }), (error) => error.code === 'capability_mount_mismatch');
});
