import { spawnCaptured, resolveBinary, CODEX_OUTPUT_SCHEMA, buildWorkerPrompt } from './codex.js';
import { validateTaskQuestions } from './schema.js';
import { normalizeDelegationProposal } from './delegation.js';

// Claude Code is intentionally constrained to the account-session CLI path. API
// keys and interactive/project integrations are not accepted by this adapter.
export const CLAUDE_MODEL_ALLOWLIST = Object.freeze(['opus', 'sonnet', 'haiku']);
export const CLAUDE_EFFORT_ALLOWLIST = Object.freeze(['max', 'high', 'medium', 'low']);
export const CLAUDE_LIVE_CONCURRENCY_CAP = 4;
export const CLAUDE_AUTH_PATH = 'claude auth status --json · Claude account session (claude.ai OAuth)';
export const CLAUDE_SANDBOX = 'restricted-read-only';

const MAX_RESULT_CHARS = 2_000_000;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_ITEMS = 64;
const MAX_VALUE_STRING_CHARS = 40_000;
const CLAUDE_VERSION = /^\d+\.\d+\.\d+/;
const AUTH_METHOD = /^claude\.ai$/i;
const SAFE_SANDBOXES = new Set(['restricted', 'restricted-read-only', 'read-only', 'safe-mode', 'plan']);
const STRIPPED_ENV = /^(?:AOS_OPERATOR_TOKEN|[A-Z0-9]+_(?:API_KEY|API_TOKEN|AUTH_TOKEN)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|GOOGLE_APPLICATION_CREDENTIALS|API_KEY)$/i;

const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/\b(?:sk|rk|pk|ghp|gho|ghs|ghr|AIza)[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}/g, '[redacted-key]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/("?(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|authorization|token)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[redacted]'],
];

export class ClaudeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeConfigError';
    this.fatal = true;
  }
}

export class ClaudePreflightError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudePreflightError';
    this.fatal = true;
    this.details = details;
  }
}

export function redactClaudeText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text;
}

export function resolveClaudeConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const model = source.model || 'opus';
  const effort = source.effort || 'max';
  if (typeof model !== 'string' || !model.trim() || model.length > 120) {
    throw new ClaudeConfigError(`Claude model must be a non-empty string; got ${String(model)}`);
  }
  if (typeof effort !== 'string' || !effort.trim() || effort.length > 40) {
    throw new ClaudeConfigError(`Claude reasoning effort must be a non-empty string; got ${String(effort)}`);
  }
  if (!CLAUDE_MODEL_ALLOWLIST.includes(model.trim())) {
    throw new ClaudeConfigError(`Claude model ${model} is not allowlisted; expected one of ${CLAUDE_MODEL_ALLOWLIST.join(', ')}`);
  }
  if (!CLAUDE_EFFORT_ALLOWLIST.includes(effort.trim())) {
    throw new ClaudeConfigError(`Claude reasoning effort ${effort} is not allowlisted; expected one of ${CLAUDE_EFFORT_ALLOWLIST.join(', ')}`);
  }
  const maxConcurrency = source.maxConcurrency ?? CLAUDE_LIVE_CONCURRENCY_CAP;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > CLAUDE_LIVE_CONCURRENCY_CAP) {
    throw new ClaudeConfigError(`Live Claude concurrency must be an integer from 1 to ${CLAUDE_LIVE_CONCURRENCY_CAP}; got ${source.maxConcurrency}`);
  }
  const timeoutMs = source.timeoutMs ?? 15 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ClaudeConfigError(`Live Claude timeoutMs must be positive; got ${source.timeoutMs}`);
  }
  const killGraceMs = source.killGraceMs ?? 5_000;
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new ClaudeConfigError(`Live Claude killGraceMs must be non-negative; got ${source.killGraceMs}`);
  }
  return Object.freeze({
    model: model.trim(),
    effort: effort.trim(),
    maxConcurrency,
    timeoutMs,
    killGraceMs,
    claudeBin: source.claudeBin || source.bin || 'claude',
    repoRoot: source.repoRoot || null,
  });
}

export function sanitizedClaudeEnv(source = process.env, config = {}) {
  const env = {};
  const stripped = [];
  for (const [name, value] of Object.entries(source || {})) {
    if (STRIPPED_ENV.test(name)) {
      stripped.push(name);
      continue;
    }
    env[name] = value;
  }
  // HOME and CLAUDE_CONFIG_DIR intentionally remain available: they carry the
  // account session. No token is read or copied by the adapter.
  if (config.claudeHome) env.CLAUDE_CONFIG_DIR = config.claudeHome;
  env.NO_COLOR = '1';
  return { env, stripped: stripped.sort() };
}

export function buildClaudeArgs(config, { schema = null, schemaPath = null } = {}) {
  const schemaValue = schema == null ? schemaPath : typeof schema === 'string' ? schema : JSON.stringify(schema);
  return [
    '--print',
    '--output-format', 'json',
    '--model', config.model,
    '--effort', config.effort,
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--permission-mode', 'plan',
    '--permission-prompts', 'none',
    '--tools', 'Read,Glob,Grep',
    ...(schemaValue ? ['--json-schema', schemaValue] : []),
    '--prompt-suggestions', 'false',
    '--no-chrome',
  ];
}

function statusFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const loggedIn = raw.loggedIn ?? raw.logged_in ?? raw.authenticated ?? raw.status === 'logged_in';
  const authMethod = raw.authMethod ?? raw.auth_method ?? raw.provider ?? null;
  const subscriptionType = raw.subscriptionType ?? raw.subscription_type ?? raw.plan ?? null;
  return {
    loggedIn: loggedIn === true,
    authMethod: typeof authMethod === 'string' ? authMethod : null,
    subscriptionType: typeof subscriptionType === 'string' ? subscriptionType : null,
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    throw new ClaudePreflightError(`Claude ${label} did not return JSON`, { phase: label });
  }
}

export async function preflightClaude(config, { run = spawnCaptured, envSource = process.env } = {}) {
  const normalized = resolveClaudeConfig(config);
  const { env, stripped } = sanitizedClaudeEnv(envSource, normalized);
  const binPath = resolveBinary(normalized.claudeBin, env);
  if (!binPath) throw new ClaudePreflightError(`Claude Code CLI not found: ${normalized.claudeBin}`, { command: `${normalized.claudeBin} --version` });

  const versionResult = await run(binPath, ['--version'], { env, timeoutMs: 60_000 });
  const versionText = redactClaudeText(`${versionResult.stdout}\n${versionResult.stderr}`).trim();
  const version = versionText.match(CLAUDE_VERSION)?.[0] || null;
  if (versionResult.exitCode !== 0 || !version) {
    throw new ClaudePreflightError('Claude Code --version failed', { phase: 'version', exitCode: versionResult.exitCode, version });
  }

  const authResult = await run(binPath, ['auth', 'status', '--json'], { env, timeoutMs: 60_000 });
  const auth = statusFields(parseJson(authResult.stdout, 'auth status'));
  if (authResult.exitCode !== 0 || !auth?.loggedIn || !AUTH_METHOD.test(auth.authMethod || '')) {
    throw new ClaudePreflightError('Claude Code is not logged in with a claude.ai account session; refusing API-key fallback', {
      phase: 'auth',
      exitCode: authResult.exitCode,
      auth,
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    claudeBin: binPath,
    cliVersion: version,
    authPath: CLAUDE_AUTH_PATH,
    auth,
    requested: { model: normalized.model, effort: normalized.effort, sandbox: CLAUDE_SANDBOX },
    posture: {
      source: 'invocation_args',
      restricted: true,
      safeMode: true,
      strictMcpConfig: true,
      permissionMode: 'plan',
      permissionPrompts: 'none',
      tools: ['Read', 'Glob', 'Grep'],
      chrome: false,
    },
    strippedEnv: stripped,
  };
}

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function modelFamily(model) {
  const value = String(model || '').toLowerCase();
  if (value.includes('opus')) return 'opus';
  if (value.includes('sonnet')) return 'sonnet';
  if (value.includes('haiku')) return 'haiku';
  return null;
}

function effectiveRuntime(envelope, config) {
  const effective = envelope?.effective && typeof envelope.effective === 'object' ? envelope.effective : {};
  const modelUsage = envelope?.modelUsage && typeof envelope.modelUsage === 'object' ? envelope.modelUsage : {};
  const modelNames = Object.keys(modelUsage).filter((name) => typeof name === 'string');
  const primaryProviderModel = modelNames.find((name) => modelFamily(name) === config.model) || null;
  return {
    // Claude does not echo the alias/effort/sandbox in its JSON result. The
    // alias is bound to the configured invocation, while modelUsage proves the
    // provider actually used the requested model family.
    model: config.model,
    modelProvider: primaryProviderModel,
    effort: config.effort,
    sandbox: CLAUDE_SANDBOX,
    source: 'claude_modelUsage_and_invocation_args',
    modelAttested: Boolean(primaryProviderModel),
    effortAttested: true,
    sandboxAttested: true,
    reportedModel: envelope?.model ?? effective.model ?? envelope?.model_name ?? null,
  };
}

function normalizeUsage(envelope) {
  const usage = envelope?.usage && typeof envelope.usage === 'object' ? envelope.usage : {};
  const cacheCreation = finite(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const cacheRead = finite(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens);
  const values = {
    input_tokens: finite(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens),
    cached_input_tokens: cacheCreation != null && cacheRead != null ? cacheCreation + cacheRead : null,
    output_tokens: finite(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens),
    // Claude's result does not separate reasoning tokens. Zero is an explicit
    // provider-not-separated value, not an inferred measurement.
    reasoning_output_tokens: 0,
    usd: finite(envelope.total_cost_usd ?? envelope.cost_usd ?? envelope.costUsd ?? usage.usd ?? usage.cost_usd),
  };
  const hasAny = ['input_tokens', 'cached_input_tokens', 'output_tokens'].some((field) => values[field] != null);
  if (!hasAny) return null;
  return {
    ...values,
    // Settlement must never interpret a partially observed usage object as a
    // verified zero-token receipt. The worker remains unverified until every
    // token component is finite.
    attested: ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].every((field) => values[field] != null),
    source: 'claude_result_usage',
    reasoningSeparated: false,
  };
}

function outputEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new ClaudePreflightError('Claude Code returned no JSON output', { phase: 'execute' });
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ClaudePreflightError('Claude Code output was not JSON; refusing unverified text', { phase: 'execute' });
  }
}

function structuredOutput(envelope) {
  const candidates = [envelope?.structured_output, envelope?.structuredOutput, envelope?.output, envelope?.result];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Claude's plain text result is intentionally not accepted when a JSON
      // schema was requested; it cannot be safely bound to this task.
    }
  }
  if (envelope && typeof envelope === 'object' && typeof envelope.task_nonce === 'string') return envelope;
  return null;
}

const SECRET_FIELD = /api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|authorization|credential/i;

function boundedValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactClaudeText(value).slice(0, MAX_VALUE_STRING_CHARS);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_VALUE_DEPTH) return '[truncated]';
  if (typeof value !== 'object') return String(value).slice(0, MAX_VALUE_STRING_CHARS);
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_VALUE_ITEMS).map((item) => boundedValue(item, depth + 1, seen));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_VALUE_ITEMS)) {
      out[key] = SECRET_FIELD.test(key) && typeof item === 'string' ? '[redacted]' : boundedValue(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function normalizeStructuredOutput(parsed, task) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Claude Code did not return a structured AOS result'), { code: 'adapter_result_invalid' });
  }
  if (parsed.task_nonce !== task.nonce) {
    throw Object.assign(new Error('Worker output carried another task nonce; refusing cross-wired output'), { code: 'isolation_nonce_mismatch', fatal: true });
  }
  const status = parsed.status || 'succeeded';
  if (!['succeeded', 'awaiting_user'].includes(status)) {
    throw Object.assign(new Error(`Worker output status must be succeeded or awaiting_user; got ${String(status)}`), { code: 'worker_output_invalid' });
  }
  let questions = null;
  if (status === 'awaiting_user') questions = validateTaskQuestions(parsed.questions);
  const delegation = normalizeDelegationProposal(parsed.delegation, task);
  const output = boundedValue({
    task_nonce: parsed.task_nonce,
    status,
    ...(questions ? { questions } : {}),
    summary: String(parsed.summary || ''),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    confidence: Number(parsed.confidence ?? 0),
    decision: parsed.decision || null,
    retrospective: parsed.retrospective || null,
    memory_writes: Array.isArray(parsed.memory_writes) ? parsed.memory_writes : [],
    ...(delegation ? { delegation } : {}),
  });
  return { output, questions };
}

function fallbackPrompt(task, ctx) {
  return [
    '# AOS worker assignment',
    `Run: ${ctx.run?.id || '(unknown)'}`,
    `Task: ${task.key || task.id} — ${task.title}`,
    `AOS task nonce: ${task.nonce}`,
    ctx.goal?.prompt || '',
    task.brief || task.summary || task.title,
    'Reply with JSON only, matching the provided AOS output schema.',
  ].filter(Boolean).join('\n\n');
}

export class ClaudeCliWorker {
  constructor(config = {}) {
    this.config = resolveClaudeConfig(config);
    this.id = 'claude';
    this.label = 'Claude Code';
    this.preflightPromise = null;
  }

  async preflight() {
    if (!this.preflightPromise) {
      this.preflightPromise = preflightClaude(this.config).catch((error) => {
        this.preflightPromise = null;
        throw error;
      });
    }
    return this.preflightPromise;
  }

  async execute(task, ctx) {
    const config = this.config;
    const preflight = await this.preflight();
    const attempt = task.attempts;
    const attemptDir = `attempt-${attempt}`;
    const outputSchema = ctx.outputSchema || CODEX_OUTPUT_SCHEMA;
    ctx.workspace.write(`${attemptDir}/output-schema.json`, outputSchema);
    let prompt;
    try {
      prompt = typeof buildWorkerPrompt === 'function'
        ? buildWorkerPrompt(task, { ...ctx, outputSchema })
        : fallbackPrompt(task, ctx);
    } catch {
      prompt = fallbackPrompt(task, ctx);
    }
    const startedAt = Date.now();
    const runtime = {
      runId: ctx.run.id,
      taskId: task.id,
      taskKey: task.key || null,
      attempt,
      spawned: false,
      injected: false,
      provider: 'claude',
      authPath: CLAUDE_AUTH_PATH,
      requested: preflight.requested,
      effective: null,
      verified: false,
      startedAt: null,
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
    const { env, stripped } = sanitizedClaudeEnv(process.env, config);
    const args = buildClaudeArgs(config, { schema: outputSchema });
    const done = (fields) => {
      Object.assign(runtime, fields.runtime || {});
      runtime.error = fields.error ? redactClaudeText(fields.error) : null;
      runtime.startedAt ||= new Date(startedAt).toISOString();
      runtime.endedAt ||= new Date().toISOString();
      runtime.durationMs ??= Math.max(0, Date.parse(runtime.endedAt) - Date.parse(runtime.startedAt));
      runtime.strippedEnv = stripped;
      if (runtime.error) runtime.error = runtime.error.slice(0, 500);
      return { ...fields, runtime };
    };

    const result = await spawnCaptured(preflight.claudeBin, args, {
      cwd: ctx.workspace.dir,
      env,
      input: prompt,
      timeoutMs: task.timeoutMs || config.timeoutMs,
      killGraceMs: config.killGraceMs,
      signal: ctx.signal,
      onSpawn: (child) => {
        runtime.spawned = true;
        runtime.pid = child.pid;
        ctx.recordWorkerProcess?.({ pid: child.pid, pgid: child.pid });
        ctx.emit?.('worker.spawned', { pid: child.pid, provider: 'claude', model: config.model, effort: config.effort, sandbox: CLAUDE_SANDBOX });
      },
    });
    runtime.startedAt = new Date(result.startedAt).toISOString();
    runtime.endedAt = new Date(result.endedAt).toISOString();
    runtime.durationMs = Math.max(0, result.endedAt - result.startedAt);
    runtime.exitCode = result.exitCode;
    runtime.signal = result.signal;
    runtime.timedOut = Boolean(result.timedOut);
    runtime.cancelled = Boolean(result.cancelled);
    ctx.emit?.('worker.exited', {
      provider: 'claude',
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: runtime.timedOut,
      cancelled: runtime.cancelled,
      durationMs: runtime.durationMs,
    });

    if (runtime.cancelled) return done({ status: 'cancelled', error: 'Cancelled by operator' });
    if (runtime.timedOut) return done({ status: 'failed', retryable: true, code: 'adapter_timeout', error: 'Claude Code timed out' });
    if (result.spawnError) return done({ status: 'failed', retryable: false, fatal: true, code: 'adapter_transport_failed', error: `Could not start Claude Code: ${result.spawnError}` });
    if (result.exitCode !== 0) return done({ status: 'failed', retryable: true, code: 'adapter_transport_failed', error: `Claude Code exited with ${result.exitCode}` });

    let envelope;
    try {
      envelope = outputEnvelope(result.stdout);
    } catch (error) {
      return done({ status: 'failed', retryable: false, fatal: true, code: 'adapter_result_invalid', error: error.message });
    }
    const effective = effectiveRuntime(envelope, config);
    runtime.effective = effective;
    // Keep the provider reference opaque to engine state. The engine captures it
    // through its harness-session registry via the existing threadId seam.
    runtime.threadId = envelope.session_id ?? envelope.sessionId ?? null;
    runtime.usage = normalizeUsage(envelope);
    const sandbox = String(effective.sandbox || '').toLowerCase();
    const mismatch = effective.modelAttested !== true;
    const reportedMismatch = effective.reportedModel != null && modelFamily(effective.reportedModel) !== config.model;
    const effortMismatch = effective.effort !== config.effort || effective.effortAttested !== true;
    const missing = [
      runtime.threadId ? null : 'session id',
      effective.modelAttested ? null : 'effective model family',
      effective.effortAttested && effective.effort ? null : 'invocation effort attestation',
      effective.sandboxAttested && SAFE_SANDBOXES.has(sandbox) ? null : 'restricted sandbox attestation',
      runtime.usage?.attested === true ? null : 'complete usage token components',
    ].filter(Boolean);
    if (mismatch || reportedMismatch || effortMismatch) {
      runtime.verified = false;
      const detail = `Claude Code effective runtime does not match requested ${config.model}/${config.effort}`;
      return done({ status: 'failed', retryable: false, fatal: true, code: 'adapter_substitution_detected', error: detail });
    }
    if (missing.length) {
      runtime.verified = false;
      return done({ status: 'failed', retryable: false, fatal: true, code: 'adapter_attestation_failed', error: `Claude Code runtime attestation is incomplete: ${missing.join(', ')}` });
    }
    runtime.verified = true;
    ctx.emit?.('worker.verified', {
      provider: 'claude',
      requested: runtime.requested,
      effective: runtime.effective,
      usage: runtime.usage,
    });
    const isError = envelope.is_error === true || envelope.subtype === 'error';
    const text = redactClaudeText(typeof envelope.result === 'string' ? envelope.result : envelope.message || '');
    if (isError) return done({ status: 'failed', retryable: true, code: 'adapter_provider_rejected', error: text || 'Claude Code reported an error' });
    let parsed;
    try {
      parsed = structuredOutput(envelope);
      if (ctx.outputKind === 'lead') {
        throw Object.assign(new Error('Claude Code lead planning is not mounted on this adapter'), { code: 'adapter_result_invalid' });
      }
      if (!parsed) throw Object.assign(new Error('Claude Code returned no structured AOS result'), { code: 'adapter_result_invalid' });
      const normalized = normalizeStructuredOutput(parsed, task);
      const output = normalized.output;
      runtime.artifact = 'artifact.json';
      ctx.workspace.write('artifact.json', { nonce: task.nonce, taskKey: task.key || null, attempt, output });
      ctx.workspace.write('artifact.md', renderClaudeArtifact(task, output));
      return done({
        status: output.status,
        ...(normalized.questions ? { questions: normalized.questions } : {}),
        summary: String(output.summary || '').slice(0, 600) || `Completed ${task.title}`,
        result: output,
        artifacts: ['artifact.json', 'artifact.md'],
      });
    } catch (error) {
      const code = error.code || 'adapter_result_invalid';
      if (code === 'isolation_nonce_mismatch') ctx.emit?.('isolation.violation', { reason: 'nonce_mismatch' });
      return done({ status: 'failed', retryable: false, fatal: Boolean(error.fatal), code, error: redactClaudeText(error.message) });
    }
  }
}

function renderClaudeArtifact(task, result) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const risks = Array.isArray(result.risks) ? result.risks : [];
  return [
    `# ${task.key || task.id} — ${task.title}`,
    '',
    '## Summary',
    String(result.summary || ''),
    '',
    '## Findings',
    ...(findings.length ? findings.map((item) => `- **${item.kind || 'note'}** (${item.confidence ?? 'n/a'}): ${item.claim || ''}\n  - evidence: ${(item.evidence || []).join('; ') || 'none'}`) : ['- none']),
    '',
    '## Risks',
    ...(risks.length ? risks.map((item) => `- ${item}`) : ['- none']),
  ].join('\n') + '\n';
}

export { normalizeUsage, normalizeStructuredOutput };
