import { fileURLToPath } from 'node:url';
import { fingerprint, newId, nowIso } from './ids.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';

export const CAPABILITY_SCHEMA_VERSION = 1;
export const CAPABILITY_KINDS = Object.freeze(['skill', 'mcp', 'plugin', 'tool']);
export const CAPABILITY_PERMISSIONS = Object.freeze(['filesystem_read', 'filesystem_write', 'network', 'external_actions']);
export const CAPABILITY_SCOPES = Object.freeze(['project', 'role', 'worker']);

// MCP is deliberately a closed boundary in this engine slice. The source,
// installation and wire contract are code-owned; none of these values may be
// supplied by a user as an alternate process or transport configuration.
export const BUILTIN_MCP_STAGED_TEXT_SOURCE = Object.freeze({
  type: 'builtin',
  reference: 'aos.mcp.staged-text-reader.v1',
});
export const BUILTIN_MCP_STAGED_TEXT_INSTALLATION = 'aos.staged-text-reader@1';
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_TOOL = 'aos.read_staged_text';
export const MCP_EFFECT_CLASS = 'read_only';
export const MCP_INPUT_SELECTOR = 'first_declared_read_path';
export const MCP_MAX_TIMEOUT_MS = 10_000;

export const BUILTIN_MCP_STAGED_TEXT_RUNTIME = Object.freeze({
  transport: 'stdio',
  installation: BUILTIN_MCP_STAGED_TEXT_INSTALLATION,
  protocolVersion: MCP_PROTOCOL_VERSION,
  tool: MCP_TOOL,
  effectClass: MCP_EFFECT_CLASS,
  inputSelector: MCP_INPUT_SELECTOR,
});

const MCP_STAGED_TEXT_SERVER_MODULE = fileURLToPath(new URL('./mcp/staged-text-reader.js', import.meta.url));
const installationDescriptor = {
  transport: 'stdio',
  installation: BUILTIN_MCP_STAGED_TEXT_INSTALLATION,
  command: process.execPath,
  argv: [MCP_STAGED_TEXT_SERVER_MODULE],
  protocolVersion: MCP_PROTOCOL_VERSION,
  tool: MCP_TOOL,
  effectClass: MCP_EFFECT_CLASS,
  inputSelector: MCP_INPUT_SELECTOR,
};
// `args` and the path aliases are non-enumerable compatibility accessors for
// sibling runtimes that use spawn-style terminology. The enumerable contract
// remains the small, inspectable descriptor above.
Object.defineProperties(installationDescriptor, {
  args: { value: installationDescriptor.argv },
  serverModulePath: { value: MCP_STAGED_TEXT_SERVER_MODULE },
  modulePath: { value: MCP_STAGED_TEXT_SERVER_MODULE },
});
export const BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR = deepFreeze(installationDescriptor);
export const BUILTIN_MCP_STAGED_TEXT_SERVER_MODULE = MCP_STAGED_TEXT_SERVER_MODULE;

export const MCP_RUNTIME_SCHEMA = t.object({
  transport: t.literal('stdio'),
  installation: t.literal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION),
  protocolVersion: t.literal(MCP_PROTOCOL_VERSION),
  tool: t.literal(MCP_TOOL),
  effectClass: t.literal(MCP_EFFECT_CLASS),
  inputSelector: t.literal(MCP_INPUT_SELECTOR),
});

const SOURCE_REFERENCE = /^[A-Za-z0-9@][A-Za-z0-9@._/+\-]{0,399}$/;
const CAPABILITY_REF = /^([A-Za-z][A-Za-z0-9_.-]{0,127})@([1-9][0-9]*)$/;

export const CAPABILITY_INPUT_SCHEMA = t.object({
  id: identifier(),
  kind: t.enumOf(CAPABILITY_KINDS),
  name: t.string({ minLength: 1, maxLength: 120 }),
  description: t.optional(t.nullable(t.string({ maxLength: 1000 }))),
  source: t.object({
    type: t.enumOf(['builtin', 'local', 'package', 'generated']),
    reference: t.string({ minLength: 1, maxLength: 400, pattern: SOURCE_REFERENCE, patternName: 'a credential-free package or relative local reference' }),
  }),
  runtime: t.optional(MCP_RUNTIME_SCHEMA),
  permissions: t.array(t.enumOf(CAPABILITY_PERMISSIONS), { unique: true, maxItems: CAPABILITY_PERMISSIONS.length }),
  test: t.object({
    required: t.literal(true),
    protocol: t.enumOf(['operator_receipt', 'schema_check', 'command_check']),
    description: t.string({ minLength: 1, maxLength: 500 }),
  }),
  createdBy: t.optional(t.string({ minLength: 1, maxLength: 120 })),
});

const TEST_INPUT_SCHEMA = t.object({
  requestId: identifier(),
  status: t.enumOf(['passed', 'failed']),
  summary: t.string({ minLength: 1, maxLength: 1000 }),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
});

const PERMISSION_INPUT_SCHEMA = t.object({
  scope: t.enumOf(CAPABILITY_SCOPES),
  scopeId: identifier(),
  permissions: t.array(t.enumOf(CAPABILITY_PERMISSIONS), { unique: true, maxItems: CAPABILITY_PERMISSIONS.length }),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
  reason: t.optional(t.nullable(t.string({ maxLength: 500 }))),
});

function validate(schema, value, label) {
  const errors = check(schema, value);
  if (errors.length) throw invalid(`${label} failed validation: ${errors[0].path} ${errors[0].message}`, { errors });
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function sameObjectShape(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => value[key] === expected[key]);
}

function sameBuiltinMcpSource(value) {
  return sameObjectShape(value, BUILTIN_MCP_STAGED_TEXT_SOURCE);
}

function sameBuiltinMcpRuntime(value) {
  return sameObjectShape(value, BUILTIN_MCP_STAGED_TEXT_RUNTIME);
}

function materialFingerprint(record) {
  return fingerprint(JSON.stringify({
    id: record.id,
    version: record.version,
    kind: record.kind,
    name: record.name,
    description: record.description,
    source: record.source,
    runtime: record.runtime,
    permissions: record.permissions,
    test: record.test,
  }));
}

export function parseCapabilityRef(reference) {
  const match = String(reference || '').match(CAPABILITY_REF);
  if (!match) {
    throw new AosError('capability_unversioned', `Capability reference ${String(reference || '(empty)')} must use id@version`, {
      statusCode: 409,
      details: { reference: String(reference || '') },
    });
  }
  return { id: match[1], version: Number(match[2]), reference: `${match[1]}@${Number(match[2])}` };
}

export class CapabilityRegistry {
  constructor({ engine, clock = () => Date.now() }) {
    this.engine = engine;
    this.clock = clock;
  }

  get stored() {
    return this.engine.state.capabilities;
  }

  #versions(id) {
    return this.stored.filter((item) => item.id === id).sort((a, b) => a.version - b.version);
  }

  #state(id, version) {
    return this.engine.state.capabilityStates
      .filter((item) => item.capabilityId === id && item.capabilityVersion === version)
      .sort((a, b) => a.sequence - b.sequence)
      .at(-1) || null;
  }

  #view(record) {
    const state = this.#state(record.id, record.version);
    const tests = this.engine.state.capabilityTests.filter((item) => item.capabilityId === record.id && item.capabilityVersion === record.version);
    const latestTest = tests.at(-1) || null;
    return {
      ...clone(record),
      // Older stores predate runtime. Keep their records readable while making
      // the runtime explicit in every public version view going forward.
      runtime: clone(record.runtime ?? null),
      reference: `${record.id}@${record.version}`,
      state: state?.status || 'active',
      tested: latestTest?.status === 'passed' && latestTest.capabilityFingerprint === record.fingerprint,
      latestTest: latestTest ? {
        id: latestTest.id,
        status: latestTest.status,
        summary: latestTest.summary,
        testedAt: latestTest.testedAt,
        actor: latestTest.actor,
      } : null,
    };
  }

  list({ includeRevoked = false, kind = null } = {}) {
    const heads = new Map();
    for (const item of this.stored) heads.set(item.id, item);
    return [...heads.values()]
      .filter((item) => !kind || item.kind === kind)
      .map((item) => this.#view(item))
      .filter((item) => includeRevoked || item.state !== 'revoked');
  }

  history(id) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('capability', id);
    return versions.map((item) => this.#view(item));
  }

  get(id, version = null) {
    const versions = this.#versions(id);
    const record = version == null ? versions.at(-1) : versions.find((item) => item.version === Number(version));
    if (!record) throw notFound('capability', version == null ? id : `${id}@${version}`);
    return this.#view(record);
  }

  #materialize(input, version, parentVersion = null) {
    validate(CAPABILITY_INPUT_SCHEMA, input, 'capability');
    if (input.source.type === 'local' && (input.source.reference.startsWith('/') || input.source.reference.split('/').includes('..'))) {
      throw invalid('local capability source must be a relative path without parent traversal', { field: 'source.reference' });
    }
    if (input.kind === 'mcp') {
      if (!sameBuiltinMcpSource(input.source)) {
        throw invalid('mcp capabilities may use only the AOS staged-text builtin source', {
          field: 'source',
          expected: BUILTIN_MCP_STAGED_TEXT_SOURCE,
        });
      }
      if (!sameBuiltinMcpRuntime(input.runtime)) {
        throw invalid('mcp capabilities require the immutable AOS staged-text runtime', {
          field: 'runtime',
          expected: BUILTIN_MCP_STAGED_TEXT_RUNTIME,
        });
      }
      if (input.permissions.length !== 1 || input.permissions[0] !== 'filesystem_read') {
        throw invalid('mcp capabilities may request only filesystem_read permission', {
          field: 'permissions',
          expected: ['filesystem_read'],
        });
      }
    } else if (input.runtime !== undefined) {
      // `runtime` did not exist on non-MCP records. Keep their old schema
      // strict rather than turning it into a generic process configuration.
      throw invalid('runtime is supported only for mcp capabilities', { field: 'runtime' });
    }
    const record = {
      id: input.id,
      version,
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      kind: input.kind,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      source: clone(input.source),
      runtime: input.kind === 'mcp' ? clone(input.runtime) : null,
      permissions: [...input.permissions],
      test: clone(input.test),
      createdAt: nowIso(this.clock),
      createdBy: input.createdBy || 'operator',
      parentVersion,
    };
    record.fingerprint = materialFingerprint(record);
    return record;
  }

  create(input) {
    return this.engine.transact(() => {
      if (this.#versions(input?.id || '').length) {
        throw new AosError('capability_exists', `Capability ${input.id} already exists; create a new version instead`, { statusCode: 409 });
      }
      const record = this.#materialize(input, 1);
      if (this.#versions(record.id).some((item) => item.version === record.version)) {
        throw new AosError('capability_version_conflict', `Capability ${record.id}@${record.version} already exists`, { statusCode: 409 });
      }
      this.engine.state.capabilities.push(record);
      this.#appendState(record, 'active', 'created');
      this.engine.recordEvent('capability.created', { payload: { capabilityId: record.id, version: record.version, kind: record.kind } });
      return this.#view(record);
    });
  }

  edit(id, patch = {}) {
    return this.engine.transact(() => {
      const head = this.get(id);
      if (patch.baseVersion !== undefined && (!Number.isInteger(patch.baseVersion) || patch.baseVersion < 1)) {
        throw invalid('baseVersion must be a positive integer', { field: 'baseVersion' });
      }
      if (patch.baseVersion !== undefined && patch.baseVersion !== head.version) {
        throw new AosError('capability_version_conflict', `Capability ${id} advanced from expected version ${patch.baseVersion} to ${head.version}`, {
          statusCode: 409,
          details: { id, expectedVersion: patch.baseVersion, currentVersion: head.version },
        });
      }
      const kind = patch.kind ?? head.kind;
      const materialized = {
        id,
        kind,
        name: patch.name ?? head.name,
        description: patch.description === undefined ? head.description : patch.description,
        source: patch.source ?? head.source,
        permissions: patch.permissions ?? head.permissions,
        test: patch.test ?? head.test,
        createdBy: patch.createdBy ?? 'operator',
      };
      if (kind === 'mcp' || patch.runtime !== undefined) {
        materialized.runtime = patch.runtime ?? head.runtime;
      }
      const record = this.#materialize(materialized, head.version + 1, head.version);
      if (this.#versions(id).some((item) => item.version === record.version)) {
        throw new AosError('capability_version_conflict', `Capability ${id}@${record.version} already exists`, { statusCode: 409 });
      }
      this.engine.state.capabilities.push(record);
      this.#appendState(record, 'active', 'version_created');
      this.engine.recordEvent('capability.versioned', { payload: { capabilityId: record.id, version: record.version, parentVersion: head.version } });
      return this.#view(record);
    });
  }

  #appendState(record, status, reason, actor = 'operator') {
    const previous = this.engine.state.capabilityStates.filter((item) => item.capabilityId === record.id && item.capabilityVersion === record.version).at(-1);
    this.engine.state.capabilityStates.push({
      id: newId('capabilityState'),
      capabilityId: record.id,
      capabilityVersion: record.version,
      sequence: (previous?.sequence || 0) + 1,
      status,
      reason,
      actor,
      createdAt: nowIso(this.clock),
    });
  }

  setState(id, version, status, { actor = 'operator', reason = null } = {}) {
    if (!['active', 'revoked'].includes(status)) throw invalid('capability state must be active or revoked', { field: 'status' });
    return this.engine.transact(() => {
      const record = this.get(id, version);
      this.#appendState(record, status, reason || status, actor);
      this.engine.recordEvent(`capability.${status}`, { payload: { capabilityId: id, version: record.version, actor, reason: reason || null } });
      return this.get(id, record.version);
    });
  }

  recordTest(id, version, input) {
    validate(TEST_INPUT_SCHEMA, input, 'capability test receipt');
    return this.engine.transact(() => {
      const capability = this.get(id, version);
      const existing = this.engine.state.capabilityTests.find((item) => item.requestId === input.requestId);
      if (existing) {
        const same = existing.capabilityId === capability.id
          && existing.capabilityVersion === capability.version
          && existing.status === input.status
          && existing.summary === input.summary;
        if (!same) throw new AosError('capability_test_request_conflict', `Test request ${input.requestId} was already used`, { statusCode: 409 });
        return clone(existing);
      }
      const receipt = {
        id: newId('capabilityTest'),
        requestId: input.requestId,
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        capabilityFingerprint: capability.fingerprint,
        status: input.status,
        summary: input.summary.trim(),
        actor: input.actor || 'operator',
        testedAt: nowIso(this.clock),
      };
      this.engine.state.capabilityTests.push(receipt);
      this.engine.recordEvent('capability.tested', { payload: { capabilityId: capability.id, version: capability.version, status: receipt.status, receiptId: receipt.id } });
      return clone(receipt);
    });
  }

  #permissionRecords(id, version, scope = null, scopeId = null) {
    return this.engine.state.capabilityPermissions.filter((item) => item.capabilityId === id
      && item.capabilityVersion === version
      && (!scope || item.scope === scope)
      && (!scopeId || item.scopeId === scopeId));
  }

  permissions(id, version) {
    const capability = this.get(id, version);
    return clone(this.#permissionRecords(capability.id, capability.version));
  }

  setPermission(id, version, action, input) {
    if (!['grant', 'revoke'].includes(action)) throw invalid('permission action must be grant or revoke', { field: 'action' });
    validate(PERMISSION_INPUT_SCHEMA, input, 'capability permission');
    return this.engine.transact(() => {
      const capability = this.get(id, version);
      const previous = this.#permissionRecords(capability.id, capability.version, input.scope, input.scopeId).at(-1);
      const record = {
        id: newId('capabilityPermission'),
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        capabilityFingerprint: capability.fingerprint,
        scope: input.scope,
        scopeId: input.scopeId,
        sequence: (previous?.sequence || 0) + 1,
        action,
        permissions: [...input.permissions],
        actor: input.actor || 'operator',
        reason: input.reason?.trim() || null,
        createdAt: nowIso(this.clock),
      };
      this.engine.state.capabilityPermissions.push(record);
      this.engine.recordEvent(action === 'grant' ? 'capability.permission_granted' : 'capability.permission_revoked', {
        projectId: input.scope === 'project' ? input.scopeId : null,
        payload: { capabilityId: capability.id, version: capability.version, scope: input.scope, scopeId: input.scopeId, permissionId: record.id },
      });
      return clone(record);
    });
  }

  #effectivePermission(capability, context) {
    const candidates = [
      context.workerId ? ['worker', context.workerId] : null,
      context.roleId ? ['role', context.roleId] : null,
      context.projectId ? ['project', context.projectId] : null,
    ].filter(Boolean);
    for (const [scope, scopeId] of candidates) {
      const record = this.#permissionRecords(capability.id, capability.version, scope, scopeId).at(-1);
      if (record) return record;
    }
    return null;
  }

  resolve(reference, context = {}) {
    const parsed = parseCapabilityRef(reference);
    const capability = this.get(parsed.id, parsed.version);
    if (capability.state === 'revoked') {
      throw new AosError('capability_revoked', `Capability ${parsed.reference} is revoked`, { statusCode: 409, details: { reference: parsed.reference } });
    }
    if (!capability.tested) {
      throw new AosError('capability_untested', `Capability ${parsed.reference} has no current passing test receipt`, { statusCode: 409, details: { reference: parsed.reference } });
    }
    const enabled = this.engine.settings.effective('capabilities.enabled', {
      projectId: context.projectId ?? null,
      presetId: context.roleId ?? null,
      agentId: context.workerId ?? null,
      runId: context.runId ?? null,
    }).value;
    if (!Array.isArray(enabled) || !enabled.includes(parsed.reference)) {
      throw new AosError('capability_disabled', `Capability ${parsed.reference} is not enabled by effective policy`, { statusCode: 409, details: { reference: parsed.reference } });
    }
    const permission = this.#effectivePermission(capability, context);
    if (!permission || permission.action !== 'grant') {
      throw new AosError('capability_permission_denied', `Capability ${parsed.reference} has no active permission for this task`, { statusCode: 409, details: { reference: parsed.reference } });
    }
    const missing = capability.permissions.filter((item) => !permission.permissions.includes(item));
    if (missing.length) {
      throw new AosError('capability_permission_denied', `Capability ${parsed.reference} lacks required granted permissions`, { statusCode: 409, details: { reference: parsed.reference, missing } });
    }
    return {
      reference: parsed.reference,
      id: capability.id,
      version: capability.version,
      kind: capability.kind,
      fingerprint: capability.fingerprint,
      runtime: clone(capability.runtime ?? null),
      permissions: [...capability.permissions],
      testReceiptId: this.engine.state.capabilityTests.filter((item) => item.capabilityId === capability.id && item.capabilityVersion === capability.version).at(-1).id,
      permissionId: permission.id,
      adapter: clone(capability.source),
    };
  }

  resolveTask(task, context = {}) {
    const mounted = [];
    const expected = { skills: 'skill', mcp: 'mcp', plugins: 'plugin', tools: 'tool' };
    for (const [bucket, kind] of Object.entries(expected)) {
      for (const reference of task.capabilities?.[bucket] || []) {
        const resolved = this.resolve(reference, context);
        if (resolved.kind !== kind) {
          throw new AosError('capability_kind_mismatch', `Capability ${resolved.reference} is ${resolved.kind}, not ${kind}`, { statusCode: 409, details: { reference: resolved.reference, expected: kind, actual: resolved.kind } });
        }
        mounted.push(resolved);
      }
    }
    return mounted;
  }
}

const MCP_ADMISSION_EXECUTION_KEYS = Object.freeze(['selector', 'reference', 'timeoutMs']);
const EFFECTFUL_PERMISSIONS = new Set(['filesystem_write', 'network', 'external_actions']);

function admissionError(code, message, details = null) {
  return new AosError(code, message, { statusCode: 409, details });
}

function isRelativeDeclaredPath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const path = value.trim();
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

function admissionArguments(taskOrInput, mountsOrTask = undefined) {
  if (Array.isArray(taskOrInput)) {
    return { task: mountsOrTask, mounts: taskOrInput };
  }
  if (taskOrInput && typeof taskOrInput === 'object' && taskOrInput.task && !Array.isArray(taskOrInput.task)) {
    return {
      task: taskOrInput.task,
      mounts: taskOrInput.mounts ?? taskOrInput.capabilityMounts ?? taskOrInput.mounted ?? (taskOrInput.mount ? [taskOrInput.mount] : []),
    };
  }
  if (Array.isArray(mountsOrTask)) return { task: taskOrInput, mounts: mountsOrTask };
  if (mountsOrTask && typeof mountsOrTask === 'object' && (mountsOrTask.task || mountsOrTask.mounts || mountsOrTask.capabilityMounts || mountsOrTask.mounted || mountsOrTask.mount)) {
    return {
      task: mountsOrTask.task ?? taskOrInput,
      mounts: mountsOrTask.mounts ?? mountsOrTask.capabilityMounts ?? mountsOrTask.mounted ?? (mountsOrTask.mount ? [mountsOrTask.mount] : []),
    };
  }
  if (mountsOrTask && typeof mountsOrTask === 'object' && mountsOrTask.kind === 'mcp') {
    return { task: taskOrInput, mounts: [mountsOrTask] };
  }
  return { task: taskOrInput, mounts: taskOrInput?.capabilityMounts ?? [] };
}

function taskEffectiveConfig(task) {
  return task?.config?.effective || task?.effective || {};
}

/**
 * Pure admission check for the one AOS-shipped MCP read tool.
 *
 * The registry must resolve tests, permissions, enablement and revocation
 * before this function is called. This helper intentionally receives only a
 * task and its resolved mount receipt; it never reaches into an engine/store.
 */
export function assertMcpTaskAdmission(taskOrInput = {}, mountsOrTask = undefined) {
  const { task, mounts } = admissionArguments(taskOrInput, mountsOrTask);
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw admissionError('mcp_task_admission_invalid', 'MCP task admission requires a task object');
  }
  if (!Array.isArray(mounts) || mounts.length !== 1) {
    throw admissionError('mcp_mount_count_invalid', 'MCP task admission requires exactly one resolved mount', { mountCount: Array.isArray(mounts) ? mounts.length : null });
  }
  const [mount] = mounts;
  if (!mount || typeof mount !== 'object' || Array.isArray(mount) || mount.kind !== 'mcp') {
    throw admissionError('mcp_mount_invalid', 'MCP task admission requires one resolved mcp mount');
  }
  if (typeof mount.reference !== 'string') {
    throw admissionError('mcp_mount_reference_invalid', 'MCP mount reference must be versioned');
  }
  let parsed;
  try {
    parsed = parseCapabilityRef(mount.reference);
  } catch (error) {
    throw admissionError('mcp_mount_reference_invalid', error.message, { reference: mount.reference });
  }
  if (mount.id !== undefined && mount.id !== parsed.id) {
    throw admissionError('mcp_mount_version_invalid', 'MCP mount id does not match its versioned reference', { reference: mount.reference, id: mount.id });
  }
  if (mount.version !== undefined && mount.version !== parsed.version) {
    throw admissionError('mcp_mount_version_invalid', 'MCP mount version does not match its versioned reference', { reference: mount.reference, version: mount.version });
  }
  if (typeof mount.fingerprint !== 'string' || !mount.fingerprint) {
    throw admissionError('mcp_mount_fingerprint_invalid', 'MCP mount requires an exact capability fingerprint', { reference: mount.reference });
  }
  if (!sameBuiltinMcpRuntime(mount.runtime)) {
    throw admissionError('mcp_mount_runtime_invalid', 'MCP mount runtime does not match the AOS staged-text contract', { reference: mount.reference, expected: BUILTIN_MCP_STAGED_TEXT_RUNTIME });
  }
  for (const source of [mount.adapter, mount.source]) {
    if (source !== undefined && !sameBuiltinMcpSource(source)) {
      throw admissionError('mcp_mount_source_invalid', 'MCP mount source does not match the AOS staged-text builtin', { reference: mount.reference });
    }
  }

  const effective = taskEffectiveConfig(task);
  const filesystem = task.filesystem || effective.filesystem || {};
  const sandbox = task.sandbox ?? filesystem.sandbox;
  if (sandbox !== 'read_only') {
    throw admissionError('mcp_sandbox_invalid', 'MCP staged-text execution requires a read_only sandbox', { sandbox: sandbox ?? null });
  }
  const readPaths = task.readPaths ?? filesystem.readPaths;
  if (!Array.isArray(readPaths) || !readPaths.length || !isRelativeDeclaredPath(readPaths[0])) {
    throw admissionError('mcp_read_paths_invalid', 'MCP staged-text execution requires a relative first declared read path');
  }
  const writePaths = task.writePaths ?? filesystem.writePaths;
  if (writePaths !== undefined && writePaths !== null && (!Array.isArray(writePaths) || writePaths.length)) {
    throw admissionError('mcp_permissions_invalid', 'MCP staged-text execution cannot declare filesystem write paths');
  }
  if (task.externalActions === true || effective.externalActions === true) {
    throw admissionError('mcp_permissions_invalid', 'MCP staged-text execution cannot enable external actions');
  }
  const network = task.network ?? effective.network;
  if (network === true) throw admissionError('mcp_network_invalid', 'MCP staged-text execution requires network disabled');
  if (network !== undefined && network !== null && network !== false) {
    if (typeof network !== 'object' || Array.isArray(network)
      || network.allowed !== false
      || (network.allowlist !== undefined && (!Array.isArray(network.allowlist) || network.allowlist.length))) {
      throw admissionError('mcp_network_invalid', 'MCP network policy must be disabled');
    }
  }

  const permissionLists = [mount.permissions, task.permissions, task.capabilityPermissions, effective.permissions]
    .filter((value) => value !== undefined && value !== null);
  for (const permissions of permissionLists) {
    if (!Array.isArray(permissions) || permissions.some((permission) => EFFECTFUL_PERMISSIONS.has(permission) || permission !== 'filesystem_read')) {
      throw admissionError('mcp_permissions_invalid', 'MCP staged-text execution may request only filesystem_read permission');
    }
  }

  const declaredMcp = task.capabilities?.mcp ?? effective.capabilities?.mcp;
  if (declaredMcp !== undefined && (!Array.isArray(declaredMcp) || declaredMcp.length !== 1 || declaredMcp[0] !== mount.reference)) {
    throw admissionError('mcp_mount_unbound', 'MCP task capability declaration must bind the exact mounted reference', { reference: mount.reference, declared: declaredMcp });
  }
  const requested = task.capabilityExecution ?? effective.capabilityExecution;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw admissionError('mcp_execution_invalid', 'MCP task capabilityExecution must name the exact reference and a bounded timeout');
  }
  const extraKeys = Object.keys(requested).filter((key) => !MCP_ADMISSION_EXECUTION_KEYS.includes(key));
  if (extraKeys.length) {
    throw admissionError('mcp_execution_invalid', 'MCP capabilityExecution contains unsupported fields', { extraKeys });
  }
  if (requested.reference !== mount.reference) {
    throw admissionError('mcp_mount_unbound', 'MCP capabilityExecution must name the exact mounted reference', { requested: requested.reference ?? null, mounted: mount.reference });
  }
  if (requested.selector !== MCP_INPUT_SELECTOR) {
    throw admissionError('mcp_selector_invalid', 'MCP capabilityExecution selector must be first_declared_read_path', { selector: requested.selector });
  }
  if (!Number.isInteger(requested.timeoutMs) || requested.timeoutMs < 1 || requested.timeoutMs > MCP_MAX_TIMEOUT_MS) {
    throw admissionError('mcp_timeout_invalid', `MCP capabilityExecution timeout must be an integer from 1 to ${MCP_MAX_TIMEOUT_MS} ms`, { timeoutMs: requested.timeoutMs ?? null });
  }
  return true;
}
