import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fingerprint, newId, nowIso } from './ids.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';

export const CAPABILITY_SCHEMA_VERSION = 1;
export const CAPABILITY_KINDS = Object.freeze(['skill', 'mcp', 'plugin', 'tool']);
export const CAPABILITY_PERMISSIONS = Object.freeze(['filesystem_read', 'filesystem_write', 'network', 'external_actions']);
export const CAPABILITY_SCOPES = Object.freeze(['project', 'role', 'worker']);

// The built-in MCP stays a closed boundary. Its source, installation and wire
// contract are code-owned; configurable local servers use the separate,
// explicitly unisolated adapter below.
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

// An operator may add a local stdio MCP only through this deliberately narrow
// adapter. It is a host-process disclosure tier: the declared read-only/offline
// scope is policy, not an OS filesystem or network sandbox. The process gets
// one engine-staged filename and no task-supplied argv, environment, or input.
export const LOCAL_MCP_STDIO_SOURCE = Object.freeze({
  type: 'local',
  reference: 'aos.local-mcp-stdio.v1',
});
export const LOCAL_MCP_STDIO_INSTALLATION = 'operator.local-stdio';
export const LOCAL_MCP_STDIO_EFFECT_CLASS = 'read_only_offline_declared';
export const LOCAL_MCP_STDIO_ISOLATION = 'host_process_unisolated';
export const LOCAL_MCP_STDIO_ADAPTER = 'local-mcp-stdio';
export const LOCAL_MCP_STDIO_TEST_PROTOCOL = 'local_mcp_stdio_probe';

// Both the shipped reader and the configurable local adapter accept exactly
// this engine-derived input. V1 intentionally does not accept raw task text or
// arbitrary JSON tool arguments.
export const MCP_STAGED_TEXT_INPUT_SCHEMA = deepFreeze({
  type: 'object',
  properties: {
    stagedFile: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: '^[^/\\\\\\x00-\\x1f<>:"|?*]+$',
    },
  },
  required: ['stagedFile'],
  additionalProperties: false,
});

// This is the only writable capability admitted by the current engine slice.
// Its target, input bytes and rollback are all engine-derived; callers may not
// supply a path, content selector, process, network or external-action option.
export const TASK_WORKSPACE_WRITE_SOURCE = 'aos.task-workspace-write-v1';
export const TASK_WORKSPACE_WRITE_EFFECT = 'task_workspace_write';
export const TASK_WORKSPACE_WRITE_TARGET_KIND = 'engine_task_workspace_file';
export const BUILTIN_TASK_WORKSPACE_WRITE_SOURCE = Object.freeze({
  type: 'generated',
  reference: TASK_WORKSPACE_WRITE_SOURCE,
});

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

const BUILTIN_MCP_RUNTIME_SCHEMA = t.object({
  transport: t.literal('stdio'),
  installation: t.literal(BUILTIN_MCP_STAGED_TEXT_INSTALLATION),
  protocolVersion: t.literal(MCP_PROTOCOL_VERSION),
  tool: t.literal(MCP_TOOL),
  effectClass: t.literal(MCP_EFFECT_CLASS),
  inputSelector: t.literal(MCP_INPUT_SELECTOR),
});

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MCP_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const LOCAL_MCP_ARG_SCHEMA = t.object({
  value: t.string({ minLength: 1, maxLength: 4096 }),
  sha256: t.optional(t.string({ minLength: 64, maxLength: 64, pattern: SHA256_HEX, patternName: 'a SHA-256 hex digest' })),
});
export const LOCAL_MCP_STDIO_RUNTIME_SCHEMA = t.object({
  transport: t.literal('stdio'),
  installation: t.literal(LOCAL_MCP_STDIO_INSTALLATION),
  command: t.object({
    path: t.string({ minLength: 1, maxLength: 4096 }),
    sha256: t.optional(t.string({ minLength: 64, maxLength: 64, pattern: SHA256_HEX, patternName: 'a SHA-256 hex digest' })),
  }),
  argv: t.array(LOCAL_MCP_ARG_SCHEMA, { maxItems: 32 }),
  protocolVersion: t.literal(MCP_PROTOCOL_VERSION),
  tool: t.object({
    name: t.string({ minLength: 1, maxLength: 128, pattern: MCP_TOOL_NAME, patternName: 'an MCP tool name' }),
    inputSchema: t.any(),
  }),
  effectClass: t.literal(LOCAL_MCP_STDIO_EFFECT_CLASS),
  isolation: t.literal(LOCAL_MCP_STDIO_ISOLATION),
  inputSelector: t.literal(MCP_INPUT_SELECTOR),
});
export const MCP_RUNTIME_SCHEMA = t.oneOf([BUILTIN_MCP_RUNTIME_SCHEMA, LOCAL_MCP_STDIO_RUNTIME_SCHEMA]);

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
    protocol: t.enumOf(['operator_receipt', 'schema_check', 'command_check', LOCAL_MCP_STDIO_TEST_PROTOCOL]),
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

const LOCAL_MCP_PROBE_INPUT_SCHEMA = t.object({
  requestId: identifier(),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
  timeoutMs: t.optional(t.integer({ min: 1, max: MCP_MAX_TIMEOUT_MS })),
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

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left == null || right == null) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  if (typeof left !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function sameBuiltinMcpSource(value) {
  return sameObjectShape(value, BUILTIN_MCP_STAGED_TEXT_SOURCE);
}

function sameBuiltinMcpRuntime(value) {
  return sameObjectShape(value, BUILTIN_MCP_STAGED_TEXT_RUNTIME);
}

function sameLocalMcpSource(value) {
  return sameObjectShape(value, LOCAL_MCP_STDIO_SOURCE);
}

const MAX_LOCAL_MCP_FILE_BYTES = 128 * 1024 * 1024;
const UNSAFE_LOCAL_MCP_ARG = /^(?:-e|-p|-r|-c|\/c|\/k|--(?:eval|print|require|loader|experimental-loader|import|input-type|command)(?:=|$))/i;
const SECRET_LIKE_LOCAL_MCP_ARG = /(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|authorization|credential|cookie)\s*[:=]|\b(?:sk|rk|pk|ghp|gho|ghs|ghr|AIza)[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i;
const SHELL_OR_LAUNCHER_EXECUTABLES = new Set([
  'bash', 'busybox', 'cmd', 'cmd.exe', 'command.com', 'csh', 'dash', 'env',
  'fish', 'ksh', 'nu', 'powershell', 'powershell.exe', 'pwsh', 'sh', 'tcsh', 'zsh',
]);

function localMcpValidationError(message, field, details = null) {
  return invalid(message, { field, ...(details || {}) });
}

function snapshotLocalMcpFile(path, expectedSha256, { executable, field }) {
  if (typeof path !== 'string' || !path || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw localMcpValidationError('local MCP file paths must be absolute and control-character free', field);
  }
  let canonical;
  let stat;
  let bytes;
  try {
    canonical = realpathSync(path);
    stat = statSync(canonical);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_LOCAL_MCP_FILE_BYTES) {
      throw localMcpValidationError('local MCP files must be bounded regular files', field);
    }
    if (executable && process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
      throw localMcpValidationError('local MCP command must be executable', field);
    }
    bytes = readFileSync(canonical);
  } catch (error) {
    if (error instanceof AosError) throw error;
    throw localMcpValidationError('local MCP file could not be resolved and fingerprinted', field);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && String(expectedSha256).toLowerCase() !== sha256) {
    throw localMcpValidationError('local MCP file no longer matches its pinned SHA-256', field, { expectedSha256, observedSha256: sha256 });
  }
  return { path: canonical, sha256 };
}

function assertNonShellLocalMcpCommand(command) {
  const name = basename(command.path).toLowerCase();
  if (SHELL_OR_LAUNCHER_EXECUTABLES.has(name)) {
    throw localMcpValidationError('local MCP command may not be a shell or command launcher', 'runtime.command.path');
  }
  return command;
}

function normalizeLocalMcpArg(input, index) {
  const value = input?.value;
  const field = `runtime.argv[${index}]`;
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw localMcpValidationError('local MCP argv values must be bounded, non-empty literals', field);
  }
  if (SECRET_LIKE_LOCAL_MCP_ARG.test(value)) {
    throw localMcpValidationError('local MCP argv may not contain secret-like values', field);
  }
  if (UNSAFE_LOCAL_MCP_ARG.test(value)) {
    throw localMcpValidationError('local MCP argv may not enable interpreter evaluation, dynamic loading, or shell commands', field);
  }
  if (isAbsolute(value)) {
    const snapshot = snapshotLocalMcpFile(value, input.sha256, { executable: false, field });
    return { value: snapshot.path, sha256: snapshot.sha256 };
  }
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.startsWith('~')) {
    throw localMcpValidationError('local MCP argv permits absolute pinned files or non-path literals only', field);
  }
  if (input.sha256 !== undefined) {
    throw localMcpValidationError('only absolute local MCP argv files may carry a SHA-256 pin', field);
  }
  return { value };
}

function normalizeLocalMcpRuntime(value) {
  const errors = check(LOCAL_MCP_STDIO_RUNTIME_SCHEMA, value);
  if (errors.length || !deepEqual(value?.tool?.inputSchema, MCP_STAGED_TEXT_INPUT_SCHEMA)) {
    throw localMcpValidationError('local MCP runtime must pin the staged-file tool schema', 'runtime', { errors });
  }
  const command = assertNonShellLocalMcpCommand(snapshotLocalMcpFile(value.command.path, value.command.sha256, { executable: true, field: 'runtime.command.path' }));
  const argv = value.argv.map((item, index) => normalizeLocalMcpArg(item, index));
  return {
    transport: 'stdio',
    installation: LOCAL_MCP_STDIO_INSTALLATION,
    command,
    argv,
    protocolVersion: MCP_PROTOCOL_VERSION,
    tool: { name: value.tool.name, inputSchema: clone(MCP_STAGED_TEXT_INPUT_SCHEMA) },
    effectClass: LOCAL_MCP_STDIO_EFFECT_CLASS,
    isolation: LOCAL_MCP_STDIO_ISOLATION,
    inputSelector: MCP_INPUT_SELECTOR,
  };
}

export function isLocalMcpRuntime(value) {
  if (check(LOCAL_MCP_STDIO_RUNTIME_SCHEMA, value).length || !deepEqual(value?.tool?.inputSchema, MCP_STAGED_TEXT_INPUT_SCHEMA)) return false;
  if (!isAbsolute(value.command?.path || '') || /[\u0000-\u001f\u007f]/.test(value.command.path)
    || SHELL_OR_LAUNCHER_EXECUTABLES.has(basename(value.command.path).toLowerCase())
    || !SHA256_HEX.test(value.command?.sha256 || '')) return false;
  return value.argv.every((item) => {
    if (!item || typeof item !== 'object' || typeof item.value !== 'string') return false;
    if (!item.value || item.value.length > 4096 || /[\u0000-\u001f\u007f]/.test(item.value)
      || SECRET_LIKE_LOCAL_MCP_ARG.test(item.value) || UNSAFE_LOCAL_MCP_ARG.test(item.value)) return false;
    if (isAbsolute(item.value)) return SHA256_HEX.test(item.sha256 || '');
    return item.sha256 === undefined && !item.value.includes('/') && !item.value.includes('\\')
      && item.value !== '.' && item.value !== '..' && !item.value.startsWith('~');
  });
}

// Re-fingerprint the command and any absolute argv file immediately before a
// host-process launch. The caller gets no path interpolation or fallback.
export function assertLocalMcpRuntimeCurrent(value) {
  if (!isLocalMcpRuntime(value)) {
    throw new AosError('local_mcp_runtime_invalid', 'Local MCP runtime is not a canonical pinned local stdio descriptor', { statusCode: 409 });
  }
  try {
    const observed = normalizeLocalMcpRuntime(value);
    if (!deepEqual(observed, value)) {
      throw new AosError('local_mcp_installation_changed', 'Local MCP executable or pinned argv changed after registration', { statusCode: 409 });
    }
    return clone(observed);
  } catch (error) {
    if (error?.code === 'local_mcp_installation_changed') throw error;
    throw new AosError('local_mcp_installation_changed', 'Local MCP executable or pinned argv is unavailable or changed', { statusCode: 409 });
  }
}

export function localMcpLaunchFingerprint(value) {
  if (!isLocalMcpRuntime(value)) {
    throw new AosError('local_mcp_runtime_invalid', 'Local MCP runtime is not a canonical pinned local stdio descriptor', { statusCode: 409 });
  }
  return fingerprint(JSON.stringify({ command: value.command.sha256, argv: value.argv.map((item) => ({ value: item.value, sha256: item.sha256 || null })) }));
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
        ...(latestTest.probeFingerprint ? { probeFingerprint: latestTest.probeFingerprint } : {}),
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
    let runtime = null;
    if (input.kind === 'mcp') {
      if (sameBuiltinMcpSource(input.source)) {
        if (!sameBuiltinMcpRuntime(input.runtime)) {
          throw invalid('builtin mcp capabilities require the immutable AOS staged-text runtime', {
            field: 'runtime',
            expected: BUILTIN_MCP_STAGED_TEXT_RUNTIME,
          });
        }
        runtime = clone(BUILTIN_MCP_STAGED_TEXT_RUNTIME);
      } else if (sameLocalMcpSource(input.source)) {
        if (input.test.protocol !== LOCAL_MCP_STDIO_TEST_PROTOCOL) {
          throw invalid('local stdio MCP capabilities require the engine local_mcp_stdio_probe test protocol', {
            field: 'test.protocol', expected: LOCAL_MCP_STDIO_TEST_PROTOCOL,
          });
        }
        runtime = normalizeLocalMcpRuntime(input.runtime);
      } else {
        throw invalid('mcp capabilities may use only the AOS staged-text builtin or the bounded local stdio source', {
          field: 'source', expected: [BUILTIN_MCP_STAGED_TEXT_SOURCE, LOCAL_MCP_STDIO_SOURCE],
        });
      }
      if (input.permissions.length !== 1 || input.permissions[0] !== 'filesystem_read') {
        throw invalid('mcp capabilities may request only filesystem_read permission', {
          field: 'permissions', expected: ['filesystem_read'],
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
      runtime: input.kind === 'mcp' ? clone(runtime) : null,
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
    const capability = this.get(id, version);
    if (sameLocalMcpSource(capability.source) && isLocalMcpRuntime(capability.runtime) && input.status === 'passed') {
      throw invalid('local stdio MCP passing tests must use the engine probe', { field: 'status' });
    }
    return this.#recordTest(id, version, input);
  }

  #recordTest(id, version, input, { probe = null } = {}) {
    validate(TEST_INPUT_SCHEMA, input, 'capability test receipt');
    const probeFingerprint = probe ? fingerprint(JSON.stringify(probe)) : null;
    return this.engine.transact(() => {
      const capability = this.get(id, version);
      const existing = this.engine.state.capabilityTests.find((item) => item.requestId === input.requestId);
      if (existing) {
        const same = existing.capabilityId === capability.id
          && existing.capabilityVersion === capability.version
          && existing.status === input.status
          && existing.summary === input.summary
          && (existing.probeFingerprint || null) === probeFingerprint;
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
        ...(probeFingerprint ? { probeFingerprint } : {}),
      };
      this.engine.state.capabilityTests.push(receipt);
      this.engine.recordEvent('capability.tested', { payload: { capabilityId: capability.id, version: capability.version, status: receipt.status, receiptId: receipt.id } });
      return clone(receipt);
    });
  }

  async probeLocalMcp(id, version, input) {
    validate(LOCAL_MCP_PROBE_INPUT_SCHEMA, input, 'local MCP probe');
    const capability = this.get(id, version);
    if (!sameLocalMcpSource(capability.source) || !isLocalMcpRuntime(capability.runtime)
      || capability.test?.protocol !== LOCAL_MCP_STDIO_TEST_PROTOCOL) {
      throw invalid('capability is not a bounded local stdio MCP probe target', { field: 'capability' });
    }
    if (capability.state === 'revoked') {
      throw new AosError('capability_revoked', `Capability ${capability.reference} is revoked`, { statusCode: 409, details: { reference: capability.reference } });
    }
    // A request id is an immutable probe receipt, not a retry token. Check
    // before launching the operator-pinned host process so a replay cannot
    // execute it a second time after a receipt has been recorded.
    const existing = this.engine.state.capabilityTests.find((item) => item.requestId === input.requestId);
    if (existing) {
      if (existing.capabilityId === capability.id && existing.capabilityVersion === capability.version) return clone(existing);
      throw new AosError('capability_test_request_conflict', `Test request ${input.requestId} was already used`, { statusCode: 409 });
    }
    const workspaceDir = mkdtempSync(join(tmpdir(), 'aos-local-mcp-probe-'));
    const stagedFile = '__aos_local_mcp_probe__.txt';
    const scope = {
      projectId: 'local-mcp-probe',
      runId: 'local-mcp-probe',
      taskId: `probe-${capability.id}`,
      agentId: 'engine',
      invocationId: `probe:${input.requestId}`,
      attempt: 1,
      harnessSessionId: null,
    };
    const mount = {
      reference: capability.reference,
      id: capability.id,
      version: capability.version,
      kind: 'mcp',
      fingerprint: capability.fingerprint,
      runtime: capability.runtime,
      adapter: capability.source,
      permissions: capability.permissions,
    };
    try {
      writeFileSync(join(workspaceDir, stagedFile), 'aos-local-mcp-probe', { encoding: 'utf8', mode: 0o600 });
      const { LocalMcpStdioRuntime } = await import('./mcp-stdio.js');
      const runtime = new LocalMcpStdioRuntime({ clock: this.clock });
      try {
        const result = await runtime.execute({
          mount,
          scope,
          workspaceDir,
          stagedFile,
          idempotencyKey: `probe:${input.requestId}`,
          timeoutMs: input.timeoutMs ?? Math.min(2_000, MCP_MAX_TIMEOUT_MS),
        });
        const probe = {
          adapter: LOCAL_MCP_STDIO_ADAPTER,
          launchFingerprint: result.receipt?.launchFingerprint || null,
          tool: capability.runtime.tool.name,
          protocol: MCP_PROTOCOL_VERSION,
          effect: LOCAL_MCP_STDIO_EFFECT_CLASS,
          isolation: LOCAL_MCP_STDIO_ISOLATION,
          outputFingerprint: result.receipt?.outputFingerprint || null,
        };
        return this.#recordTest(id, version, {
          requestId: input.requestId,
          status: 'passed',
          summary: `Local stdio MCP probe passed for ${capability.runtime.tool.name}.`,
          actor: input.actor,
        }, { probe });
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
          ? error.code : 'local_mcp_probe_failed';
        return this.#recordTest(id, version, {
          requestId: input.requestId,
          status: 'failed',
          summary: `Local stdio MCP probe failed: ${code}.`,
          actor: input.actor,
        }, { probe: { adapter: LOCAL_MCP_STDIO_ADAPTER, errorCode: code } });
      }
    } finally {
      try { rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 1 }); } catch { /* probe cleanup is best effort */ }
    }
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

export function isTaskWorkspaceWriteRequested(task) {
  const requested = task?.capabilityExecution ?? taskEffectiveConfig(task)?.capabilityExecution;
  return Boolean(requested && typeof requested === 'object' && !Array.isArray(requested)
    && requested.effect === TASK_WORKSPACE_WRITE_EFFECT);
}

/**
 * Pure admission check for a bounded MCP staged-file read invocation.
 *
 * The registry must resolve tests, permissions, enablement and revocation
 * before this function is called. The shipped reader stays a read_only
 * sandbox; an operator-local server must explicitly select host_process so
 * callers cannot mistake a declared scope for OS-enforced isolation.
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
  const builtinMcp = sameBuiltinMcpRuntime(mount.runtime);
  const localMcp = isLocalMcpRuntime(mount.runtime);
  if (!builtinMcp && !localMcp) {
    throw admissionError('mcp_mount_runtime_invalid', 'MCP mount runtime is not an admitted staged-file contract', { reference: mount.reference });
  }
  for (const source of [mount.adapter, mount.source]) {
    if (source !== undefined && !(builtinMcp ? sameBuiltinMcpSource(source) : sameLocalMcpSource(source))) {
      throw admissionError('mcp_mount_source_invalid', builtinMcp
        ? 'MCP mount source does not match the AOS staged-text builtin'
        : 'MCP mount source does not match the bounded local stdio adapter', { reference: mount.reference });
    }
  }
  if (localMcp && !sameLocalMcpSource(mount.adapter)) {
    throw admissionError('mcp_mount_source_invalid', 'Local MCP mount requires the bounded local stdio adapter', { reference: mount.reference });
  }

  const effective = taskEffectiveConfig(task);
  const filesystem = task.filesystem || effective.filesystem || {};
  const sandbox = task.sandbox ?? filesystem.sandbox;
  const expectedSandbox = localMcp ? 'host_process' : 'read_only';
  if (sandbox !== expectedSandbox) {
    throw admissionError(localMcp ? 'local_mcp_sandbox_invalid' : 'mcp_sandbox_invalid', localMcp
      ? 'Local MCP execution requires explicit host_process disclosure; it is not filesystem or network isolation'
      : 'MCP staged-text execution requires a read_only sandbox', { sandbox: sandbox ?? null, expectedSandbox });
  }
  const readPaths = task.readPaths ?? filesystem.readPaths;
  if (!Array.isArray(readPaths) || readPaths.length !== 1 || !isRelativeDeclaredPath(readPaths[0])) {
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
  if (localMcp && (task.worker ?? effective.harness?.id ?? 'local') !== 'local') {
    throw admissionError('local_mcp_worker_invalid', 'Local MCP execution runs only through the local deterministic engine path');
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

/**
 * Pure admission check for the one AOS-owned deterministic workspace writer.
 * Registry resolution happens separately; this function keeps the executable
 * contract narrow enough that a plan cannot turn it into a generic file writer.
 */
export function assertTaskWorkspaceWriteAdmission(taskOrInput = {}, mountsOrTask = undefined) {
  const { task, mounts } = admissionArguments(taskOrInput, mountsOrTask);
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw admissionError('workspace_write_task_admission_invalid', 'Task-workspace write admission requires a task object');
  }
  if (!Array.isArray(mounts) || mounts.length !== 1) {
    throw admissionError('workspace_write_mount_count_invalid', 'Task-workspace write admission requires exactly one resolved mount', { mountCount: Array.isArray(mounts) ? mounts.length : null });
  }
  const [mount] = mounts;
  if (!mount || typeof mount !== 'object' || Array.isArray(mount) || mount.kind !== 'tool') {
    throw admissionError('workspace_write_mount_invalid', 'Task-workspace write admission requires one resolved tool mount');
  }
  if (typeof mount.reference !== 'string' || typeof mount.fingerprint !== 'string' || !mount.fingerprint) {
    throw admissionError('workspace_write_mount_invalid', 'Task-workspace write mount requires an exact versioned reference and fingerprint');
  }
  if (!sameObjectShape(mount.adapter, BUILTIN_TASK_WORKSPACE_WRITE_SOURCE)
    || (mount.source !== undefined && !sameObjectShape(mount.source, BUILTIN_TASK_WORKSPACE_WRITE_SOURCE))) {
    throw admissionError('workspace_write_source_invalid', 'Task-workspace write requires the immutable AOS generated source', { reference: mount.reference });
  }
  if (!Array.isArray(mount.permissions) || mount.permissions.length !== 1 || mount.permissions[0] !== 'filesystem_write') {
    throw admissionError('workspace_write_permissions_invalid', 'Task-workspace write requires only filesystem_write permission');
  }

  const effective = taskEffectiveConfig(task);
  const filesystem = task.filesystem || effective.filesystem || {};
  const sandbox = task.sandbox ?? filesystem.sandbox;
  if (sandbox !== 'workspace_write') {
    throw admissionError('workspace_write_sandbox_invalid', 'Task-workspace write requires the workspace_write sandbox', { sandbox: sandbox ?? null });
  }
  const pathLists = [task.readPaths, task.writePaths, task.filesystem?.readPaths, task.filesystem?.writePaths,
    effective.readPaths, effective.writePaths, effective.filesystem?.readPaths, effective.filesystem?.writePaths]
    .filter((value) => value !== undefined && value !== null);
  if (pathLists.some((paths) => !Array.isArray(paths) || paths.length)) {
    throw admissionError('workspace_write_paths_invalid', 'Task-workspace write does not accept declared read or write paths');
  }
  const networkPolicies = [task.network, effective.network].filter((value) => value !== undefined && value !== null);
  if (networkPolicies.some((network) => network !== false)) {
    throw admissionError('workspace_write_network_invalid', 'Task-workspace write requires network disabled');
  }
  const externalActionPolicies = [task.externalActions, effective.externalActions].filter((value) => value !== undefined && value !== null);
  if (externalActionPolicies.some((value) => value !== false)) {
    throw admissionError('workspace_write_external_actions_invalid', 'Task-workspace write cannot enable external actions');
  }
  const permissionLists = [task.permissions, task.capabilityPermissions, effective.permissions]
    .filter((value) => value !== undefined && value !== null);
  for (const permissions of permissionLists) {
    if (!Array.isArray(permissions) || permissions.length !== 1 || permissions[0] !== 'filesystem_write') {
      throw admissionError('workspace_write_permissions_invalid', 'Task-workspace write may request only filesystem_write permission');
    }
  }
  const declaredTools = [task.capabilities?.tools, effective.capabilities?.tools]
    .filter((value) => value !== undefined && value !== null);
  if (!declaredTools.length || declaredTools.some((tools) => !Array.isArray(tools) || tools.length !== 1 || tools[0] !== mount.reference)) {
    throw admissionError('workspace_write_mount_unbound', 'Task-workspace write capability declaration must bind the exact mounted reference', { reference: mount.reference });
  }
  const requested = task.capabilityExecution ?? effective.capabilityExecution;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)
    || Object.keys(requested).length !== 1 || requested.effect !== TASK_WORKSPACE_WRITE_EFFECT) {
    throw admissionError('workspace_write_execution_invalid', 'Task-workspace write capabilityExecution must be the exact engine-owned effect selector');
  }
  if (task.requiresApproval !== true) {
    throw admissionError('workspace_write_approval_required', 'Task-workspace write requires an exact operator approval gate');
  }
  if ((task.worker || effective.harness?.id || 'local') !== 'local') {
    throw admissionError('workspace_write_worker_invalid', 'Task-workspace write executes only through the local deterministic engine path');
  }
  return true;
}
