import { CODEX_OUTPUT_SCHEMA, buildWorkerPrompt } from './codex.js';
import { validateTaskQuestions } from './schema.js';

// Ollama is a local HTTP adapter, not an identity-bearing provider. Its
// configuration intentionally has no model discovery, credential, or remote
// endpoint path.
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_ALLOWED_HOSTNAMES = Object.freeze(['127.0.0.1', '[::1]']);
export const OLLAMA_LIVE_CONCURRENCY_CAP = 4;
export const OLLAMA_MAX_CONCURRENCY = OLLAMA_LIVE_CONCURRENCY_CAP;
export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;
export const OLLAMA_TIMEOUT_CAP_MS = 15 * 60_000;
export const OLLAMA_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
export const OLLAMA_MAX_PROMPT_BYTES = 256 * 1024;
export const OLLAMA_MAX_VALUE_DEPTH = 6;
export const OLLAMA_MAX_VALUE_ITEMS = 64;
export const OLLAMA_MAX_VALUE_STRING_CHARS = 40_000;
export const OLLAMA_AUTH_PATH = 'loopback_http_no_auth';

// Ollama model names are deliberately not statically allowlisted. Preflight
// proves that the exact configured name is present; no model is selected by
// searching, aliasing, or choosing the first catalog entry.
export const OLLAMA_OUTPUT_SCHEMA = Object.freeze({
  ...CODEX_OUTPUT_SCHEMA,
  properties: {
    ...CODEX_OUTPUT_SCHEMA.properties,
    delegation: { type: 'null' },
  },
});

const SECRET_FIELD = /api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|authorization|credential|cookie/i;
const SECRET_TEXT = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:sk|rk|pk|ghp|gho|ghs|ghr|AIza)[A-Za-z0-9_-]{16,}/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|authorization)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi,
];
const AUTH_CONFIG_KEY = /auth|authorization|headers?|token|secret|password|credential|cookie|username|user|(?:api|access|private)[_-]?key|client[_-]?secret/i;
const CONFIG_OPTION_KEYS = new Set(['enabled', 'model', 'baseUrl', 'baseURL', 'maxConcurrency', 'timeoutMs', 'maxResponseBytes', 'maxPromptBytes', 'transport', 'fetch', 'signal']);
const UNSUPPORTED_CONFIG_KEYS = new Set(['fallback', 'fallbacks', 'capabilities', 'tools', 'plugins', 'delegation', 'effort', 'redirect']);
const SAFE_STATUS = new Set(['succeeded', 'awaiting_user']);
const FINDING_KINDS = new Set(['supported', 'conflict', 'note']);
const MEMORY_SCOPES = new Set(['agent', 'role', 'run', 'swarm', 'project']);
const MEMORY_TYPES = new Set(['fact', 'decision', 'procedure', 'preference', 'failure_lesson', 'evidence_reference', 'summary', 'unresolved_question']);
const MEMORY_SENSITIVITIES = new Set(['normal', 'sensitive']);
const MAX_ERROR_CHARS = 500;

export class OllamaConfigError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'OllamaConfigError';
    this.code = 'adapter_config_invalid';
    this.fatal = true;
    this.retryable = false;
    this.details = details;
  }
}

export class OllamaPreflightError extends Error {
  constructor(code, message, details = null, { retryable = true, fatal = false } = {}) {
    super(message);
    this.name = 'OllamaPreflightError';
    this.code = code;
    this.retryable = retryable;
    this.fatal = fatal;
    this.details = details;
  }
}

export class OllamaAdapterError extends Error {
  constructor(code, message, { retryable = false, fatal = false, details = null } = {}) {
    super(message);
    this.name = 'OllamaAdapterError';
    this.code = code;
    this.retryable = retryable;
    this.fatal = fatal;
    this.details = details;
  }
}

function boundedText(value, max = OLLAMA_MAX_VALUE_STRING_CHARS) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of [
    [SECRET_TEXT[0], '[redacted-jwt]'],
    [SECRET_TEXT[1], '[redacted-key]'],
    [SECRET_TEXT[2], '$1 [redacted]'],
    [SECRET_TEXT[3], '$1[redacted]'],
  ]) text = text.replace(pattern, replacement);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function redactOllamaText(value) {
  return boundedText(value, MAX_ERROR_CHARS);
}

function rejectAuthLikeOptions(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return;
  seen.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      // Transport implementations are test seams, not persisted adapter
      // configuration. Do not inspect their implementation internals.
      if (key === 'transport' || key === 'fetch' || key === 'signal') continue;
      if (AUTH_CONFIG_KEY.test(key)) {
        throw new OllamaConfigError('Ollama authentication and token configuration is not supported');
      }
      rejectAuthLikeOptions(child, seen, depth + 1);
    }
  } finally {
    seen.delete(value);
  }
}

function normalizeLoopbackOrigin(value) {
  const raw = value ?? OLLAMA_DEFAULT_BASE_URL;
  if (typeof raw !== 'string' || !raw || raw.trim() !== raw) {
    throw new OllamaConfigError('Ollama baseUrl must be an origin on the loopback address');
  }
  // URL() canonicalizes alternate numeric and encoded host spellings. The
  // literal authority check prevents those spellings from bypassing policy.
  if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::(?:0|[1-9][0-9]{0,4}))\/?$/.test(raw)) {
    throw new OllamaConfigError('Ollama baseUrl must be HTTP and use literal 127.0.0.1 or [::1], with no path or credentials');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OllamaConfigError('Ollama baseUrl is not a valid loopback HTTP origin');
  }
  if (
    parsed.protocol !== 'http:'
    || !OLLAMA_ALLOWED_HOSTNAMES.includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
  ) {
    throw new OllamaConfigError('Ollama baseUrl must be an origin-only loopback HTTP URL');
  }
  return parsed.origin;
}

function boundedInteger(value, { name, fallback, min = 1, max }) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new OllamaConfigError(`Ollama ${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

export function resolveOllamaConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  rejectAuthLikeOptions(source);
  for (const key of Object.keys(source)) {
    if (key === 'config') continue;
    if (UNSUPPORTED_CONFIG_KEYS.has(key)) {
      throw new OllamaConfigError(`Ollama option ${key} is not supported by this bounded adapter`);
    }
    if (!CONFIG_OPTION_KEYS.has(key)) continue;
  }

  const model = source.model;
  if (typeof model !== 'string' || !model || model.trim() !== model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new OllamaConfigError('Ollama model must be a non-empty exact model name of at most 200 characters');
  }
  const maxConcurrency = boundedInteger(source.maxConcurrency, {
    name: 'maxConcurrency',
    fallback: OLLAMA_LIVE_CONCURRENCY_CAP,
    max: OLLAMA_LIVE_CONCURRENCY_CAP,
  });
  const timeoutMs = boundedInteger(source.timeoutMs, {
    name: 'timeoutMs',
    fallback: OLLAMA_DEFAULT_TIMEOUT_MS,
    max: OLLAMA_TIMEOUT_CAP_MS,
  });
  const maxResponseBytes = boundedInteger(source.maxResponseBytes, {
    name: 'maxResponseBytes',
    fallback: OLLAMA_MAX_RESPONSE_BYTES,
    min: 64,
    max: OLLAMA_MAX_RESPONSE_BYTES,
  });
  const maxPromptBytes = boundedInteger(source.maxPromptBytes, {
    name: 'maxPromptBytes',
    fallback: OLLAMA_MAX_PROMPT_BYTES,
    min: 64,
    max: OLLAMA_MAX_PROMPT_BYTES,
  });
  return Object.freeze({
    // `enabled` is metadata for the wiring lane. A model-bearing config is
    // explicit wiring even when callers omit the convenience flag; there is
    // no implicit env or default-model enablement.
    enabled: source.enabled !== false,
    model,
    baseUrl: normalizeLoopbackOrigin(source.baseUrl ?? source.baseURL),
    maxConcurrency,
    timeoutMs,
    maxResponseBytes,
    maxPromptBytes,
  });
}

function transportFrom(options, config) {
  if (options && typeof options === 'object') {
    if (options.transport) return options.transport;
    if (options.fetch) return options.fetch;
  }
  if (config?.transport) return config.transport;
  return defaultOllamaTransport;
}

export async function defaultOllamaTransport(url, init = {}) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch is unavailable in this runtime');
  }
  return globalThis.fetch(url, { ...init, redirect: 'error' });
}

function invokeTransport(transport, url, init) {
  if (typeof transport === 'function') return transport(url, init);
  if (transport && typeof transport.request === 'function') return transport.request(url, init);
  if (transport && typeof transport.fetch === 'function') return transport.fetch(url, init);
  if (transport && init.method === 'GET' && typeof transport.get === 'function') return transport.get(url, init);
  if (transport && init.method === 'POST' && typeof transport.post === 'function') return transport.post(url, init);
  throw new OllamaAdapterError('adapter_transport_failed', 'Ollama transport is not callable', { retryable: true });
}

function abortError(code, message) {
  return new OllamaAdapterError(code, message, {
    retryable: code === 'adapter_timeout',
    fatal: false,
  });
}

async function requestWithDeadline(transport, url, init, { timeoutMs, signal, transform = null } = {}) {
  if (signal?.aborted) throw abortError('adapter_aborted', 'Ollama request was aborted');
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer = null;
  let onAbort = null;
  const requestInit = { ...init, signal: controller.signal, redirect: 'error' };
  const transportPromise = Promise.resolve()
    .then(() => invokeTransport(transport, url, requestInit))
    .then((response) => transform ? transform(response) : response);
  // A transport that ignores AbortSignal must not hold an AOS task open. The
  // race rejects at the deadline while the signal still reaches the transport.
  const interrupt = new Promise((_, reject) => {
    onAbort = () => {
      callerAborted = true;
      try { controller.abort(); } catch { /* already aborted */ }
      reject(abortError('adapter_aborted', 'Ollama request was aborted'));
    };
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* already aborted */ }
      reject(abortError('adapter_timeout', `Ollama request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  // A late provider rejection after Promise.race settles must not become an
  // unhandled rejection in the host process.
  transportPromise.catch(() => {});
  try {
    return await Promise.race([transportPromise, interrupt]);
  } catch (error) {
    if (error instanceof OllamaAdapterError) throw error;
    if (timedOut) throw abortError('adapter_timeout', `Ollama request timed out after ${timeoutMs}ms`);
    if (callerAborted || signal?.aborted) throw abortError('adapter_aborted', 'Ollama request was aborted');
    throw new OllamaAdapterError('adapter_unavailable', 'Ollama loopback service is unavailable', { retryable: true, details: null });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener?.('abort', onAbort);
  }
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const value = headers[name] ?? headers[name.toLowerCase()];
  return value == null ? null : String(value);
}

function byteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value), 'utf8');
}

async function readStreamBounded(stream, maxBytes) {
  let total = 0;
  const chunks = [];
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk);
      total += byteLength(value);
      if (total > maxBytes) throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
      chunks.push(value);
    }
  } else if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const value = typeof item.value === 'string' ? item.value : Buffer.from(item.value);
        total += byteLength(value);
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    throw new OllamaAdapterError('adapter_result_invalid', 'Ollama response body was not readable', { fatal: true });
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))).toString('utf8');
}

async function readResponseBody(response, maxBytes) {
  const declared = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
  }
  if (response && response.body && (typeof response.body[Symbol.asyncIterator] === 'function' || typeof response.body.getReader === 'function')) {
    return { text: await readStreamBounded(response.body, maxBytes), parsed: false };
  }
  if (response && typeof response.text === 'function') {
    const text = await response.text();
    if (byteLength(text) > maxBytes) {
      throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
    }
    return { text: String(text), parsed: false };
  }
  if (response && typeof response.json === 'function') {
    const value = await response.json();
    let serialized;
    try { serialized = JSON.stringify(value); } catch { serialized = null; }
    if (serialized == null || byteLength(serialized) > maxBytes) {
      throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
    }
    return { value, parsed: true };
  }
  if (response && Object.prototype.hasOwnProperty.call(response, 'body')) {
    const value = response.body;
    let serialized;
    try { serialized = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value); } catch { serialized = null; }
    if (serialized == null || byteLength(serialized) > maxBytes) {
      throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
    }
    if (typeof value === 'string' || Buffer.isBuffer(value)) return { text: Buffer.isBuffer(value) ? value.toString('utf8') : value, parsed: false };
    return { value, parsed: true };
  }
  if (response && valueIsObject(response) && !('status' in response) && !('ok' in response) && !('headers' in response) && !('text' in response) && !('json' in response) && !('redirected' in response) && !('type' in response)) {
    let serialized;
    try { serialized = JSON.stringify(response); } catch { serialized = null; }
    if (serialized == null || byteLength(serialized) > maxBytes) {
      throw new OllamaAdapterError('adapter_response_oversize', 'Ollama response exceeded the bounded JSON limit', { fatal: true });
    }
    return { value: response, parsed: true };
  }
  throw new OllamaAdapterError('adapter_result_invalid', 'Ollama response body was not readable', { fatal: true });
}

async function decodeResponseJson(response, maxBytes) {
  const status = Number(response?.status ?? 200);
  if (response?.redirected || response?.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
    throw new OllamaAdapterError('adapter_redirect_refused', 'Ollama redirects are refused', { fatal: true, details: { status } });
  }
  if (!Number.isFinite(status) || status < 200 || status >= 300 || response?.ok === false) {
    throw new OllamaAdapterError('adapter_unavailable', 'Ollama loopback service returned an unavailable response', { retryable: true, details: { status: Number.isFinite(status) ? status : null } });
  }
  const result = await readResponseBody(response, maxBytes);
  if (result.parsed) {
    if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
      throw new OllamaAdapterError('adapter_result_invalid', 'Ollama returned a non-object JSON response', { fatal: true });
    }
    return result.value;
  }
  const text = String(result.text || '').trim();
  if (!text) throw new OllamaAdapterError('adapter_result_invalid', 'Ollama returned empty JSON', { fatal: true });
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new OllamaAdapterError('adapter_result_invalid', 'Ollama returned malformed JSON', { fatal: true });
  }
}

async function requestJson(config, transport, path, { method = 'GET', body = null, signal, timeoutMs = config.timeoutMs } = {}) {
  const url = `${config.baseUrl}${path}`;
  const init = {
    method,
    headers: { accept: 'application/json' },
    ...(body == null ? {} : { headers: { accept: 'application/json', 'content-type': 'application/json' }, body }),
  };
  return requestWithDeadline(transport, url, init, {
    timeoutMs,
    signal,
    transform: (response) => decodeResponseJson(response, config.maxResponseBytes),
  });
}

function preflightFailure(error, phase) {
  if (error instanceof OllamaPreflightError) return error;
  if (error instanceof OllamaAdapterError) {
    const retryable = error.code === 'adapter_unavailable' || error.code === 'adapter_timeout';
    return new OllamaPreflightError(error.code, redactOllamaText(error.message), { phase, ...(error.details || {}) }, { retryable, fatal: !retryable });
  }
  return new OllamaPreflightError('adapter_unavailable', 'Ollama loopback service is unavailable', { phase }, { retryable: true });
}

export async function preflightOllama(config, options = {}) {
  const normalized = resolveOllamaConfig(config);
  rejectAuthLikeOptions(options);
  const transport = transportFrom(options, config);
  let tags;
  try {
    tags = await requestJson(normalized, transport, '/api/tags', { signal: options.signal });
  } catch (error) {
    throw preflightFailure(error, 'tags');
  }
  if (!Array.isArray(tags.models)) {
    throw new OllamaPreflightError('adapter_preflight_invalid', 'Ollama model catalog was malformed', { phase: 'tags' }, { retryable: false, fatal: true });
  }
  const names = tags.models
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.name === 'string')
    .map((entry) => entry.name.slice(0, 200));
  const listed = names.includes(normalized.model);
  if (!listed) {
    throw new OllamaPreflightError('adapter_model_unsupported', `Ollama does not list the configured model ${redactOllamaText(normalized.model)}`, { phase: 'tags', model: redactOllamaText(normalized.model) }, { retryable: false, fatal: true });
  }
  const reportedModels = names.slice(0, OLLAMA_MAX_VALUE_ITEMS);
  if (!reportedModels.includes(normalized.model)) reportedModels[reportedModels.length - 1] = normalized.model;
  return {
    provider: 'ollama',
    checkedAt: new Date().toISOString(),
    baseUrl: normalized.baseUrl,
    requested: { model: normalized.model },
    model: normalized.model,
    models: reportedModels,
    modelListed: true,
    verified: false,
    attestation: 'local_response',
  };
}

function valueIsObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasSecretLikeContent(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return SECRET_TEXT.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
  if (value == null || typeof value !== 'object' || depth > OLLAMA_MAX_VALUE_DEPTH || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => hasSecretLikeContent(item, seen, depth + 1));
    return Object.entries(value).some(([key, child]) => SECRET_FIELD.test(key) || hasSecretLikeContent(child, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
}

function boundedValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return boundedText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= OLLAMA_MAX_VALUE_DEPTH) return '[truncated]';
  if (typeof value !== 'object') return String(value).slice(0, OLLAMA_MAX_VALUE_STRING_CHARS);
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, OLLAMA_MAX_VALUE_ITEMS).map((item) => boundedValue(item, depth + 1, seen));
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, OLLAMA_MAX_VALUE_ITEMS)) {
      result[key] = SECRET_FIELD.test(key) && typeof child === 'string' ? '[redacted]' : boundedValue(child, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function validationError(message, code = 'adapter_result_invalid', { retryable = false, fatal = true } = {}) {
  return new OllamaAdapterError(code, message, { retryable, fatal });
}

function assertOutputKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw validationError(`Ollama output ${label} contains unsupported fields`);
}

function validateString(value, label, { max = OLLAMA_MAX_VALUE_STRING_CHARS, required = true } = {}) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw validationError(`Ollama output ${label} is invalid`);
  }
}

function normalizeOllamaOutput(value, task) {
  if (!valueIsObject(value)) throw validationError('Ollama output was not an object');
  const supported = new Set(['task_nonce', 'status', 'questions', 'summary', 'findings', 'risks', 'confidence', 'decision', 'retrospective', 'memory_writes', 'delegation']);
  const extras = Object.keys(value).filter((key) => !supported.has(key));
  if (extras.length) throw validationError('Ollama output contains unsupported fields');
  if (value.task_nonce !== task.nonce) {
    throw validationError('Worker output carried another task nonce; refusing cross-wired output', 'isolation_nonce_mismatch', { fatal: true });
  }
  if (!SAFE_STATUS.has(value.status)) throw validationError('Ollama output status is invalid');
  if (value.delegation != null) {
    throw validationError('Ollama workers may not delegate', 'adapter_delegation_forbidden', { fatal: true });
  }
  validateString(value.summary, 'summary');
  if (!Array.isArray(value.findings) || value.findings.length > 5) throw validationError('Ollama output findings are invalid');
  const findings = value.findings.map((finding) => {
    if (!valueIsObject(finding) || !FINDING_KINDS.has(finding.kind)) throw validationError('Ollama output finding is invalid');
    assertOutputKeys(finding, ['kind', 'claim', 'evidence', 'confidence'], 'finding');
    validateString(finding.claim, 'finding claim');
    if (!Array.isArray(finding.evidence) || finding.evidence.some((item) => typeof item !== 'string' || item.length > 2_000)) throw validationError('Ollama output finding evidence is invalid');
    if (typeof finding.confidence !== 'number' || !Number.isFinite(finding.confidence) || finding.confidence < 0 || finding.confidence > 1) throw validationError('Ollama output finding confidence is invalid');
    return { kind: finding.kind, claim: finding.claim, evidence: [...finding.evidence], confidence: finding.confidence };
  });
  if (!Array.isArray(value.risks) || value.risks.length > OLLAMA_MAX_VALUE_ITEMS || value.risks.some((risk) => typeof risk !== 'string' || risk.length > OLLAMA_MAX_VALUE_STRING_CHARS)) throw validationError('Ollama output risks are invalid');
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw validationError('Ollama output confidence is invalid');
  if (value.decision !== null && !valueIsObject(value.decision)) throw validationError('Ollama output decision is invalid');
  if (value.decision) {
    assertOutputKeys(value.decision, ['recommendation', 'objection', 'confidence'], 'decision');
    validateString(value.decision.recommendation, 'decision recommendation');
    validateString(value.decision.objection, 'decision objection');
    if (typeof value.decision.confidence !== 'number' || !Number.isFinite(value.decision.confidence) || value.decision.confidence < 0 || value.decision.confidence > 1) throw validationError('Ollama output decision confidence is invalid');
  }
  if (value.retrospective !== null && !valueIsObject(value.retrospective)) throw validationError('Ollama output retrospective is invalid');
  if (value.retrospective) {
    assertOutputKeys(value.retrospective, ['what_failed', 'why', 'should_improve', 'proposals'], 'retrospective');
    for (const key of ['what_failed', 'why', 'should_improve']) validateString(value.retrospective[key], `retrospective ${key}`);
    if (!Array.isArray(value.retrospective.proposals) || value.retrospective.proposals.length > OLLAMA_MAX_VALUE_ITEMS) throw validationError('Ollama output retrospective proposals are invalid');
    for (const proposal of value.retrospective.proposals) {
      if (!valueIsObject(proposal)) throw validationError('Ollama output retrospective proposal is invalid');
      assertOutputKeys(proposal, ['title', 'change', 'rationale', 'risk'], 'retrospective proposal');
      for (const key of ['title', 'change', 'rationale', 'risk']) validateString(proposal[key], `retrospective proposal ${key}`);
    }
  }
  if (!Array.isArray(value.memory_writes) || value.memory_writes.length > OLLAMA_MAX_VALUE_ITEMS) throw validationError('Ollama output memory_writes are invalid');
  for (const item of value.memory_writes) {
    if (!valueIsObject(item)) throw validationError('Ollama output memory_write is invalid');
    assertOutputKeys(item, ['scope', 'type', 'title', 'content', 'tags', 'confidence', 'sensitivity'], 'memory_write');
    for (const key of ['scope', 'type', 'title', 'content', 'sensitivity']) validateString(item[key], `memory_write ${key}`);
    if (!MEMORY_SCOPES.has(item.scope) || !MEMORY_TYPES.has(item.type) || !MEMORY_SENSITIVITIES.has(item.sensitivity)) throw validationError('Ollama output memory_write enum is invalid');
    if (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string' || tag.length > 2_000)) throw validationError('Ollama output memory_write tags are invalid');
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw validationError('Ollama output memory_write confidence is invalid');
  }
  if (value.status === 'awaiting_user') {
    if (!Array.isArray(value.questions)) throw validationError('Ollama output questions are invalid');
    const questions = validateTaskQuestions(value.questions);
    return boundedValue({
      task_nonce: value.task_nonce,
      status: value.status,
      questions,
      summary: value.summary,
      findings,
      risks: [...value.risks],
      confidence: value.confidence,
      decision: value.decision,
      retrospective: value.retrospective,
      memory_writes: value.memory_writes,
      delegation: null,
    });
  }
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions)) throw validationError('Ollama output questions are invalid');
    validateTaskQuestions(value.questions);
  }
  return boundedValue({
    task_nonce: value.task_nonce,
    status: value.status,
    summary: value.summary,
    findings,
    risks: [...value.risks],
    confidence: value.confidence,
    decision: value.decision,
    retrospective: value.retrospective,
    memory_writes: value.memory_writes,
    delegation: null,
  });
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeUsage(envelope) {
  const source = valueIsObject(envelope?.usage) ? { ...envelope, ...envelope.usage } : envelope;
  const usage = {};
  const aliases = [
    ['input_tokens', ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'prompt_eval_count']],
    ['output_tokens', ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'eval_count']],
    ['total_duration_ns', ['total_duration']],
    ['load_duration_ns', ['load_duration']],
    ['prompt_eval_duration_ns', ['prompt_eval_duration']],
    ['eval_duration_ns', ['eval_duration']],
    ['usd', ['usd', 'cost_usd', 'costUsd', 'total_cost_usd']],
  ];
  for (const [field, names] of aliases) {
    const found = names.find((name) => numeric(source?.[name]) != null);
    if (found) usage[field] = numeric(source[found]);
  }
  return Object.keys(usage).length ? usage : null;
}

function makeMessages(task, ctx, outputSchema) {
  const safeTask = { ...task, mayDelegate: false };
  let user;
  try {
    user = buildWorkerPrompt(safeTask, { ...ctx, outputSchema, outputKind: ctx.outputKind === 'lead' ? undefined : ctx.outputKind });
  } catch {
    throw validationError('Ollama worker prompt could not be built', 'adapter_result_invalid');
  }
  const system = [
    'You are a bounded local Ollama worker in an AOS run.',
    'Do not delegate, spawn agents, invoke tools, use capabilities, write files, or use the network.',
    'Return one JSON object only, matching the supplied AOS output schema.',
    `The task nonce must be exactly ${JSON.stringify(task.nonce)}.`,
    'The delegation field must be null or omitted.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function restrictedOutputSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return OLLAMA_OUTPUT_SCHEMA;
  return {
    ...value,
    properties: {
      ...(value.properties || {}),
      delegation: { type: 'null' },
    },
  };
}

function persist(ctx, path, value) {
  if (ctx?.workspace && typeof ctx.workspace.write === 'function') return ctx.workspace.write(path, value);
  return null;
}

function failureFields(error, fallbackCode = 'adapter_transport_failed') {
  const code = error?.code || fallbackCode;
  const retryable = error?.retryable ?? ['adapter_unavailable', 'adapter_timeout', 'adapter_transport_failed'].includes(code);
  return {
    status: code === 'adapter_aborted' ? 'cancelled' : 'failed',
    retryable,
    ...(error?.fatal != null ? { fatal: Boolean(error.fatal) } : {}),
    code,
    error: redactOllamaText(error?.message || 'Ollama worker failed'),
  };
}

function renderArtifact(task, output) {
  const findings = output.findings || [];
  const risks = output.risks || [];
  return [
    `# ${task.key || task.id} — ${task.title || ''}`,
    '',
    '## Summary',
    output.summary,
    '',
    '## Findings',
    ...(findings.length ? findings.map((item) => `- **${item.kind}** (${item.confidence}): ${item.claim}\n  - evidence: ${item.evidence.join('; ') || 'none'}`) : ['- none']),
    '',
    '## Risks',
    ...(risks.length ? risks.map((item) => `- ${item}`) : ['- none']),
  ].join('\n') + '\n';
}

export class OllamaWorker {
  id = 'ollama';
  label = 'Ollama (loopback HTTP)';

  constructor(config = {}, { preflight = preflightOllama, transport = null } = {}) {
    this.config = resolveOllamaConfig(config);
    this.preflightFn = preflight;
    this.transport = transport || config?.transport || null;
    this.preflightPromise = null;
  }

  preflight(options = {}) {
    if (!this.preflightPromise) {
      this.preflightPromise = this.preflightFn(this.config, {
        ...options,
        ...(this.transport ? { transport: this.transport } : {}),
      }).catch((error) => {
        this.preflightPromise = null;
        throw error;
      });
    }
    return this.preflightPromise;
  }

  async execute(task = {}, ctx = {}) {
    const startedAt = Date.now();
    const config = this.config;
    const attempt = Number.isInteger(task.attempts) && task.attempts > 0 ? task.attempts : 1;
    const runtime = {
      runId: ctx.run?.id || null,
      taskId: task.id || null,
      taskKey: task.key || null,
      attempt,
      spawned: false,
      injected: false,
      provider: 'ollama',
      authPath: OLLAMA_AUTH_PATH,
      requested: { model: config.model },
      effective: null,
      verified: false,
      attestation: null,
      startedAt: new Date(startedAt).toISOString(),
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
    const done = (fields) => {
      Object.assign(runtime, fields.runtime || {});
      runtime.endedAt ||= new Date().toISOString();
      runtime.durationMs = Math.max(0, Date.parse(runtime.endedAt) - startedAt);
      runtime.error = fields.error ? redactOllamaText(fields.error) : null;
      try { persist(ctx, `attempt-${attempt}/runtime.json`, runtime); } catch { /* runtime persistence cannot change the outcome */ }
      return { ...fields, runtime };
    };
    const fail = (error) => {
      const fields = failureFields(error);
      if (fields.code === 'adapter_timeout') runtime.timedOut = true;
      if (fields.code === 'adapter_aborted') runtime.cancelled = true;
      return done(fields);
    };

    if (typeof task.nonce !== 'string' || !task.nonce.trim()) {
      return fail(validationError('Ollama task nonce is required', 'adapter_result_invalid'));
    }
    let messages;
    try {
      messages = makeMessages(task, ctx, restrictedOutputSchema(ctx.outputSchema));
      const messageBytes = messages.reduce((total, item) => total + byteLength(item.content), 0);
      if (messageBytes > config.maxPromptBytes || hasSecretLikeContent(messages)) {
        throw new OllamaAdapterError('adapter_secret_content', 'Ollama prompt contains secret-like content and was not persisted', { fatal: true });
      }
    } catch (error) {
      return fail(error);
    }

    try {
      await this.preflight({ signal: ctx.signal });
    } catch (error) {
      return fail(error);
    }

    const outputSchema = restrictedOutputSchema(ctx.outputSchema);
    let requestTimeoutMs = config.timeoutMs;
    if (task.timeoutMs != null) {
      if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0) return fail(new OllamaAdapterError('adapter_timeout', 'Ollama task timeout is invalid', { retryable: true }));
      requestTimeoutMs = Math.min(requestTimeoutMs, task.timeoutMs);
    }
    const bodyValue = {
      model: config.model,
      stream: false,
      format: outputSchema,
      messages,
    };
    let body;
    try {
      body = JSON.stringify(bodyValue);
      if (byteLength(body) > config.maxPromptBytes) throw new OllamaAdapterError('adapter_request_oversize', 'Ollama request exceeded the bounded prompt limit', { fatal: true });
    } catch (error) {
      return fail(error);
    }

    let envelope;
    try {
      envelope = await requestJson(config, transportFrom({ transport: this.transport }, this.config), '/api/chat', { method: 'POST', body, signal: ctx.signal, timeoutMs: requestTimeoutMs });
    } catch (error) {
      return fail(error);
    }
    if (envelope.model !== config.model) {
      runtime.effective = { model: typeof envelope.model === 'string' ? boundedText(envelope.model, 200) : null, source: 'ollama_response_model', attestation: 'local_response' };
      return fail(validationError('Ollama response model did not match the configured model', 'adapter_substitution_detected', { fatal: true }));
    }
    runtime.effective = { model: config.model, source: 'ollama_response_model', attestation: 'local_response' };
    runtime.attestation = 'local_response';
    runtime.usage = normalizeUsage(envelope);
    const content = envelope.message?.content;
    if (typeof content !== 'string' || !content.trim()) return fail(validationError('Ollama response did not contain JSON message content'));
    if (byteLength(content) > config.maxResponseBytes || hasSecretLikeContent(content)) {
      return fail(new OllamaAdapterError('adapter_secret_content', 'Ollama response contains secret-like content and was not persisted', { fatal: true }));
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return fail(validationError('Ollama message content was malformed JSON'));
    }
    let output;
    try {
      output = normalizeOllamaOutput(parsed, task);
      if (hasSecretLikeContent(output)) throw new OllamaAdapterError('adapter_secret_content', 'Ollama output contains secret-like content and was not persisted', { fatal: true });
    } catch (error) {
      return fail(error);
    }
    runtime.artifact = 'artifact.json';
    try {
      persist(ctx, 'artifact.json', { nonce: task.nonce, taskKey: task.key || null, attempt, output });
      persist(ctx, 'artifact.md', renderArtifact(task, output));
    } catch (error) {
      return fail(new OllamaAdapterError('adapter_persistence_failed', 'Ollama result could not be persisted', { retryable: false, fatal: true, details: null }));
    }
    return done({
      status: output.status,
      ...(output.questions ? { questions: output.questions } : {}),
      summary: output.summary.slice(0, 600) || `Completed ${task.title || task.id || 'task'}`,
      result: output,
      artifacts: ['artifact.json', 'artifact.md'],
    });
  }
}

export { normalizeOllamaOutput, normalizeUsage, makeMessages };
