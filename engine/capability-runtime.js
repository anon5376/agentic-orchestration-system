import { fingerprint, nowIso } from './ids.js';
import { AosError } from './schema.js';
import {
  BUILTIN_MCP_STAGED_TEXT_RUNTIME,
  MCP_MAX_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  MCP_TOOL,
  MCP_EFFECT_CLASS,
} from './capabilities.js';

export const BOUNDED_ECHO_SOURCE = 'aos.bounded-echo-v1';
export const MCP_STAGED_TEXT_SOURCE = 'aos.mcp.staged-text-reader.v1';
export const MCP_STAGED_TEXT_ADAPTER = 'mcp-stdio';
const MAX_INPUT_BYTES = 4096;
const MAX_OUTPUT_BYTES = 4096;
const MAX_TIMEOUT_MS = 500;
const REQUIRED_SCOPE_FIELDS = ['projectId', 'runId', 'taskId', 'agentId', 'invocationId', 'attempt'];

function fail(code, message, details = null) {
  return new AosError(code, message, { statusCode: 409, details });
}

function json(value, label, maxBytes) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw fail('capability_payload_invalid', `${label} must be JSON-serializable`); }
  if (serialized === undefined) throw fail('capability_payload_invalid', `${label} must be JSON-serializable`);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) throw fail('capability_payload_too_large', `${label} exceeds ${maxBytes} bytes`, { maxBytes, bytes });
  return { serialized, bytes };
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object') throw fail('capability_scope_invalid', 'Capability execution requires an exact attempt scope');
  for (const field of REQUIRED_SCOPE_FIELDS) {
    const value = scope[field];
    if (field === 'attempt') {
      if (!Number.isInteger(value) || value < 1) throw fail('capability_scope_invalid', 'Capability execution scope requires a positive attempt');
    } else if (typeof value !== 'string' || !value) {
      throw fail('capability_scope_invalid', `Capability execution scope requires ${field}`);
    }
  }
  if (scope.harnessSessionId != null && (typeof scope.harnessSessionId !== 'string' || !scope.harnessSessionId.startsWith('hss_'))) {
    throw fail('capability_scope_invalid', 'harnessSessionId must be an AOS harness session or null');
  }
  return { ...Object.fromEntries(REQUIRED_SCOPE_FIELDS.map((field) => [field, scope[field]])), harnessSessionId: scope.harnessSessionId ?? null };
}

function sameObjectShape(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => value[key] === expected[key]);
}

function validateMount(mount) {
  if (!mount || typeof mount !== 'object' || typeof mount.reference !== 'string' || typeof mount.fingerprint !== 'string') {
    throw fail('capability_mount_invalid', 'Capability execution requires an exact mounted capability receipt');
  }
  if (mount.kind === 'tool') {
    if (mount.adapter?.type !== 'generated' || mount.adapter?.reference !== BOUNDED_ECHO_SOURCE) {
      throw fail('capability_adapter_unsupported', `No local runtime adapter is implemented for ${mount.reference}`);
    }
    return 'echo';
  }
  if (mount.kind === 'mcp') {
    if (!sameObjectShape(mount.runtime, BUILTIN_MCP_STAGED_TEXT_RUNTIME)) {
      throw fail('mcp_runtime_invalid', 'MCP execution requires the immutable AOS staged-text runtime');
    }
    if (mount.adapter?.type !== 'builtin' || mount.adapter?.reference !== MCP_STAGED_TEXT_SOURCE) {
      throw fail('mcp_source_invalid', 'MCP execution requires the immutable AOS staged-text source');
    }
    if (!Array.isArray(mount.permissions) || mount.permissions.length !== 1 || mount.permissions[0] !== 'filesystem_read') {
      throw fail('mcp_permissions_invalid', 'MCP execution requires only filesystem_read permission');
    }
    return 'mcp';
  }
  throw fail('capability_adapter_unsupported', `No local runtime adapter is implemented for ${mount.reference}`);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('capability_cancelled', 'Capability execution was cancelled'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(fail('capability_cancelled', 'Capability execution was cancelled')); }, { once: true });
  });
}

// The deterministic echo adapter and the engine-shipped MCP adapter share the
// idempotency/receipt boundary, but only MCP is allowed to invoke a process.
export class CapabilityRuntime {
  constructor({ clock = () => Date.now(), mcpRuntime = null } = {}) {
    this.clock = clock;
    this.mcpRuntime = mcpRuntime;
    this.mcpRuntimePromise = null;
    this.attempts = new Map();
  }

  async execute({ mount, scope, input = {}, idempotencyKey, timeoutMs = 250, signal = null, workspaceDir = null, stagedFile = null, sourceFingerprint = null } = {}) {
    const adapter = validateMount(mount);
    const exactScope = validateScope(scope);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 300) {
      throw fail('capability_idempotency_invalid', 'Capability execution requires a bounded idempotency key');
    }
    const timeoutLimit = adapter === 'mcp' ? MCP_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > timeoutLimit) {
      throw fail('capability_timeout_invalid', `Capability timeout must be an integer from 1 to ${timeoutLimit} ms`);
    }
    if (adapter === 'mcp') {
      return this.#executeMcp({ mount, scope: exactScope, idempotencyKey, timeoutMs, signal, workspaceDir, stagedFile, sourceFingerprint });
    }

    const inputJson = json(input, 'Capability input', MAX_INPUT_BYTES);
    const requestFingerprint = fingerprint(JSON.stringify({ mount: { reference: mount.reference, fingerprint: mount.fingerprint }, scope: exactScope, input: inputJson.serialized }));
    const prior = this.attempts.get(idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) throw fail('capability_idempotency_conflict', 'Capability idempotency key was already used with different input');
      if (prior.receipt.status !== 'succeeded') throw Object.assign(fail(prior.receipt.errorCode || 'capability_execution_failed', 'Capability execution already reached a terminal failure'), { receipt: prior.receipt, requestFingerprint });
      return { ...prior, idempotent: true };
    }
    const startedAt = nowIso(this.clock); const started = this.clock(); let timeoutTimer;
    const receipt = (status, extra = {}) => ({ reference: mount.reference, capabilityFingerprint: mount.fingerprint, adapter: 'bounded-echo', adapterVersion: 1, status, scope: exactScope, idempotencyKey, inputFingerprint: fingerprint(inputJson.serialized), outputFingerprint: extra.outputJson ? fingerprint(extra.outputJson) : null, startedAt, endedAt: nowIso(this.clock), durationMs: Math.max(0, this.clock() - started), errorCode: extra.errorCode || null });
    try {
      const delayMs = input && typeof input === 'object' && !Array.isArray(input) ? (input.delayMs ?? 0) : 0;
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 250) throw fail('capability_input_invalid', 'bounded-echo delayMs must be an integer from 0 to 250');
      const timeout = new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(fail('capability_timed_out', 'Capability execution timed out')), timeoutMs); });
      await Promise.race([sleep(delayMs, signal), timeout]);
      const output = { echoed: input }; const outputJson = json(output, 'Capability output', MAX_OUTPUT_BYTES).serialized;
      const result = { output, receipt: receipt('succeeded', { outputJson }), requestFingerprint }; this.attempts.set(idempotencyKey, result); return result;
    } catch (error) {
      const code = error?.code || 'capability_execution_failed'; const result = { output: null, receipt: receipt(code === 'capability_cancelled' ? 'cancelled' : 'failed', { errorCode: code }), requestFingerprint }; this.attempts.set(idempotencyKey, result);
      throw Object.assign(error instanceof Error ? error : fail(code, 'Capability execution failed'), { receipt: result.receipt, requestFingerprint });
    } finally { if (timeoutTimer) clearTimeout(timeoutTimer); }
  }

  async #loadMcpRuntime() {
    if (this.mcpRuntime) {
      if (typeof this.mcpRuntime === 'function') return new this.mcpRuntime({ clock: this.clock });
      return this.mcpRuntime;
    }
    if (!this.mcpRuntimePromise) {
      this.mcpRuntimePromise = import('./mcp-stdio.js').then((module) => {
        const Runtime = module.McpStdioRuntime || module.default;
        if (!Runtime) throw fail('mcp_runtime_unavailable', 'The shipped MCP runtime is unavailable');
        if (typeof Runtime === 'function' && Runtime.prototype?.execute) return new Runtime({ clock: this.clock });
        if (typeof Runtime.execute === 'function') return Runtime;
        throw fail('mcp_runtime_unavailable', 'The shipped MCP runtime is unavailable');
      }).catch((error) => {
        this.mcpRuntimePromise = null;
        if (error?.code) throw error;
        throw fail('mcp_runtime_unavailable', 'The shipped MCP runtime is unavailable');
      });
    }
    return this.mcpRuntimePromise;
  }

  async #executeMcp({ mount, scope, idempotencyKey, timeoutMs, signal, workspaceDir, stagedFile, sourceFingerprint }) {
    if (typeof workspaceDir !== 'string' || !workspaceDir || typeof stagedFile !== 'string' || !stagedFile) {
      throw fail('mcp_staging_invalid', 'MCP execution requires an engine-owned staged file');
    }
    if (signal?.aborted) throw fail('capability_cancelled', 'Capability execution was cancelled');
    const requestFingerprint = fingerprint(JSON.stringify({
      mount: { reference: mount.reference, fingerprint: mount.fingerprint },
      scope,
      stagedFile: stagedFile.split(/[\\/]/).at(-1),
      sourceFingerprint: typeof sourceFingerprint === 'string' ? sourceFingerprint : null,
    }));
    const prior = this.attempts.get(idempotencyKey);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) throw fail('capability_idempotency_conflict', 'Capability idempotency key was already used with a different staged input');
      if (prior.receipt.status !== 'succeeded') throw Object.assign(fail(prior.receipt.errorCode || 'mcp_execution_failed', 'Capability execution already reached a terminal failure'), { receipt: prior.receipt, requestFingerprint });
      return { ...prior, idempotent: true };
    }
    const startedAt = nowIso(this.clock);
    const started = this.clock();
    try {
      const runtime = await this.#loadMcpRuntime();
      // Keep this call shape deliberately narrow: the stdio sibling owns the
      // protocol and receives no task prompt, argv, environment or raw source.
      const result = await runtime.execute({ mount, scope, workspaceDir, stagedFile, idempotencyKey, timeoutMs, signal });
      const output = boundedMcpOutput(result?.output);
      const receipt = sanitizeMcpReceipt(result?.receipt, {
        mount, scope, idempotencyKey, requestFingerprint, startedAt, started, output, sourceFingerprint, clock: this.clock,
      });
      const stored = { output, receipt, requestFingerprint };
      this.attempts.set(idempotencyKey, stored);
      return stored;
    } catch (error) {
      const receipt = sanitizeMcpReceipt(error?.receipt, {
        mount, scope, idempotencyKey, requestFingerprint, startedAt, started, output: null, sourceFingerprint, clock: this.clock,
        status: error?.code === 'capability_cancelled' ? 'cancelled' : 'failed', errorCode: error?.code || 'mcp_execution_failed',
      });
      const stored = { output: null, receipt, requestFingerprint };
      this.attempts.set(idempotencyKey, stored);
      throw Object.assign(error instanceof Error ? error : fail(receipt.errorCode, 'MCP capability execution failed'), { receipt, requestFingerprint });
    }
  }
}

function boundedMcpOutput(value) {
  if (value === undefined || value === null) return null;
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw fail('mcp_output_invalid', 'MCP output must be JSON-serializable'); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_BYTES) throw fail('mcp_output_too_large', `MCP output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  return structuredClone(value);
}

function boundedHash(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
}

function sanitizeMcpReceipt(receipt, fallback) {
  const status = ['succeeded', 'failed', 'cancelled'].includes(receipt?.status) ? receipt.status : fallback.status || 'succeeded';
  const outputFingerprint = boundedHash(receipt?.outputFingerprint) || boundedHash(receipt?.fingerprints?.output) || (fallback.output == null ? null : fingerprint(JSON.stringify(fallback.output)));
  const inputFingerprint = boundedHash(receipt?.inputFingerprint) || boundedHash(receipt?.fingerprints?.input) || fallback.requestFingerprint;
  const source = boundedHash(receipt?.sourceFingerprint) || boundedHash(receipt?.stagedFingerprint) || boundedHash(fallback.sourceFingerprint) || inputFingerprint;
  const installationFingerprint = boundedHash(receipt?.installationFingerprint) || boundedHash(receipt?.fingerprints?.installation) || fingerprint(JSON.stringify(BUILTIN_MCP_STAGED_TEXT_RUNTIME));
  const scopeFingerprint = boundedHash(receipt?.scopeFingerprint) || boundedHash(receipt?.fingerprints?.scope) || fingerprint(JSON.stringify(fallback.scope));
  const requestFingerprint = boundedHash(receipt?.requestFingerprint) || boundedHash(receipt?.fingerprints?.request) || fallback.requestFingerprint;
  const clock = fallback.clock || (() => Date.now());
  const endedAt = typeof receipt?.endedAt === 'string' ? receipt.endedAt : nowIso(clock);
  const durationMs = Number.isFinite(receipt?.durationMs) ? Math.max(0, Math.min(60_000, Number(receipt.durationMs))) : Math.max(0, clock() - fallback.started);
  return {
    reference: fallback.mount.reference,
    capabilityFingerprint: fallback.mount.fingerprint,
    adapter: MCP_STAGED_TEXT_ADAPTER,
    adapterVersion: 1,
    status,
    scope: fallback.scope,
    idempotencyKey: fallback.idempotencyKey,
    inputFingerprint,
    outputFingerprint,
    sourceFingerprint: source,
    installation: 'aos.staged-text-reader',
    version: 1,
    protocol: MCP_PROTOCOL_VERSION,
    tool: MCP_TOOL,
    effect: MCP_EFFECT_CLASS,
    fingerprints: {
      installation: installationFingerprint,
      mount: fallback.mount.fingerprint,
      scope: scopeFingerprint,
      input: inputFingerprint,
      request: requestFingerprint,
      output: outputFingerprint,
    },
    startedAt: typeof receipt?.startedAt === 'string' ? receipt.startedAt : fallback.startedAt,
    endedAt,
    durationMs,
    errorCode: receipt?.errorCode || fallback.errorCode || null,
  };
}
