import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiActions } from '../engine/api.js';
import { AosEngine } from '../engine/engine.js';
import {
  assertMcpTaskAdmission,
  LOCAL_MCP_STDIO_EFFECT_CLASS,
  LOCAL_MCP_STDIO_INSTALLATION,
  LOCAL_MCP_STDIO_ISOLATION,
  LOCAL_MCP_STDIO_SOURCE,
  LOCAL_MCP_STDIO_TEST_PROTOCOL,
  MCP_PROTOCOL_VERSION,
  MCP_STAGED_TEXT_INPUT_SCHEMA,
} from '../engine/capabilities.js';
import { LocalMcpStdioRuntime } from '../engine/mcp-stdio.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'local-mcp-stdio-server.mjs');
const SAFE_SOURCE = 'local-mcp-safe-source-91d63c';

function localRuntime({ command = process.execPath, server = FIXTURE, mode = 'happy' } = {}) {
  return {
    transport: 'stdio',
    installation: LOCAL_MCP_STDIO_INSTALLATION,
    command: { path: command },
    argv: [{ value: server }, { value: '--mode' }, { value: mode }],
    protocolVersion: MCP_PROTOCOL_VERSION,
    tool: { name: 'local.read_staged_text', inputSchema: structuredClone(MCP_STAGED_TEXT_INPUT_SCHEMA) },
    effectClass: LOCAL_MCP_STDIO_EFFECT_CLASS,
    isolation: LOCAL_MCP_STDIO_ISOLATION,
    inputSelector: 'first_declared_read_path',
  };
}

function localCapabilityInput(overrides = {}) {
  return {
    id: 'local-reader',
    kind: 'mcp',
    name: 'Pinned local staged reader',
    description: 'Reads one engine-staged text file through a fixed local stdio server.',
    source: { ...LOCAL_MCP_STDIO_SOURCE },
    runtime: localRuntime(),
    permissions: ['filesystem_read'],
    test: {
      required: true,
      protocol: LOCAL_MCP_STDIO_TEST_PROTOCOL,
      description: 'Run the engine-owned bounded local stdio probe before enabling this version.',
    },
    ...overrides,
  };
}

function makeEngine() {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-local-mcp-state-'));
  const projectReadRoot = mkdtempSync(join(tmpdir(), 'aos-local-mcp-source-'));
  const sourcePath = join(projectReadRoot, 'declared.txt');
  writeFileSync(sourcePath, SAFE_SOURCE, 'utf8');
  const aos = new AosEngine({ dataDir, projectReadRoot });
  aos.load();
  return { aos, projectId: aos.defaultProject().id, sourcePath };
}

function mount(capability) {
  return {
    reference: capability.reference,
    id: capability.id,
    version: capability.version,
    kind: 'mcp',
    fingerprint: capability.fingerprint,
    runtime: capability.runtime,
    adapter: capability.source,
    permissions: capability.permissions,
  };
}

function localPlan(capability, task = {}) {
  return {
    title: 'Pinned local MCP execution',
    tasks: [{
      id: 'read',
      key: 'read',
      title: 'Read the one staged fixture',
      kind: 'research',
      worker: 'local',
      capabilities: { mcp: [capability.reference] },
      capabilityExecution: {
        selector: 'first_declared_read_path',
        reference: capability.reference,
        timeoutMs: 500,
      },
      sandbox: 'host_process',
      readPaths: ['declared.txt'],
      ...task,
    }],
    dependencies: [],
  };
}

async function runPlan(aos, projectId, plan) {
  const goal = aos.createGoal({
    projectId,
    prompt: 'Run exactly one pinned local stdio MCP reader against one declared file. Network and effects are out of scope.',
    plan,
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  return aos.getRunTree(run.id).tasks[0];
}

test('a local MCP requires an engine probe, scoped grant, host_process disclosure, and produces redacted execution receipts', async () => {
  const { aos, projectId } = makeEngine();
  const capability = aos.capabilities.create(localCapabilityInput());
  assert.match(capability.runtime.command.sha256, /^[a-f0-9]{64}$/);
  assert.match(capability.runtime.argv[0].sha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => aos.capabilities.recordTest(capability.id, capability.version, { requestId: 'manual-pass', status: 'passed', summary: 'operator says it passed' }),
    (error) => error.code === 'invalid_input',
  );

  const probe = await apiActions(aos).capabilities.probe({
    id: capability.id,
    version: capability.version,
    input: { requestId: 'local-probe-v1', actor: 'operator' },
  });
  assert.equal(probe.status, 'passed');
  assert.match(probe.probeFingerprint, /^[a-f0-9]{16}$/);
  const replay = await apiActions(aos).capabilities.probe({
    id: capability.id,
    version: capability.version,
    input: { requestId: 'local-probe-v1', actor: 'operator' },
  });
  assert.deepEqual(replay, probe);
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project', scopeId: projectId, permissions: ['filesystem_read'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });

  const resolved = aos.capabilities.resolve(capability.reference, { projectId });
  const admitted = {
    id: 'local-read',
    worker: 'local',
    capabilities: { mcp: [capability.reference] },
    capabilityMounts: [resolved],
    capabilityExecution: { selector: 'first_declared_read_path', reference: capability.reference, timeoutMs: 500 },
    sandbox: 'host_process',
    readPaths: ['declared.txt'],
    network: false,
  };
  assert.equal(assertMcpTaskAdmission(admitted), true);
  assert.throws(() => assertMcpTaskAdmission({ ...admitted, sandbox: 'read_only' }), (error) => error.code === 'local_mcp_sandbox_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...admitted, network: { allowed: true, allowlist: [] } }), (error) => error.code === 'mcp_network_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...admitted, capabilityExecution: { ...admitted.capabilityExecution, argv: ['-e'] } }), (error) => error.code === 'mcp_execution_invalid');

  let workerCalls = 0;
  const worker = aos.workers.get('local');
  const execute = worker.execute.bind(worker);
  worker.execute = async (...args) => { workerCalls += 1; return execute(...args); };
  const task = await runPlan(aos, projectId, localPlan(capability));
  assert.equal(task.status, 'succeeded');
  assert.equal(workerCalls, 0);
  const artifact = JSON.parse(readFileSync(join(task.workspace, 'mcp-output.json'), 'utf8'));
  assert.equal(artifact.output, `local:${SAFE_SOURCE}`);

  const receipt = aos.state.capabilityExecutions.find((item) => item.id === task.capabilityExecutionReceipts[0]);
  assert.equal(receipt.adapter, 'local-mcp-stdio');
  assert.equal(receipt.tool, 'local.read_staged_text');
  assert.equal(receipt.effect, LOCAL_MCP_STDIO_EFFECT_CLASS);
  assert.equal(receipt.isolation, LOCAL_MCP_STDIO_ISOLATION);
  assert.match(receipt.launchFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(receipt).includes(FIXTURE), false);
  assert.equal(JSON.stringify(receipt).includes(process.execPath), false);
  assert.equal(JSON.stringify(receipt).includes(SAFE_SOURCE), false);
});

test('local MCP registration rejects dynamic launch vectors and non-staged tool schemas', () => {
  const { aos } = makeEngine();
  for (const runtime of [
    { ...localRuntime(), transport: 'http' },
    { ...localRuntime(), command: { path: process.execPath, env: { TOKEN: 'nope' } } },
    { ...localRuntime(), argv: [{ value: '-e' }, { value: 'process.exit(0)' }] },
    { ...localRuntime(), argv: [{ value: '-c' }, { value: 'anything' }] },
    { ...localRuntime(), tool: { name: 'local.read_staged_text', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  ]) {
    assert.throws(() => aos.capabilities.create(localCapabilityInput({ id: `bad-${Math.random().toString(36).slice(2, 8)}`, runtime })), (error) => error.code === 'invalid_input');
  }
  if (process.platform !== 'win32') {
    assert.throws(
      () => aos.capabilities.create(localCapabilityInput({ id: 'shell-launcher', runtime: localRuntime({ command: '/bin/sh' }) })),
      (error) => error.code === 'invalid_input',
    );
  }
  assert.throws(
    () => aos.capabilities.create(localCapabilityInput({ id: 'effectful-local', permissions: ['filesystem_read', 'network'] })),
    (error) => error.code === 'invalid_input',
  );
});

test('a changed pinned executable or absolute argv file is refused before local MCP spawn', async () => {
  const { aos } = makeEngine();
  const copiedServer = join(mkdtempSync(join(tmpdir(), 'aos-local-mcp-server-')), 'server.mjs');
  copyFileSync(FIXTURE, copiedServer);
  const capability = aos.capabilities.create(localCapabilityInput({ runtime: localRuntime({ server: copiedServer }) }));
  writeFileSync(copiedServer, 'process.exitCode = 0;\n', 'utf8');
  const workspace = mkdtempSync(join(tmpdir(), 'aos-local-mcp-workspace-'));
  writeFileSync(join(workspace, 'declared.txt'), SAFE_SOURCE, 'utf8');
  await assert.rejects(
    () => new LocalMcpStdioRuntime().execute({
      mount: mount(capability),
      scope: { projectId: 'prj_local', runId: 'run_local', taskId: 'tsk_local', agentId: 'engine', invocationId: 'local-pin', attempt: 1, harnessSessionId: null },
      workspaceDir: workspace,
      stagedFile: 'declared.txt',
      idempotencyKey: 'local-pin-1',
      timeoutMs: 500,
    }),
    (error) => error.code === 'local_mcp_installation_changed' && !JSON.stringify(error.receipt || {}).includes(copiedServer),
  );
});
