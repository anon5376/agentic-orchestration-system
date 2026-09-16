import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';
import { dispatch } from '../engine/cli.js';

function engine() {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-capabilities-')) });
  aos.load();
  return aos;
}

function input(overrides = {}) {
  return {
    id: 'source-reader',
    kind: 'skill',
    name: 'Source reader',
    description: 'Reads one bounded local source.',
    source: { type: 'local', reference: 'capabilities/source-reader' },
    permissions: ['filesystem_read'],
    test: { required: true, protocol: 'operator_receipt', description: 'Read a fixture and return its fingerprint.' },
    ...overrides,
  };
}

test('capabilities are versioned and require a current passing test plus explicit permission', () => {
  const aos = engine();
  const projectId = aos.defaultProject().id;
  const created = aos.capabilities.create(input());
  assert.equal(created.reference, 'source-reader@1');
  assert.equal(created.tested, false);
  assert.throws(() => aos.capabilities.resolve(created.reference, { projectId }), (error) => error.code === 'capability_untested');

  aos.capabilities.recordTest(created.id, created.version, { requestId: 'test-source-reader-v1', status: 'passed', summary: 'Fixture fingerprint matched.' });
  aos.capabilities.setPermission(created.id, created.version, 'grant', { scope: 'project', scopeId: projectId, permissions: ['filesystem_read'] });
  aos.settings.set('capabilities.enabled', [created.reference], { scope: 'project', scopeId: projectId });
  const resolved = aos.capabilities.resolve(created.reference, { projectId });
  assert.equal(resolved.reference, created.reference);
  assert.ok(resolved.testReceiptId);
  assert.ok(resolved.permissionId);

  const edited = aos.capabilities.edit(created.id, { description: 'Reads a bounded source and records provenance.' });
  assert.equal(edited.version, 2);
  assert.equal(edited.tested, false);
  assert.equal(aos.capabilities.get(created.id, 1).description, 'Reads one bounded local source.');
  assert.throws(() => aos.capabilities.resolve(edited.reference, { projectId }), (error) => error.code === 'capability_untested');
});

test('revocation blocks future dispatch before workspace claim and preserves the prior mount receipt', async () => {
  const aos = engine();
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create(input());
  aos.capabilities.recordTest(capability.id, capability.version, { requestId: 'test-dispatch-capability', status: 'passed', summary: 'Fixture passed.' });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', { scope: 'project', scopeId: projectId, permissions: ['filesystem_read'] });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });

  const goal = aos.createGoal({
    projectId,
    prompt: 'Check one local source. Success is two bounded outputs. Scope excludes network access.',
    plan: {
      title: 'Capability dispatch gate',
      tasks: [
        { id: 'first', title: 'First read', kind: 'research', worker: 'local', capabilities: { skills: [capability.reference] } },
        { id: 'second', title: 'Second read', kind: 'research', worker: 'local', capabilities: { skills: [capability.reference] } },
      ],
      dependencies: [{ taskId: 'second', dependsOnTaskId: 'first' }],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { steps: 1 });
  const first = aos.getRunTree(run.id).tasks.find((item) => item.planTaskId === 'first');
  assert.equal(first.status, 'succeeded');
  assert.equal(first.capabilityMounts[0].reference, capability.reference);
  const firstMount = structuredClone(first.capabilityMounts);

  aos.capabilities.setState(capability.id, capability.version, 'revoked', { reason: 'operator revoked future use' });
  await aos.advanceRun(run.id, { untilIdle: true });
  const tasks = aos.getRunTree(run.id).tasks;
  const second = tasks.find((item) => item.planTaskId === 'second');
  assert.equal(second.status, 'failed');
  assert.equal(second.errorCode, 'capability_revoked');
  assert.equal(second.workspace, null);
  assert.deepEqual(tasks.find((item) => item.planTaskId === 'first').capabilityMounts, firstMount);
  assert.equal(existsSync(join(aos.store.workspacesDir, run.id, second.id)), false);
});

test('an approved exact mounted tool executes through the bounded adapter and stores only a redacted receipt', async () => {
  const aos = engine();
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create(input({
    id: 'bounded-echo',
    kind: 'tool',
    source: { type: 'generated', reference: 'aos.bounded-echo-v1' },
  }));
  aos.capabilities.recordTest(capability.id, capability.version, { requestId: 'test-bounded-echo', status: 'passed', summary: 'Deterministic adapter fixture passed.' });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', { scope: 'project', scopeId: projectId, permissions: ['filesystem_read'] });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });
  const goal = aos.createGoal({
    projectId,
    prompt: 'Run the one bounded capability.',
    plan: {
      title: 'Bounded capability execution',
      tasks: [{
        id: 'invoke', title: 'Invoke bounded tool', kind: 'research', worker: 'local',
        capabilities: { tools: [capability.reference] },
        capabilityExecution: true,
      }], dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = aos.getRunTree(run.id).tasks[0];
  assert.equal(task.status, 'succeeded');
  assert.equal(task.capabilityExecutionReceipts.length, 1);
  const receipt = aos.state.capabilityExecutions.find((item) => item.id === task.capabilityExecutionReceipts[0]);
  assert.equal(receipt.reference, capability.reference);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(JSON.stringify(receipt).includes('bounded-echo-v1'), false);
  assert.equal(receipt.scope.taskId, task.id);
  const reloaded = new AosEngine({ dataDir: aos.store.dataDir });
  reloaded.load();
  assert.deepEqual(reloaded.state.capabilityExecutions, aos.state.capabilityExecutions);
});

test('capability HTTP routes share immutable test and permission records', async () => {
  const aos = engine();
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const createdResponse = await fetch(`${base}/capabilities`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: input() }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const testResponse = await fetch(`${base}/capabilities/${created.id}/tests`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, input: { requestId: 'http-capability-test', status: 'passed', summary: 'HTTP fixture passed.' } }),
    });
    assert.equal(testResponse.status, 201);
    assert.equal((await testResponse.json()).status, 'passed');

    const permissionResponse = await fetch(`${base}/capabilities/${created.id}/permissions/grant`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, input: { scope: 'project', scopeId: aos.defaultProject().id, permissions: ['filesystem_read'] } }),
    });
    assert.equal(permissionResponse.status, 201);
    assert.equal((await permissionResponse.json()).action, 'grant');

    const history = await fetch(`${base}/capabilities/${created.id}/history`).then((response) => response.json());
    assert.equal(history.length, 1);
    assert.equal(history[0].tested, true);
    const cliView = JSON.parse((await dispatch(aos, ['capability', 'show', created.id, '--version', '1'])).join('\n'));
    assert.equal(cliView.reference, 'source-reader@1');
  } finally {
    await close();
  }
});

test('stale engines cannot duplicate capability identities or overwrite a version head', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-capability-race-'));
  const first = new AosEngine({ dataDir });
  const second = new AosEngine({ dataDir });
  first.load();
  second.load();

  first.capabilities.create(input());
  assert.throws(
    () => second.capabilities.create(input()),
    (error) => error.code === 'capability_exists' && error.statusCode === 409,
  );

  first.capabilities.edit('source-reader', { baseVersion: 1, description: 'First version-two candidate.' });
  assert.throws(
    () => second.capabilities.edit('source-reader', { baseVersion: 1, description: 'Stale version-two candidate.' }),
    (error) => error.code === 'capability_version_conflict' && error.details.currentVersion === 2,
  );
  assert.deepEqual(second.capabilities.history('source-reader').map((item) => item.version), [1, 2]);
});
