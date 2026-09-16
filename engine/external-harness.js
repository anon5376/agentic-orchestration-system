import { randomUUID } from 'node:crypto';
import { buildWorkerPrompt, redactText, resolveBinary, spawnCaptured } from './codex.js';
import { validateTaskQuestions } from './schema.js';

// This is a wire protocol for a wrapper owned by the operator. It is not a
// claim that AOS knows how to log into, sandbox, or parse any particular CLI.
export const EXTERNAL_HARNESS_PROTOCOL = 'aos-external-harness-v1';
export const EXTERNAL_HARNESS_SANDBOX = 'host_process';
export const EXTERNAL_HARNESS_ATTESTATION = 'external_harness_protocol';

const CONFIG_KEYS = new Set([
  'enabled', 'bin', 'argv', 'provider', 'model', 'authType', 'sessionMode',
  'maxConcurrency', 'timeoutMs', 'killGraceMs', 'maxOutputBytes', 'sandbox',
]);
const SECRET_KEY = /api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|authorization|credential|cookie/i;
const SECRET_TEXT = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:sk|rk|pk|ghp|gho|ghs|ghr|AIza)[A-Za-z0-9_-]{16,}/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
];
const SAFE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class ExternalHarnessConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExternalHarnessConfigError';
    this.code = 'adapter_config_invalid';
    this.fatal = true;
  }
}

export class ExternalHarnessPreflightError extends Error {
  constructor(code, message, { details = null, retryable = false, fatal = true } = {}) {
    super(message);
    this.name = 'ExternalHarnessPreflightError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.fatal = fatal;
  }
}

function configError(message) {
  throw new ExternalHarnessConfigError(message);
}

function integer(value, { name, fallback, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    configError(`${name} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function text(value, { name, required = false, max = 240, pattern = null } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    configError(`${name} must be a non-empty printable string`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) configError(`${name} has an unsupported format`);
  if (looksSecret(normalized)) configError(`${name} cannot contain credential-like content`);
  return normalized;
}

function looksSecret(value) {
  const source = String(value ?? '');
  return SECRET_TEXT.some((pattern) => pattern.test(source));
}

function rejectSecrets(value, path = 'config', seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (looksSecret(value)) configError(`${path} cannot contain credential-like content`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) configError(`${path} must not contain cycles`);
  seen.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) configError('credential configuration is unsupported for the external harness');
      rejectSecrets(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function normalizeArg(value, index) {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000]/.test(value)) {
    configError(`argv[${index}] must be a non-empty string no longer than 512 characters`);
  }
  if (/^--?(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|authorization|credential|cookie)(?:=|$)/i.test(value)) {
    configError('credential argv options are unsupported for the external harness');
  }
  if (looksSecret(value)) configError(`argv[${index}] cannot contain credential-like content`);
  return value;
}

export function resolveExternalHarnessConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) configError('external harness config must be an object');
  rejectSecrets(input);
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) configError(`external harness config key ${key} is unsupported`);
  }
  if (input.enabled !== undefined && input.enabled !== true) configError('external harness config must be explicitly enabled');
  if (input.sandbox !== undefined && input.sandbox !== EXTERNAL_HARNESS_SANDBOX) {
    configError(`sandbox must be ${EXTERNAL_HARNESS_SANDBOX} for the external harness`);
  }
  const bin = text(input.bin, { name: 'bin', required: true, max: 1024 });
  const provider = text(input.provider, { name: 'provider', required: true, max: 81, pattern: PROVIDER_ID });
  const model = input.model == null ? null : text(input.model, { name: 'model', max: 120 });
  if (!Array.isArray(input.argv || [])) configError('argv must be an array');
  if ((input.argv || []).length > 32) configError('argv may contain at most 32 values');
  const argv = Object.freeze((input.argv || []).map(normalizeArg));
  const authType = input.authType ?? 'external_cli_session';
  if (!['none', 'external_cli_session'].includes(authType)) configError('authType must be none or external_cli_session');
  const sessionMode = input.sessionMode ?? 'none';
  if (!['none', 'ephemeral'].includes(sessionMode)) configError('sessionMode must be none or ephemeral; resume is not supported');
  return Object.freeze({
    enabled: true,
    bin,
    argv,
    provider,
    model,
    authType,
    sessionMode,
    maxConcurrency: integer(input.maxConcurrency, { name: 'maxConcurrency', fallback: 1, min: 1, max: 16 }),
    timeoutMs: integer(input.timeoutMs, { name: 'timeoutMs', fallback: 15 * 60_000, min: 1_000, max: 60 * 60_000 }),
    killGraceMs: integer(input.killGraceMs, { name: 'killGraceMs', fallback: 5_000, min: 0, max: 30_000 }),
    maxOutputBytes: integer(input.maxOutputBytes, { name: 'maxOutputBytes', fallback: 256 * 1024, min: 1_024, max: 1024 * 1024 }),
    sandbox: EXTERNAL_HARNESS_SANDBOX,
  });
}

// A wrapper may use its own on-disk account session. AOS never passes a token,
// API key, custom environment, or operator token into that process.
export function sanitizedExternalHarnessEnv(source = process.env) {
  const env = {};
  const stripped = [];
  for (const [name, value] of Object.entries(source || {})) {
    if (SAFE_ENV.test(name)) env[name] = value;
    else stripped.push(name);
  }
  env.NO_COLOR = '1';
  return { env, stripped: stripped.sort() };
}

function requestEnvelope(config, type, nonce, extra = {}) {
  return {
    protocol: EXTERNAL_HARNESS_PROTOCOL,
    type,
    nonce,
    provider: config.provider,
    model: config.model,
    sandbox: config.sandbox,
    authType: config.authType,
    sessionMode: config.sessionMode,
    ...extra,
  };
}

function redacted(value, max = 8_000) {
  return redactText(String(value ?? '')).slice(0, max);
}

function responseEnvelope(result, config, { phase, expectedNonce }) {
  if (result.truncated || Buffer.byteLength(result.stdout || '') + Buffer.byteLength(result.stderr || '') > config.maxOutputBytes) {
    throw new ExternalHarnessPreflightError('adapter_output_oversize', 'External harness output exceeded its configured limit', { retryable: false });
  }
  if (result.spawnError) throw new ExternalHarnessPreflightError('adapter_transport_failed', `External harness could not start: ${redacted(result.spawnError, 300)}`, { retryable: true, fatal: false });
  if (result.cancelled) throw new ExternalHarnessPreflightError('adapter_aborted', 'External harness was aborted', { retryable: false, fatal: false });
  if (result.timedOut) throw new ExternalHarnessPreflightError('adapter_timeout', 'External harness timed out', { retryable: true, fatal: false });
  if (result.exitCode !== 0) throw new ExternalHarnessPreflightError('adapter_provider_rejected', `External harness exited ${result.exitCode}`, { details: { signal: result.signal || null }, retryable: false, fatal: false });
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${phase} must emit exactly one JSON response`, { retryable: false });
  let envelope;
  try {
    envelope = JSON.parse(lines[0]);
  } catch {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${phase} emitted invalid JSON`, { retryable: false });
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${phase} response must be an object`, { retryable: false });
  }
  const allowed = phase === 'preflight'
    ? new Set(['protocol', 'type', 'nonce', 'provider', 'model', 'sandbox', 'authType', 'sessionMode', 'ready', 'attestation'])
    : new Set(['protocol', 'type', 'nonce', 'provider', 'model', 'sandbox', 'authType', 'sessionMode', 'status', 'summary', 'output', 'sessionId', 'delegation']);
  if (Object.keys(envelope).some((key) => !allowed.has(key))) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${phase} response includes unsupported fields`, { retryable: false });
  }
  rejectResponseSecrets(envelope);
  if (envelope.protocol !== EXTERNAL_HARNESS_PROTOCOL || envelope.nonce !== expectedNonce) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${phase} did not bind the protocol nonce`, { retryable: false });
  }
  const metadata = ['provider', 'model', 'sandbox', 'authType', 'sessionMode'];
  if (metadata.some((key) => envelope[key] !== config[key])) {
    throw new ExternalHarnessPreflightError('adapter_substitution_detected', `External harness ${phase} did not match its configured runtime`, { retryable: false });
  }
  return envelope;
}

function rejectResponseSecrets(value, path = 'response', seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (looksSecret(value)) throw new ExternalHarnessPreflightError('adapter_secret_content', `External harness ${path} contains credential-like content`, { retryable: false });
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new ExternalHarnessPreflightError('adapter_result_invalid', `External harness ${path} contains a cycle`, { retryable: false });
  seen.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new ExternalHarnessPreflightError('adapter_secret_content', `External harness ${path} contains credential-like content`, { retryable: false });
      rejectResponseSecrets(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function safeWrite(ctx, path, value) {
  try {
    const written = ctx?.workspace?.write?.(path, value);
    return typeof written === 'string' && written.length ? written : null;
  } catch {
    return null;
  }
}

function requiredWrite(ctx, path, value) {
  const written = safeWrite(ctx, path, value);
  if (!written) {
    throw new ExternalHarnessPreflightError('adapter_artifact_write_failed', `External harness could not persist ${path}`, { retryable: true, fatal: false });
  }
  return written;
}

function processFields(result, config) {
  return {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    startedAt: new Date(result.startedAt || Date.now()).toISOString(),
    endedAt: new Date(result.endedAt || Date.now()).toISOString(),
    durationMs: Math.max(0, (result.endedAt || Date.now()) - (result.startedAt || Date.now())),
    stdout: redacted(result.stdout, config.maxOutputBytes),
    stderr: redacted(result.stderr, config.maxOutputBytes),
  };
}

function safeFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const claim = typeof item.claim === 'string' ? redacted(item.claim, 2_000) : '';
    if (!claim) return [];
    return [{
      kind: typeof item.kind === 'string' ? redacted(item.kind, 80) : 'unsupported',
      claim,
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry) => typeof entry === 'string').slice(0, 20).map((entry) => redacted(entry, 300)) : [],
      confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0,
    }];
  });
}

function taskOutput(envelope) {
  const body = envelope.output;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness result requires an output object', { retryable: false });
  }
  if (envelope.delegation != null || body.delegation != null) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness delegation is not supported', { retryable: false });
  }
  const allowed = new Set(['status', 'summary', 'findings', 'risks', 'confidence', 'questions']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness result output includes unsupported fields', { retryable: false });
  }
  const status = body.status;
  if (!['succeeded', 'awaiting_user'].includes(status)) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness result has an unsupported status', { retryable: false });
  }
  if (envelope.status !== status || envelope.summary !== body.summary) {
    throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness result metadata does not match its output', { retryable: false });
  }
  const summary = typeof body.summary === 'string' ? redacted(body.summary, 600) : '';
  if (!summary) throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness result needs a summary', { retryable: false });
  let questions = null;
  if (status === 'awaiting_user') questions = validateTaskQuestions(body.questions);
  return {
    status,
    ...(questions ? { questions } : {}),
    summary,
    findings: safeFindings(body.findings),
    risks: Array.isArray(body.risks) ? body.risks.filter((item) => typeof item === 'string').slice(0, 50).map((item) => redacted(item, 600)) : [],
    confidence: Number.isFinite(Number(body.confidence)) ? Math.max(0, Math.min(1, Number(body.confidence))) : 0,
    decision: null,
    retrospective: null,
    memory_writes: [],
  };
}

function sessionReference(envelope, config) {
  const present = envelope.sessionId != null && envelope.sessionId !== '';
  if (config.sessionMode === 'none') {
    if (present) throw new ExternalHarnessPreflightError('adapter_substitution_detected', 'External harness returned a session for a stateless configuration', { retryable: false });
    return null;
  }
  if (!present || typeof envelope.sessionId !== 'string' || !SESSION_ID.test(envelope.sessionId) || looksSecret(envelope.sessionId)) {
    throw new ExternalHarnessPreflightError('adapter_attestation_failed', 'External harness did not return a safe session reference', { retryable: false });
  }
  return envelope.sessionId;
}

function publicPreflight(result, config, binPath, stripped) {
  const receipt = {
    protocol: EXTERNAL_HARNESS_PROTOCOL,
    provider: config.provider,
    checkedAt: new Date().toISOString(),
    model: config.model,
    sandbox: config.sandbox,
    authType: config.authType,
    sessionMode: config.sessionMode,
    ready: result.ready === true,
    verified: false,
    attestation: EXTERNAL_HARNESS_ATTESTATION,
    strippedEnvCount: stripped.length,
  };
  Object.defineProperty(receipt, 'binPath', { value: binPath, enumerable: false });
  return Object.freeze(receipt);
}

export async function preflightExternalHarness(config, { run = spawnCaptured, envSource = process.env } = {}) {
  const normalized = resolveExternalHarnessConfig(config);
  const { env, stripped } = sanitizedExternalHarnessEnv(envSource);
  const binPath = resolveBinary(normalized.bin, env);
  if (!binPath) {
    throw new ExternalHarnessPreflightError('adapter_unavailable', `External harness executable was not found: ${normalized.bin}`, { retryable: true, fatal: false });
  }
  const nonce = randomUUID();
  const result = await run(binPath, normalized.argv, {
    cwd: process.cwd(), env, input: `${JSON.stringify(requestEnvelope(normalized, 'preflight', nonce))}\n`,
    timeoutMs: Math.min(normalized.timeoutMs, 60_000), killGraceMs: normalized.killGraceMs,
    maxStdoutBytes: normalized.maxOutputBytes, maxStderrBytes: normalized.maxOutputBytes,
  });
  const envelope = responseEnvelope(result, normalized, { phase: 'preflight', expectedNonce: nonce });
  if (envelope.type !== 'preflight' || envelope.ready !== true || envelope.attestation !== EXTERNAL_HARNESS_ATTESTATION) {
    throw new ExternalHarnessPreflightError('adapter_attestation_failed', 'External harness did not attest its configured protocol boundary', { retryable: false });
  }
  return publicPreflight(envelope, normalized, binPath, stripped);
}

function failure(runtime, ctx, fields) {
  runtime.error = fields.error ? redacted(fields.error, 500) : null;
  runtime.endedAt ||= new Date().toISOString();
  runtime.durationMs ??= Math.max(0, Date.parse(runtime.endedAt) - Date.parse(runtime.startedAt));
  const runtimePath = `attempt-${runtime.attempt}/runtime.json`;
  const artifacts = safeWrite(ctx, runtimePath, runtime) ? [runtimePath] : [];
  return { ...fields, runtime, artifacts };
}

export class ExternalHarnessWorker {
  id = 'command';
  label = 'External harness (protocol)';

  constructor(config = {}, { preflight = preflightExternalHarness, run = spawnCaptured } = {}) {
    this.config = resolveExternalHarnessConfig(config);
    this.preflightFn = preflight;
    this.run = run;
    this.preflightPromise = null;
  }

  preflight() {
    if (!this.preflightPromise) {
      this.preflightPromise = this.preflightFn(this.config).catch((error) => {
        this.preflightPromise = null;
        throw error;
      });
    }
    return this.preflightPromise;
  }

  async execute(task = {}, ctx = {}) {
    const config = this.config;
    const attempt = Number.isInteger(task.attempts) && task.attempts > 0 ? task.attempts : 1;
    const runtime = {
      protocol: EXTERNAL_HARNESS_PROTOCOL,
      runId: ctx.run?.id || null,
      taskId: task.id || null,
      taskKey: task.key || null,
      attempt,
      spawned: false,
      provider: 'command',
      authPath: config.authType,
      requested: { model: config.model, sandbox: config.sandbox, authType: config.authType, sessionMode: config.sessionMode },
      effective: null,
      verified: false,
      externalVerified: false,
      attestation: EXTERNAL_HARNESS_ATTESTATION,
      command: [config.bin, ...config.argv],
      strippedEnvCount: 0,
      cwd: ctx.workspace?.dir || null,
      threadId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      usage: null,
      artifact: null,
      error: null,
    };
    if (task.command != null || ctx.taskCommand != null) {
      return failure(runtime, ctx, { status: 'failed', retryable: false, fatal: true, code: 'adapter_legacy_command_unsupported', error: 'Task-provided commands are no longer supported; configure the external harness adapter instead' });
    }
    if (typeof task.nonce !== 'string' || !task.nonce) {
      return failure(runtime, ctx, { status: 'failed', retryable: false, fatal: true, code: 'adapter_result_invalid', error: 'External harness task has no nonce' });
    }
    let preflight;
    try {
      preflight = await this.preflight();
    } catch (error) {
      return failure(runtime, ctx, { status: 'failed', retryable: Boolean(error.retryable), fatal: Boolean(error.fatal), code: error.code || 'adapter_unavailable', error: error.message || 'External harness preflight failed' });
    }
    const taskTimeout = task.timeoutMs == null ? config.timeoutMs : Number(task.timeoutMs);
    if (!Number.isInteger(taskTimeout) || taskTimeout <= 0) {
      return failure(runtime, ctx, { status: 'failed', retryable: false, fatal: true, code: 'adapter_timeout', error: 'External harness task timeout is invalid' });
    }
    const { env, stripped } = sanitizedExternalHarnessEnv(process.env);
    runtime.strippedEnvCount = stripped.length;
    const prompt = buildWorkerPrompt(task, ctx);
    const request = requestEnvelope(config, 'execute', task.nonce, {
      task: {
        id: task.id || null,
        key: task.key || null,
        title: typeof task.title === 'string' ? task.title.slice(0, 500) : null,
        kind: typeof task.kind === 'string' ? task.kind : null,
        nonce: task.nonce,
        prompt,
      },
    });
    let result;
    try {
      result = await this.run(preflight.binPath, config.argv, {
        cwd: ctx.workspace?.dir || process.cwd(), env, input: `${JSON.stringify(request)}\n`,
        timeoutMs: Math.min(config.timeoutMs, taskTimeout), killGraceMs: config.killGraceMs, signal: ctx.signal,
        maxStdoutBytes: config.maxOutputBytes, maxStderrBytes: config.maxOutputBytes,
        onSpawn: (child) => {
          runtime.spawned = true;
          runtime.pid = child.pid;
          ctx.recordWorkerProcess?.({ pid: child.pid, pgid: child.pid });
          ctx.emit?.('worker.spawned', { pid: child.pid, provider: config.provider, model: config.model, sandbox: config.sandbox });
        },
      });
    } catch (error) {
      return failure(runtime, ctx, { status: 'failed', retryable: true, fatal: false, code: 'adapter_transport_failed', error: error.message || 'External harness execution failed' });
    }
    const fields = processFields(result, config);
    Object.assign(runtime, fields);
    const stdoutPath = `attempt-${attempt}/stdout.txt`;
    const stderrPath = `attempt-${attempt}/stderr.txt`;
    const optionalArtifacts = [];
    if (safeWrite(ctx, stdoutPath, fields.stdout)) optionalArtifacts.push(stdoutPath);
    if (safeWrite(ctx, stderrPath, fields.stderr)) optionalArtifacts.push(stderrPath);
    ctx.emit?.('worker.exited', { exitCode: runtime.exitCode, signal: runtime.signal, timedOut: runtime.timedOut, cancelled: runtime.cancelled, durationMs: runtime.durationMs });
    try {
      const envelope = responseEnvelope(result, config, { phase: 'execute', expectedNonce: task.nonce });
      if (envelope.type !== 'result') throw new ExternalHarnessPreflightError('adapter_result_invalid', 'External harness execute response has an unsupported type', { retryable: false });
      const output = taskOutput(envelope);
      runtime.threadId = sessionReference(envelope, config);
      runtime.effective = {
        model: config.model,
        sandbox: config.sandbox,
        authType: config.authType,
        sessionMode: config.sessionMode,
        protocol: EXTERNAL_HARNESS_PROTOCOL,
        source: 'external_harness_protocol',
        attestation: EXTERNAL_HARNESS_ATTESTATION,
      };
      const artifact = { nonce: task.nonce, taskKey: task.key || null, attempt, output };
      const runtimePath = `attempt-${attempt}/runtime.json`;
      try {
        requiredWrite(ctx, 'artifact.json', artifact);
        runtime.artifact = 'artifact.json';
        requiredWrite(ctx, runtimePath, runtime);
      } catch (error) {
        return failure(runtime, ctx, {
          status: 'failed',
          retryable: Boolean(error.retryable),
          fatal: Boolean(error.fatal),
          code: error.code || 'adapter_artifact_write_failed',
          error: error.message || 'External harness result could not be persisted',
        });
      }
      return {
        status: output.status,
        ...(output.questions ? { questions: output.questions } : {}),
        summary: output.summary,
        result: output,
        runtime,
        artifacts: ['artifact.json', ...optionalArtifacts, runtimePath],
      };
    } catch (error) {
      if (error.code === 'adapter_timeout') runtime.timedOut = true;
      if (error.code === 'adapter_aborted') runtime.cancelled = true;
      return failure(runtime, ctx, { status: error.code === 'adapter_aborted' ? 'cancelled' : 'failed', retryable: Boolean(error.retryable), fatal: Boolean(error.fatal), code: error.code || 'adapter_result_invalid', error: error.message || 'External harness result was invalid' });
    }
  }
}
