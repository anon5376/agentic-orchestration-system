import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as capabilityRegistry from './capabilities.js';
import { fingerprint, nowIso } from './ids.js';
import { AosError } from './schema.js';

export const MCP_PROTOCOL_VERSION = capabilityRegistry.MCP_PROTOCOL_VERSION;
export const STAGED_TEXT_READER_REFERENCE = capabilityRegistry.BUILTIN_MCP_STAGED_TEXT_INSTALLATION;
export const [STAGED_TEXT_READER_ID, STAGED_TEXT_READER_VERSION_TEXT] = STAGED_TEXT_READER_REFERENCE.split('@');
export const STAGED_TEXT_READER_VERSION = Number(STAGED_TEXT_READER_VERSION_TEXT);
export const MCP_TOOL_NAME = capabilityRegistry.MCP_TOOL;
export const MCP_EFFECT = capabilityRegistry.MCP_EFFECT_CLASS;

export const MAX_STAGED_FILE_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_STDIO_LINE_BYTES = 64 * 1024;
export const MAX_MCP_TIMEOUT_MS = capabilityRegistry.MCP_MAX_TIMEOUT_MS;
export const DEFAULT_MCP_TIMEOUT_MS = Math.min(2_000, MAX_MCP_TIMEOUT_MS);
export const MCP_KILL_GRACE_MS = 100;
export const MCP_REAP_TIMEOUT_MS = 2_000;

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIR = resolve(ENGINE_DIR, '..');
const ENGINE_INSTALLATION_DESCRIPTOR = capabilityRegistry.BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR;
export const STAGED_TEXT_READER_SERVER_MODULE = ENGINE_INSTALLATION_DESCRIPTOR?.argv?.[0] || null;

const STAGED_FILE_PATTERN = '^[^/\\\\\\x00-\\x1f<>:"|?*]+$';
export const STAGED_TEXT_READER_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    stagedFile: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: STAGED_FILE_PATTERN,
    }),
  }),
  required: Object.freeze(['stagedFile']),
  additionalProperties: false,
});

export const STAGED_TEXT_READER_TOOL = Object.freeze({
  name: MCP_TOOL_NAME,
  inputSchema: STAGED_TEXT_READER_INPUT_SCHEMA,
});

const ENGINE_INSTALLATION = Object.freeze({
  id: STAGED_TEXT_READER_ID,
  version: STAGED_TEXT_READER_VERSION,
  reference: STAGED_TEXT_READER_REFERENCE,
  kind: 'mcp',
  protocolVersion: MCP_PROTOCOL_VERSION,
  tool: STAGED_TEXT_READER_TOOL,
  fingerprint: fingerprint(STAGED_TEXT_READER_REFERENCE),
});

const ERROR_MESSAGES = Object.freeze({
  capability_mount_invalid: 'MCP capability mount is invalid.',
  capability_mount_mismatch: 'MCP capability mount does not match the engine installation.',
  capability_scope_invalid: 'MCP capability scope is invalid.',
  capability_idempotency_invalid: 'MCP capability idempotency key is invalid.',
  capability_idempotency_conflict: 'MCP capability idempotency key was already used for a different request.',
  capability_installation_invalid: 'The engine MCP installation descriptor is invalid.',
  capability_installation_unavailable: 'The requested engine MCP installation is unavailable.',
  capability_workspace_invalid: 'The MCP workspace is invalid.',
  capability_staged_file_invalid: 'The staged file name is invalid.',
  capability_staged_file_missing: 'The staged file is unavailable.',
  capability_staged_file_symlink: 'The staged file may not be a symbolic link.',
  capability_staged_file_not_regular: 'The staged file must be a regular file.',
  capability_staged_file_oversize: 'The staged file exceeds the bounded size.',
  capability_staged_file_unreadable: 'The staged file could not be read safely.',
  capability_timeout_invalid: 'The MCP timeout is invalid.',
  capability_timed_out: 'MCP capability execution timed out.',
  capability_cancelled: 'MCP capability execution was cancelled.',
  capability_spawn_failed: 'The MCP capability process could not be started.',
  capability_process_failed: 'The MCP capability process failed.',
  capability_process_ended: 'The MCP capability process ended before completing the protocol.',
  capability_reap_failed: 'The MCP capability process could not be reaped.',
  capability_stdout_oversize: 'MCP stdout exceeded the bounded size.',
  capability_stderr_oversize: 'MCP stderr exceeded the bounded size.',
  capability_protocol_malformed: 'The MCP protocol line was malformed.',
  capability_protocol_oversize: 'The MCP protocol line or stream exceeded the bounded size.',
  capability_protocol_version: 'The MCP protocol version was not accepted.',
  capability_protocol_id: 'The MCP response id was not accepted.',
  capability_protocol_result: 'The MCP response result was not accepted.',
  capability_protocol_unexpected: 'The MCP process sent an unexpected message.',
  capability_tool_list_drift: 'The MCP tool list did not match the engine contract.',
  capability_tool_result_invalid: 'The MCP tool result was invalid.',
  capability_output_oversize: 'The MCP tool output exceeded the bounded size.',
  capability_secret_content: 'The MCP tool output contained secret-like content.',
  capability_shutdown_failed: 'The MCP capability process did not shut down cleanly.',
});

export class McpCapabilityError extends AosError {
  constructor(code, message = ERROR_MESSAGES[code] || 'MCP capability execution failed.') {
    super(code, message, { statusCode: 409, details: null });
    this.name = 'McpCapabilityError';
    this.retryable = false;
    this.fatal = true;
  }
}

function fail(code) {
  return new McpCapabilityError(code);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return structuredClone(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function normalizeScope(scope) {
  const required = ['projectId', 'runId', 'taskId', 'agentId', 'invocationId', 'attempt'];
  if (!isRecord(scope)) throw fail('capability_scope_invalid');
  const allowed = new Set([...required, 'harnessSessionId']);
  if (Object.keys(scope).some((key) => !allowed.has(key))) throw fail('capability_scope_invalid');
  for (const field of required.slice(0, -1)) {
    if (!boundedString(scope[field], 300)) throw fail('capability_scope_invalid');
  }
  if (!Number.isInteger(scope.attempt) || scope.attempt < 1) throw fail('capability_scope_invalid');
  if (scope.harnessSessionId !== undefined && scope.harnessSessionId !== null && !boundedString(scope.harnessSessionId, 300)) {
    throw fail('capability_scope_invalid');
  }
  return {
    projectId: scope.projectId,
    runId: scope.runId,
    taskId: scope.taskId,
    agentId: scope.agentId,
    invocationId: scope.invocationId,
    attempt: scope.attempt,
    harnessSessionId: scope.harnessSessionId ?? null,
  };
}

function normalizeIdempotencyKey(value) {
  if (!boundedString(value, 300) || /[\u0000-\u001f\u007f]/.test(value)) throw fail('capability_idempotency_invalid');
  return value;
}

function normalizeStagedFile(value) {
  if (!boundedString(value, 255) || value === '.' || value === '..') throw fail('capability_staged_file_invalid');
  if (value !== basename(value) || value.includes('/') || value.includes('\\') || value.includes('\u0000')) {
    throw fail('capability_staged_file_invalid');
  }
  if (!new RegExp(STAGED_FILE_PATTERN).test(value)) throw fail('capability_staged_file_invalid');
  return value;
}

function canonicalWorkspace(workspaceDir) {
  if (!boundedString(workspaceDir, 4_096) || !isAbsolute(workspaceDir)) throw fail('capability_workspace_invalid');
  try {
    const canonical = realpathSync(workspaceDir);
    if (!statSync(canonical).isDirectory()) throw fail('capability_workspace_invalid');
    return canonical;
  } catch (error) {
    if (error instanceof McpCapabilityError) throw error;
    throw fail('capability_workspace_invalid');
  }
}

function within(parent, candidate) {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function readStagedFile(workspaceDir, stagedFile) {
  const path = resolve(workspaceDir, stagedFile);
  if (!within(workspaceDir, path)) throw fail('capability_staged_file_invalid');
  let descriptor;
  try {
    descriptor = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail('capability_staged_file_missing');
    throw fail('capability_staged_file_unreadable');
  }
  if (descriptor.isSymbolicLink()) throw fail('capability_staged_file_symlink');
  if (!descriptor.isFile()) throw fail('capability_staged_file_not_regular');
  if (descriptor.size > MAX_STAGED_FILE_BYTES) throw fail('capability_staged_file_oversize');

  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw fail('capability_staged_file_not_regular');
    if (opened.size > MAX_STAGED_FILE_BYTES) throw fail('capability_staged_file_oversize');
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_STAGED_FILE_BYTES) throw fail('capability_staged_file_oversize');
    return bytes;
  } catch (error) {
    if (error instanceof McpCapabilityError) throw error;
    if (error?.code === 'ELOOP') throw fail('capability_staged_file_symlink');
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw fail('capability_staged_file_missing');
    throw fail('capability_staged_file_unreadable');
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* the descriptor is already closed */ }
    }
  }
}

function hasSecretLikeContent(text) {
  if (typeof text !== 'string') return false;
  const patterns = [
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    /\b(?:sk|rk|pk|ghp|gho|ghs|ghr|AIza)[A-Za-z0-9_-]{16,}/i,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|authorization|credential|cookie)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{6,}/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function installationCandidate(value, key = '') {
  if (!isRecord(value)) return null;
  const directReference = typeof value.reference === 'string' ? value.reference : null;
  const id = typeof value.id === 'string' ? value.id : typeof value.capabilityId === 'string' ? value.capabilityId : null;
  const version = Number.isInteger(value.version) ? value.version : Number.isInteger(value.capabilityVersion) ? value.capabilityVersion : null;
  const installation = typeof value.installation === 'string' ? value.installation : null;
  const keyReference = key === STAGED_TEXT_READER_REFERENCE ? key : null;
  if (directReference !== STAGED_TEXT_READER_REFERENCE
    && installation !== STAGED_TEXT_READER_REFERENCE
    && !(id === STAGED_TEXT_READER_ID && version === STAGED_TEXT_READER_VERSION)
    && !keyReference) return null;
  return value;
}

function likelyInstallationCollectionName(name) {
  return /(?:INSTALLATION|CAPABILITY).*?(?:MAP|REGISTRY|INSTALLATION|DESCRIPTOR|BUILTIN)/i.test(name)
    || /(?:MCP|BUILTIN).*?(?:CAPABILIT|INSTALL)/i.test(name);
}

function findEngineInstallation() {
  const explicitNames = [
    'AOS_CAPABILITY_INSTALLATIONS',
    'CAPABILITY_INSTALLATIONS',
    'ENGINE_CAPABILITY_INSTALLATIONS',
    'BUILTIN_CAPABILITY_INSTALLATIONS',
    'MCP_INSTALLATIONS',
    'MCP_CAPABILITIES',
    'CAPABILITY_DESCRIPTORS',
    'BUILTIN_MCP_STAGED_TEXT_INSTALLATION_DESCRIPTOR',
  ];
  const roots = [];
  for (const name of explicitNames) {
    if (Object.prototype.hasOwnProperty.call(capabilityRegistry, name)) roots.push([name, capabilityRegistry[name]]);
  }
  for (const [name, value] of Object.entries(capabilityRegistry)) {
    if (likelyInstallationCollectionName(name) && !roots.some(([rootName]) => rootName === name)) roots.push([name, value]);
  }
  const visited = new WeakSet();
  const walk = (value, key = '', depth = 0) => {
    if (depth > 5 || value == null || typeof value !== 'object') return null;
    const direct = installationCandidate(value, key);
    if (direct) return direct;
    if (visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, '', depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const [childKey, child] of Object.entries(value)) {
      const found = walk(child, childKey, depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const [name, value] of roots) {
    const found = walk(value, name, 0);
    if (found) return { descriptor: found, registryPresent: true };
  }
  return { descriptor: null, registryPresent: roots.length > 0 };
}

function descriptorTool(descriptor) {
  const candidate = descriptor?.tool
    || descriptor?.toolDescriptor
    || descriptor?.mcp?.tool
    || (Array.isArray(descriptor?.tools) ? descriptor.tools.find((tool) => tool?.name === MCP_TOOL_NAME) : null);
  if (!candidate || typeof candidate === 'string') {
    if (candidate !== undefined && candidate !== MCP_TOOL_NAME) throw fail('capability_installation_invalid');
    return STAGED_TEXT_READER_TOOL;
  }
  const inputSchema = candidate.inputSchema || candidate.input_schema || candidate.schema;
  if (candidate.name !== MCP_TOOL_NAME || !inputSchema || !deepEqual(inputSchema, STAGED_TEXT_READER_INPUT_SCHEMA)) {
    throw fail('capability_installation_invalid');
  }
  return STAGED_TEXT_READER_TOOL;
}

function engineInstallation() {
  const found = findEngineInstallation();
  if (!found.descriptor) {
    if (found.registryPresent) throw fail('capability_installation_unavailable');
    return ENGINE_INSTALLATION;
  }
  const descriptor = found.descriptor;
  const reference = descriptor.reference
    || descriptor.installation
    || (descriptor.id && descriptor.version ? `${descriptor.id}@${descriptor.version}` : null);
  if (reference !== STAGED_TEXT_READER_REFERENCE || (descriptor.kind !== undefined && descriptor.kind !== 'mcp')) {
    throw fail('capability_installation_invalid');
  }
  const tool = descriptorTool(descriptor);
  const installationFingerprint = typeof descriptor.fingerprint === 'string'
    ? descriptor.fingerprint
    : typeof descriptor.capabilityFingerprint === 'string' ? descriptor.capabilityFingerprint : ENGINE_INSTALLATION.fingerprint;
  if (!boundedString(installationFingerprint, 300)) throw fail('capability_installation_invalid');
  if (descriptor.protocolVersion !== undefined && descriptor.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw fail('capability_installation_invalid');
  }
  return Object.freeze({
    id: STAGED_TEXT_READER_ID,
    version: STAGED_TEXT_READER_VERSION,
    reference: STAGED_TEXT_READER_REFERENCE,
    kind: 'mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    tool,
    fingerprint: installationFingerprint,
  });
}

function validateMount(mount, installation) {
  if (!isRecord(mount) || mount.kind !== 'mcp' || !boundedString(mount.reference, 300) || !boundedString(mount.fingerprint, 300)) {
    throw fail('capability_mount_invalid');
  }
  const parsedReference = mount.reference.match(/^([A-Za-z][A-Za-z0-9_.-]{0,127})@([1-9][0-9]*)$/);
  if (!parsedReference) throw fail('capability_mount_invalid');
  if (mount.id !== undefined && mount.id !== parsedReference[1]) throw fail('capability_mount_mismatch');
  if (mount.version !== undefined && mount.version !== Number(parsedReference[2])) throw fail('capability_mount_mismatch');
  if (!deepEqual(mount.runtime, capabilityRegistry.BUILTIN_MCP_STAGED_TEXT_RUNTIME)) {
    throw fail('capability_mount_mismatch');
  }
  if (!deepEqual(mount.adapter, capabilityRegistry.BUILTIN_MCP_STAGED_TEXT_SOURCE)) throw fail('capability_mount_mismatch');
  if (mount.source !== undefined && !deepEqual(mount.source, capabilityRegistry.BUILTIN_MCP_STAGED_TEXT_SOURCE)) throw fail('capability_mount_mismatch');
  return mount.fingerprint;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MCP_TIMEOUT_MS) throw fail('capability_timeout_invalid');
  return timeoutMs;
}

function outputTextFromResult(result) {
  if (!isRecord(result) || !exactKeys(result, ['content', 'isError']) || result.isError !== false || !Array.isArray(result.content) || result.content.length !== 1) {
    throw fail('capability_tool_result_invalid');
  }
  const content = result.content[0];
  if (!isRecord(content) || !exactKeys(content, ['type', 'text']) || content.type !== 'text' || typeof content.text !== 'string') {
    throw fail('capability_tool_result_invalid');
  }
  const bytes = Buffer.byteLength(content.text, 'utf8');
  if (bytes > MAX_TOOL_OUTPUT_BYTES) throw fail('capability_output_oversize');
  if (hasSecretLikeContent(content.text)) throw fail('capability_secret_content');
  return content.text;
}

function validateRpcResponse(message, expectedId) {
  if (!isRecord(message)) throw fail('capability_protocol_malformed');
  if (message.jsonrpc !== '2.0') throw fail('capability_protocol_version');
  if (!Object.prototype.hasOwnProperty.call(message, 'id') || message.id !== expectedId) throw fail('capability_protocol_id');
  if (!exactKeys(message, ['jsonrpc', 'id', 'result']) || !isRecord(message.result)) throw fail('capability_protocol_result');
  return message.result;
}

function parseProtocolLine(line) {
  if (!line.length) throw fail('capability_protocol_malformed');
  let parsed;
  try {
    parsed = JSON.parse(line.toString('utf8'));
  } catch {
    throw fail('capability_protocol_malformed');
  }
  if (!isRecord(parsed)) throw fail('capability_protocol_malformed');
  return parsed;
}

class ProtocolChannel {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.failure = null;
    this.ended = false;
    this.totalBytes = 0;
  }

  fail(error) {
    if (this.failure || this.ended) return;
    this.failure = error instanceof McpCapabilityError ? error : fail('capability_process_failed');
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(this.failure);
  }

  deliver(message) {
    if (this.failure || this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.queue.push(message);
  }

  push(chunk) {
    if (this.failure || this.ended) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += bytes.length;
    if (this.totalBytes > MAX_STDOUT_BYTES) {
      this.fail(fail('capability_stdout_oversize'));
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    if (this.pending.length > MAX_STDIO_LINE_BYTES && !this.pending.includes(0x0a)) {
      this.fail(fail('capability_protocol_oversize'));
      return;
    }
    while (!this.failure) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > MAX_STDIO_LINE_BYTES) {
        this.fail(fail('capability_protocol_oversize'));
        break;
      }
      try {
        this.deliver(parseProtocolLine(line));
      } catch (error) {
        this.fail(error);
      }
    }
    if (!this.failure && this.pending.length > MAX_STDIO_LINE_BYTES) this.fail(fail('capability_protocol_oversize'));
  }

  end() {
    if (this.failure || this.ended) return;
    if (this.pending.length) {
      let line = this.pending;
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > MAX_STDIO_LINE_BYTES) this.fail(fail('capability_protocol_oversize'));
      else {
        try { this.deliver(parseProtocolLine(line)); } catch (error) { this.fail(error); }
      }
    }
    if (this.failure) return;
    this.ended = true;
    const waiters = this.waiters.splice(0);
    const error = fail('capability_process_ended');
    for (const waiter of waiters) waiter.reject(error);
  }

  next() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.ended) return Promise.reject(fail('capability_process_ended'));
    return new Promise((resolvePromise, rejectPromise) => this.waiters.push({ resolve: resolvePromise, reject: rejectPromise }));
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function closeStdin(child) {
  if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
  try { child.stdin.end(); } catch { /* the child may have exited */ }
}

function waitForClose(processState, timeoutMs = MCP_REAP_TIMEOUT_MS) {
  if (processState.closed) return Promise.resolve(processState.closeInfo);
  return Promise.race([
    processState.closePromise,
    delay(timeoutMs).then(() => { throw fail('capability_reap_failed'); }),
  ]);
}

async function stopProcess(processState, { graceMs = MCP_KILL_GRACE_MS, terminateImmediately = true } = {}) {
  if (processState.closed) return processState.closeInfo;
  closeStdin(processState.child);
  if (terminateImmediately && !processState.closed) {
    try { processState.child.kill('SIGTERM'); } catch { /* already gone */ }
    await Promise.race([processState.closePromise, delay(graceMs)]);
  }
  if (!processState.closed && !terminateImmediately) await Promise.race([processState.closePromise, delay(graceMs)]);
  if (!processState.closed) {
    try { processState.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  return waitForClose(processState);
}

function launchProcess({ workspaceDir, stagedFile, serverModule, mode = null }) {
  const descriptorArgv = mode === null ? ENGINE_INSTALLATION_DESCRIPTOR?.argv : [serverModule];
  const command = mode === null ? ENGINE_INSTALLATION_DESCRIPTOR?.command : process.execPath;
  if (command !== process.execPath || !Array.isArray(descriptorArgv) || descriptorArgv.length !== 1 || !isAbsolute(descriptorArgv[0])
    || !within(REPOSITORY_DIR, resolve(descriptorArgv[0]))) {
    throw fail('capability_installation_invalid');
  }
  const args = [...descriptorArgv, '--workspace-dir', workspaceDir, '--staged-file', stagedFile];
  if (mode !== null) args.push('--mode', mode);
  try {
    const child = spawn(process.execPath, args, {
      cwd: workspaceDir,
      env: Object.freeze({ NODE_ENV: 'production', NO_COLOR: '1' }),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const channel = new ProtocolChannel();
    const processState = {
      child,
      channel,
      closed: false,
      closeInfo: { exitCode: null, signal: null },
      closePromise: null,
    };
    processState.closePromise = new Promise((resolvePromise) => {
      child.stdout.on('data', (chunk) => channel.push(chunk));
      child.stdout.on('end', () => channel.end());
      child.stdout.on('error', () => channel.fail(fail('capability_process_failed')));
      child.stderr.on('data', (chunk) => {
        processState.stderrBytes = (processState.stderrBytes || 0) + chunk.length;
        if (processState.stderrBytes > MAX_STDERR_BYTES) channel.fail(fail('capability_stderr_oversize'));
      });
      child.stderr.on('error', () => { /* stderr is diagnostic only */ });
      child.stdin.on('error', () => { /* a child can exit before consuming stdin */ });
      child.once('error', () => channel.fail(fail('capability_spawn_failed')));
      child.once('close', (exitCode, signal) => {
        processState.closed = true;
        processState.closeInfo = { exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: signal || null };
        channel.end();
        resolvePromise(processState.closeInfo);
      });
    });
    return processState;
  } catch (error) {
    if (error instanceof McpCapabilityError) throw error;
    throw fail('capability_spawn_failed');
  }
}

function sendLine(processState, value) {
  let line;
  try { line = JSON.stringify(value); } catch { throw fail('capability_protocol_result'); }
  if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_LINE_BYTES - 1) throw fail('capability_protocol_oversize');
  try { processState.child.stdin.write(`${line}\n`); } catch { throw fail('capability_process_failed'); }
}

async function executeLifecycle({ workspaceDir, stagedFile, timeoutMs, signal, serverModule, mode }) {
  const processState = launchProcess({ workspaceDir, stagedFile, serverModule, mode });
  let stopPromise = null;
  let terminalError = null;
  const stop = (error) => {
    if (!terminalError) terminalError = error;
    processState.channel.fail(error);
    if (!stopPromise) stopPromise = stopProcess(processState);
    return stopPromise;
  };
  const timer = setTimeout(() => { void stop(fail('capability_timed_out')); }, timeoutMs);
  const onAbort = () => { void stop(fail('capability_cancelled')); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });

  const request = (id, method, params) => {
    sendLine(processState, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  };
  const notification = (method) => sendLine(processState, { jsonrpc: '2.0', method });
  let output = null;
  try {
    request(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'AOS', version: '1' },
    });
    const initializeResult = validateRpcResponse(await processState.channel.next(), 1);
    if (initializeResult.protocolVersion !== MCP_PROTOCOL_VERSION) throw fail('capability_protocol_version');

    notification('notifications/initialized');
    request(2, 'tools/list', {});
    const listResult = validateRpcResponse(await processState.channel.next(), 2);
    if (!exactKeys(listResult, ['tools']) || !Array.isArray(listResult.tools) || listResult.tools.length !== 1 || !deepEqual(listResult.tools[0], STAGED_TEXT_READER_TOOL)) {
      throw fail('capability_tool_list_drift');
    }

    request(3, 'tools/call', { name: MCP_TOOL_NAME, arguments: { stagedFile } });
    const callResult = validateRpcResponse(await processState.channel.next(), 3);
    output = outputTextFromResult(callResult);
    if (terminalError) throw terminalError;

    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    closeStdin(processState.child);
    const closeInfo = await stopProcess(processState, { graceMs: MCP_KILL_GRACE_MS, terminateImmediately: false });
    if (processState.channel.failure) throw processState.channel.failure;
    if (processState.channel.queue.length) throw fail('capability_protocol_unexpected');
    if (closeInfo.exitCode !== null && closeInfo.exitCode !== 0 && closeInfo.signal === null) throw fail('capability_process_failed');
    return { output, processInfo: closeInfo };
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    if (!stopPromise) stopPromise = stopProcess(processState).catch((reapError) => { terminalError ||= reapError; return processState.closeInfo; });
    const processInfo = await stopPromise;
    if (terminalError && (error?.code === 'capability_process_ended' || error?.code === 'capability_process_failed')) error = terminalError;
    if (error instanceof McpCapabilityError) {
      error.processInfo = processInfo;
      throw error;
    }
    const wrapped = fail('capability_process_failed');
    wrapped.processInfo = processInfo;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function makeReceipt({ installation, scope, mountFingerprint, requestFingerprint, inputFingerprint, outputFingerprint, startedAt, endedAt, processInfo, errorCode }) {
  return {
    installation: installation.id,
    version: installation.version,
    protocol: MCP_PROTOCOL_VERSION,
    tool: MCP_TOOL_NAME,
    effect: MCP_EFFECT,
    scope: clone(scope),
    fingerprints: {
      installation: installation.fingerprint,
      mount: mountFingerprint,
      scope: fingerprint(stableJson(scope)),
      input: inputFingerprint,
      request: requestFingerprint,
      output: outputFingerprint,
    },
    startedAt,
    endedAt,
    exitCode: processInfo?.exitCode ?? null,
    signal: processInfo?.signal ?? null,
    errorCode: errorCode || null,
  };
}

function cloneFailure(code, receipt, requestFingerprint) {
  const error = fail(code);
  error.receipt = clone(receipt);
  error.requestFingerprint = requestFingerprint;
  return error;
}

export class McpStdioRuntime {
  #attempts = new Map();

  constructor({
    clock = () => Date.now(),
    // These two options are test seams only. Production execution always uses
    // the fixed shipped module and does not accept a server path or arguments.
    testServerModule = null,
    testServerMode = null,
  } = {}) {
    this.clock = clock;
    this.testServerModule = testServerModule;
    this.testServerMode = testServerMode;
    if (testServerModule !== null) {
      if (typeof testServerModule !== 'string' || !isAbsolute(testServerModule) || !within(REPOSITORY_DIR, resolve(testServerModule))) {
        throw fail('capability_installation_invalid');
      }
      if (typeof testServerMode !== 'string' || !/^[a-z][a-z0-9-]{0,48}$/.test(testServerMode)) throw fail('capability_installation_invalid');
    } else if (testServerMode !== null) {
      throw fail('capability_installation_invalid');
    }
  }

  async execute({ mount, scope, workspaceDir, stagedFile, idempotencyKey, timeoutMs = DEFAULT_MCP_TIMEOUT_MS, signal = null } = {}) {
    const installation = engineInstallation();
    const exactScope = normalizeScope(scope);
    const key = normalizeIdempotencyKey(idempotencyKey);
    const exactTimeout = validateTimeout(timeoutMs);
    const mountFingerprint = validateMount(mount, installation);
    const workspace = canonicalWorkspace(workspaceDir);
    const file = normalizeStagedFile(stagedFile);
    const bytes = readStagedFile(workspace, file);
    const inputFingerprint = fingerprint(Buffer.from(bytes).toString('base64'));
    const requestFingerprint = fingerprint(stableJson({
      installation: installation.reference,
      installationFingerprint: installation.fingerprint,
      mountFingerprint,
      scope: exactScope,
      timeoutMs: exactTimeout,
      workspace: fingerprint(workspace),
      stagedFile: file,
      inputFingerprint,
    }));
    const prior = this.#attempts.get(key);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) throw fail('capability_idempotency_conflict');
      if (prior.errorCode) throw cloneFailure(prior.errorCode, prior.receipt, requestFingerprint);
      return { output: prior.output, receipt: clone(prior.receipt), requestFingerprint, idempotent: true };
    }

    const startedAt = nowIso(this.clock);
    let outputFingerprint = null;
    let processInfo = null;
    try {
      if (signal?.aborted) throw fail('capability_cancelled');
      const lifecycle = await executeLifecycle({
        workspaceDir: workspace,
        stagedFile: file,
        timeoutMs: exactTimeout,
        signal,
        serverModule: this.testServerModule || STAGED_TEXT_READER_SERVER_MODULE,
        mode: this.testServerModule ? this.testServerMode : null,
      });
      outputFingerprint = fingerprint(lifecycle.output);
      processInfo = lifecycle.processInfo;
      const receipt = makeReceipt({
        installation,
        scope: exactScope,
        mountFingerprint,
        requestFingerprint,
        inputFingerprint,
        outputFingerprint,
        startedAt,
        endedAt: nowIso(this.clock),
        processInfo,
        errorCode: null,
      });
      const result = { output: lifecycle.output, receipt, requestFingerprint };
      this.#attempts.set(key, { requestFingerprint, output: lifecycle.output, receipt, errorCode: null });
      return result;
    } catch (error) {
      const typed = error instanceof McpCapabilityError ? error : fail('capability_process_failed');
      processInfo = typed.processInfo || processInfo;
      const receipt = makeReceipt({
        installation,
        scope: exactScope,
        mountFingerprint,
        requestFingerprint,
        inputFingerprint,
        outputFingerprint,
        startedAt,
        endedAt: nowIso(this.clock),
        processInfo,
        errorCode: typed.code,
      });
      typed.receipt = receipt;
      typed.requestFingerprint = requestFingerprint;
      this.#attempts.set(key, { requestFingerprint, output: null, receipt, errorCode: typed.code });
      throw typed;
    }
  }
}

export function getEngineMcpInstallation() {
  return clone(engineInstallation());
}
