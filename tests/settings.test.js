import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { executeCommand } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';
import { SETTING_DEFINITIONS, SETTING_GROUPS, SETTINGS_EXPORT_FORMAT } from '../engine/settings.js';
import { RESOURCE_ROUTES } from '../engine/api.js';

const PROMPT = 'Settings objective with success criteria and a bounded scope.';

function engine(dataDir = mkdtempSync(join(tmpdir(), 'aos-settings-'))) {
  const aos = new AosEngine({ dataDir, concurrency: 2, memory: { globalDir: mkdtempSync(join(tmpdir(), 'aos-settings-global-')) } });
  aos.load();
  return aos;
}

async function withServer(aos, fn) {
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1' });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    await fn(http);
  } finally {
    await close();
  }
}

const cliJson = async (aos, command) => {
  const result = await executeCommand(aos, command);
  assert.equal(result.ok, true, `${command}: ${result.lines.join(' ')}`);
  return JSON.parse(result.lines.join('\n'));
};

test('the manifest describes every setting group, definition and registry for a dashboard', () => {
  const aos = engine();
  const manifest = aos.settings.manifest();
  assert.equal(manifest.groups.length, SETTING_GROUPS.length);
  assert.deepEqual(manifest.groups.map((group) => group.id), ['agents_roles', 'templates', 'swarms', 'models_harnesses', 'capabilities', 'memory', 'budgets_concurrency', 'approvals_safety', 'storage_retention', 'diagnostics']);
  const described = manifest.groups.flatMap((group) => group.settings);
  assert.equal(described.length, SETTING_DEFINITIONS.length);
  for (const setting of described) {
    assert.ok(setting.key && setting.description && setting.schema && Array.isArray(setting.scopes), `${setting.key} fully described`);
  }
  assert.deepEqual(Object.keys(manifest.registries), ['presets', 'templates', 'blueprints', 'memory', 'runs']);
  assert.equal(manifest.diagnostics.store.version, 2);
  assert.ok(manifest.inputSchemas.preset.fields.role.values.includes('lead'), 'registry input schemas are described');
  assert.ok(manifest.routes.some((route) => route.method === 'POST' && route.path === '/api/v1/memory/clear' && route.destructive.gate === 'approval'), 'destructive gates are declared');
  assert.ok(manifest.routes.some((route) => route.path === '/api/v1/presets/:id/preview'), 'route params are named');
  assert.deepEqual(manifest.enumerations.harnesses, ['local', 'codex', 'claude', 'api', 'ollama', 'command']);
  assert.ok(manifest.diagnostics.counts.presets >= 0);
  assert.ok(RESOURCE_ROUTES.length > 60);
});

test('settings layer with provenance: built-in, global, project, then a versioned run patch', async () => {
  const aos = engine();
  const project = aos.defaultProject().id;
  assert.deepEqual(aos.settings.effective('maxConcurrency', { projectId: project }).provenance.layer, 'builtin');
  aos.settings.set('maxConcurrency', 3, { scope: 'global' });
  const projectRecord = aos.settings.set('maxConcurrency', 5, { scope: 'project', scopeId: project });
  assert.equal(projectRecord.version, 1);
  const effective = aos.settings.effective('maxConcurrency', { projectId: project });
  assert.equal(effective.value, 5);
  assert.equal(effective.provenance.layer, 'project');
  assert.deepEqual(effective.layers.map((layer) => [layer.layer, layer.value]), [['builtin', 2], ['global', 3], ['project', 5]]);
  assert.equal(aos.settings.set('maxConcurrency', 6, { scope: 'project', scopeId: project }).version, 2);
  assert.equal(aos.settings.get('maxConcurrency', { scope: 'project', scopeId: project }).history.length, 2);

  const goal = aos.createGoal({ prompt: PROMPT });
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 1 });
  const patch = aos.settings.patchRun(run.id, { key: 'maxConcurrency', value: 4, reason: 'more workers' });
  assert.equal(patch.version, 1);
  assert.equal(aos.getRun(run.id).maxConcurrency, 4);
  const patched = aos.settings.effective('maxConcurrency', { projectId: project, runId: run.id });
  assert.equal(patched.value, 4);
  assert.equal(patched.provenance.layer, 'run');
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'run.patched' && event.payload.version === 1));
  assert.throws(() => aos.settings.patchRun(run.id, { key: 'retentionDays', value: 5 }), (error) => error.code === 'setting_not_run_patchable');
  assert.throws(() => aos.settings.patchRun(run.id, { key: 'maxConcurrency', value: 'many' }), (error) => error.code === 'invalid_input');
  aos.cancelRun(run.id);
  assert.throws(() => aos.settings.patchRun(run.id, { key: 'maxConcurrency', value: 2 }), (error) => error.code === 'run_terminal');
  assert.equal(aos.settings.runPatches(run.id).length, 1);

  assert.throws(() => aos.settings.set('maxConcurrency', 'many', { scope: 'global' }), (error) => error.code === 'invalid_input');
  assert.throws(() => aos.settings.set('maxConcurrency', 3, { scope: 'agent', scopeId: 'agt_x' }), (error) => error.code === 'setting_scope');
  assert.throws(() => aos.settings.set('execution.mode', 'codex', { scope: 'global' }), (error) => error.code === 'setting_read_only');
  assert.throws(() => aos.settings.get('nope', { scope: 'global' }), (error) => error.code === 'not_found');
  aos.settings.unset('maxConcurrency', { scope: 'global' });
  assert.equal(aos.settings.effective('maxConcurrency', {}).provenance.layer, 'builtin');
});

test('object settings merge across layers, preview does not persist, and memory policy shares the same records', () => {
  const aos = engine();
  const project = aos.defaultProject().id;
  aos.settings.set('memory', { enabled: true, maxItemsPerQuery: 4 }, { scope: 'global' });
  aos.memory.setPolicy('project', project, { maxItemsPerQuery: 2 });
  const effective = aos.settings.effective('memory', { projectId: project });
  assert.equal(effective.value.enabled, true);
  assert.equal(effective.value.maxItemsPerQuery, 2);
  assert.equal(aos.memory.policyFor({ project: { id: project } }).maxItemsPerQuery, 2, 'memory reads the same records');
  const preview = aos.settings.preview('memory', { enabled: false }, { scope: 'project', scopeId: project, context: { projectId: project } });
  assert.equal(preview.before.enabled, true);
  assert.equal(preview.after.enabled, false);
  assert.equal(aos.settings.effective('memory', { projectId: project }).value.enabled, true, 'preview did not persist');
  assert.equal(aos.settings.get('memory', { scope: 'project', scopeId: project }).version, 1);
  const payload = aos.settings.exportSettings();
  assert.equal(payload.format, SETTINGS_EXPORT_FORMAT);
  const target = engine();
  const report = target.settings.importSettings({ ...payload, settings: payload.settings.map((item) => item.scope === 'project' ? { ...item, scopeId: target.defaultProject().id } : item) });
  assert.equal(report.errors.length, 0);
  assert.equal(target.settings.effective('memory', { projectId: target.defaultProject().id }).value.maxItemsPerQuery, 2);
  const reloaded = engine(target.store.dataDir);
  assert.equal(reloaded.settings.list().length, 2);
});

test('CLI and HTTP are two doors to the same actions with identical validation', async () => {
  const aos = engine();
  const project = aos.defaultProject().id;
  await withServer(aos, async (http) => {
    // settings
    const manifestHttp = await http('GET', '/api/v1/settings/manifest');
    const manifestCli = await cliJson(aos, 'settings manifest');
    assert.deepEqual(manifestHttp.body.groups.map((group) => group.id), manifestCli.groups.map((group) => group.id));
    assert.equal((await http('PUT', '/api/v1/settings/maxRetries', { scope: 'project', scopeId: project, value: 3 })).status, 200);
    assert.equal((await cliJson(aos, `settings get maxRetries --scope project --scope-id ${project}`)).value, 3);
    assert.equal((await cliJson(aos, `settings effective maxRetries --project ${project}`)).provenance.layer, 'project');
    const bad = await http('PUT', '/api/v1/settings/maxRetries', { scope: 'project', scopeId: project, value: 'lots' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_input');
    const badCli = await executeCommand(aos, `settings set maxRetries lots --scope project --scope-id ${project}`);
    assert.equal(badCli.ok, false);
    assert.match(badCli.lines[0], /failed validation/);
    assert.equal((await http('GET', '/api/v1/settings/nope')).status, 404);

    // presets: create over HTTP, read over CLI, preview both ways
    const created = await http('POST', '/api/v1/presets', { input: { id: 'http-worker', name: 'HTTP worker', role: 'worker', extends: { id: 'general-worker' }, sections: { Mission: 'Created over HTTP.' } } });
    assert.equal(created.status, 201);
    assert.equal((await cliJson(aos, 'preset show http-worker')).version, 1);
    const previewHttp = await http('POST', '/api/v1/presets/http-worker/preview', { variables: { goal: 'g', run_id: 'r', task_key: 't', task_nonce: 'n', brief: 'b' } });
    const previewCli = await executeCommand(aos, 'preset preview http-worker --var goal=g --var run_id=r --var task_key=t --var task_nonce=n --var brief=b');
    assert.equal(previewHttp.body.text, previewCli.lines.join('\n'));
    assert.equal((await http('GET', '/api/v1/presets/export')).body.presets.length, 1);
    assert.equal((await cliJson(aos, 'preset list')).some((item) => item.id === 'http-worker'), true);

    // templates: create over CLI, read over HTTP, save from task over CLI
    await cliJson(aos, 'template create --json {"id":"cli-template","name":"CLI template","config":{"preset":{"id":"http-worker"},"harness":{"id":"local"}}}');
    assert.equal((await http('GET', '/api/v1/templates/cli-template')).body.config.preset.id, 'http-worker');
    assert.equal((await http('GET', '/api/v1/templates/cli-template/history')).body.length, 1);
    const invalidTemplate = await http('POST', '/api/v1/templates/validate', { input: { id: 'x', name: 'x', config: { preset: { id: 'ghost' }, harness: { id: 'local' } } } });
    assert.equal(invalidTemplate.body.ok, false);
    assert.equal(invalidTemplate.body.errors[0].code, 'not_found');

    // blueprints: estimate both ways
    const estimateHttp = await http('GET', '/api/v1/blueprints/default-research-swarm/estimate?depth=2');
    const estimateCli = await cliJson(aos, 'blueprint estimate default-research-swarm --depth 2');
    assert.deepEqual(estimateHttp.body.levels, estimateCli.levels);
    assert.equal((await http('GET', '/api/v1/blueprints/ghost/effective')).status, 404);

    // memory: policy and items through both doors
    assert.equal((await http('PUT', '/api/v1/memory/policy', { scope: 'global', value: { enabled: true } })).status, 200);
    await cliJson(aos, `memory policy set --scope project --scope-id ${project} --json {"enabled":true}`);
    const added = await http('POST', '/api/v1/memory/items', { scope: 'project', namespace: project, input: { type: 'fact', title: 'HTTP fact', content: 'Coupling fact added over HTTP.', tags: ['coupling'] } });
    assert.equal(added.status, 201);
    const found = await cliJson(aos, 'memory search --query coupling');
    assert.equal(found.items[0].id, added.body.id);
    assert.equal((await cliJson(aos, `memory show ${added.body.id}`)).title, 'HTTP fact');
    assert.equal((await http('GET', `/api/v1/memory/items/${added.body.id}`)).body.title, 'HTTP fact');
    assert.equal((await http('GET', '/api/v1/memory/stats')).body.scopes.project.committed, 1);
    const cleared = await cliJson(aos, `memory clear project ${project}`);
    assert.equal(cleared.proposed, true);
    const approved = await executeCommand(aos, `approve ${cleared.proposalId}`);
    assert.equal(approved.ok, true, approved.lines.join(' '));
    assert.match(approved.lines[1], /applied true/);
    assert.equal((await http('GET', '/api/v1/memory/stats')).body.scopes.project?.committed ?? 0, 0, 'approval cleared the scope');
    const second = await cliJson(aos, `memory clear project ${project}`);
    const viaHttp = await http('POST', `/api/v1/proposals/${second.proposalId}/approve`, {});
    assert.equal(viaHttp.status, 200);
    assert.equal(viaHttp.body.run, null);

    // runs: patch over CLI, list over HTTP
    const goal = aos.createGoal({ prompt: PROMPT });
    const run = aos.startRun({ goalId: goal.id });
    const patch = await cliJson(aos, `run patch ${run.id} maxConcurrency 7 --reason "parity test"`);
    assert.equal(patch.version, 1);
    assert.deepEqual((await http('GET', `/api/v1/runs/${run.id}/patches`)).body.map((item) => item.value), [7]);
    assert.equal(aos.getRun(run.id).maxConcurrency, 7);
    const unknownRoute = await http('GET', '/api/v1/nothing/here');
    assert.equal(unknownRoute.status, 404);
    assert.equal(unknownRoute.body.code, 'not_found');
  });
});
