import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import {
  BUILTIN_MCP_STAGED_TEXT_RUNTIME,
  BUILTIN_MCP_STAGED_TEXT_SOURCE,
} from '../engine/capabilities.js';

const SAFE_SOURCE = 'bounded-reader-content-7f0e4d1c';

function makeEngine() {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-mcp-execution-'));
  const projectReadRoot = mkdtempSync(join(tmpdir(), 'aos-mcp-read-root-'));
  mkdirSync(join(projectReadRoot, 'fixtures'), { recursive: true });
  const sourcePath = join(projectReadRoot, 'fixtures', 'declared.txt');
  writeFileSync(sourcePath, SAFE_SOURCE, 'utf8');
  const aos = new AosEngine({ dataDir, projectReadRoot });
  aos.load();
  const projectId = aos.defaultProject().id;
  return { aos, projectId, sourcePath };
}

function createMcp(aos, projectId) {
  const capability = aos.capabilities.create({
    id: 'staged-reader',
    kind: 'mcp',
    name: 'Staged text reader',
    description: 'Reads one declared staged text path.',
    source: { ...BUILTIN_MCP_STAGED_TEXT_SOURCE },
    runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME },
    permissions: ['filesystem_read'],
    test: {
      required: true,
      protocol: 'schema_check',
      description: 'Read one bounded fixture through the staged reader contract.',
    },
  });
  aos.capabilities.recordTest(capability.id, capability.version, {
    requestId: 'mcp-execution-test',
    status: 'passed',
    summary: 'The staged reader contract passed.',
  });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project',
    scopeId: projectId,
    permissions: ['filesystem_read'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], {
    scope: 'project',
    scopeId: projectId,
  });
  return capability;
}

function mcpPlan(capability, task = {}) {
  return {
    title: 'Engine MCP execution',
    tasks: [{
      id: 'read',
      key: 'read',
      title: 'Read declared fixture',
      kind: 'research',
      worker: 'local',
      capabilities: { mcp: [capability.reference] },
      capabilityExecution: {
        selector: 'first_declared_read_path',
        reference: capability.reference,
        timeoutMs: 500,
      },
      sandbox: 'read_only',
      readPaths: ['fixtures/declared.txt'],
      ...task,
    }],
    dependencies: [],
  };
}

async function runPlan(aos, projectId, plan) {
  const goal = aos.createGoal({
    projectId,
    prompt: 'Read one bounded fixture. Success is the exact staged text. Scope excludes network access.',
    plan,
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  return { run, task: aos.getRunTree(run.id).tasks[0] };
}

test('engine MCP success bypasses the model worker and keeps state hash-only', async () => {
  const { aos, projectId } = makeEngine();
  const capability = createMcp(aos, projectId);
  let workerCalls = 0;
  const worker = aos.workers.get('local');
  const originalExecute = worker.execute.bind(worker);
  worker.execute = async (...args) => {
    workerCalls += 1;
    return originalExecute(...args);
  };

  const { task } = await runPlan(aos, projectId, mcpPlan(capability));
  assert.equal(task.status, 'succeeded');
  assert.equal(workerCalls, 0, 'capabilityExecution owns the task; no provider worker runs');
  assert.deepEqual(task.output.artifacts, ['mcp-output.json']);

  const artifact = JSON.parse(readFileSync(join(task.workspace, 'mcp-output.json'), 'utf8'));
  assert.equal(artifact.output, SAFE_SOURCE);
  assert.match(artifact.outputFingerprint, /^[a-f0-9]{16}$/);

  const receipt = aos.state.capabilityExecutions.find((item) => item.id === task.capabilityExecutionReceipts[0]);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.installation, 'aos.staged-text-reader');
  assert.equal(receipt.tool, 'aos.read_staged_text');
  assert.equal(receipt.effect, 'read_only');
  assert.match(receipt.sourceFingerprint, /^[a-f0-9]{16}$/);
  assert.match(receipt.outputFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(receipt).includes(SAFE_SOURCE), false);
  assert.equal(JSON.stringify(receipt).includes('declared.txt'), false);

  const stateAndEvents = JSON.stringify({ state: aos.state, events: aos.store.readEventLog() });
  assert.equal(stateAndEvents.includes(SAFE_SOURCE), false);
  assert.equal(stateAndEvents.includes('mcp-output.json'), true);
});

test('MCP capability revocation during pre-spawn revalidation fails closed', async () => {
  const { aos, projectId } = makeEngine();
  const capability = createMcp(aos, projectId);
  let workerCalls = 0;
  const worker = aos.workers.get('local');
  const originalExecute = worker.execute.bind(worker);
  worker.execute = async (...args) => {
    workerCalls += 1;
    return originalExecute(...args);
  };

  const originalResolve = aos.capabilities.resolve.bind(aos.capabilities);
  let resolveCalls = 0;
  aos.capabilities.resolve = (reference, context) => {
    resolveCalls += 1;
    if (resolveCalls === 2) {
      aos.capabilities.setState(capability.id, capability.version, 'revoked', { reason: 'test revocation before spawn' });
    }
    return originalResolve(reference, context);
  };

  const { task } = await runPlan(aos, projectId, mcpPlan(capability));
  assert.equal(resolveCalls, 2, 'dispatch resolves the mount and re-resolves immediately before spawn');
  assert.equal(task.status, 'failed');
  assert.equal(task.errorCode, 'capability_revoked');
  assert.equal(workerCalls, 0);
  assert.equal(existsSync(join(task.workspace, 'mcp-output.json')), false);
  const receipt = aos.state.capabilityExecutions.find((item) => item.id === task.capabilityExecutionReceipts[0]);
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.errorCode, 'capability_revoked');
  assert.equal(JSON.stringify(receipt).includes(SAFE_SOURCE), false);
});

test('bounded echo remains available through the engine capability path', async () => {
  const { aos, projectId } = makeEngine();
  const capability = aos.capabilities.create({
    id: 'bounded-echo',
    kind: 'tool',
    name: 'Bounded echo',
    description: 'Deterministic bounded echo adapter.',
    source: { type: 'generated', reference: 'aos.bounded-echo-v1' },
    permissions: ['filesystem_read'],
    test: {
      required: true,
      protocol: 'schema_check',
      description: 'The deterministic adapter contract passed.',
    },
  });
  aos.capabilities.recordTest(capability.id, capability.version, {
    requestId: 'bounded-echo-execution-test',
    status: 'passed',
    summary: 'The deterministic adapter passed.',
  });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project',
    scopeId: projectId,
    permissions: ['filesystem_read'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], {
    scope: 'project',
    scopeId: projectId,
  });
  let workerCalls = 0;
  const worker = aos.workers.get('local');
  const originalExecute = worker.execute.bind(worker);
  worker.execute = async (...args) => {
    workerCalls += 1;
    return originalExecute(...args);
  };

  const { task } = await runPlan(aos, projectId, {
    title: 'Bounded echo regression',
    tasks: [{
      id: 'echo',
      key: 'echo',
      title: 'Run bounded echo',
      kind: 'research',
      worker: 'local',
      capabilities: { tools: [capability.reference] },
      capabilityExecution: true,
    }],
    dependencies: [],
  });
  assert.equal(task.status, 'succeeded');
  assert.equal(workerCalls, 1);
  const receipt = aos.state.capabilityExecutions.find((item) => item.id === task.capabilityExecutionReceipts[0]);
  assert.equal(receipt.adapter, 'bounded-echo');
  assert.equal(receipt.status, 'succeeded');
  assert.equal(task.output.artifacts.includes('finding.json'), true);
});
