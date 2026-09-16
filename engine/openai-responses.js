import { CODEX_OUTPUT_SCHEMA, buildWorkerPrompt } from './codex.js';
import { normalizeOllamaOutput } from './ollama.js';

// This is a deliberately narrow direct-API adapter. It is not a generic HTTP
// client, OAuth bridge, tool runner, or Responses-session client.
export const OPENAI_RESPONSES_DEFAULT_ORIGIN = 'https://api.openai.com';
export const OPENAI_RESPONSES_DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
export const OPENAI_RESPONSES_AUTH_PATH = 'OpenAI Responses API · API key from named process environment variable';
export const OPENAI_RESPONSES_ATTESTATION = 'openai_api_response';
export const OPENAI_RESPONSES_LIVE_CONCURRENCY_CAP = 4;
export const OPENAI_RESPONSES_DEFAULT_TIMEOUT_MS = 120_000;
export const OPENAI_RESPONSES_TIMEOUT_CAP_MS = 15 * 60_000;
export const OPENAI_RESPONSES_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
export const OPENAI_RESPONSES_MAX_PROMPT_BYTES = 256 * 1024;
export const OPENAI_RESPONSES_MAX_OUTPUT_TOKENS = 16_384;
export const OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

const CODEX_QUESTION_SCHEMA = CODEX_OUTPUT_SCHEMA.properties.questions;
const OPENAI_QUESTION_ITEM_SCHEMA = Object.freeze({
  ...CODEX_QUESTION_SCHEMA.items,
  required: ['prompt', 'reason'],
  properties: {
    ...CODEX_QUESTION_SCHEMA.items.properties,
    reason: {
      anyOf: [
        CODEX_QUESTION_SCHEMA.items.properties.reason,
        { type: 'null' },
      ],
    },
  },
});

// Strict Structured Outputs requires object fields to be required. Fields that
// are optional in the internal worker schema are carried as null on the wire,
// then normalized back to the existing result shape before persistence.
export const OPENAI_RESPONSES_OUTPUT_SCHEMA = Object.freeze({
  ...CODEX_OUTPUT_SCHEMA,
  required: [...CODEX_OUTPUT_SCHEMA.required, 'questions'],
  properties: {
    ...CODEX_OUTPUT_SCHEMA.properties,
    questions: {
      anyOf: [
        { type: 'null' },
        { ...CODEX_QUESTION_SCHEMA, items: OPENAI_QUESTION_ITEM_SCHEMA },
      ],
    },
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
const CONFIG_KEYS = new Set([
  'enabled',
  'model',
  'apiKeyEnv',
  'origin',
  'allowCustomOrigin',
  'maxConcurrency',
  'timeoutMs',
  'maxResponseBytes',
  'maxPromptBytes',
  'maxOutputTokens',
]);

export class OpenAIResponsesConfigError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'OpenAIResponsesConfigError';
    this.code = 'adapter_config_invalid';
    this.fatal = true;
    this.retryable = false;
    this.details = details;
  }
}

export class OpenAIResponsesPreflightError extends Error {
  constructor(code, message, details = null, { retryable = true, fatal = false } = {}) {
    super(message);
    this.name = 'OpenAIResponsesPreflightError';
    this.code = code;
    this.retryable = retryable;
    this.fatal = fatal;
    this.details = details;
  }
}

export class OpenAIResponsesAdapterError extends Error {
  constructor(code, message, { retryable = false, fatal = false, details = null } = {}) {
    super(message);
    this.name = 'OpenAIResponsesAdapterError';
    this.code = code;
    this.retryable = retryable;
    this.fatal = fatal;
    this.details = details;
  }
}

function boundedText(value, max = 500) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of [
    [SECRET_TEXT[0], '[redacted-jwt]'],
    [SECRET_TEXT[1], '[redacted-key]'],
    [SECRET_TEXT[2], '$1 [redacted]'],
    [SECRET_TEXT[3], '$1[redacted]'],
  ]) text = text.replace(pattern, replacement);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function redactOpenAIResponsesText(value) {
  return boundedText(value, 500);
}

function valueIsObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value), 'utf8');
}

function hasSecretLikeContent(value, seen = new WeakSet(), depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') return SECRET_TEXT.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.some((item) => hasSecretLikeContent(item, seen, depth + 1));
    return Object.entries(value).some(([key, item]) => (SECRET_FIELD.test(key) && typeof item === 'string' && item.length > 0)
      || hasSecretLikeContent(item, seen, depth + 1));
  } finally {
    seen.delete(value);
  }
}

function boundedInteger(value, { name, fallback, min = 1, max }) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new OpenAIResponsesConfigError(`OpenAI Responses ${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function exactModel(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OpenAIResponsesConfigError('OpenAI Responses model must be a non-empty exact model name of at most 200 characters');
  }
  return value;
}

function apiKeyEnvironmentName(value) {
  const name = value ?? OPENAI_RESPONSES_DEFAULT_API_KEY_ENV;
  if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) {
    throw new OpenAIResponsesConfigError('OpenAI Responses apiKeyEnv must be a bounded uppercase environment variable name');
  }
  return name;
}

function normalizeOrigin(value, { allowCustomOrigin = false } = {}) {
  const raw = value ?? OPENAI_RESPONSES_DEFAULT_ORIGIN;
  if (typeof raw !== 'string' || !raw || raw.trim() !== raw) {
    throw new OpenAIResponsesConfigError('OpenAI Responses origin must be an exact HTTPS origin');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OpenAIResponsesConfigError('OpenAI Responses origin must be an exact HTTPS origin');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
    || parsed.port
    || !parsed.hostname
  ) {
    throw new OpenAIResponsesConfigError('OpenAI Responses origin must be HTTPS with no path, port, credentials, query, or fragment');
  }
  if (parsed.origin !== OPENAI_RESPONSES_DEFAULT_ORIGIN) {
    // Keep the OpenAI credential on OpenAI-controlled API hosts. This flag is
    // for regional OpenAI origins, not arbitrary OpenAI-compatible gateways.
    const officialOpenAIHost = parsed.hostname.endsWith('.api.openai.com');
    if (allowCustomOrigin !== true || !officialOpenAIHost) {
      throw new OpenAIResponsesConfigError('A non-default OpenAI Responses origin requires allowCustomOrigin: true and an OpenAI API hostname');
    }
  }
  return parsed.origin;
}

export function resolveOpenAIResponsesConfig(input = {}) {
  if (!valueIsObject(input)) throw new OpenAIResponsesConfigError('OpenAI Responses configuration must be an object');
  for (const [key, value] of Object.entries(input)) {
    if (!CONFIG_KEYS.has(key)) {
      if (SECRET_FIELD.test(key) && value != null) throw new OpenAIResponsesConfigError('OpenAI Responses credentials must be supplied only through apiKeyEnv');
      throw new OpenAIResponsesConfigError(`OpenAI Responses option ${key} is not supported by this bounded adapter`);
    }
  }
  const model = exactModel(input.model);
  const apiKeyEnv = apiKeyEnvironmentName(input.apiKeyEnv);
  const allowCustomOrigin = input.allowCustomOrigin === true;
  const origin = normalizeOrigin(input.origin, { allowCustomOrigin });
  return Object.freeze({
    enabled: input.enabled !== false,
    model,
    apiKeyEnv,
    origin,
    allowCustomOrigin,
    maxConcurrency: boundedInteger(input.maxConcurrency, {
      name: 'maxConcurrency', fallback: OPENAI_RESPONSES_LIVE_CONCURRENCY_CAP, max: OPENAI_RESPONSES_LIVE_CONCURRENCY_CAP,
    }),
    timeoutMs: boundedInteger(input.timeoutMs, {
      name: 'timeoutMs', fallback: OPENAI_RESPONSES_DEFAULT_TIMEOUT_MS, max: OPENAI_RESPONSES_TIMEOUT_CAP_MS,
    }),
    maxResponseBytes: boundedInteger(input.maxResponseBytes, {
      name: 'maxResponseBytes', fallback: OPENAI_RESPONSES_MAX_RESPONSE_BYTES, min: 64, max: OPENAI_RESPONSES_MAX_RESPONSE_BYTES,
    }),
    maxPromptBytes: boundedInteger(input.maxPromptBytes, {
      name: 'maxPromptBytes', fallback: OPENAI_RESPONSES_MAX_PROMPT_BYTES, min: 64, max: OPENAI_RESPONSES_MAX_PROMPT_BYTES,
    }),
    maxOutputTokens: boundedInteger(input.maxOutputTokens, {
      name: 'maxOutputTokens', fallback: OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS, max: OPENAI_RESPONSES_MAX_OUTPUT_TOKENS,
    }),
  });
}

export async function defaultOpenAIResponsesTransport(url, init = {}) {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is unavailable in this runtime');
  return globalThis.fetch(url, { ...init, redirect: 'error' });
}

function invokeTransport(transport, url, init) {
  if (typeof transport === 'function') return transport(url, init);
  if (transport && typeof transport.request === 'function') return transport.request(url, init);
  if (transport && typeof transport.fetch === 'function') return transport.fetch(url, init);
  throw new OpenAIResponsesAdapterError('adapter_transport_failed', 'OpenAI Responses transport is not callable', { retryable: true });
}

function abortError(code, message) {
  return new OpenAIResponsesAdapterError(code, message, { retryable: code === 'adapter_timeout' });
}

async function requestWithDeadline(transport, url, init, { timeoutMs, signal, transform = null } = {}) {
  if (signal?.aborted) throw abortError('adapter_aborted', 'OpenAI Responses request was aborted');
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let timer = null;
  let onAbort = null;
  const requestInit = { ...init, signal: controller.signal, redirect: 'error' };
  const request = Promise.resolve()
    .then(() => invokeTransport(transport, url, requestInit))
    .then((response) => transform ? transform(response) : response);
  const interrupt = new Promise((_, reject) => {
    onAbort = () => {
      callerAborted = true;
      try { controller.abort(); } catch { /* already settled */ }
      reject(abortError('adapter_aborted', 'OpenAI Responses request was aborted'));
    };
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* already settled */ }
      reject(abortError('adapter_timeout', `OpenAI Responses request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  request.catch(() => {});
  try {
    return await Promise.race([request, interrupt]);
  } catch (error) {
    if (error instanceof OpenAIResponsesAdapterError) throw error;
    if (timedOut) throw abortError('adapter_timeout', `OpenAI Responses request timed out after ${timeoutMs}ms`);
    if (callerAborted || signal?.aborted) throw abortError('adapter_aborted', 'OpenAI Responses request was aborted');
    throw new OpenAIResponsesAdapterError('adapter_unavailable', 'OpenAI Responses service is unavailable', { retryable: true });
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

async function readStreamBounded(stream, maxBytes) {
  let total = 0;
  const chunks = [];
  const add = (value) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
    chunks.push(chunk);
  };
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) add(chunk);
  } else if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        try { add(item.value); } catch (error) {
          try { await reader.cancel(); } catch { /* best effort */ }
          throw error;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses response body was not readable', { fatal: true });
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readResponseBody(response, maxBytes) {
  const declared = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
  }
  if (response?.body && (typeof response.body[Symbol.asyncIterator] === 'function' || typeof response.body.getReader === 'function')) {
    return { text: await readStreamBounded(response.body, maxBytes), parsed: false };
  }
  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (byteLength(text) > maxBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
    return { text: String(text), parsed: false };
  }
  if (typeof response?.json === 'function') {
    const value = await response.json();
    let serialized;
    try { serialized = JSON.stringify(value); } catch { serialized = null; }
    if (serialized == null || byteLength(serialized) > maxBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
    return { value, parsed: true };
  }
  if (response && Object.prototype.hasOwnProperty.call(response, 'body')) {
    const value = response.body;
    let serialized;
    try { serialized = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value); } catch { serialized = null; }
    if (serialized == null || byteLength(serialized) > maxBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
    return typeof value === 'string' || Buffer.isBuffer(value)
      ? { text: Buffer.isBuffer(value) ? value.toString('utf8') : value, parsed: false }
      : { value, parsed: true };
  }
  if (valueIsObject(response) && !('status' in response) && !('ok' in response) && !('headers' in response) && !('text' in response) && !('json' in response) && !('redirected' in response) && !('type' in response)) {
    const serialized = JSON.stringify(response);
    if (byteLength(serialized) > maxBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses response exceeded the bounded JSON limit', { fatal: true });
    return { value: response, parsed: true };
  }
  throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses response body was not readable', { fatal: true });
}

async function decodeResponseJson(response, maxBytes) {
  const status = Number(response?.status ?? 200);
  if (response?.redirected || response?.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
    throw new OpenAIResponsesAdapterError('adapter_redirect_refused', 'OpenAI Responses redirects are refused', { fatal: true, details: { status } });
  }
  if (!Number.isFinite(status) || status < 200 || status >= 300 || response?.ok === false) {
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new OpenAIResponsesAdapterError(retryable ? 'adapter_unavailable' : 'adapter_provider_rejected', 'OpenAI Responses rejected the request', {
      retryable,
      fatal: !retryable,
      details: { status: Number.isFinite(status) ? status : null },
    });
  }
  const body = await readResponseBody(response, maxBytes);
  const value = body.parsed ? body.value : (() => {
    const text = String(body.text || '').trim();
    if (!text) throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned empty JSON', { fatal: true });
    try { return JSON.parse(text); } catch { throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned malformed JSON', { fatal: true }); }
  })();
  if (!valueIsObject(value)) throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned a non-object JSON response', { fatal: true });
  return value;
}

function apiKeyFor(config, env) {
  const value = env?.[config.apiKeyEnv];
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 16_384 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OpenAIResponsesAdapterError('adapter_auth_unavailable', `OpenAI Responses API key is unavailable from ${config.apiKeyEnv}`, { fatal: true });
  }
  return value;
}

function requestBody(config, apiKey, payload) {
  let body;
  try { body = JSON.stringify(payload); } catch { throw new OpenAIResponsesAdapterError('adapter_request_invalid', 'OpenAI Responses request could not be serialized', { fatal: true }); }
  if (byteLength(body) > config.maxPromptBytes) throw new OpenAIResponsesAdapterError('adapter_request_oversize', 'OpenAI Responses request exceeded the bounded prompt limit', { fatal: true });
  if (hasSecretLikeContent(payload)) throw new OpenAIResponsesAdapterError('adapter_secret_content', 'OpenAI Responses request contains secret-like content', { fatal: true });
  return {
    body,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
      redirect: 'error',
    },
  };
}

async function postResponse(config, { transport, env, payload, signal, timeoutMs = config.timeoutMs }) {
  const apiKey = apiKeyFor(config, env);
  const request = requestBody(config, apiKey, payload);
  return requestWithDeadline(transport, `${config.origin}/v1/responses`, request.init, {
    timeoutMs,
    signal,
    transform: (response) => decodeResponseJson(response, config.maxResponseBytes),
  });
}

function exactResponseModel(envelope, config) {
  if (envelope.object !== 'response' || envelope.model !== config.model) {
    throw new OpenAIResponsesAdapterError('adapter_substitution_detected', 'OpenAI Responses response model did not match the configured model', { fatal: true });
  }
}

function outputText(envelope) {
  if (envelope.status !== 'completed') throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses did not complete the response', { fatal: true });
  if (!Array.isArray(envelope.output)) throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses did not return output items', { fatal: true });
  const texts = [];
  for (const item of envelope.output) {
    if (!valueIsObject(item)) throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned an invalid output item', { fatal: true });
    // Reasoning items may be present for a reasoning model. They are neither
    // used as tool calls nor persisted; only strict assistant output text is
    // admitted to the AOS result parser.
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) {
      throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned unsupported output instead of assistant text', { fatal: true });
    }
    for (const part of item.content) {
      if (!valueIsObject(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
        throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned unsupported content instead of assistant text', { fatal: true });
      }
      texts.push(part.text);
    }
  }
  const text = texts.join('');
  if (!text.trim()) throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses returned empty assistant text', { fatal: true });
  return text;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeOpenAIResponsesUsage(envelope) {
  const usage = valueIsObject(envelope?.usage) ? envelope.usage : null;
  if (!usage) return null;
  const values = {
    input_tokens: numeric(usage.input_tokens),
    cached_input_tokens: numeric(usage.input_tokens_details?.cached_tokens),
    output_tokens: numeric(usage.output_tokens),
    reasoning_output_tokens: numeric(usage.output_tokens_details?.reasoning_tokens),
    total_tokens: numeric(usage.total_tokens),
  };
  const output = Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));
  return Object.keys(output).length ? output : null;
}

function restrictedOutputSchema() {
  const base = OPENAI_RESPONSES_OUTPUT_SCHEMA;
  return {
    ...base,
    properties: {
      ...(base.properties || {}),
      delegation: { type: 'null' },
    },
  };
}

function normalizeStrictNullableOutput(value) {
  if (!valueIsObject(value)) return value;
  const output = { ...value };
  if (output.questions === null) delete output.questions;
  else if (Array.isArray(output.questions)) {
    output.questions = output.questions.map((question) => {
      if (!valueIsObject(question) || question.reason !== null) return question;
      const { reason, ...rest } = question;
      return rest;
    });
  }
  return output;
}

function parseStrictOutput(content, task) {
  if (hasSecretLikeContent(content)) throw new OpenAIResponsesAdapterError('adapter_secret_content', 'OpenAI Responses output contains secret-like content and was not persisted', { fatal: true });
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses assistant text was malformed JSON', { fatal: true }); }
  let output;
  try { output = normalizeOllamaOutput(normalizeStrictNullableOutput(parsed), task); } catch {
    throw new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses output did not match the bounded AOS result schema', { fatal: true });
  }
  if (hasSecretLikeContent(output)) throw new OpenAIResponsesAdapterError('adapter_secret_content', 'OpenAI Responses output contains secret-like content and was not persisted', { fatal: true });
  return output;
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

function persist(ctx, path, value) {
  if (ctx?.workspace && typeof ctx.workspace.write === 'function') return ctx.workspace.write(path, value);
  return null;
}

function failureFields(error) {
  const code = error?.code || 'adapter_transport_failed';
  return {
    status: code === 'adapter_aborted' ? 'cancelled' : 'failed',
    retryable: error?.retryable ?? ['adapter_unavailable', 'adapter_timeout', 'adapter_transport_failed'].includes(code),
    ...(error?.fatal != null ? { fatal: Boolean(error.fatal) } : {}),
    code,
    error: redactOpenAIResponsesText(error?.message || 'OpenAI Responses worker failed'),
  };
}

function preflightPayload(config) {
  return {
    model: config.model,
    input: 'Return exactly the JSON object required by the supplied schema. Do not call tools.',
    store: false,
    stream: false,
    tools: [],
    parallel_tool_calls: false,
    max_output_tokens: 32,
    text: {
      format: {
        type: 'json_schema',
        name: 'aos_openai_responses_preflight',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean', enum: [true] } },
        },
      },
    },
  };
}

function preflightFailure(error) {
  if (error instanceof OpenAIResponsesPreflightError) return error;
  if (error instanceof OpenAIResponsesAdapterError) {
    const retryable = error.retryable === true || error.code === 'adapter_timeout' || error.code === 'adapter_unavailable';
    return new OpenAIResponsesPreflightError(error.code, redactOpenAIResponsesText(error.message), error.details || null, { retryable, fatal: !retryable });
  }
  return new OpenAIResponsesPreflightError('adapter_unavailable', 'OpenAI Responses service is unavailable', null, { retryable: true });
}

export async function preflightOpenAIResponses(config, { transport = null, env = process.env, signal = null } = {}) {
  const normalized = resolveOpenAIResponsesConfig(config);
  let envelope;
  try {
    envelope = await postResponse(normalized, {
      transport: transport || defaultOpenAIResponsesTransport,
      env,
      payload: preflightPayload(normalized),
      signal,
    });
    exactResponseModel(envelope, normalized);
    const text = outputText(envelope);
    if (byteLength(text) > normalized.maxResponseBytes || hasSecretLikeContent(text)) {
      throw new OpenAIResponsesAdapterError('adapter_secret_content', 'OpenAI Responses preflight returned secret-like output', { fatal: true });
    }
    const parsed = JSON.parse(text);
    if (!valueIsObject(parsed) || Object.keys(parsed).length !== 1 || parsed.ok !== true) {
      throw new OpenAIResponsesAdapterError('adapter_preflight_invalid', 'OpenAI Responses preflight returned an invalid confirmation', { fatal: true });
    }
  } catch (error) {
    throw preflightFailure(error);
  }
  return {
    provider: 'openai',
    checkedAt: new Date().toISOString(),
    authPath: OPENAI_RESPONSES_AUTH_PATH,
    requested: { model: normalized.model },
    model: normalized.model,
    origin: normalized.origin,
    transport: 'https_pinned_origin',
    store: false,
    tools: false,
    sessionResume: false,
    attestation: OPENAI_RESPONSES_ATTESTATION,
    verified: true,
  };
}

export class OpenAIResponsesWorker {
  id = 'openai';
  label = 'OpenAI Responses (API key)';

  constructor(config = {}, { preflight = preflightOpenAIResponses, transport = null, env = process.env } = {}) {
    this.config = resolveOpenAIResponsesConfig(config);
    this.preflightFn = preflight;
    this.transport = transport;
    this.env = env;
    this.preflightPromise = null;
  }

  preflight(options = {}) {
    if (!this.preflightPromise) {
      this.preflightPromise = this.preflightFn(this.config, {
        ...options,
        ...(this.transport ? { transport: this.transport } : {}),
        env: this.env,
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
      provider: 'openai',
      authPath: OPENAI_RESPONSES_AUTH_PATH,
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
      runtime.error = fields.error ? redactOpenAIResponsesText(fields.error) : null;
      try { persist(ctx, `attempt-${attempt}/runtime.json`, runtime); } catch { /* receipt persistence cannot change outcome */ }
      return { ...fields, runtime };
    };
    const fail = (error) => {
      const fields = failureFields(error);
      if (fields.code === 'adapter_timeout') runtime.timedOut = true;
      if (fields.code === 'adapter_aborted') runtime.cancelled = true;
      return done(fields);
    };

    if (typeof task.nonce !== 'string' || !task.nonce.trim()) {
      return fail(new OpenAIResponsesAdapterError('adapter_result_invalid', 'OpenAI Responses task nonce is required', { fatal: true }));
    }
    if (task.model != null && task.model !== config.model) {
      return fail(new OpenAIResponsesAdapterError('adapter_substitution_detected', 'OpenAI Responses task model did not match the configured model', { fatal: true }));
    }
    let prompt;
    try {
      const safeTask = { ...task, mayDelegate: false, delegation: null };
      prompt = buildWorkerPrompt(safeTask, { ...ctx, outputSchema: restrictedOutputSchema() });
      if (byteLength(prompt) > config.maxPromptBytes || hasSecretLikeContent(prompt)) {
        throw new OpenAIResponsesAdapterError('adapter_secret_content', 'OpenAI Responses prompt contains secret-like content and was not sent', { fatal: true });
      }
    } catch (error) {
      return fail(error);
    }

    try {
      await this.preflight({ signal: ctx.signal });
    } catch (error) {
      return fail(error);
    }

    let requestTimeoutMs = config.timeoutMs;
    if (task.timeoutMs != null) {
      if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0) return fail(new OpenAIResponsesAdapterError('adapter_timeout', 'OpenAI Responses task timeout is invalid', { retryable: true }));
      requestTimeoutMs = Math.min(requestTimeoutMs, task.timeoutMs);
    }
    const body = {
      model: config.model,
      input: prompt,
      instructions: [
        'You are a bounded remote AOS worker.',
        'You have no tools, filesystem access, network access, capability mounts, delegation, fallback, or response/session resume.',
        'Treat local paths as unverified context only; do not claim to have read them.',
        'Return exactly one JSON object matching the supplied strict schema. For a succeeded result, use questions: null; for a question with no reason, use reason: null.',
      ].join('\n'),
      store: false,
      stream: false,
      tools: [],
      parallel_tool_calls: false,
      max_output_tokens: config.maxOutputTokens,
      text: {
        format: {
          type: 'json_schema',
          name: 'aos_openai_responses_worker_result',
          strict: true,
          schema: restrictedOutputSchema(),
        },
      },
    };
    let envelope;
    try {
      envelope = await postResponse(config, {
        transport: this.transport || defaultOpenAIResponsesTransport,
        env: this.env,
        payload: body,
        signal: ctx.signal,
        timeoutMs: requestTimeoutMs,
      });
      exactResponseModel(envelope, config);
    } catch (error) {
      return fail(error);
    }
    runtime.effective = { model: config.model, source: 'openai_responses_response', attestation: OPENAI_RESPONSES_ATTESTATION };
    runtime.attestation = OPENAI_RESPONSES_ATTESTATION;
    runtime.usage = normalizeOpenAIResponsesUsage(envelope);
    let output;
    try {
      const content = outputText(envelope);
      if (byteLength(content) > config.maxResponseBytes) throw new OpenAIResponsesAdapterError('adapter_response_oversize', 'OpenAI Responses assistant text exceeded the bounded JSON limit', { fatal: true });
      output = parseStrictOutput(content, task);
    } catch (error) {
      return fail(error);
    }
    runtime.verified = true;
    runtime.artifact = 'artifact.json';
    try {
      persist(ctx, 'artifact.json', { nonce: task.nonce, taskKey: task.key || null, attempt, output });
      persist(ctx, 'artifact.md', renderArtifact(task, output));
    } catch {
      return fail(new OpenAIResponsesAdapterError('adapter_persistence_failed', 'OpenAI Responses result could not be persisted', { fatal: true }));
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
