import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { validateTaskQuestions } from './schema.js';
import {
  LEAD_PLANNING_OUTPUT_SCHEMA,
  buildLeadPlanningPrompt,
  normalizeLeadPlanOutput,
} from './lead-planning-schema.js';
import {
  DELEGATION_PROPOSAL_SCHEMA,
  DELEGATION_LIMITS,
  normalizeDelegationProposal,
} from './delegation.js';

// Live Codex execution is deliberately narrow: one model, one effort, a ChatGPT
// account session, and a read-only sandbox. Widening any of these is a code change.
export const CODEX_MODEL_ALLOWLIST = Object.freeze(['gpt-5.6-luna']);
export const CODEX_EFFORT_ALLOWLIST = Object.freeze(['max']);
export const CODEX_LIVE_CONCURRENCY_CAP = 4;

// Features that would let a worker reach a different model (sub-agents, image
// generation, guardian review) or act outside its sandbox (apps, browser, memories).
export const CODEX_DISABLED_FEATURES = Object.freeze([
  'multi_agent',
  'guardian_approval',
  'image_generation',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'memories',
  'goals',
  'hooks',
  'skill_mcp_dependency_install',
  'tool_suggest',
]);

export const CODEX_AUTH_PATH = 'codex-cli exec · ChatGPT account login (codex login status)';

const CHATGPT_LOGIN = /Logged in using ChatGPT/;
const STRIPPED_ENV = /^(OPENAI_|AZURE_OPENAI_)|API_KEY$|ACCESS_TOKEN$|AUTH_TOKEN$|^CODEX_API_KEY$|^AOS_OPERATOR_TOKEN$/;
const FATAL_ERROR = /unauthori[sz]ed|\b401\b|\b403\b|forbidden|not logged in|login required|api key|unknown model|model .*not (?:found|supported|available)|does not exist|not supported|invalid value|unrecognized|invalid (?:config|argument)/i;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;

const REDACTIONS = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/("?(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password|authorization)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi, '$1[redacted]'],
];

export class CodexConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexConfigError';
    this.fatal = true;
  }
}

export class CodexPreflightError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CodexPreflightError';
    this.fatal = true;
    this.details = details;
  }
}

export function redactText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

export function resolveCodexConfig(input = {}) {
  const model = input.model || CODEX_MODEL_ALLOWLIST[0];
  const effort = input.effort || CODEX_EFFORT_ALLOWLIST[0];
  if (!CODEX_MODEL_ALLOWLIST.includes(model)) {
    throw new CodexConfigError(`Model "${model}" is not allowlisted for live Codex execution. Allowed: ${CODEX_MODEL_ALLOWLIST.join(', ')}`);
  }
  if (!CODEX_EFFORT_ALLOWLIST.includes(effort)) {
    throw new CodexConfigError(`Reasoning effort "${effort}" is not allowlisted for live Codex execution. Allowed: ${CODEX_EFFORT_ALLOWLIST.join(', ')}`);
  }
  const maxConcurrency = input.maxConcurrency ?? CODEX_LIVE_CONCURRENCY_CAP;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > CODEX_LIVE_CONCURRENCY_CAP) {
    throw new CodexConfigError(`Live Codex concurrency must be an integer from 1 to ${CODEX_LIVE_CONCURRENCY_CAP}; got ${input.maxConcurrency}`);
  }
  const timeoutMs = input.timeoutMs ?? 15 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexConfigError(`Live Codex timeoutMs must be positive; got ${input.timeoutMs}`);
  }
  return Object.freeze({
    model,
    effort,
    maxConcurrency,
    timeoutMs,
    killGraceMs: input.killGraceMs ?? 5_000,
    codexBin: input.codexBin || 'codex',
    codexHome: input.codexHome || null,
    repoRoot: input.repoRoot || null,
  });
}

export function sanitizedChildEnv(source = process.env, config = {}) {
  const env = {};
  const stripped = [];
  for (const [name, value] of Object.entries(source)) {
    if (STRIPPED_ENV.test(name)) {
      stripped.push(name);
      continue;
    }
    env[name] = value;
  }
  if (config.codexHome) env.CODEX_HOME = config.codexHome;
  env.NO_COLOR = '1';
  return { env, stripped: stripped.sort() };
}

export function codexHomeDir(config = {}) {
  return config.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function resolveBinary(bin, env = process.env) {
  if (isAbsolute(bin)) return existsSync(bin) ? realpathSync(bin) : null;
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // not in this PATH entry
    }
  }
  return null;
}

export function buildCodexArgs(config, { cwd, lastMessagePath, schemaPath }) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-m', config.model,
    '-c', `model_reasoning_effort="${config.effort}"`,
    '-c', 'forced_login_method="chatgpt"',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--output-schema', schemaPath,
    '-C', cwd,
    '-o', lastMessagePath,
    '-',
  ];
}

// Runs a process in its own process group so a timeout or cancel also stops the
// shell commands Codex started. Output is captured with byte caps.
export function spawnCaptured(bin, args, {
  cwd,
  env,
  input = null,
  timeoutMs = 30_000,
  killGraceMs = 5_000,
  signal,
  onStdoutLine,
  onSpawn,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
} = {}) {
  const stdoutLimit = Number.isInteger(maxStdoutBytes) && maxStdoutBytes > 0 ? maxStdoutBytes : MAX_STDOUT_BYTES;
  const stderrLimit = Number.isInteger(maxStderrBytes) && maxStderrBytes > 0 ? maxStderrBytes : MAX_STDERR_BYTES;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let pending = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer = null;
    let child;

    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      if (pending && onStdoutLine) onStdoutLine(pending);
      resolve({
        pid: child?.pid ?? null,
        stdout,
        stderr,
        truncated,
        timedOut,
        cancelled,
        startedAt,
        endedAt: Date.now(),
        ...fields,
      });
    };

    const killGroup = (sig) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const stop = () => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    };

    const onAbort = () => {
      cancelled = true;
      stop();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    try {
      child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      finish({ exitCode: null, signal: null, spawnError: error.message });
      return;
    }
    LIVE_CHILDREN.add(child);
    onSpawn?.(child);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutBytes += chunk.length;
      if (stdoutBytes <= stdoutLimit) stdout += text;
      else truncated = true;
      if (!onStdoutLine) return;
      pending += text;
      let index = pending.indexOf('\n');
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.trim()) onStdoutLine(line);
        index = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= stderrLimit) stderr += chunk.toString('utf8');
      else truncated = true;
    });
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.on('error', (error) => {
      LIVE_CHILDREN.delete(child);
      finish({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on('close', (exitCode, exitSignal) => {
      LIVE_CHILDREN.delete(child);
      finish({ exitCode, signal: exitSignal });
    });
    child.stdin.end(input ?? '');
  });
}

const LIVE_CHILDREN = new Set();
process.once('exit', () => {
  for (const child of LIVE_CHILDREN) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

export async function preflightCodex(config, { run = spawnCaptured } = {}) {
  const { env, stripped } = sanitizedChildEnv(process.env, config);
  const binPath = resolveBinary(config.codexBin, env);
  if (!binPath) {
    throw new CodexPreflightError(`Codex CLI not found: ${config.codexBin}`, { command: `${config.codexBin} --version` });
  }
  const check = async (args, timeoutMs = 60_000) => {
    const result = await run(binPath, args, { env, timeoutMs });
    return { ...result, command: `codex ${args.join(' ')}`, text: redactText(`${result.stdout}\n${result.stderr}`).trim() };
  };

  const version = await check(['--version']);
  if (version.exitCode !== 0 || !/codex-cli/.test(version.text)) {
    throw new CodexPreflightError('codex --version failed', { command: version.command, exitCode: version.exitCode, output: version.text.slice(0, 2000) });
  }

  const login = await check(['login', 'status']);
  if (login.exitCode !== 0 || !CHATGPT_LOGIN.test(login.text)) {
    throw new CodexPreflightError('Codex CLI is not logged in with a ChatGPT account; refusing live execution (no API-key fallback)', {
      command: login.command,
      exitCode: login.exitCode,
      output: login.text.slice(0, 2000),
    });
  }

  const catalog = await check(['debug', 'models']);
  let entry = null;
  try {
    entry = JSON.parse(catalog.stdout).models?.find((item) => item.slug === config.model) || null;
  } catch {
    entry = null;
  }
  const efforts = entry?.supported_reasoning_levels?.map((level) => level.effort) || [];
  if (catalog.exitCode !== 0 || !entry || !efforts.includes(config.effort) || entry.upgrade) {
    throw new CodexPreflightError(`Codex model catalog does not offer ${config.model} with effort ${config.effort}`, {
      command: catalog.command,
      exitCode: catalog.exitCode,
      found: Boolean(entry),
      efforts,
      upgrade: entry?.upgrade ?? null,
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    codexBin: binPath,
    cliVersion: version.text.split('\n')[0],
    login: login.text.split('\n').find((line) => CHATGPT_LOGIN.test(line)),
    authPath: CODEX_AUTH_PATH,
    model: { slug: entry.slug, efforts, upgrade: entry.upgrade ?? null },
    requested: { model: config.model, effort: config.effort },
    strippedEnv: stripped,
    disabledFeatures: [...CODEX_DISABLED_FEATURES],
  };
}

// Reads only named, non-secret fields from the session file Codex writes for a
// thread: effective model and effort, provider, sandbox, and ChatGPT plan type.
export function readSessionEvidence({ codexHome, threadId, startedAt = Date.now() }) {
  const sessions = join(codexHome, 'sessions');
  const days = new Set();
  for (const offset of [-1, 0, 1]) {
    const date = new Date(startedAt + offset * 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    days.add(join(sessions, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())));
  }
  let file = null;
  for (const dir of days) {
    if (!existsSync(dir)) continue;
    const name = readdirSync(dir).find((entry) => entry.endsWith(`-${threadId}.jsonl`));
    if (name) {
      file = join(dir, name);
      break;
    }
  }
  if (!file) return { found: false, threadId };

  const evidence = {
    found: true,
    threadId,
    sessionFile: file,
    sessionId: null,
    cliVersion: null,
    source: null,
    modelProvider: null,
    models: [],
    efforts: [],
    sandboxes: [],
    approvalPolicies: [],
    planType: null,
    usedPercent: null,
    turnDurationMs: null,
  };
  const add = (list, value) => {
    if (value != null && !list.includes(value)) list.push(value);
  };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload || {};
    if (record.type === 'session_meta') {
      evidence.sessionId = payload.id ?? payload.session_id ?? null;
      evidence.cliVersion = payload.cli_version ?? null;
      evidence.source = payload.source ?? null;
      evidence.modelProvider = payload.model_provider ?? null;
    } else if (record.type === 'turn_context') {
      add(evidence.models, payload.model);
      add(evidence.efforts, payload.effort);
      add(evidence.sandboxes, payload.sandbox_policy?.type);
      add(evidence.approvalPolicies, payload.approval_policy);
    } else if (record.type === 'event_msg' && payload.type === 'token_count' && payload.rate_limits) {
      evidence.planType = payload.rate_limits.plan_type ?? evidence.planType;
      evidence.usedPercent = payload.rate_limits.primary?.used_percent ?? evidence.usedPercent;
    } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
      evidence.turnDurationMs = payload.duration_ms ?? null;
    }
  }
  return evidence;
}

// A mismatch is always fatal. Missing evidence is fatal only when the attempt
// produced output, because unverifiable output must not be accepted.
export function verifySession(evidence, config) {
  const mismatch = [];
  const missing = [];
  if (!evidence?.found) {
    missing.push('Codex session file for the thread was not found');
  } else {
    if (!evidence.models.length) missing.push('session recorded no model');
    if (!evidence.efforts.length) missing.push('session recorded no reasoning effort');
    if (evidence.models.some((model) => model !== config.model)) mismatch.push(`session model ${evidence.models.join(',')} != requested ${config.model}`);
    if (evidence.efforts.some((effort) => effort !== config.effort)) mismatch.push(`session effort ${evidence.efforts.join(',')} != requested ${config.effort}`);
    if (evidence.modelProvider && evidence.modelProvider !== 'openai') mismatch.push(`session provider ${evidence.modelProvider} != openai`);
    if (!evidence.modelProvider) missing.push('session recorded no model provider');
    if (evidence.sandboxes.some((mode) => mode !== 'read-only')) mismatch.push(`session sandbox ${evidence.sandboxes.join(',')} != read-only`);
  }
  return { ok: mismatch.length === 0 && missing.length === 0, mismatch, missing, problems: [...mismatch, ...missing] };
}

async function readSessionWithRetry(args, attempts = 12, delayMs = 250) {
  let evidence = readSessionEvidence(args);
  for (let i = 1; i < attempts && (!evidence.found || !evidence.models.length); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    evidence = readSessionEvidence(args);
  }
  return evidence;
}

export const CODEX_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['task_nonce', 'status', 'summary', 'findings', 'risks', 'confidence', 'decision', 'retrospective', 'memory_writes', 'delegation'],
  properties: {
    task_nonce: { type: 'string' },
    status: { type: 'string', enum: ['succeeded', 'awaiting_user'] },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 500 },
          reason: { type: 'string', maxLength: 300 },
        },
      },
    },
    summary: { type: 'string' },
    memory_writes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'type', 'title', 'content', 'tags', 'confidence', 'sensitivity'],
        properties: {
          scope: { type: 'string', enum: ['agent', 'role', 'run', 'swarm', 'project'] },
          type: { type: 'string', enum: ['fact', 'decision', 'procedure', 'preference', 'failure_lesson', 'evidence_reference', 'summary', 'unresolved_question'] },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          sensitivity: { type: 'string', enum: ['normal', 'sensitive'] },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'claim', 'evidence', 'confidence'],
        properties: {
          kind: { type: 'string', enum: ['supported', 'conflict', 'note'] },
          claim: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    decision: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['recommendation', 'objection', 'confidence'],
          properties: {
            recommendation: { type: 'string' },
            objection: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
      ],
    },
    retrospective: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['what_failed', 'why', 'should_improve', 'proposals'],
          properties: {
            what_failed: { type: 'string' },
            why: { type: 'string' },
            should_improve: { type: 'string' },
            proposals: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'change', 'rationale', 'risk'],
                properties: {
                  title: { type: 'string' },
                  change: { type: 'string' },
                  rationale: { type: 'string' },
                  risk: { type: 'string' },
                },
              },
            },
          },
        },
      ],
    },
    delegation: {
      anyOf: [DELEGATION_PROPOSAL_SCHEMA, { type: 'null' }],
    },
  },
});

export { LEAD_PLANNING_OUTPUT_SCHEMA };

function delegationChildLimit(task) {
  const raw = task.delegation?.maxChildren;
  if (raw === null || raw === 'unlimited' || raw === undefined) return DELEGATION_LIMITS.maxTasks;
  return Number.isInteger(raw) && raw >= 0 ? Math.min(raw, DELEGATION_LIMITS.maxTasks) : 0;
}

function delegationDepthLimit(task) {
  const raw = task.delegation?.maxDepth;
  if (raw === null || raw === 'unlimited' || raw === undefined) return DELEGATION_LIMITS.maxTasks;
  return Number.isInteger(raw) && raw >= 0 ? Math.min(raw, DELEGATION_LIMITS.maxTasks) : 0;
}

function delegationTemplatePins(task, ctx) {
  const delegation = task?.delegation && typeof task.delegation === 'object' ? task.delegation : {};
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const rawPins = delegation.childTemplateVersions
    ?? task?.childTemplateVersions
    ?? context.childTemplateVersions
    ?? context.delegation?.childTemplateVersions;
  const pins = [];
  const add = (rawId, rawVersion) => {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    const version = rawVersion && typeof rawVersion === 'object' && !Array.isArray(rawVersion)
      ? rawVersion.templateVersion ?? rawVersion.version
      : rawVersion;
    if (id && Number.isInteger(version) && version > 0) pins.push(`${id}@${version}`);
  };
  if (Array.isArray(rawPins)) {
    for (const ref of rawPins) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
      add(ref.templateId ?? ref.id, ref.templateVersion ?? ref.version);
    }
  } else if (rawPins && typeof rawPins === 'object') {
    for (const [id, version] of Object.entries(rawPins)) add(id, version);
  }
  if (!pins.length) {
    const rawRefs = delegation.childTemplateRefs ?? context.childTemplateRefs;
    if (Array.isArray(rawRefs)) {
      for (const ref of rawRefs) {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
        add(ref.templateId ?? ref.id, ref.templateVersion ?? ref.version);
      }
    }
  }
  if (!pins.length && Array.isArray(delegation.childTemplates)) {
    for (const ref of delegation.childTemplates) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
      add(ref.templateId ?? ref.id, ref.templateVersion ?? ref.version);
    }
  }
  return [...new Set(pins)];
}

export function buildWorkerPrompt(task, ctx) {
  if (ctx.outputKind === 'lead') return ctx.planningPrompt || buildLeadPlanningPrompt(task, ctx);
  const exactTemplatePins = delegationTemplatePins(task, ctx);
  const lines = [
    // A rendered role preset, when the task has one, is the system prompt for this worker.
    ...(ctx.systemPrompt ? [String(ctx.systemPrompt).trimEnd(), '', '---', ''] : []),
    '# AOS worker assignment',
    '',
    'You are one worker in an AOS run. The AOS engine persists your answer; you do not write files.',
    '',
    `Run: ${ctx.run.id}`,
    `Task: ${task.key || task.id} — ${task.title} (kind: ${task.kind}, branch: ${task.branch || 'root'}, attempt ${task.attempts})`,
    `AOS task nonce: ${task.nonce}`,
    '',
    '## Job objective',
    ctx.goal.prompt,
    '',
    '## Your brief',
    task.brief || task.summary || task.title,
  ];
  const answers = (task.questions || []).filter((question) => typeof question.answer === 'string' && question.answer.trim());
  if (answers.length) {
    lines.push('', '## Operator answers (from an earlier wait)', 'These answers are supplemental context. Do not rewrite the task brief or plan.', ...answers.map((question) => `- ${question.id}: ${question.answer}`));
  }
  lines.push('', '## Inputs');
  if (ctx.repoRoot) lines.push(`Repository root (read-only): ${ctx.repoRoot}`);
  if (ctx.eventsPath) lines.push(`This run's append-only event log (read-only, still growing): ${ctx.eventsPath}`);
  if (task.readPaths?.length) {
    lines.push('Paths to read:');
    for (const path of task.readPaths) lines.push(`- ${path}`);
  }
  if (ctx.dependencies?.length) {
    lines.push('', 'Dependency results:');
    for (const dep of ctx.dependencies) {
      lines.push(`### ${dep.key || dep.id} — ${dep.title} (${dep.status})`);
      lines.push(`Summary: ${dep.summary || '(none)'}`);
      for (const finding of dep.findings || []) {
        lines.push(`- [${finding.kind}] ${finding.claim} (evidence: ${(finding.evidence || []).join('; ') || 'none'})`);
      }
      if (dep.decision) lines.push(`Decision: ${dep.decision.recommendation} | Objection: ${dep.decision.objection}`);
      if (dep.artifact) lines.push(`Artifact: ${dep.artifact}`);
    }
  }
  lines.push(
    '',
    '## Rules',
    '- The sandbox is read-only. Do not modify files, install packages, or use the network.',
    '- Do not open credential stores (~/.codex/auth.json, keychains, .env files) and do not print environment variables.',
    ...(task.mayDelegate
      ? [
          `- You may propose bounded child work for the engine to validate: at most ${delegationChildLimit(task, 'maxChildren')} child tasks and ${delegationDepthLimit(task)} delegation level${delegationDepthLimit(task) === 1 ? '' : 's'} below this task. A proposal is not a spawn command; do not spawn sub-agents directly.`,
          `- Permitted child templates (exact): ${exactTemplatePins.length ? exactTemplatePins.join(', ') : 'use only the exact id@version pins supplied by the engine/task context; if no pins are supplied, do not propose child work'}.`,
          '- Each proposed child must be standalone and use an exact permitted templateId plus its positive pinned templateVersion supplied by the engine/task context; both fields are required. Never use "latest", null, or an omitted version. The remaining fields are id, key, title, kind, brief, an optional positive bounded budget, sibling dependencies by local id, and optional delegation within this inherited authority.',
          '- Never include parentId, provider, harness, model, effort, credentials, actor, capabilities, sandbox, filesystem, network, or arbitrary plan fields in a delegation proposal; the engine derives those from approved templates and the parent task.',
        ]
      : ['- Do not spawn sub-agents, delegate, or propose child work. Work only on this assignment.']),
    '- Stay concise: summary at most 120 words, at most 5 findings, each citing evidence as path:line or an events.jsonl event id.',
    '- Use at most about 8 shell commands. If evidence is missing, say so under risks instead of guessing.',
    '',
    '## Output',
    'Reply with JSON only, matching the provided output schema.',
    `- task_nonce must be exactly "${task.nonce}".`,
    '- status must be "succeeded" for a completed assignment, or "awaiting_user" when one to three required operator answers are needed before continuing.',
    '- For awaiting_user, questions must contain 1–3 objects with a nonblank prompt of at most 500 characters, an optional reason of at most 300 characters, and at most 1500 prompt characters total. Do not include answers.',
    '- Omit questions when status is succeeded.',
    task.mayDelegate
      ? '- Set delegation to null when no child work is needed. If you include a proposal, the engine will validate it before any later materialization; do not claim that children were spawned.'
      : '- Set delegation to null (or omit it for compatibility); this task is not authorized to propose child work.',
    task.kind === 'synthesis'
      ? '- decision is required: recommendation, the strongest objection, and confidence 0-1.'
      : '- decision must be null.',
    task.kind === 'retrospective'
      ? '- retrospective is required: what failed, why, what should improve, and concrete proposals. Proposals are recorded for human approval only; never apply them.'
      : '- retrospective must be null.',
  );
  return `${lines.join('\n')}\n`;
}

function classifyFailure(message) {
  return FATAL_ERROR.test(message) ? { retryable: false, fatal: true } : { retryable: true, fatal: false };
}

function renderArtifact(task, result, runtime) {
  const lines = [
    `# ${task.key || task.id} — ${task.title}`,
    '',
    `Worker: ${runtime.effective?.model || runtime.requested.model} / ${runtime.effective?.effort || runtime.requested.effort} · thread ${runtime.threadId} · attempt ${runtime.attempt}`,
    '',
    '## Summary',
    result.summary,
    '',
    '## Findings',
    ...(result.findings.length
      ? result.findings.map((item) => `- **${item.kind}** (${item.confidence}): ${item.claim}\n  - evidence: ${item.evidence.join('; ') || 'none'}`)
      : ['- none']),
    '',
    '## Risks',
    ...(result.risks.length ? result.risks.map((item) => `- ${item}`) : ['- none']),
  ];
  if (result.decision) {
    lines.push('', '## Decision', `Recommendation: ${result.decision.recommendation}`, '', `Objection: ${result.decision.objection}`, '', `Confidence: ${result.decision.confidence}`);
  }
  if (result.retrospective) {
    const retro = result.retrospective;
    lines.push('', '## Retrospective', `What failed: ${retro.what_failed}`, '', `Why: ${retro.why}`, '', `Should improve: ${retro.should_improve}`, '', '### Proposals (pending approval)');
    for (const proposal of retro.proposals) {
      lines.push(`- **${proposal.title}**: ${proposal.change}\n  - rationale: ${proposal.rationale}\n  - risk: ${proposal.risk}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export class CodexCliWorker {
  id = 'codex';
  label = 'Codex CLI (ChatGPT login)';

  constructor(config, { preflight = preflightCodex } = {}) {
    this.config = resolveCodexConfig(config);
    this.preflightFn = preflight;
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

  async execute(task, ctx) {
    const config = this.config;
    const preflight = await this.preflight();
    const attempt = task.attempts;
    const attemptDir = `attempt-${attempt}`;
    const workspace = ctx.workspace;
    const prompt = buildWorkerPrompt(task, ctx);
    const outputSchema = ctx.outputSchema || CODEX_OUTPUT_SCHEMA;
    const schemaPath = workspace.write(`${attemptDir}/output-schema.json`, outputSchema);
    workspace.write(`${attemptDir}/prompt.md`, prompt);
    const lastMessagePath = join(workspace.dir, attemptDir, 'last-message.json');
    const args = buildCodexArgs(config, { cwd: workspace.dir, lastMessagePath, schemaPath });
    const { env, stripped } = sanitizedChildEnv(process.env, config);

    const runtime = {
      runId: ctx.run.id,
      taskId: task.id,
      taskKey: task.key || null,
      attempt,
      spawned: false,
      injected: false,
      provider: 'codex',
      authPath: CODEX_AUTH_PATH,
      login: preflight.login,
      codexBin: preflight.codexBin,
      cliVersion: preflight.cliVersion,
      requested: { model: config.model, effort: config.effort, sandbox: 'read-only' },
      effective: null,
      verified: false,
      command: ['codex', ...args],
      strippedEnv: stripped,
      cwd: workspace.dir,
      threadId: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      usage: null,
      artifact: null,
      stdoutPath: `${attemptDir}/stdout.jsonl`,
      stderrPath: `${attemptDir}/stderr.txt`,
      error: null,
    };

    const errors = [];
    const result = await spawnCaptured(preflight.codexBin, args, {
      cwd: workspace.dir,
      env,
      input: prompt,
      timeoutMs: task.timeoutMs || config.timeoutMs,
      killGraceMs: config.killGraceMs,
      signal: ctx.signal,
      onSpawn: (child) => {
        runtime.spawned = true;
        runtime.pid = child.pid;
        ctx.recordWorkerProcess?.({ pid: child.pid, pgid: child.pid });
        ctx.emit?.('worker.spawned', { pid: child.pid, model: config.model, effort: config.effort, sandbox: 'read-only' });
      },
      onStdoutLine: (line) => {
        ctx.heartbeat?.();
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'thread.started' && event.thread_id && !runtime.threadId) {
          runtime.threadId = event.thread_id;
          ctx.emit?.('worker.thread', { threadId: event.thread_id });
        } else if (event.type === 'turn.completed') {
          runtime.usage = event.usage || null;
        } else if (/error|failed/.test(String(event.type))) {
          const message = event.message || event.error?.message || event.error || JSON.stringify(event);
          errors.push(redactText(String(message)).slice(0, 2000));
        }
      },
    });

    runtime.startedAt = new Date(result.startedAt).toISOString();
    runtime.endedAt = new Date(result.endedAt).toISOString();
    runtime.durationMs = result.endedAt - result.startedAt;
    runtime.exitCode = result.exitCode;
    runtime.signal = result.signal;
    runtime.timedOut = result.timedOut;
    runtime.cancelled = result.cancelled;
    workspace.write(runtime.stdoutPath, redactText(result.stdout));
    workspace.write(runtime.stderrPath, redactText(result.stderr));
    ctx.emit?.('worker.exited', {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: runtime.durationMs,
      threadId: runtime.threadId,
    });

    const done = (fields) => {
      Object.assign(runtime, fields.runtime || {});
      runtime.error = fields.error || null;
      workspace.write(`${attemptDir}/runtime.json`, runtime);
      return { ...fields, runtime, artifacts: [...(fields.artifacts || []), `${attemptDir}/runtime.json`] };
    };

    if (result.spawnError) {
      return done({ status: 'failed', retryable: false, fatal: true, error: `Could not start codex: ${result.spawnError}` });
    }

    if (runtime.threadId) {
      const session = await readSessionWithRetry({ codexHome: codexHomeDir(config), threadId: runtime.threadId, startedAt: result.startedAt });
      runtime.effective = {
        model: session.models?.join(',') || null,
        effort: session.efforts?.join(',') || null,
        modelProvider: session.modelProvider ?? null,
        source: session.source ?? null,
        sandbox: session.sandboxes?.join(',') || null,
        approvalPolicy: session.approvalPolicies?.join(',') || null,
        planType: session.planType ?? null,
        usedPercent: session.usedPercent ?? null,
        cliVersion: session.cliVersion ?? null,
        sessionFound: Boolean(session.found),
      };
      const verdict = verifySession(session, config);
      runtime.verified = verdict.ok;
      if (runtime.verified && runtime.usage == null) {
        // A verified invocation may fail before emitting turn.completed. Keep
        // that absence explicit so lead planning reports the real Codex
        // failure instead of misclassifying it as an unverified receipt.
        runtime.usageUnavailable = true;
      }
      ctx.emit?.(verdict.mismatch.length ? 'worker.substitution_detected' : verdict.ok ? 'worker.verified' : 'worker.unverified', {
        threadId: runtime.threadId,
        requested: runtime.requested,
        effective: runtime.effective,
        problems: verdict.problems,
      });
      const producedOutput = result.exitCode === 0 && !result.timedOut && !result.cancelled;
      if (verdict.mismatch.length || (producedOutput && !verdict.ok)) {
        return done({
          status: 'failed',
          retryable: false,
          fatal: true,
          error: `Live worker could not be verified as ${config.model}/${config.effort}: ${verdict.problems.join('; ')}`,
        });
      }
    }

    if (result.cancelled) return done({ status: 'cancelled', error: 'Cancelled by operator' });
    if (result.timedOut) {
      return done({ status: 'failed', retryable: true, error: `codex exec timed out after ${task.timeoutMs || config.timeoutMs}ms` });
    }
    if (result.exitCode !== 0) {
      const message = errors.at(-1) || redactText(result.stderr).trim().split('\n').slice(-5).join(' ') || `codex exited with ${result.exitCode}`;
      return done({ status: 'failed', ...classifyFailure(message), error: `codex exec failed (exit ${result.exitCode}, signal ${result.signal}): ${message}` });
    }
    if (!runtime.threadId) {
      return done({ status: 'failed', retryable: false, fatal: true, error: 'codex exec exited 0 without a thread id; the worker cannot be verified' });
    }

    let parsed;
    try {
      const raw = readFileSync(lastMessagePath, 'utf8');
      const clean = redactText(raw);
      if (clean !== raw) {
        workspace.write(`${attemptDir}/last-message.json`, clean);
        ctx.emit?.('worker.output_redacted', { file: `${attemptDir}/last-message.json` });
      }
      parsed = JSON.parse(clean);
    } catch (error) {
      return done({ status: 'failed', retryable: true, error: `Worker output was not valid JSON: ${error.message}` });
    }
    if (parsed.task_nonce !== task.nonce) {
      ctx.emit?.('isolation.violation', { reason: 'nonce_mismatch', expected: task.nonce, received: String(parsed.task_nonce).slice(0, 80) });
      return done({ status: 'failed', retryable: false, fatal: true, error: 'Worker output carried another task nonce; refusing cross-wired output' });
    }

    if (ctx.outputKind === 'lead') {
      let leadOutput;
      try {
        leadOutput = normalizeLeadPlanOutput(parsed, { expectedNonce: task.nonce });
      } catch (error) {
        return done({
          status: 'failed',
          retryable: false,
          fatal: false,
          code: error.code || 'lead_plan_invalid',
          error: error.message,
          details: error.details,
        });
      }
      runtime.artifact = 'artifact.json';
      workspace.write('artifact.json', { nonce: task.nonce, taskKey: task.key || null, attempt, threadId: runtime.threadId, output: leadOutput });
      return done({
        status: leadOutput.status,
        ...(leadOutput.questions.length ? { questions: leadOutput.questions } : {}),
        summary: leadOutput.summary.slice(0, 600) || `Proposed lead plan for ${task.title}`,
        result: leadOutput,
        artifacts: ['artifact.json', runtime.stdoutPath, runtime.stderrPath],
      });
    }

    const status = parsed.status || 'succeeded';
    if (!['succeeded', 'awaiting_user'].includes(status)) {
      return done({ status: 'failed', retryable: false, fatal: false, code: 'worker_output_invalid', error: `Worker output status must be succeeded or awaiting_user; got ${String(status)}` });
    }
    let questions = null;
    if (status === 'awaiting_user') {
      try {
        questions = validateTaskQuestions(parsed.questions);
      } catch (error) {
        return done({ status: 'failed', retryable: false, fatal: false, code: error.code || 'task_question_payload_invalid', error: error.message, details: error.details });
      }
    }
    let delegation = null;
    try {
      delegation = normalizeDelegationProposal(parsed.delegation, task);
    } catch (error) {
      return done({
        status: 'failed',
        retryable: false,
        fatal: false,
        code: error.code || 'delegation_invalid',
        error: error.message,
        details: error.details,
      });
    }
    const output = {
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
    };
    runtime.artifact = 'artifact.json';
    workspace.write('artifact.json', { nonce: task.nonce, taskKey: task.key || null, attempt, threadId: runtime.threadId, output });
    workspace.write('artifact.md', renderArtifact(task, output, runtime));
    return done({
      status,
      ...(questions ? { questions } : {}),
      summary: output.summary.slice(0, 600) || `Completed ${task.title}`,
      result: output,
      artifacts: ['artifact.json', 'artifact.md', runtime.stdoutPath, runtime.stderrPath],
    });
  }
}
