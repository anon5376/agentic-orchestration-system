import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { ModelControlService } from '../engine/model-control.js';
import { createAosServer } from '../engine/http.js';

function engine() {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-model-control-')) });
  aos.load();
  return aos;
}

function control(aos) {
  return new ModelControlService({ engine: aos });
}

function allow(aos, harnesses, models = { codex: ['gpt-5.6-luna'] }, defaultEffort = null) {
  const projectId = aos.defaultProject().id;
  aos.settings.set('execution.allowedHarnesses', harnesses, { scope: 'project', scopeId: projectId });
  aos.settings.set('execution.allowedModels', models, { scope: 'project', scopeId: projectId });
  if (defaultEffort !== null) aos.settings.set('execution.defaultEffort', defaultEffort, { scope: 'project', scopeId: projectId });
  return projectId;
}

function customTemplate(aos, id = 'custom-worker', config = {}) {
  return aos.templates.create({
    id,
    name: 'Custom worker',
    description: 'A test template with explicit non-harness configuration.',
    config: {
      preset: { id: 'general-worker' },
      harness: { id: 'local' },
      ...config,
    },
  });
}

test('snapshot separates policy, adapter truth, and template worker assignment', () => {
  const aos = engine();
  const snapshot = control(aos).snapshot();

  assert.deepEqual(snapshot.allowedHarnesses, ['local', 'codex', 'claude']);
  assert.deepEqual(snapshot.allowedModels, { codex: ['gpt-5.6-terra', 'gpt-5.6-luna'], claude: ['opus'] });
  assert.equal(snapshot.defaultEffort, null);
  assert.equal(snapshot.execution.mode, 'local');
  assert.equal(snapshot.policy.effective.allowedHarnesses.provenance.layer, 'builtin');

  const local = snapshot.providers.find((item) => item.id === 'local');
  assert.equal(local.implementation.implemented, true);
  assert.equal(local.live.ready, true);
  assert.equal(local.configured, true);
  assert.equal(local.auth.type, 'none');
  assert.equal(local.runnable, true);

  const codex = snapshot.providers.find((item) => item.id === 'codex');
  assert.equal(codex.implementation.implemented, true);
  assert.equal(codex.configured, false);
  assert.equal(codex.runnable, false);
  assert.equal(codex.status, 'not_configured');

  const claude = snapshot.providers.find((item) => item.id === 'claude');
  assert.equal(claude.implementation.implemented, true);
  assert.equal(claude.runnable, false);
  assert.equal(claude.status, 'not_configured');

  const worker = snapshot.assignments.find((item) => item.templateId === 'default-worker');
  assert.equal(worker.harness, 'local');
  assert.equal(worker.status, 'available');
  assert.equal(worker.runnable, true);
  assert.equal(snapshot.templates.find((item) => item.id === 'default-worker').assignment.status, 'available');
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('built-in assignment forks to the supplied id/name and versions the fork at one', () => {
  const aos = engine();
  const source = aos.templates.get('default-worker');
  const result = control(aos).assign({
    templateId: 'default-worker',
    harness: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'max',
    fork: { id: 'codex-worker', name: 'Codex worker' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, 'fork');
  assert.equal(result.template.id, 'codex-worker');
  assert.equal(result.template.version, 1);
  assert.equal(result.template.name, 'Codex worker');
  assert.deepEqual(result.template.forkedFrom, { id: source.id, version: source.version });
  assert.deepEqual(result.template.config.harness, { id: 'codex', model: 'gpt-5.6-luna', effort: 'max', fallback: [] });
  assert.deepEqual(aos.templates.get('codex-worker').config.harness, result.template.config.harness);
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'template.assigned' && event.payload.templateId === 'codex-worker'));
});

test('manager assignments bind Terra/max and refuse a worker profile', () => {
  const aos = engine();
  const service = control(aos);
  const result = service.assign({
    templateId: 'default-branch-manager',
    harness: 'codex',
    model: 'gpt-5.6-terra',
    effort: 'max',
    fork: { id: 'codex-manager', name: 'Codex manager' },
  });
  assert.deepEqual(result.template.config.harness, { id: 'codex', model: 'gpt-5.6-terra', effort: 'max', fallback: [] });
  assert.deepEqual(result.assignment.roleRuntime, {
    role: 'branch-manager', class: 'manager', model: 'gpt-5.6-terra', effort: 'max',
  });
  assert.throws(
    () => service.assign({ templateId: 'codex-manager', harness: 'codex', model: 'gpt-5.6-luna', effort: 'max' }),
    (error) => error.code === 'role_runtime_violation' && error.statusCode === 409,
  );
});

test('a failed built-in fork leaves no forked template in memory or the registry', () => {
  const aos = engine();
  const service = control(aos);
  const originalRecordEvent = aos.recordEvent.bind(aos);
  aos.recordEvent = (type, fields) => {
    if (type === 'template.assigned') throw new Error('injected assignment failure');
    return originalRecordEvent(type, fields);
  };

  assert.throws(
    () => service.assign({
      templateId: 'default-worker',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
      fork: { id: 'failed-codex-worker', name: 'Failed Codex worker' },
    }),
    /injected assignment failure/,
  );
  assert.equal(aos.state.templates.some((item) => item.id === 'failed-codex-worker'), false);
  assert.equal(aos.store.readEventLog().some((event) => event.payload?.templateId === 'failed-codex-worker'), false);
  assert.throws(
    () => aos.templates.get('failed-codex-worker'),
    (error) => error.code === 'not_found' && error.statusCode === 404,
  );
  const reloaded = new AosEngine({ dataDir: aos.store.dataDir });
  reloaded.load();
  assert.throws(
    () => reloaded.templates.get('failed-codex-worker'),
    (error) => error.code === 'not_found' && error.statusCode === 404,
  );
  assert.equal(reloaded.store.readEventLog().some((event) => event.payload?.templateId === 'failed-codex-worker'), false);
});

test('custom assignment creates a new version and preserves every non-harness field', () => {
  const aos = engine();
  allow(aos, ['local', 'codex', 'command'], { codex: ['gpt-5.6-luna'], command: ['shell-model'] });
  const source = customTemplate(aos, 'versioned-worker', {
    harness: { id: 'local', model: null, effort: null, fallback: [{ id: 'local', model: null }] },
    capabilities: { skills: ['source-skill'], mcp: ['source-mcp'], plugins: ['source-plugin'], tools: ['source-tool'] },
    filesystem: { sandbox: 'read_only', readPaths: ['notes/'], writePaths: [] },
    network: { allowed: false, allowlist: [] },
    memory: { read: true, write: false, scopes: ['project'], retentionDays: 90 },
    context: { inputs: ['goal', 'brief'], maxTokens: 2048 },
    output: { contract: 'worker_output_v2', maxFindings: 17, maxSummaryWords: 300 },
    delegation: { mayDelegate: false, maxChildren: 0, maxDepth: 0, childTemplates: [] },
    concurrency: 3,
    retry: { maxRetries: 4 },
    timeoutMs: 12_000,
    budget: { tokens: 9_000, usd: 1.2, timeMs: 60_000 },
    escalation: { target: 'operator' },
    termination: { criteria: ['keep the evidence bounded'], stopOnBudget: false },
    variables: { source_label: 'kept' },
  });
  const nonHarness = (config) => {
    const copy = structuredClone(config);
    delete copy.harness;
    return copy;
  };

  const result = control(aos).assign({ templateId: source.id, harness: 'command', model: 'shell-model', effort: 'shell-effort' });
  assert.equal(result.operation, 'version');
  assert.equal(result.template.id, source.id);
  assert.equal(result.template.version, 2);
  assert.equal(result.template.parentVersion, 1);
  assert.deepEqual(nonHarness(result.template.config), nonHarness(source.config));
  assert.deepEqual(result.template.config.harness, {
    id: 'command', model: 'shell-model', effort: 'shell-effort', fallback: [{ id: 'local', model: null }],
  });
  assert.equal(aos.templates.history(source.id).length, 2);
});

test('pending adapter assignment is persisted and never labeled runnable', () => {
  const aos = engine();
  allow(aos, ['local', 'api'], { api: ['api-model'] });
  const source = customTemplate(aos, 'pending-worker');
  const result = control(aos).assign({ templateId: source.id, harness: 'api', model: 'api-model', effort: 'high' });

  assert.equal(result.ok, true);
  assert.equal(result.pendingAdapter, true);
  assert.equal(result.assignment.status, 'pending_adapter');
  assert.equal(result.assignment.runnable, false);
  assert.equal(result.adapter.implementation.implemented, false);
  assert.equal(result.adapter.configured, false);
  assert.equal(result.adapter.auth.type, 'unsupported_oauth');
  assert.equal(result.template.config.harness.id, 'api');

  const snapshot = control(aos).snapshot();
  const assignment = snapshot.assignments.find((item) => item.templateId === source.id);
  assert.equal(assignment.status, 'pending_adapter');
  assert.equal(assignment.runnable, false);
  assert.equal(assignment.adapter.implementation.implemented, false);
});

test('assignment rejects missing ids, invalid fork requests, malformed input, policy violations, and hard Codex widening', () => {
  const aos = engine();
  const service = control(aos);
  assert.throws(
    () => service.assign({ templateId: 'missing-template', harness: 'local' }),
    (error) => error.code === 'not_found' && error.statusCode === 404,
  );
  assert.throws(
    () => service.assign({ templateId: 'default-worker', harness: 'local' }),
    (error) => error.code === 'invalid_fork' && error.statusCode === 400,
  );
  assert.throws(
    () => service.assign({ templateId: 'default-worker', harness: 'local', fork: { id: 'fork-without-name' } }),
    (error) => error.code === 'invalid_fork' && error.statusCode === 400,
  );
  const source = customTemplate(aos, 'rejection-worker');
  assert.throws(
    () => service.assign({ templateId: source.id }),
    (error) => error.code === 'invalid_input' && error.statusCode === 400,
  );
  assert.throws(
    () => service.assign({ templateId: source.id, harness: 'claude', model: 'claude-model' }),
    (error) => error.code === 'assignment_not_allowed' && error.statusCode === 409,
  );

  allow(aos, ['local', 'codex'], { codex: ['gpt-5.6-sol'] });
  assert.throws(
    () => service.assign({ templateId: source.id, harness: 'codex', model: 'gpt-5.6-sol', effort: 'max' }),
    (error) => error.code === 'role_runtime_violation' && error.statusCode === 409,
  );
  assert.equal(aos.templates.history(source.id).length, 1, 'rejected assignments do not create versions');
});

test('model control HTTP routes expose one truthful snapshot and one validated assignment seam', async () => {
  const aos = engine();
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const snapshotResponse = await fetch(`${base}/models`);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshotResponse.status, 200);
    assert.deepEqual(snapshot.constraints.codex.models, ['gpt-5.6-terra', 'gpt-5.6-luna']);
    assert.equal(snapshot.providers.find((item) => item.id === 'local').runnable, true);

    const assignmentResponse = await fetch(`${base}/models/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'default-worker',
        harness: 'codex',
        model: 'gpt-5.6-luna',
        effort: 'max',
        fork: { id: 'http-codex-worker', name: 'HTTP Codex worker' },
      }),
    });
    const assignment = await assignmentResponse.json();
    assert.equal(assignmentResponse.status, 201);
    assert.equal(assignment.operation, 'fork');
    assert.equal(assignment.template.version, 1);

    const rejectedResponse = await fetch(`${base}/models/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: 'http-codex-worker',
        harness: 'codex',
        model: 'not-mounted',
        effort: 'max',
      }),
    });
    assert.equal(rejectedResponse.status, 409);
    assert.equal((await rejectedResponse.json()).code, 'role_runtime_violation');
  } finally {
    await close();
  }
});
