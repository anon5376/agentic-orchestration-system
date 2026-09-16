import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../engine/ids.js';
import { AosEngine } from '../engine/engine.js';
import {
  assertMcpTaskAdmission,
  BUILTIN_MCP_STAGED_TEXT_INSTALLATION,
  BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR,
  BUILTIN_MCP_STAGED_TEXT_RUNTIME,
  BUILTIN_MCP_STAGED_TEXT_SOURCE,
  MCP_PROTOCOL_VERSION,
} from '../engine/capabilities.js';
import { TEMPLATE_CONFIG_SCHEMA, TemplateRegistry } from '../engine/templates.js';
import { check } from '../engine/schema.js';

function engine() {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-mcp-registry-')) });
  aos.load();
  return aos;
}

function mcpInput(overrides = {}) {
  return {
    id: 'staged-reader',
    kind: 'mcp',
    name: 'Staged text reader',
    description: 'Reads one declared staged text path.',
    source: { ...BUILTIN_MCP_STAGED_TEXT_SOURCE },
    runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME },
    permissions: ['filesystem_read'],
    test: { required: true, protocol: 'schema_check', description: 'Read a declared fixture through the staged reader contract.' },
    ...overrides,
  };
}

function mountedTask(capability, mount) {
  return {
    id: 'read-task',
    capabilities: { mcp: [capability.reference] },
    capabilityMounts: [mount],
    capabilityExecution: { selector: 'first_declared_read_path', reference: capability.reference, timeoutMs: 250 },
    sandbox: 'read_only',
    readPaths: ['fixtures/declared.txt'],
    network: { allowed: false, allowlist: [] },
  };
}

function resolvedMcp(aos) {
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create(mcpInput());
  aos.capabilities.recordTest(capability.id, capability.version, { requestId: 'mcp-registry-test', status: 'passed', summary: 'The staged reader fixture passed.' });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', { scope: 'project', scopeId: projectId, permissions: ['filesystem_read'] });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });
  return { capability, mount: aos.capabilities.resolve(capability.reference, { projectId }) };
}

test('the builtin MCP source, runtime, and installation descriptor are code-owned and exact', () => {
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION, 'aos.staged-text-reader@1');
  assert.equal(MCP_PROTOCOL_VERSION, '2024-11-05');
  assert.deepEqual(BUILTIN_MCP_STAGED_TEXT_RUNTIME, {
    transport: 'stdio',
    installation: BUILTIN_MCP_STAGED_TEXT_INSTALLATION,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tool: 'aos.read_staged_text',
    effectClass: 'read_only',
    inputSelector: 'first_declared_read_path',
  });
  assert.equal(Object.isFrozen(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR), true);
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.command, process.execPath);
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.argv.length, 1);
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.argv[0].startsWith('/'), true);
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.tool, 'aos.read_staged_text');
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.effectClass, 'read_only');
  assert.equal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.args, BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR.argv);
});

test('MCP creation and version views retain the immutable runtime and fingerprint it', () => {
  const aos = engine();
  const created = aos.capabilities.create(mcpInput());
  assert.deepEqual(created.runtime, BUILTIN_MCP_STAGED_TEXT_RUNTIME);
  assert.deepEqual(aos.capabilities.get(created.id, 1).runtime, BUILTIN_MCP_STAGED_TEXT_RUNTIME);
  const withoutRuntime = JSON.stringify({
    id: created.id,
    version: created.version,
    kind: created.kind,
    name: created.name,
    description: created.description,
    source: created.source,
    permissions: created.permissions,
    test: created.test,
  });
  assert.notEqual(created.fingerprint, fingerprint(withoutRuntime));

  const version = aos.capabilities.edit(created.id, { description: 'Reads exactly one declared staged path.' });
  assert.equal(version.version, 2);
  assert.deepEqual(version.runtime, created.runtime);
  assert.notEqual(version.fingerprint, created.fingerprint);
  assert.deepEqual(aos.capabilities.history(created.id).map((item) => item.runtime), [created.runtime, version.runtime]);
});

test('MCP creation rejects non-builtin sources, process configuration, alternate runtime, and effectful permissions', () => {
  const aos = engine();
  for (const source of [
    { type: 'local', reference: 'fixtures/staged-reader.js' },
    { type: 'package', reference: 'some-package' },
    { type: 'generated', reference: 'generated-reader-v1' },
  ]) {
    assert.throws(() => aos.capabilities.create(mcpInput({ id: `source-${source.type}`, source })), (error) => error.code === 'invalid_input');
  }
  assert.throws(() => aos.capabilities.create(mcpInput({ id: 'missing-runtime', runtime: undefined })), (error) => error.code === 'invalid_input');
  assert.throws(() => aos.capabilities.create(mcpInput({ id: 'wrong-install', runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME, installation: 'other@1' } })), (error) => error.code === 'invalid_input');
  assert.throws(() => aos.capabilities.create(mcpInput({ id: 'process-config', runtime: { ...BUILTIN_MCP_STAGED_TEXT_RUNTIME, command: process.execPath } })), (error) => error.code === 'invalid_input');
  for (const permission of ['filesystem_write', 'network', 'external_actions']) {
    assert.throws(() => aos.capabilities.create(mcpInput({ id: `permission-${permission}`, permissions: [permission] })), (error) => error.code === 'invalid_input');
  }
  assert.doesNotThrow(() => aos.capabilities.create({
    id: 'legacy-skill', kind: 'skill', name: 'Legacy skill', source: { type: 'local', reference: 'skills/legacy' },
    permissions: ['filesystem_read'], test: { required: true, protocol: 'operator_receipt', description: 'Legacy receipt.' },
  }));
});

test('pure MCP admission accepts one exact read-only mount and rejects unbound or effectful tasks', () => {
  const aos = engine();
  const { capability, mount } = resolvedMcp(aos);
  const task = mountedTask(capability, mount);
  assert.equal(assertMcpTaskAdmission(task), true);
  assert.equal(assertMcpTaskAdmission({ task, mounts: [mount] }), true);
  assert.equal(assertMcpTaskAdmission([mount], task), true);

  assert.throws(() => assertMcpTaskAdmission({ ...task, capabilityExecution: { ...task.capabilityExecution, reference: 'other@1' } }), (error) => error.code === 'mcp_mount_unbound');
  assert.throws(() => assertMcpTaskAdmission({ ...task, capabilityMounts: [mount, mount] }), (error) => error.code === 'mcp_mount_count_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, sandbox: 'workspace_write' }), (error) => error.code === 'mcp_sandbox_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, network: { allowed: true, allowlist: [] } }), (error) => error.code === 'mcp_network_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, capabilityMounts: [{ ...mount, permissions: ['filesystem_read', 'filesystem_write'] }] }), (error) => error.code === 'mcp_permissions_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, readPaths: ['/etc/passwd'] }), (error) => error.code === 'mcp_read_paths_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, readPaths: ['/etc/passwd', 'fixtures/declared.txt'] }), (error) => error.code === 'mcp_read_paths_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, capabilityExecution: { ...task.capabilityExecution, timeoutMs: 10_001 } }), (error) => error.code === 'mcp_timeout_invalid');
  assert.throws(() => assertMcpTaskAdmission({ ...task, capabilityExecution: { ...task.capabilityExecution, selector: 'arbitrary' } }), (error) => error.code === 'mcp_selector_invalid');
});

test('templates accept only the structured capabilityExecution selector, reference, and timeout fields', () => {
  const valid = check(TEMPLATE_CONFIG_SCHEMA, {
    preset: { id: 'general-worker' },
    harness: { id: 'local' },
    capabilityExecution: { selector: 'first_declared_read_path', reference: 'staged-reader@1', timeoutMs: 250 },
  });
  assert.deepEqual(valid, []);
  assert.notDeepEqual(check(TEMPLATE_CONFIG_SCHEMA, {
    preset: { id: 'general-worker' }, harness: { id: 'local' }, capabilityExecution: { reference: 'staged-reader@1', timeoutMs: 250, command: 'node' },
  }), []);
  assert.notDeepEqual(check(TEMPLATE_CONFIG_SCHEMA, {
    preset: { id: 'general-worker' }, harness: { id: 'local' }, capabilityExecution: { reference: 'staged-reader@1', timeoutMs: 250 },
  }), []);
  const registry = new TemplateRegistry({ engine: engine() });
  const created = registry.create({ id: 'mcp-reader-template', name: 'MCP reader template', config: {
    preset: { id: 'general-worker' }, harness: { id: 'local' }, capabilityExecution: { selector: 'first_declared_read_path', reference: 'staged-reader@1', timeoutMs: 250 },
  } });
  assert.deepEqual(created.config.capabilityExecution, { selector: 'first_declared_read_path', reference: 'staged-reader@1', timeoutMs: 250 });
});
