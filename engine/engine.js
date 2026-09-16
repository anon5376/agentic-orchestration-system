import { copyFileSync, existsSync, fstatSync, lstatSync, openSync, closeSync, readSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { JsonStore } from './store.js';
import { fingerprint, newId, nowIso } from './ids.js';
import { identifyAmbiguities, interpretGoal, questionsFromAmbiguities, validatePlan } from './intake.js';
import { claimWorkspace, createWorkerRegistry, IsolationError } from './workers.js';
import { applyExecutionToProviders, defaultProviders, publicProviderView, redactSecrets, refreshProviderSecrets } from './providers.js';
import { assertExternalHarnessTaskAdmission, assertOllamaTaskAdmission, assertProviderDispatchable } from './provider-contracts.js';
import { CODEX_AUTH_PATH, codexHomeDir, readSessionEvidence, redactText, resolveCodexConfig, verifySession } from './codex.js';
import { CLAUDE_AUTH_PATH, CLAUDE_SANDBOX, resolveClaudeConfig } from './claude.js';
import { resolveOllamaConfig } from './ollama.js';
import {
  EXTERNAL_HARNESS_ATTESTATION,
  EXTERNAL_HARNESS_PROTOCOL,
  EXTERNAL_HARNESS_SANDBOX,
  resolveExternalHarnessConfig,
} from './external-harness.js';
import { notFound, validateTaskQuestions } from './schema.js';
import { PresetRegistry } from './presets/registry.js';
import { TemplateRegistry, applyTemplateToTask, PRESET_FOR_KIND } from './templates.js';
import { BlueprintRegistry } from './blueprints.js';
import { MANAGER_ROLE_TASK_LIMIT, roleRuntimeFor, roleRuntimePolicyView } from './role-runtime.js';
import { MemoryService } from './memory/index.js';
import { SettingsRegistry } from './settings.js';
import { ModelControlService } from './model-control.js';
import { PlanService } from './plans.js';
import { normalizeDelegationProposal } from './delegation.js';
import { LeadPlanningService, leadPlanFingerprint, validateLeadAnswerEntries } from './lead-planning.js';
import {
  assertMcpTaskAdmission,
  assertTaskWorkspaceWriteAdmission,
  BUILTIN_MCP_STAGED_TEXT_RUNTIME,
  CapabilityRegistry,
  isTaskWorkspaceWriteRequested,
  MCP_INPUT_SELECTOR,
  MCP_MAX_TIMEOUT_MS,
} from './capabilities.js';
import { CapabilityRuntime } from './capability-runtime.js';
import { EffectClaimService } from './effect-claims.js';
import {
  buildTaskWorkspaceWriteIdentity,
  taskWorkspaceWriteBytes,
  TaskWorkspaceWriteAdapter,
  TASK_WORKSPACE_WRITE_JOURNAL_DIR,
} from './task-workspace-write.js';
import { ResourceGovernor, ResourceGovernorError } from './resources.js';
import { HarnessSessionRegistry } from './sessions.js';
import { ImprovementService, IMPROVABLE_POLICY_KEYS } from './improvements.js';
import { AosError, invalid } from './schema.js';

export const TASK_STATUS = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  awaiting_user: 'awaiting_user',
  awaiting_approval: 'awaiting_approval',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'blocked',
};

export const RUN_STATUS = {
  planning: 'planning',
  running: 'running',
  paused: 'paused',
  awaiting_user: 'awaiting_user',
  awaiting_approval: 'awaiting_approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const TERMINAL = new Set([TASK_STATUS.succeeded, TASK_STATUS.failed, TASK_STATUS.cancelled, TASK_STATUS.blocked]);
const NOT_DISPATCHABLE = new Set([RUN_STATUS.paused, RUN_STATUS.awaiting_user, RUN_STATUS.awaiting_approval, RUN_STATUS.cancelled, RUN_STATUS.failed, RUN_STATUS.completed]);

const ALLOWED_POLICY_KEYS = new Set(IMPROVABLE_POLICY_KEYS);

// Attempt leases: a running task carries the driver that owns it and an expiry. Another
// process may take the task over only when the lease is missing, expired, or its driver is dead.
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const LEASE_GRACE_MS = 60_000;
const HEARTBEAT_MIN_MS = 5_000;
const REAP_KILL_GRACE_MS = 5_000;
const POOL_ID_MAX_CHARS = 128;
const POOL_RESULT_MAX_BYTES = 128 * 1024;
const POOL_RESULT_MAX_DEPTH = 8;
const POOL_RESULT_MAX_ENTRIES = 100;
const POOL_RESULT_MAX_STRING_CHARS = 8_000;
const MCP_MAX_SOURCE_BYTES = 64 * 1024;
const MCP_STAGING_NAME = 'mcp-staged-input.txt';
const MCP_SENSITIVE_NAME = /(^|[._-])(env|secret|secrets|credential|credentials|token|password|passwd|api[_-]?key|private[_-]?key|id[_-]?(rsa|dsa|ecdsa|ed25519)|authorized[_-]?keys)([._-]|$)/i;
const MCP_SENSITIVE_CONTENT = /(api[_-]?key|secret|password|passwd|authorization\s*:\s*bearer|-----begin[^\n]{0,80}private\s+key-----)/i;

export function resolveExecution(input) {
  if (!input || input === 'local' || input.mode === 'local') {
    // Keep the legacy persisted/runtime shape stable. Provider-indexed details
    // are introduced only for the mixed mode below.
    return Object.freeze({ mode: 'local' });
  }
  if (input === 'codex' || input.mode === 'codex') {
    const codex = resolveCodexConfig(input?.codex || {});
    return Object.freeze({ mode: 'codex', codex });
  }
  if (input === 'claude' || input.mode === 'claude') {
    const claude = resolveClaudeConfig(input?.claude || {});
    return freezeExecution({ mode: 'mixed', claude, adapters: { claude: { enabled: true, ...claude } } });
  }
  if (!input || typeof input !== 'object' || (!['mixed', 'providers'].includes(input.mode) && !input.adapters && !input.providers)) {
    throw new Error(`Unknown execution mode: ${input?.mode}`);
  }
  const raw = input.adapters || input.providers || {};
  const adapters = {};
  for (const [id, value] of Object.entries(Array.isArray(raw) ? Object.fromEntries(raw.map((item) => [item, { enabled: true }])) : raw)) {
    if (value === false || value == null) {
      adapters[id] = { enabled: false };
      continue;
    }
    adapters[id] = typeof value === 'object' && value.enabled === false ? { enabled: false } : typeof value === 'object' ? { ...value } : { enabled: Boolean(value) };
  }
  if (input.local && adapters.local === undefined) adapters.local = { enabled: Boolean(input.local) };
  if (input.codex && adapters.codex === undefined) adapters.codex = { enabled: true, ...input.codex };
  if (input.claude && adapters.claude === undefined) adapters.claude = { enabled: true, ...input.claude };
  if (input.ollama && adapters.ollama === undefined) adapters.ollama = { enabled: true, ...input.ollama };
  if (input.command && adapters.command === undefined) adapters.command = { enabled: true, ...input.command };
  const codexEntry = adapters.codex?.enabled === false ? null : adapters.codex;
  const claudeEntry = adapters.claude?.enabled === false ? null : adapters.claude;
  const ollamaEntry = adapters.ollama?.enabled === false ? null : adapters.ollama;
  const commandEntry = adapters.command?.enabled === false ? null : adapters.command;
  const codex = codexEntry ? resolveCodexConfig(codexEntry.config || codexEntry) : null;
  const claude = claudeEntry ? resolveClaudeConfig(claudeEntry.config || claudeEntry) : null;
  const ollama = ollamaEntry ? resolveOllamaConfig(ollamaEntry.config || ollamaEntry) : null;
  const command = commandEntry ? resolveCommandAdapterConfig(commandEntry) : null;
  if (codex) adapters.codex = { enabled: true, ...codex };
  if (claude) adapters.claude = { enabled: true, ...claude };
  if (ollama) adapters.ollama = { enabled: true, ...ollama };
  if (command) adapters.command = { enabled: true, ...command };
  if (!Object.keys(adapters).length) adapters.local = { enabled: true };
  return freezeExecution({ mode: 'mixed', adapters, ...(codex ? { codex } : {}), ...(claude ? { claude } : {}), ...(ollama ? { ollama } : {}), ...(command ? { command } : {}) });
}

function resolveCommandAdapterConfig(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return resolveExternalHarnessConfig(entry);
  if (!Object.prototype.hasOwnProperty.call(entry, 'config')) return resolveExternalHarnessConfig(entry);
  const nested = entry.config;
  const extras = Object.keys(entry).filter((key) => !['enabled', 'config'].includes(key));
  if (!extras.length) return resolveExternalHarnessConfig(nested);
  // Route any unexpected envelope fields through the same secret-aware config
  // validator rather than silently ignoring a token or a second command source.
  return resolveExternalHarnessConfig({ ...(nested && typeof nested === 'object' ? nested : {}), ...Object.fromEntries(extras.map((key) => [key, entry[key]])) });
}

function freezeExecution(value) {
  const adapters = Object.fromEntries(Object.entries(value.adapters || {}).map(([id, config]) => [id, Object.freeze({ ...config })]));
  return Object.freeze({ ...value, adapters: Object.freeze(adapters) });
}

function executionAdapterConfig(execution, providerId) {
  if (!execution) return null;
  if (providerId === 'codex' && execution.codex) return execution.codex;
  if (providerId === 'claude' && execution.claude) return execution.claude;
  if (providerId === 'command' && execution.command) return execution.command;
  const entry = execution.adapters?.[providerId] || execution.providers?.[providerId];
  if (!entry || entry === false || entry.enabled === false) return null;
  return entry.config && typeof entry.config === 'object' ? entry.config : entry;
}

function resolveProjectReadRoot({ projectReadRoot, readRoot, repoRoot, execution }) {
  const explicit = projectReadRoot || readRoot || repoRoot;
  if (explicit) return resolve(explicit);
  const configured = executionAdapterConfig(execution, 'local')?.repoRoot
    || executionAdapterConfig(execution, 'codex')?.repoRoot
    || executionAdapterConfig(execution, 'claude')?.repoRoot
    || executionAdapterConfig(execution, 'ollama')?.repoRoot;
  return resolve(configured || process.cwd());
}

function providerProfile(execution, providerId, task = null) {
  const config = executionAdapterConfig(execution, providerId) || {};
  const roleRuntime = providerId === 'codex' && task?.roleRuntime?.requested
    ? task.roleRuntime.requested
    : null;
  const model = roleRuntime?.model || task?.model || config.model || (providerId === 'local' ? null : null);
  const effort = roleRuntime?.effort || task?.effort || config.effort || null;
  const sandbox = providerId === 'codex'
    ? 'read-only'
    : providerId === 'claude'
      ? CLAUDE_SANDBOX
      : providerId === 'ollama'
        ? 'loopback-only'
      : providerId === 'local'
        ? 'task-workspace'
        : providerId === 'command'
          ? EXTERNAL_HARNESS_SANDBOX
          : 'unknown';
  const authPathKind = ['codex', 'claude'].includes(providerId)
    ? 'external_cli_session'
    : providerId === 'command'
      ? config.authType || 'external_cli_session'
      : ['local', 'ollama'].includes(providerId) ? 'none' : 'unknown';
  const maxConcurrency = Number.isInteger(config.maxConcurrency) ? config.maxConcurrency : null;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : null;
  const profile = {
    provider: providerId,
    model,
    effort,
    sandbox,
    authPathKind,
    maxConcurrency,
    timeoutMs,
  };
  return Object.freeze({
    ...profile,
    fingerprint: fingerprint(JSON.stringify(profile)),
  });
}

export class AosEngine {
  constructor({ dataDir, clock = () => Date.now(), concurrency = 2, execution = null, memory = null, leadPlanner = null, projectReadRoot = null, readRoot = null, repoRoot = null } = {}) {
    if (!dataDir) throw new Error('dataDir is required');
    this.clock = clock;
    this.defaultConcurrency = concurrency;
    this.execution = resolveExecution(execution);
    this.projectReadRoot = resolveProjectReadRoot({ projectReadRoot, readRoot, repoRoot, execution: this.execution });
    this.providerReadiness = {};
    for (const id of ['codex', 'claude', 'ollama', 'command']) {
      const configured = this.execution.mode === id || this.execution.adapters?.[id]?.enabled === true;
      if (configured) this.providerReadiness[id] = { status: 'unverified', checkedAt: null };
    }
    this.store = new JsonStore({ dataDir, clock });
    this.workers = createWorkerRegistry({ codex: this.execution.codex || null, claude: this.execution.claude || null, ollama: this.execution.ollama || null, command: this.execution.command || null, adapters: this.execution.adapters || null });
    this.inflight = new Map();
    this.drivers = new Map();
    this.slotWaiters = [];
    this.transactionDepth = 0;
    this.driverId = `${process.pid}:${newId('driver')}`;
    this.presets = new PresetRegistry({ engine: this, clock });
    this.templates = new TemplateRegistry({ engine: this, clock });
    this.blueprints = new BlueprintRegistry({ engine: this, clock });
    this.memory = new MemoryService({ engine: this, clock, globalDir: memory?.globalDir ?? null });
    this.settings = new SettingsRegistry({ engine: this, clock });
    this.modelControl = new ModelControlService({ engine: this, clock });
    this.plans = new PlanService({ engine: this, clock });
    this.leadPlanning = new LeadPlanningService({ engine: this, clock, planner: leadPlanner });
    this.capabilities = new CapabilityRegistry({ engine: this, clock });
    this.capabilityRuntime = new CapabilityRuntime({ clock });
    this.effects = new EffectClaimService({ engine: this, clock });
    this.taskWorkspaceWrites = new TaskWorkspaceWriteAdapter({ effects: this.effects, clock });
    this.sessions = new HarnessSessionRegistry({ engine: this, clock });
    this.improvements = new ImprovementService({ engine: this, clock });
  }

  get state() {
    return this.store.state;
  }

  get live() {
    return this.execution.mode === 'codex' || this.execution.mode === 'mixed';
  }

  sync() {
    if (this.store.stale()) this.store.load();
    return this;
  }

  transact(fn) {
    if (this.transactionDepth > 0) return fn();
    const unlock = this.store.lock();
    try {
      // Every mutation re-resolves runs, tasks and agents by id inside the transaction,
      // so reloading a store another process changed is safe even while a drive is active.
      this.sync();
      const stateCheckpoint = structuredClone(this.state);
      const durableStateCheckpoint = this.store.stateCheckpoint?.();
      const eventCheckpoint = this.store.eventCheckpoint?.();
      this.transactionDepth = 1;
      try {
        const result = fn();
        this.store.save();
        return result;
      } catch (error) {
        // Callback and save failures are one atomic operation: restore both the
        // in-memory graph and every event appended during the failed transaction.
        this.store.state = stateCheckpoint;
        try { this.store.rollbackEventLog?.(eventCheckpoint); } catch { /* preserve original failure */ }
        try { this.store.restoreStateCheckpoint?.(durableStateCheckpoint); } catch { /* preserve original failure */ }
        throw error;
      }
    } finally {
      this.transactionDepth = 0;
      unlock();
    }
  }

  // Only seeds an empty store. Read-only callers (CLI watchers) never rewrite state.
  load() {
    this.store.load();
    this.leadPlanning.recoverGenerating();
    // A write can reach the fixed target before its terminal receipt. Recover
    // that exact fenced attempt while its lease is still valid, before generic
    // expiry/orphan handling turns it into a new attempt.
    this.#recoverTaskWorkspaceWrites();
    this.effects.recoverExpired();
    // An exact post-byte attempt may have expired while the engine was down.
    // Reclaim its same approved identity before orphan recovery clears that
    // approval for a genuinely new attempt.
    this.#recoverTaskWorkspaceWrites({ reclaimRecoverable: true });
    let changed = false;
    if (!this.state.providers.length) {
      this.state.providers = defaultProviders();
      changed = true;
    } else {
      // Existing stores predate newer catalog entries. Add only missing
      // descriptors so an Ollama adapter can be inspected without rewriting
      // any operator-owned provider records.
      const known = new Set(this.state.providers.map((provider) => provider.id));
      for (const provider of defaultProviders()) {
        if (known.has(provider.id)) continue;
        this.state.providers.push(provider);
        known.add(provider.id);
        changed = true;
      }
    }
    if (!this.state.projects.length) {
      this.createProject({ name: 'Local research' });
      changed = true;
    }
    if (!this.state.policies.length) {
      this.#seedPolicies(this.state.projects[0].id);
      changed = true;
    }
    if (changed) this.store.save();
    this.recoverOrphans();
    this.memory.runRetention();
    this.sessions.runRetention();
    return this.snapshot();
  }

  save() {
    this.store.save();
  }

  now() {
    return nowIso(this.clock);
  }

  createProject({ name }) {
    return this.transact(() => {
      const project = {
        id: newId('project'),
        name: name || 'Untitled project',
        createdAt: this.now(),
        maxConcurrency: this.defaultConcurrency,
        maxRetries: 1,
        retentionDays: 30,
      };
      this.state.projects.push(project);
      this.#event('project.created', { projectId: project.id, payload: { name: project.name } });
      return project;
    });
  }

  defaultProject() {
    return this.state.projects[0];
  }

  createGoal({ projectId, prompt, contextPaths = [], plan = null }) {
    return this.transact(() => {
      const project = this.#require('projects', projectId || this.defaultProject()?.id, 'project');
      let interpreted;
      if (plan) {
        const ambiguities = identifyAmbiguities(prompt, contextPaths);
        interpreted = {
          prompt: String(prompt || '').trim(),
          contextPaths: [...contextPaths],
          ambiguities,
          questions: questionsFromAmbiguities(ambiguities),
          plan: validatePlan(plan),
        };
      } else {
        const enabledWorkers = ['codex', 'claude'].filter((id) => this.execution.mode === id || this.execution.adapters?.[id]?.enabled === true);
        const defaultExecution = this.execution.mode === 'codex'
          ? 'codex'
          : enabledWorkers[0] || 'local';
        interpreted = interpretGoal({ prompt, contextPaths, execution: defaultExecution });
      }
      const goal = {
        id: newId('goal'),
        projectId: project.id,
        createdAt: this.now(),
        updatedAt: this.now(),
        status: !plan && interpreted.questions.some((question) => question.required)
          ? 'awaiting_user'
          : 'planned',
        prompt: interpreted.prompt,
        contextPaths: interpreted.contextPaths,
        ambiguities: interpreted.ambiguities,
        questions: interpreted.questions,
        plan: interpreted.plan,
      };
      this.state.goals.push(goal);
      this.#event('goal.created', {
        projectId: project.id,
        payload: { goalId: goal.id, ambiguityCount: goal.ambiguities.length, taskCount: goal.plan.tasks.length },
      });
      this.#event('plan.created', {
        projectId: project.id,
        payload: { goalId: goal.id, title: goal.plan.title },
      });
      if (goal.status === 'awaiting_user') {
        this.#event('goal.awaiting_user', {
          projectId: project.id,
          payload: { goalId: goal.id, requiredQuestionIds: goal.questions.filter((question) => question.required).map((question) => question.id) },
        });
      }
      return goal;
    });
  }

  // Lead planning starts from a real goal shell. It must not run the deterministic
  // interpreter or seed a fallback plan before the operator accepts a proposal.
  createLeadGoalShell({ projectId, prompt, contextPaths = [] } = {}) {
    return this.transact(() => {
      const project = this.#require('projects', projectId || this.defaultProject()?.id, 'project');
      if (!Array.isArray(contextPaths) || contextPaths.some((path) => typeof path !== 'string')) {
        throw invalid('contextPaths must be an array of strings', { field: 'contextPaths' });
      }
      const normalizedPrompt = String(prompt || '').trim();
      if (!normalizedPrompt) throw invalid('prompt must be a non-empty string', { field: 'prompt' });
      const at = this.now();
      const goal = {
        id: newId('goal'),
        projectId: project.id,
        createdAt: at,
        updatedAt: at,
        status: 'planning',
        planningMode: 'lead',
        prompt: normalizedPrompt,
        contextPaths: [...contextPaths],
        ambiguities: [],
        questions: [],
        plan: null,
        leadPlan: null,
        planProvenance: null,
      };
      this.state.goals.push(goal);
      this.#event('goal.created', {
        projectId: project.id,
        payload: { goalId: goal.id, ambiguityCount: 0, taskCount: 0, planningMode: 'lead' },
      });
      return goal;
    });
  }

  answerQuestions(goalId, answers = []) {
    return this.transact(() => {
      const goal = this.#require('goals', goalId, 'goal');
      const lead = goal.planningMode === 'lead';
      if (lead) {
        const proposal = goal.leadPlan?.id ? this.state.leadPlans.find((item) => item.id === goal.leadPlan.id) : null;
        if (!proposal || proposal.status !== 'needs_clarification' || goal.leadPlan?.status !== proposal.status || goal.status !== 'awaiting_user') {
          throw new AosError('lead_plan_questions_unavailable', `Goal ${goal.id} is not awaiting answers for an active clarification proposal`, { statusCode: 409, details: { goalId, proposalId: goal.leadPlan?.id || null, status: goal.status, proposalStatus: proposal?.status || null } });
        }
        answers = validateLeadAnswerEntries(answers, { goalId, questions: goal.questions });
      }
      const known = new Set(goal.questions.map((question) => question.id));
      for (const answer of answers) {
        if (!known.has(answer.id)) throw new Error(`Unknown question for goal ${goal.id}: ${answer.id}`);
      }
      const byId = new Map(answers.map((item) => [item.id, item.answer]));
      const previousStatus = goal.status;
      goal.questions = goal.questions.map((question) => ({
        ...question,
        answer: byId.has(question.id) ? String(byId.get(question.id) ?? '').trim() : question.answer,
      }));
      const remaining = goal.questions.filter((question) => question.required && !String(question.answer || '').trim());
      goal.status = remaining.length ? 'awaiting_user' : lead ? 'lead_revision_ready' : 'planned';
      goal.updatedAt = this.now();
      this.#event('goal.questions_answered', {
        projectId: goal.projectId,
        payload: { goalId, answeredQuestionIds: [...byId.keys()], remainingRequired: remaining.length },
      });
      if (lead && !remaining.length) {
        this.#event('lead_revision_ready', { projectId: goal.projectId, payload: { goalId, derivedFromProposalId: goal.leadPlan?.id || null } });
      } else if (!lead && previousStatus === 'awaiting_user' && goal.status === 'planned') {
        this.#event('goal.ready', { projectId: goal.projectId, payload: { goalId } });
      }
      return goal;
    });
  }

  startRun({ goalId, projectId, maxConcurrency, blueprintId = null, blueprintVersion = null } = {}) {
    return this.transact(() => {
    const goal = this.#require('goals', goalId, 'goal');
    const hasPlan = Boolean(goal.plan && typeof goal.plan === 'object' && Array.isArray(goal.plan.tasks) && goal.plan.tasks.length);
    if (goal.planningMode === 'lead') {
      const proposal = goal.leadPlan?.id ? this.state.leadPlans.find((item) => item.id === goal.leadPlan.id) : null;
      const provenance = goal.planProvenance;
      const runnable = goal.status === 'planned'
        && hasPlan
        && proposal?.status === 'accepted'
        && provenance?.source === 'lead'
        && provenance.proposalId === proposal.id
        && provenance.inputFingerprint === proposal.inputFingerprint
        && provenance.planFingerprint === proposal.planFingerprint
        && goal.leadPlan?.status === 'accepted'
        && goal.leadPlan?.planFingerprint === proposal.planFingerprint
        && leadPlanFingerprint(goal.plan) === proposal.planFingerprint;
      if (!runnable) {
        throw new AosError('goal_not_planned', `Goal ${goal.id} does not have an accepted, current lead plan`, { statusCode: 409, details: { goalId: goal.id, status: goal.status, proposalId: goal.leadPlan?.id || null, proposalStatus: proposal?.status || null } });
      }
    } else if (goal.status === 'awaiting_user') {
      const remaining = goal.questions.filter((question) => question.required && !String(question.answer || '').trim());
      const error = new Error(`Goal ${goal.id} is awaiting user input for ${remaining.length} required question${remaining.length === 1 ? '' : 's'}`);
      error.statusCode = 409;
      error.code = 'goal_awaiting_user';
      error.details = { goalId: goal.id, questionIds: remaining.map((question) => question.id) };
      throw error;
    } else if (goal.status !== 'planned' || !hasPlan) {
      throw new AosError('goal_not_planned', `Goal ${goal.id} is not ready to run`, { statusCode: 409, details: { goalId: goal.id, status: goal.status, hasPlan } });
    }
    const project = this.#require('projects', projectId || goal.projectId, 'project');
    const blueprint = blueprintId ? this.blueprints.get(blueprintId, blueprintVersion) : null;
    const settings = blueprint ? this.blueprints.runSettings(blueprint) : null;
    const plannedTasks = blueprint ? this.blueprints.applyToPlan(blueprint, goal.plan.tasks) : goal.plan.tasks;
    const requestedCap = maxConcurrency != null ? maxConcurrency : settings ? settings.maxConcurrency : project.maxConcurrency;
    const cap = this.#runConcurrency(requestedCap, maxConcurrency != null);
    if (this.live) this.#assertLivePlan({ ...goal.plan, tasks: plannedTasks });
    if (settings && settings.ceilings.tasks != null && plannedTasks.length > settings.ceilings.tasks) {
      throw new AosError('blueprint_ceiling', `Plan has ${plannedTasks.length} tasks; blueprint ${blueprint.id} allows ${settings.ceilings.tasks}`, { statusCode: 409, details: { blueprintId: blueprint.id, tasks: plannedTasks.length, ceiling: settings.ceilings.tasks } });
    }
    this.#validatePlannedTasks(goal, plannedTasks);
    this.assertManagerRoleTaskLimit(null, plannedTasks);
    const run = {
      id: newId('run'),
      projectId: project.id,
      goalId: goal.id,
      status: RUN_STATUS.running,
      createdAt: this.now(),
      updatedAt: this.now(),
      startedAt: this.now(),
      endedAt: null,
      objective: goal.prompt,
      maxConcurrency: cap,
      execution: this.executionSummary(),
      blueprint: settings?.blueprint ?? null,
      roleRuntimePolicy: roleRuntimePolicyView(),
      ceilings: settings?.ceilings ?? null,
      policies: settings ? { depth: settings.depth, perBranchConcurrency: settings.perBranchConcurrency, gates: settings.gates, failure: settings.failure, stop: settings.stop, memory: settings.memory, contextPartition: settings.contextPartition, messaging: settings.messaging, artifacts: settings.artifacts, routing: settings.routing, priority: settings.priority } : null,
    };
    const planVersion = this.plans.createInitial({
      run,
      goal,
      plan: { ...goal.plan, tasks: plannedTasks },
      blueprint,
    });
    run.plan = { id: planVersion.id, version: planVersion.version };
    this.state.runs.push(run);

    this.materializePlanTasks(run, plannedTasks, goal.plan.dependencies, planVersion.version);
    this.#event('run.started', {
      projectId: project.id,
      runId: run.id,
      payload: { goalId: goal.id, maxConcurrency: cap, execution: run.execution, taskCount: plannedTasks.length, blueprint: run.blueprint },
    });
    return run;
    });
  }

  // Shared instantiation path for initial plans and operator additions. The caller owns
  // the surrounding transaction; this method never rewrites an existing runtime task.
  materializePlanTasks(run, plannedTasks = [], dependencies = [], planVersion = run?.plan?.version ?? null) {
    this.assertManagerRoleTaskLimit(run, plannedTasks);
    const existing = this.state.tasks.filter((item) => item.runId === run.id);
    const idMap = new Map(existing.filter((item) => item.planTaskId).map((item) => [item.planTaskId, item.id]));
    const added = [];
    for (const planned of plannedTasks) {
      if (!planned?.id || idMap.has(planned.id)) {
        throw new AosError('plan_duplicate_task_id', `Plan task id ${planned?.id || '(missing)'} already exists`, { statusCode: 409, details: { taskId: planned?.id || null } });
      }
      const task = {
        ...structuredClone(planned),
        id: newId('task'),
        key: planned.key ?? null,
        runId: run.id,
        projectId: run.projectId,
        goalId: run.goalId,
        status: TASK_STATUS.pending,
        attempts: 0,
        agentId: null,
        workspace: null,
        lease: null,
        output: null,
        error: null,
        errorCode: null,
        questions: [],
        wait: null,
        blockedBy: null,
        startedAt: null,
        endedAt: null,
        planVersion,
        ...(run.execution?.mode === 'mixed'
          ? { providerProfile: run.execution.adapters?.[planned.worker || 'local']?.profile || providerProfile(this.execution, planned.worker || 'local') }
          : {}),
      };
      task.nonce = `aos-${fingerprint(`${run.id}|${task.id}|${planned.id}`)}`;
      task.planTaskId = planned.id;
      if (planned.templateId) {
        applyTemplateToTask(task, planned, this.templates.get(planned.templateId, planned.templateVersion ?? null));
      } else if (planned.presetId) {
        task.presetId = planned.presetId;
        task.presetVersion = planned.presetVersion ?? null;
      }
      if (task.worker === 'codex') this.#bindCodexRoleRuntime(task);
      if (run.execution?.mode === 'mixed') task.providerProfile = providerProfile(this.execution, task.worker || 'local', task);
      // applyTemplateToTask intentionally projects only known template fields;
      // restore this engine-derived ancestry marker after that projection so a
      // finite child cannot silently escape an unlimited ancestor's gate.
      if (planned.operatorPaced === true || planned.delegation?.operatorPaced === true) {
        task.operatorPaced = true;
        task.delegation = { ...(task.delegation || {}), operatorPaced: true };
      }
      this.#pinDelegationTemplateVersions(task);
      idMap.set(planned.id, task.id);
      this.state.tasks.push(task);
      const agent = {
        id: newId('agent'),
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        name: planned.title,
        role: task.roleRuntime?.role || planned.kind,
        provider: planned.worker || 'local',
        status: 'queued',
        workspace: null,
      };
      this.state.agents.push(agent);
      task.agentId = agent.id;
      added.push({ task, planTaskId: planned.id, parentId: planned.parentId || null });
    }

    for (const item of added) {
      if (item.parentId) {
        const parentId = idMap.get(item.parentId);
        if (!parentId) throw new AosError('plan_unknown_parent', `Plan task ${item.planTaskId} has unknown parent ${item.parentId}`, { statusCode: 409, details: { taskId: item.planTaskId, parentId: item.parentId } });
        item.task.parentId = parentId;
      } else {
        item.task.parentId = null;
      }
    }

    const seenDependencies = new Set(this.state.dependencies.filter((item) => item.runId === run.id).map((item) => `${item.taskId}|${item.dependsOnTaskId}`));
    for (const dep of dependencies) {
      const taskId = idMap.get(dep.taskId);
      const dependsOnTaskId = idMap.get(dep.dependsOnTaskId);
      if (!taskId || !dependsOnTaskId) {
        throw new AosError('plan_unknown_dependency', `Dependency ${dep.taskId} -> ${dep.dependsOnTaskId} references an unknown task`, { statusCode: 409, details: { dependency: dep } });
      }
      const key = `${taskId}|${dependsOnTaskId}`;
      if (seenDependencies.has(key)) throw new AosError('plan_duplicate_dependency', `Dependency ${dep.taskId} -> ${dep.dependsOnTaskId} already exists`, { statusCode: 409, details: { dependency: dep } });
      seenDependencies.add(key);
      this.state.dependencies.push({ id: newId('dep'), runId: run.id, taskId, dependsOnTaskId });
    }
    this.#refreshReady(run.id);
    return added.map((item) => item.task);
  }

  // Public only for the plan service; worker/agent surfaces do not expose this method.
  validatePlanTasks(goal, plannedTasks = goal?.plan?.tasks || []) {
    this.#validatePlannedTasks(goal, plannedTasks);
    if (this.live) this.#assertLivePlan({ tasks: plannedTasks });
    return true;
  }

  // One driver per run. A second call while the run is being driven joins the first.
  advanceRun(runId, options = {}) {
    const existing = this.drivers.get(runId);
    if (existing) return existing;
    const driver = this.#drive(runId, options).finally(() => this.drivers.delete(runId));
    this.drivers.set(runId, driver);
    return driver;
  }

  // A pool worker receives one durable, fenced attempt at a time. The complete
  // claim preparation lives in this transaction so two engine processes cannot
  // reserve the same ready task or consume the same capacity slot.
  claimPoolTask({ worker, ownerId, requestId, runId = null, protocol = null, profileFingerprint = null } = {}) {
    const workerId = normalizePoolId(worker, 'worker');
    const owner = normalizePoolId(ownerId, 'ownerId');
    const request = normalizePoolId(requestId, 'requestId');
    const requestedRunId = runId == null ? null : normalizePoolId(runId, 'runId');
    const claimProtocol = normalizePoolProtocol(protocol);
    const requestedProfileFingerprint = normalizePoolProfileFingerprint(profileFingerprint, claimProtocol);
    if (claimProtocol) {
      const current = providerProfile(this.execution, workerId).fingerprint;
      if (requestedProfileFingerprint !== current) {
        throw new AosError('pool_claim_profile_mismatch', 'Pool runner provider profile does not match this engine', { statusCode: 409, details: { worker: workerId } });
      }
    }
    return this.transact(() => {
      const liveClaims = this.state.tasks.filter((task) => task.status === TASK_STATUS.running && task.lease?.executorKind === 'pool');
      const sameRequest = liveClaims.find((task) => task.lease.claimRequestId === request);
      if (sameRequest) {
        if (sameRequest.lease.ownerId !== owner || (sameRequest.worker || 'local') !== workerId
          || (sameRequest.lease.poolProtocol || null) !== claimProtocol
          || (requestedRunId && sameRequest.runId !== requestedRunId)) {
          throw new AosError('pool_claim_request_conflict', `Pool claim request ${request} is already bound to another live claim`, { statusCode: 409, details: { requestId: request } });
        }
        return this.#poolClaimResponse(this.#require('runs', sameRequest.runId, 'run'), sameRequest);
      }

      // Idempotency keys are never silently reused after the original lease was
      // settled or recovered. This prevents a late retry from claiming a new task.
      const prior = this.store.readEventLog().find((event) => event.type === 'task.claimed' && event.payload?.claimRequestId === request);
      if (prior) {
        throw new AosError('pool_claim_request_reused', `Pool claim request ${request} has already been consumed`, { statusCode: 409, details: { requestId: request, taskId: prior.taskId || null } });
      }

      const runs = requestedRunId
        ? [this.#require('runs', requestedRunId, 'run')]
        : [...this.state.runs];
      for (const run of runs) {
        if (NOT_DISPATCHABLE.has(run.status)) continue;
        this.#refreshReady(run.id);
        const task = this.#tasks(run.id).find((item) => item.status === TASK_STATUS.ready
          && (item.worker || 'local') === workerId
          && !isTaskWorkspaceWriteRequested(item)
          && this.#depsSatisfied(item)
          && (!claimProtocol || this.#providerAdapterPoolEligible(run, item, owner)));
        if (!task) continue;
        return this.#claimPoolTaskInTransaction(run, task, workerId, owner, request, { protocol: claimProtocol });
      }
      return null;
    });
  }

  heartbeatPoolClaim(claimId, { ownerId, attempt, workerPid = null, workerPgid = null } = {}) {
    const claim = normalizePoolId(claimId, 'claimId');
    const owner = normalizePoolId(ownerId, 'ownerId');
    const expectedAttempt = normalizePoolAttempt(attempt);
    const pid = normalizePoolPid(workerPid, 'workerPid');
    const pgid = normalizePoolPid(workerPgid, 'workerPgid');
    return this.transact(() => {
      const task = this.#requirePoolClaim(claim);
      this.#assertPoolFence(task, claim, owner, expectedAttempt);
      const lease = task.lease;
      const now = this.now();
      lease.heartbeatAt = now;
      lease.leaseUntil = new Date(this.clock() + lease.ttlMs).toISOString();
      // Null means that this heartbeat did not carry process metadata. Preserve
      // an earlier recorded pid/pgid rather than erasing recovery evidence.
      if (pid != null) lease.workerPid = pid;
      if (pgid != null) lease.workerPgid = pgid;
      return {
        claimId: claim,
        runId: task.runId,
        taskId: task.id,
        attempt: expectedAttempt,
        heartbeatAt: lease.heartbeatAt,
        leaseUntil: lease.leaseUntil,
        workerPid: lease.workerPid ?? null,
        workerPgid: lease.workerPgid ?? null,
      };
    });
  }

  completePoolClaim(claimId, { ownerId, attempt, result } = {}) {
    const claim = normalizePoolId(claimId, 'claimId');
    const owner = normalizePoolId(ownerId, 'ownerId');
    const expectedAttempt = normalizePoolAttempt(attempt);
    return this.transact(() => {
      const task = this.#requirePoolClaim(claim);
      this.#assertPoolFence(task, claim, owner, expectedAttempt);
      const run = this.#require('runs', task.runId, 'run');
      const agent = this.state.agents.find((item) => item.id === task.agentId);
      const worker = this.workers.get(task.worker || 'local') || { id: task.worker || 'local' };
      const revalidation = this.#revalidatePoolClaim(run, task, worker, agent);
      if (!revalidation.ok) {
        return this.#refusePoolCompletion(run, task, agent, claim, expectedAttempt, revalidation.error);
      }
      const normalized = normalizePoolResult(result, task);
      if (task.lease?.poolProtocol === 'provider-adapter-v1' && ['succeeded', 'awaiting_user'].includes(normalized.status)) {
        try {
          this.#validatePoolAdapterReceipt(task, normalized);
        } catch (error) {
          return this.#refusePoolCompletion(run, task, agent, claim, expectedAttempt, error);
        }
      }
      const workspace = claimWorkspace({
        root: this.store.workspacesDir,
        runId: run.id,
        taskId: task.id,
        agentId: agent?.id || owner,
        now: this.now(),
      });

      let sessionId = null;
      if (normalized.runtime?.threadId) {
        sessionId = this.sessions.capture({
          provider: normalized.runtime.provider || worker.id,
          harnessReference: normalized.runtime.threadId,
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          agentId: agent?.id || task.agentId,
          roleId: task.presetId || task.kind,
          attempt: expectedAttempt,
        }).id;
      }

      if (task.resourceReservationId) {
        const settled = this.#settleResource(run, task, normalized.status, normalized.runtime || null);
        if (settled) {
          this.#event('resource.settled', {
            projectId: run.projectId,
            runId: run.id,
            taskId: task.id,
            payload: { attempt: expectedAttempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed },
          });
        }
      }
      if (normalized.runtime) {
        task.runtime = [...(task.runtime || []), summarizeRuntime(normalized.runtime, { sessionId })];
      }
      if (sessionId) task.sessionId = sessionId;
      task.lease = null;

      if (normalized.status === TASK_STATUS.succeeded) {
        const delegation = this.#processDelegationResult(run, task, agent, worker, expectedAttempt, normalized);
        if (delegation?.status === 'rejected') {
          this.#failTask(run, task, agent, `Delegation proposal rejected (${delegation.errorCode || 'delegation_rejected'})`, {
            retryable: false,
            fatal: false,
            code: delegation.errorCode || 'delegation_rejected',
          });
        } else {
          const storedResult = poolStoredResult(normalized);
          task.status = TASK_STATUS.succeeded;
          task.output = {
            summary: normalized.summary,
            artifacts: normalized.artifacts || [],
            ...(storedResult !== undefined ? { result: storedResult } : {}),
          };
          task.endedAt = this.now();
          if (agent) agent.status = 'complete';
          if (storedResult !== undefined) this.#absorbResult(run, task, worker, workspace,
            normalized.result && typeof normalized.result === 'object' && !Array.isArray(normalized.result)
              ? normalized.result
              : normalized);
          this.#event('task.completed', {
            projectId: run.projectId,
            runId: run.id,
            taskId: task.id,
            payload: { summary: normalized.summary, attempt: expectedAttempt, key: task.key || null, executorKind: 'pool' },
          });
        }
      } else if (normalized.status === TASK_STATUS.awaiting_user) {
        const askedAt = this.now();
        const questions = normalized.questions.map((question) => ({
          id: newId('task').replace(/^tsk_/, 'q_'),
          prompt: question.prompt,
          ...(question.reason ? { reason: question.reason } : {}),
          required: true,
          answer: null,
          askedAt,
          askedBy: { worker: worker.id, agentId: agent?.id || null },
          attempt: expectedAttempt,
          answeredAt: null,
          answeredBy: null,
        }));
        task.status = TASK_STATUS.awaiting_user;
        task.questions = [...(Array.isArray(task.questions) ? task.questions : []), ...questions];
        task.wait = { code: 'operator_question', questionIds: questions.map((question) => question.id), attempt: expectedAttempt, at: askedAt };
        task.blockedBy = null;
        task.error = null;
        task.errorCode = null;
        task.endedAt = null;
        if (agent) agent.status = 'waiting_user';
        this.#event('task.awaiting_user', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          payload: { questionIds: questions.map((question) => question.id), questionCount: questions.length, attempt: expectedAttempt, executorKind: 'pool' },
        });
        if (run.status !== RUN_STATUS.paused && run.status !== RUN_STATUS.awaiting_user) {
          run.status = RUN_STATUS.awaiting_user;
          run.updatedAt = askedAt;
          this.#event('run.awaiting_user', {
            projectId: run.projectId,
            runId: run.id,
            payload: { taskId: task.id, questionIds: questions.map((question) => question.id), questionCount: questions.length },
          });
        }
      } else if (normalized.status === TASK_STATUS.cancelled) {
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        if (agent) agent.status = 'cancelled';
        this.#event('task.cancelled', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { reason: normalized.error || 'cancelled', attempt: expectedAttempt, executorKind: 'pool' } });
      } else {
        this.#failTask(run, task, agent, normalized.error || normalized.summary || 'Pool worker failed', {
          retryable: normalized.retryable !== false,
          fatal: Boolean(normalized.fatal),
          code: normalized.code || null,
        });
        if (normalized.fatal) this.#abortRun(run, normalized.error || normalized.summary || 'Pool worker failed', normalized.details || null);
      }

      this.#refreshReady(run.id);
      this.#settleRun(run);
      return {
        claimId: claim,
        runId: run.id,
        taskId: task.id,
        attempt: expectedAttempt,
        status: task.status,
      };
    });
  }

  pauseRun(runId) {
    return this.transact(() => {
    const run = this.#require('runs', runId, 'run');
    if (!TERMINAL.has(run.status) && run.status !== RUN_STATUS.cancelled) {
      run.status = RUN_STATUS.paused;
      run.updatedAt = this.now();
      this.#event('run.paused', { projectId: run.projectId, runId: run.id });
    }
    return run;
    });
  }

  resumeRun(runId) {
    return this.transact(() => {
    const run = this.#require('runs', runId, 'run');
    if (run.status === RUN_STATUS.paused) {
      const waitingUser = this.#tasks(run.id).some((task) => task.status === TASK_STATUS.awaiting_user);
      run.status = waitingUser ? RUN_STATUS.awaiting_user : RUN_STATUS.running;
      run.updatedAt = this.now();
      this.#refreshReady(run.id);
      this.#event('run.resumed', { projectId: run.projectId, runId: run.id });
    }
    return run;
    });
  }

  cancelRun(runId) {
    return this.transact(() => {
    const run = this.#require('runs', runId, 'run');
    for (const task of this.#tasks(run.id)) {
      if (!TERMINAL.has(task.status)) {
        this.#reconcileTaskWorkspaceWriteBeforeTerminal(run, task, 'run_cancelled');
        if (task.lease?.executorKind === 'pool') this.#reap(run, task);
        if (task.resourceReservationId) this.#settleResource(run, task, 'cancelled');
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        task.lease = null;
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        if (agent) agent.status = 'cancelled';
        this.inflight.get(task.id)?.controller.abort();
        this.#event('task.cancelled', { projectId: run.projectId, runId: run.id, taskId: task.id });
      }
    }
    run.status = RUN_STATUS.cancelled;
    run.endedAt = this.now();
    run.updatedAt = this.now();
    this.#event('run.cancelled', { projectId: run.projectId, runId: run.id });
    return run;
    });
  }

  cancelTask(taskId) {
    return this.transact(() => {
    const task = this.#require('tasks', taskId, 'task');
    if (!TERMINAL.has(task.status)) {
      const run = this.#require('runs', task.runId, 'run');
      this.#reconcileTaskWorkspaceWriteBeforeTerminal(run, task, 'task_cancelled');
      if (task.lease?.executorKind === 'pool') this.#reap(run, task);
      if (task.resourceReservationId) this.#settleResource(run, task, 'cancelled');
      task.status = TASK_STATUS.cancelled;
      task.endedAt = this.now();
      task.lease = null;
      this.inflight.get(task.id)?.controller.abort();
      this.#event('task.cancelled', { projectId: task.projectId, runId: task.runId, taskId: task.id });
      this.#refreshReady(task.runId);
      this.#settleRun(run);
    }
    return task;
    });
  }

  approveTask(taskId) {
    return this.transact(() => {
    const task = this.#require('tasks', taskId, 'task');
    if (isTaskWorkspaceWriteRequested(task)) {
      throw new AosError('workspace_write_exact_approval_required', 'Task-workspace writes require an exact approval bound to the upcoming attempt', { statusCode: 409, details: { taskId } });
    }
    if (task.status !== TASK_STATUS.awaiting_approval) {
      throw new Error(`Task ${taskId} is not awaiting approval`);
    }
    task.status = TASK_STATUS.ready;
    this.#event('task.approved', { projectId: task.projectId, runId: task.runId, taskId: task.id });
    const run = this.#require('runs', task.runId, 'run');
    if (run.status === RUN_STATUS.awaiting_approval) run.status = RUN_STATUS.running;
    return task;
    });
  }

  // This is intentionally separate from approveTask(): a generic task gate
  // cannot prove the capability, bytes, workspace isolation and rollback plan
  // that this effect will use on its next attempt.
  approveTaskWorkspaceWrite(taskId, { requestId, actor = 'operator' } = {}) {
    return this.transact(() => {
      const task = this.#require('tasks', taskId, 'task');
      const previous = task.workspaceWriteApproval || null;
      const requestedActor = typeof actor === 'string' ? actor.trim() : actor ?? 'operator';
      const requestedId = typeof requestId === 'string' ? requestId.trim() : requestId;
      if (previous) {
        if (previous.requestId === requestedId && previous.actor === requestedActor) {
          return workspaceWriteApprovalView(previous);
        }
        throw new AosError('workspace_write_approval_conflict', 'Task-workspace write already has an approval for this attempt', {
          statusCode: 409,
          details: { taskId, attempt: previous.attempt },
        });
      }
      if (task.status !== TASK_STATUS.awaiting_approval) {
        throw new AosError('workspace_write_not_awaiting_approval', `Task ${taskId} is not awaiting a workspace-write approval`, {
          statusCode: 409,
          details: { taskId, status: task.status },
        });
      }
      const run = this.#require('runs', task.runId, 'run');
      if (run.status === RUN_STATUS.cancelled || run.status === RUN_STATUS.failed || run.status === RUN_STATUS.completed) {
        throw new AosError('workspace_write_run_terminal', 'Task-workspace write cannot be approved on a terminal run', { statusCode: 409, details: { runId: run.id, status: run.status } });
      }
      const agent = this.state.agents.find((item) => item.id === task.agentId);
      const attempt = task.attempts + 1;
      const mounted = this.capabilities.resolveTask(task, {
        projectId: run.projectId,
        roleId: task.presetId || task.kind,
        workerId: agent?.id || null,
        runId: run.id,
      });
      assertTaskWorkspaceWriteAdmission(task, mounted);
      const identity = buildTaskWorkspaceWriteIdentity({
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        attempt,
        capabilityReference: mounted[0].reference,
        capabilityFingerprint: mounted[0].fingerprint,
      });
      const approval = this.effects.approve({ ...identity, requestId: requestedId, actor: requestedActor });
      const record = {
        approvalId: approval.id,
        requestId: approval.requestId,
        actor: approval.actor,
        attempt,
        actionFingerprint: approval.actionFingerprint,
        capabilityReference: identity.capabilityReference,
        capabilityFingerprint: identity.capabilityFingerprint,
        inputFingerprint: identity.inputFingerprint,
        isolationFingerprint: identity.isolationFingerprint,
        rollbackPlanFingerprint: identity.rollbackPlanFingerprint,
      };
      task.workspaceWriteApproval = record;
      task.capabilityMounts = mounted;
      task.status = TASK_STATUS.ready;
      task.error = null;
      task.errorCode = null;
      if (agent) agent.status = 'queued';
      if (run.status === RUN_STATUS.awaiting_approval) run.status = RUN_STATUS.running;
      this.#event('task.workspace_write_approved', {
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        actor: approval.actor,
        payload: {
          approvalId: approval.id,
          actionFingerprint: approval.actionFingerprint,
          capabilityReference: identity.capabilityReference,
          attempt,
        },
      });
      this.#event('task.approved', { projectId: task.projectId, runId: task.runId, taskId: task.id, actor: approval.actor });
      return workspaceWriteApprovalView(record);
    });
  }

  rollbackTaskWorkspaceWrite(claimId, { requestId, actor = 'operator' } = {}) {
    this.sync();
    const claim = this.effects.get(claimId);
    const task = this.#require('tasks', claim.identity.taskId, 'task');
    const run = this.#require('runs', claim.identity.runId, 'run');
    if (task.runId !== run.id || task.projectId !== run.projectId
      || claim.identity.projectId !== run.projectId || claim.identity.runId !== run.id || claim.identity.taskId !== task.id
      || !isTaskWorkspaceWriteRequested(task)) {
      throw new AosError('workspace_write_claim_scope_invalid', 'Effect claim is not a task-workspace write', { statusCode: 409, details: { claimId } });
    }
    const revalidateRollback = (activeClaim = claim) => this.#revalidateTaskWorkspaceWriteRollback({
      runId: run.id,
      taskId: task.id,
      claim: activeClaim,
    });
    revalidateRollback(claim);
    return this.taskWorkspaceWrites.rollback({
      claim,
      workspaceRoot: this.store.workspacesDir,
      workspaceDir: this.store.workspacePath(run.id, task.id),
      journalRoot: join(this.store.dataDir, TASK_WORKSPACE_WRITE_JOURNAL_DIR),
      requestId,
      actor,
      revalidate: revalidateRollback,
    });
  }

  listDelegationExpansions(runId) {
    this.#require('runs', runId, 'run');
    const receipts = Array.isArray(this.state.delegationReceipts) ? this.state.delegationReceipts : [];
    return structuredClone(receipts.filter((item) => item.runId === runId));
  }

  decideDelegationExpansion({ receiptId, decision, requestId } = {}) {
    const action = normalizeDelegationDecision(decision);
    const request = normalizeDelegationRequestId(requestId);
    return this.transact(() => {
      const receipts = this.#delegationReceipts();
      const receipt = receipts.find((item) => item.id === receiptId);
      if (!receipt) throw notFound('delegation expansion', receiptId);
      const run = this.#require('runs', receipt.runId, 'run');

      if (receipt.status !== 'awaiting_approval') {
        if (receipt.requestId === request && receipt.requestedDecision === action) return structuredClone(receipt);
        if (receipt.requestId === request) {
          throw new AosError('delegation_decision_conflict', `Delegation expansion ${receipt.id} already received a different decision for request ${request}`, { statusCode: 409, details: { receiptId: receipt.id, requestId: request } });
        }
        throw new AosError('delegation_already_decided', `Delegation expansion ${receipt.id} has already been decided`, { statusCode: 409, details: { receiptId: receipt.id, status: receipt.status } });
      }
      if (receipt.requestId && receipt.requestId !== request) {
        throw new AosError('delegation_decision_conflict', `Delegation expansion ${receipt.id} is already claimed by request ${receipt.requestId}`, { statusCode: 409, details: { receiptId: receipt.id, requestId: request } });
      }

      receipt.requestId = request;
      receipt.requestedDecision = action;
      receipt.decidedBy = 'operator';
      receipt.decidedAt = this.now();

      if (action === 'reject') {
        receipt.status = 'rejected';
        receipt.decision = 'reject';
        receipt.errorCode = null;
        this.#event('delegation.rejected', {
          projectId: run.projectId,
          runId: run.id,
          taskId: receipt.taskId,
          actor: 'operator',
          payload: { receiptId: receipt.id, patchId: receipt.patchId, baseVersion: receipt.baseVersion, decision: 'reject' },
        });
        this.#restoreDelegationRun(run);
        return structuredClone(receipt);
      }

      try {
        const patch = this.#revalidateDelegationReceipt(run, receipt);
        const patched = this.plans.patch(run.id, patch, {
          actor: 'operator',
          source: 'delegation',
          allowAwaitingApproval: true,
        });
        receipt.status = 'accepted';
        receipt.decision = 'approve';
        receipt.errorCode = null;
        receipt.planId = patched.plan.id;
        receipt.planVersion = patched.plan.version;
        this.#event('delegation.accepted', {
          projectId: run.projectId,
          runId: run.id,
          taskId: receipt.taskId,
          actor: 'operator',
          payload: { receiptId: receipt.id, patchId: receipt.patchId, baseVersion: receipt.baseVersion, version: patched.plan.version, childCount: receipt.childCount, decision: 'approve' },
        });
        this.#restoreDelegationRun(run);
        return structuredClone(receipt);
      } catch (error) {
        receipt.status = 'stale';
        receipt.decision = 'stale';
        receipt.errorCode = 'delegation_stale';
        this.#event('delegation.stale', {
          projectId: run.projectId,
          runId: run.id,
          taskId: receipt.taskId,
          actor: 'operator',
          payload: { receiptId: receipt.id, patchId: receipt.patchId, baseVersion: receipt.baseVersion, code: safeDelegationCode(error?.code, 'delegation_stale') },
        });
        this.#restoreDelegationRun(run);
        return structuredClone(receipt);
      }
    });
  }

  // Records operator answers without changing the task brief or immutable plan.
  // Validation runs before any question is changed so mixed valid/invalid input is
  // one atomic failure. Repeating an already-recorded answer is intentionally a no-op.
  answerTaskQuestions(taskId, answers = []) {
    return this.transact(() => {
      const task = this.#require('tasks', taskId, 'task');
      if (!Array.isArray(answers) || !answers.length) {
        throw new AosError('task_answer_invalid', 'answers must be a non-empty array', { statusCode: 400, details: { field: 'answers' } });
      }

      const provided = [];
      const seen = new Set();
      for (const item of answers) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.answer !== 'string') {
          throw new AosError('task_answer_invalid', 'Each answer must include a question id and nonblank answer text', { statusCode: 400, details: { field: 'answers' } });
        }
        const id = item.id.trim();
        const answer = item.answer.trim();
        if (seen.has(id)) {
          throw new AosError('task_answer_invalid', `Question ${id} is answered more than once`, { statusCode: 400, details: { questionId: id } });
        }
        if (!answer || answer.length > 2000) {
          throw new AosError('task_answer_invalid', `Answer for question ${id} must be 1 to 2000 nonblank characters`, { statusCode: 400, details: { questionId: id, maxLength: 2000 } });
        }
        seen.add(id);
        provided.push({ id, answer });
      }

      const questions = Array.isArray(task.questions) ? task.questions : [];
      const byId = new Map(questions.map((question) => [question.id, question]));
      for (const item of provided) {
        const question = byId.get(item.id);
        if (!question) {
          throw new AosError('task_question_not_found', `Unknown task question: ${item.id}`, { statusCode: 404, details: { taskId, questionId: item.id } });
        }
        const previous = typeof question.answer === 'string' ? question.answer.trim() : '';
        if (previous && previous !== item.answer) {
          throw new AosError('task_answer_conflict', `Question ${item.id} already has a different answer`, { statusCode: 409, details: { taskId, questionId: item.id } });
        }
      }

      // A retry after the task has resumed is idempotent when every supplied value
      // agrees with the persisted answer. A different value was rejected above.
      const alreadyAnswered = provided.every((item) => String(byId.get(item.id)?.answer || '').trim() === item.answer);
      if (task.status !== TASK_STATUS.awaiting_user) {
        if (alreadyAnswered && provided.length) return task;
        throw new AosError('task_not_awaiting_user', `Task ${taskId} is not awaiting user input`, { statusCode: 409, details: { taskId, status: task.status } });
      }
      if (alreadyAnswered) return task;

      const answeredAt = this.now();
      for (const item of provided) {
        const question = byId.get(item.id);
        question.answer = item.answer;
        question.answeredAt = question.answeredAt || answeredAt;
        question.answeredBy = question.answeredBy || 'operator';
      }
      const required = questions.filter((question) => question.required !== false);
      const remaining = required.filter((question) => !String(question.answer || '').trim());
      const complete = remaining.length === 0;
      task.updatedAt = answeredAt;
      if (complete) {
        task.status = TASK_STATUS.ready;
        task.wait = null;
        task.blockedBy = null;
        task.endedAt = null;
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        if (agent) agent.status = 'queued';
      } else {
        // Keep the original wait provenance stable while only the answer fields
        // change. In particular, do not expose answer text through the wait/event
        // metadata or turn it into a new wait attempt.
        task.wait ||= {
          code: 'operator_question',
          questionIds: questions.map((question) => question.id),
          attempt: questions[0]?.attempt ?? task.attempts,
          at: questions[0]?.askedAt ?? answeredAt,
        };
      }
      this.#event('task.questions_answered', {
        projectId: task.projectId,
        runId: task.runId,
        taskId: task.id,
        payload: { questionIds: provided.map((item) => item.id), answeredCount: provided.length, remainingCount: remaining.length },
      });

      const run = this.#require('runs', task.runId, 'run');
      if (complete) {
        this.#event('task.resumed', {
          projectId: task.projectId,
          runId: task.runId,
          taskId: task.id,
          payload: { questionIds: required.map((question) => question.id), answeredCount: required.length },
        });
        const anotherWait = this.#tasks(run.id).some((item) => item.id !== task.id && item.status === TASK_STATUS.awaiting_user);
        if (!anotherWait && run.status === RUN_STATUS.awaiting_user) {
          run.status = RUN_STATUS.running;
          run.updatedAt = this.now();
        }
        this.#refreshReady(run.id);
      }
      return task;
    });
  }

  approveProposal(proposalId) {
    return this.transact(() => {
    const proposal = this.#require('proposals', proposalId, 'proposal');
    if (proposal.status !== 'proposed') throw new Error(`Proposal ${proposalId} is not pending`);
    if (proposal.evaluationRequired === true) {
      this.improvements.assertPromotionReady(proposal, { project: this.#require('projects', proposal.projectId, 'project') });
    }
    proposal.status = 'approved';
    proposal.decidedAt = this.now();
    this.#event('proposal.approved', {
      projectId: proposal.projectId,
      runId: proposal.runId,
      payload: { proposalId, applied: false },
    });
    if (proposal.type === 'memory_promotion' || proposal.type === 'memory_clear') {
      this.memory.applyProposal(proposal, { actor: 'operator' });
      proposal.applied = true;
      this.#event('proposal.applied', { projectId: proposal.projectId, runId: proposal.runId, payload: { proposalId, type: proposal.type } });
    }
    const adopt = this.state.tasks.find(
      (task) => task.runId === proposal.runId && task.kind === 'adopt' && task.status === TASK_STATUS.awaiting_approval,
    );
    if (adopt) this.approveTask(adopt.id);
    return proposal;
    });
  }

  rejectProposal(proposalId, reason = 'Rejected by operator') {
    return this.transact(() => {
    const proposal = this.#require('proposals', proposalId, 'proposal');
    if (proposal.status !== 'proposed') throw new Error(`Proposal ${proposalId} is not pending`);
    proposal.status = 'rejected';
    proposal.decidedAt = this.now();
    proposal.rejectionReason = reason;
    this.#event('proposal.rejected', {
      projectId: proposal.projectId,
      runId: proposal.runId,
      payload: { proposalId, reason },
    });
    const adopt = this.state.tasks.find(
      (task) => task.runId === proposal.runId && task.kind === 'adopt' && task.status === TASK_STATUS.awaiting_approval,
    );
    if (adopt) this.cancelTask(adopt.id);
    return proposal;
    });
  }

  getGoal(id) {
    return this.#require('goals', id, 'goal');
  }

  planGoal(options = {}) {
    return this.leadPlanning.plan({ ...options, planningMode: 'lead' });
  }

  createLeadGoalProposal(input = {}) {
    return input.goalId
      ? this.leadPlanning.plan({ ...input, planningMode: 'lead' })
      : this.leadPlanning.createLeadGoal({ ...input, planningMode: 'lead' });
  }

  proposeLeadPlan(options = {}) {
    return this.leadPlanning.plan({ ...options, planningMode: 'lead' });
  }

  getLeadPlan(id) {
    return this.leadPlanning.get(id);
  }

  listLeadPlans(goalId = null, options = {}) {
    return this.leadPlanning.list(goalId, options);
  }

  answerLeadPlanQuestions(id, answers = []) {
    return this.leadPlanning.answerQuestions(id, answers);
  }

  approveLeadPlan(id, options = {}) {
    return this.leadPlanning.approve(id, options);
  }

  acceptLeadPlan(id, options = {}) {
    return this.leadPlanning.accept(id, options);
  }

  rejectLeadPlan(id, options = {}) {
    return this.leadPlanning.reject(id, options);
  }

  getRun(id) {
    return this.#require('runs', id, 'run');
  }

  getTask(id) {
    return this.#require('tasks', id, 'task');
  }

  getProposal(id) {
    return this.#require('proposals', id, 'proposal');
  }

  listRuns() {
    return [...this.state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listProposals(runId) {
    return this.state.proposals.filter((item) => !runId || item.runId === runId);
  }

  getDecision(runId) {
    return this.state.decisions.find((item) => item.runId === runId) || null;
  }

  getRetrospective(runId) {
    return this.state.retrospectives.find((item) => item.runId === runId) || null;
  }

  getRunTree(runId) {
    const run = this.#require('runs', runId, 'run');
    const tasks = this.#tasks(run.id);
    const deps = this.state.dependencies.filter((item) => item.runId === run.id);
    const byParent = new Map();
    for (const task of tasks) {
      const key = task.parentId || 'root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(task);
    }
    const decorate = (task) => ({
      ...task,
      dependsOn: deps.filter((dep) => dep.taskId === task.id).map((dep) => dep.dependsOnTaskId),
      children: (byParent.get(task.id) || []).map(decorate),
    });
    return {
      run,
      roots: (byParent.get('root') || []).map(decorate),
      tasks,
    };
  }

  getPublicRunTree(runId) {
    const tree = this.getRunTree(runId);
    return {
      run: tree.run,
      roots: tree.roots.map(publicTaskTreeNode),
      tasks: tree.tasks.map(publicTaskView),
    };
  }

  getPublicTask(id) {
    return publicTaskView(this.#require('tasks', id, 'task'));
  }

  executionSummary() {
    if (this.execution.mode === 'local') return { mode: 'local' };
    if (this.execution.mode === 'mixed') {
      const adapters = Object.fromEntries(Object.entries(this.execution.adapters || {}).map(([id, value]) => [id, {
        enabled: value.enabled !== false,
        ...(value.model ? { model: value.model } : {}),
        ...(value.effort ? { effort: value.effort } : {}),
        ...(value.maxConcurrency != null ? { maxConcurrency: value.maxConcurrency } : {}),
        ...(id === 'ollama' && value.timeoutMs != null ? { timeoutMs: value.timeoutMs } : {}),
        ...(id === 'ollama' && value.baseUrl ? { baseUrl: value.baseUrl } : {}),
        profile: providerProfile(this.execution, id),
      }]));
      return { mode: 'mixed', adapters };
    }
    const { model, effort, maxConcurrency, timeoutMs } = this.execution.codex;
    return { mode: 'codex', provider: 'codex', authPath: CODEX_AUTH_PATH, model, effort, sandbox: 'read-only', maxConcurrency, timeoutMs };
  }

  runtimeTelemetry(runId, allEvents = this.store.readEventLog()) {
    const run = this.#require('runs', runId, 'run');
    const tasks = this.#tasks(run.id);
    const events = allEvents.filter((event) => event.runId === run.id);
    const dependencies = this.state.dependencies.filter((item) => item.runId === run.id);
    const agents = new Map(this.state.agents.filter((item) => item.runId === run.id).map((item) => [item.taskId, item]));
    const workers = tasks.map((task) => buildWorkerTelemetry({ store: this.store, run, task, events, dependencies, agent: agents.get(task.id), clock: this.clock }));
    const attempts = workers.flatMap((worker) => worker.runtime);
    const tokenTotals = attempts.reduce((total, runtime) => addUsage(total, runtime.usage), emptyUsage());
    const counts = tasks.reduce((total, task) => {
      total[task.status] = (total[task.status] || 0) + 1;
      return total;
    }, {});
    const latestEvent = events.at(-1) || null;
    const startedAt = Date.parse(run.startedAt || run.createdAt || '');
    const liveUntil = run.status === RUN_STATUS.running || run.status === RUN_STATUS.planning
      ? this.now()
      : latestEvent?.ts || run.updatedAt || run.createdAt;
    const endedAt = Date.parse(run.endedAt || liveUntil || '');

    return {
      runId: run.id,
      generatedAt: this.now(),
      status: run.status,
      counts,
      active: workers.filter((worker) => worker.status === TASK_STATUS.running).length,
      total: workers.length,
      cap: run.maxConcurrency ?? null,
      peakConcurrency: Math.max(0, ...events.filter((event) => event.type === 'worker.dispatched').map((event) => Number(event.payload?.running) || 0)),
      durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null,
      retries: {
        total: events.filter((event) => event.type === 'task.retried').length,
        injected: events.filter((event) => event.type === 'task.retried' && event.payload?.injected).length,
        organic: events.filter((event) => event.type === 'task.retried' && !event.payload?.injected).length,
      },
      tokens: tokenTotals,
      spawned: attempts.filter((runtime) => runtime.spawned).length,
      verified: attempts.filter((runtime) => runtime.spawned && runtime.verified).length,
      latestEvent: latestEvent
        ? { id: latestEvent.id, ts: latestEvent.ts, type: latestEvent.type, taskId: latestEvent.taskId }
        : null,
      workers,
    };
  }

  snapshot() {
    const run = this.listRuns()[0] || null;
    const tree = run ? this.getPublicRunTree(run.id) : { roots: [], tasks: [] };
    const project = this.defaultProject();
    const eventLog = this.store.readEventLog();
    return redactSecrets({
      generatedAt: this.now(),
      mode: 'live',
      execution: this.executionSummary(),
      eventCursor: this.state.eventCursor || 0,
      project,
      projects: this.state.projects,
      goals: this.state.goals,
      run,
      runs: this.listRuns(),
      tasks: run ? tree.tasks : [],
      taskTree: tree.roots,
      agents: this.state.agents.filter((item) => !run || item.runId === run.id),
      evidence: this.state.evidence.filter((item) => !run || item.runId === run.id),
      decision: run ? this.getDecision(run.id) : null,
      decisions: this.state.decisions,
      retrospective: run ? this.getRetrospective(run.id) : null,
      retrospectives: this.state.retrospectives,
      proposals: this.state.proposals,
      delegationReceipts: Array.isArray(this.state.delegationReceipts) ? this.state.delegationReceipts : [],
      improvementEvaluations: this.state.improvementEvaluations,
      genomeVersions: project ? this.improvements.listGenome({ projectId: project.id }) : [],
      leadPlans: this.state.leadPlans,
      policies: this.state.policies,
      providers: this.listProviders(),
      capabilities: this.capabilities.list({ includeRevoked: true }),
      harnessSessions: this.sessions.list(),
      telemetry: run ? this.runtimeTelemetry(run.id, eventLog) : null,
      events: eventLog.slice(-120),
      memory: (() => {
        const stats = this.memory.stats();
        return {
          ...stats,
          global: stats.scopes.global?.committed ?? 0,
          project: stats.scopes.project?.committed ?? 0,
          agent: (stats.scopes.agent?.committed ?? 0) + (stats.scopes.run?.committed ?? 0),
          retention: stats.policy.enabled ? `${stats.policy.retentionDays.project ?? 'unlimited'} days (project)` : 'memory disabled',
          inheritance: 'agent → run → role/swarm → project → global, promotion by policy',
        };
      })(),
    });
  }

  listProviders() {
    return applyExecutionToProviders(
      refreshProviderSecrets(this.state.providers),
      this.execution,
      this.providerReadiness,
    ).map((provider) => publicProviderView(provider, { execution: this.execution }));
  }

  // Run the mounted Codex adapter's public preflight and keep readiness truthful
  // for callers that inspect providers before a run is started. The result is
  // intentionally returned only to the caller; readiness remains in memory.
  async preflightCodex({ worker = null, config = null } = {}) {
    if (!this.execution.codex) throw new AosError('codex_preflight_unavailable', 'Codex preflight requires a configured Codex adapter', { statusCode: 409 });
    try {
      const expected = config ? resolveCodexConfig(config) : this.execution.codex;
      const adapter = worker || this.workers.get('codex');
      if (!adapter || typeof adapter.preflight !== 'function') {
        throw new AosError('codex_preflight_unavailable', 'The mounted Codex worker does not expose preflight', { statusCode: 409 });
      }
      const result = await adapter.preflight(expected);
      this.#validateCodexPreflight(result, expected);
      const checkedAt = result.checkedAt || new Date(this.clock()).toISOString();
      this.providerReadiness.codex = {
        status: 'available',
        checkedAt,
        model: result.model.slug,
        effort: result.requested.effort,
      };
      return result;
    } catch (error) {
      this.providerReadiness.codex = {
        status: 'unavailable',
        checkedAt: new Date(this.clock()).toISOString(),
      };
      throw error;
    }
  }

  #validateCodexPreflight(result, config = this.execution.codex) {
    const validObject = result && typeof result === 'object' && !Array.isArray(result);
    if (!validObject) {
      throw new AosError('codex_preflight_invalid', 'Codex preflight did not return a result object', { statusCode: 409 });
    }
    if (result.login !== 'Logged in using ChatGPT') {
      throw new AosError('codex_preflight_auth_invalid', 'Codex preflight did not verify a ChatGPT login', { statusCode: 409, details: { login: result.login || null } });
    }
    if (result.authPath !== CODEX_AUTH_PATH) {
      throw new AosError('codex_preflight_auth_invalid', 'Codex preflight reported an unsupported auth path', { statusCode: 409, details: { authPath: result.authPath || null, expected: CODEX_AUTH_PATH } });
    }
    if (result.requested?.model !== config.model || result.requested?.effort !== config.effort) {
      throw new AosError('codex_preflight_config_invalid', 'Codex preflight does not match the configured model and effort', {
        statusCode: 409,
        details: { requested: { model: result.requested?.model || null, effort: result.requested?.effort || null }, expected: { model: config.model, effort: config.effort } },
      });
    }
    if (result.model?.slug !== config.model || !Array.isArray(result.model?.efforts) || !result.model.efforts.includes(config.effort) || result.model.upgrade) {
      throw new AosError('codex_preflight_config_invalid', 'Codex preflight model catalog does not match the configured model and effort', {
        statusCode: 409,
        details: { model: result.model?.slug || null, efforts: result.model?.efforts || [], upgrade: result.model?.upgrade || null, expected: { model: config.model, effort: config.effort } },
      });
    }
  }

  async preflightClaude({ worker = null } = {}) {
    if (!this.execution.claude) throw new AosError('claude_preflight_unavailable', 'Claude preflight requires a configured Claude adapter', { statusCode: 409 });
    try {
      const adapter = worker || this.workers.get('claude');
      if (!adapter || typeof adapter.preflight !== 'function') {
        throw new AosError('claude_preflight_unavailable', 'The mounted Claude worker does not expose preflight', { statusCode: 409 });
      }
      const result = await adapter.preflight();
      this.#validateClaudePreflight(result);
      this.providerReadiness.claude = {
        status: 'available',
        checkedAt: result.checkedAt || new Date(this.clock()).toISOString(),
        model: result.requested.model,
        effort: result.requested.effort,
        sandbox: CLAUDE_SANDBOX,
      };
      return result;
    } catch (error) {
      this.providerReadiness.claude = { status: 'unavailable', checkedAt: new Date(this.clock()).toISOString() };
      throw error;
    }
  }

  #validateClaudePreflight(result) {
    const config = this.execution.claude;
    const validObject = result && typeof result === 'object' && !Array.isArray(result);
    if (!validObject) throw new AosError('claude_preflight_invalid', 'Claude preflight did not return a result object', { statusCode: 409 });
    if (result.auth?.loggedIn !== true || result.auth?.authMethod !== 'claude.ai') {
      throw new AosError('claude_preflight_auth_invalid', 'Claude preflight did not verify a claude.ai account session', { statusCode: 409, details: { auth: result.auth || null } });
    }
    if (result.authPath !== CLAUDE_AUTH_PATH) {
      throw new AosError('claude_preflight_auth_invalid', 'Claude preflight reported an unsupported auth path', { statusCode: 409, details: { authPath: result.authPath || null, expected: CLAUDE_AUTH_PATH } });
    }
    if (result.requested?.model !== config.model || result.requested?.effort !== config.effort) {
      throw new AosError('claude_preflight_config_invalid', 'Claude preflight does not match the configured model and effort', { statusCode: 409, details: { requested: result.requested || null, expected: { model: config.model, effort: config.effort } } });
    }
    const posture = result.posture || {};
    const exact = posture.restricted === true
      && posture.safeMode === true
      && posture.strictMcpConfig === true
      && posture.permissionMode === 'plan'
      && posture.permissionPrompts === 'none'
      && posture.chrome === false
      && Array.isArray(posture.tools)
      && posture.tools.join(',') === 'Read,Glob,Grep';
    if (result.requested?.sandbox !== CLAUDE_SANDBOX || !exact) {
      throw new AosError('claude_preflight_posture_invalid', 'Claude preflight did not attest the exact restricted read-only invocation posture', { statusCode: 409, details: { requested: result.requested || null, posture } });
    }
  }

  // Ollama has no account/session identity. Its preflight is therefore limited
  // to a loopback transport check and an observed model-list match; readiness
  // must never be inferred from configuration alone.
  async preflightOllama({ worker = null } = {}) {
    if (!this.execution.ollama) throw new AosError('ollama_preflight_unavailable', 'Ollama preflight requires explicit mixed-mode Ollama configuration', { statusCode: 409 });
    try {
      const adapter = worker || this.workers.get('ollama');
      if (!adapter || typeof adapter.preflight !== 'function') {
        throw new AosError('ollama_preflight_unavailable', 'The mounted Ollama worker does not expose preflight', { statusCode: 409 });
      }
      const result = await adapter.preflight();
      this.#validateOllamaPreflight(result);
      const checkedAt = result.checkedAt || new Date(this.clock()).toISOString();
      this.providerReadiness.ollama = {
        status: 'available',
        checkedAt,
        model: this.execution.ollama.model,
        sandbox: 'loopback-only',
      };
      return result;
    } catch (error) {
      this.providerReadiness.ollama = { status: 'unavailable', checkedAt: new Date(this.clock()).toISOString() };
      throw error;
    }
  }

  #validateOllamaPreflight(result) {
    const config = this.execution.ollama;
    const validObject = result && typeof result === 'object' && !Array.isArray(result);
    if (!validObject) throw new AosError('ollama_preflight_invalid', 'Ollama preflight did not return a result object', { statusCode: 409 });
    const requestedModel = result.requested?.model
      || (typeof result.model === 'string' ? result.model : result.model?.name || result.model?.model)
      || null;
    if (requestedModel !== config.model) {
      throw new AosError('ollama_preflight_config_invalid', 'Ollama preflight does not match the configured model', {
        statusCode: 409,
        details: { requested: requestedModel, expected: config.model },
      });
    }
    if (result.model !== config.model) {
      throw new AosError('ollama_preflight_config_invalid', 'Ollama preflight did not return the configured model', {
        statusCode: 409,
        details: { model: result.model || null, expected: config.model },
      });
    }
    if (result.provider !== 'ollama') {
      throw new AosError('ollama_preflight_provider_invalid', 'Ollama preflight returned another provider identity', { statusCode: 409, details: { provider: result.provider } });
    }
    if (result.baseUrl !== config.baseUrl) {
      throw new AosError('ollama_preflight_transport_invalid', 'Ollama preflight did not attest the configured loopback origin', { statusCode: 409, details: { baseUrl: result.baseUrl, expected: config.baseUrl } });
    }
    if (result.modelListed !== true) {
      throw new AosError('ollama_preflight_model_unavailable', `Ollama does not report configured model ${config.model}`, { statusCode: 409, details: { expected: config.model } });
    }
    if (!['local_response', 'local-response'].includes(String(result.attestation))) {
      throw new AosError('ollama_preflight_attestation_invalid', 'Ollama preflight did not attest a local response boundary', { statusCode: 409, details: { attestation: result.attestation } });
    }
    if (result.verified !== false) {
      throw new AosError('ollama_preflight_attestation_invalid', 'Ollama preflight cannot claim externally verified provider identity', { statusCode: 409, details: { verified: result.verified } });
    }
    if (Array.isArray(result.models) && !result.models.some((item) => (typeof item === 'string' ? item : item?.name || item?.model) === config.model)) {
      throw new AosError('ollama_preflight_model_unavailable', `Ollama does not report configured model ${config.model}`, {
        statusCode: 409,
        details: { expected: config.model, models: result.models.map((item) => typeof item === 'string' ? item : item?.name || item?.model || null) },
      });
    }
    const transport = result.transport;
    if (transport && typeof transport === 'object' && (transport.scope || transport.kind)) {
      const scope = transport.scope || transport.kind;
      if (!String(scope).toLowerCase().includes('loopback') && !String(scope).toLowerCase().includes('local')) {
        throw new AosError('ollama_preflight_transport_invalid', 'Ollama preflight did not attest loopback-local transport', { statusCode: 409, details: { transport } });
      }
    } else if (typeof transport === 'string' && !/loopback|local/i.test(transport)) {
      throw new AosError('ollama_preflight_transport_invalid', 'Ollama preflight did not attest loopback-local transport', { statusCode: 409, details: { transport } });
    }
  }

  // The adapter can attest only that an operator-owned wrapper spoke the fixed
  // protocol. It does not establish an OpenCode/OpenClaw identity or OAuth.
  async preflightCommand({ worker = null } = {}) {
    if (!this.execution.command) throw new AosError('command_preflight_unavailable', 'External harness preflight requires explicit mixed-mode configuration', { statusCode: 409 });
    try {
      const adapter = worker || this.workers.get('command');
      if (!adapter || typeof adapter.preflight !== 'function') {
        throw new AosError('command_preflight_unavailable', 'The mounted external harness worker does not expose preflight', { statusCode: 409 });
      }
      const result = await adapter.preflight();
      this.#validateCommandPreflight(result);
      this.providerReadiness.command = {
        status: 'available',
        checkedAt: result.checkedAt || new Date(this.clock()).toISOString(),
        model: this.execution.command.model,
        sandbox: EXTERNAL_HARNESS_SANDBOX,
        authType: this.execution.command.authType,
        sessionMode: this.execution.command.sessionMode,
      };
      return result;
    } catch (error) {
      this.providerReadiness.command = { status: 'unavailable', checkedAt: new Date(this.clock()).toISOString() };
      throw error;
    }
  }

  #validateCommandPreflight(result) {
    const config = this.execution.command;
    const validObject = result && typeof result === 'object' && !Array.isArray(result);
    if (!validObject) throw new AosError('command_preflight_invalid', 'External harness preflight did not return a result object', { statusCode: 409 });
    const exact = result.protocol === EXTERNAL_HARNESS_PROTOCOL
      && result.provider === config.provider
      && result.model === config.model
      && result.sandbox === EXTERNAL_HARNESS_SANDBOX
      && result.authType === config.authType
      && result.sessionMode === config.sessionMode
      && result.ready === true
      && result.verified === false
      && result.attestation === EXTERNAL_HARNESS_ATTESTATION;
    if (!exact) {
      throw new AosError('command_preflight_attestation_invalid', 'External harness preflight did not attest the exact configured protocol boundary', {
        statusCode: 409,
        details: {
          expected: {
            protocol: EXTERNAL_HARNESS_PROTOCOL,
            provider: config.provider,
            model: config.model,
            sandbox: EXTERNAL_HARNESS_SANDBOX,
            authType: config.authType,
            sessionMode: config.sessionMode,
          },
        },
      });
    }
  }

  async #preflightProvider(providerId) {
    if (providerId === 'codex') return this.preflightCodex();
    if (providerId === 'claude') return this.preflightClaude();
    if (providerId === 'ollama') return this.preflightOllama();
    if (providerId === 'command') return this.preflightCommand();
    return null;
  }

  async #drive(runId, { untilIdle = false, steps = 1 } = {}) {
    const limit = untilIdle ? Infinity : Math.max(1, Number(steps) || 1);
    const active = new Set();
    let executed = 0;

    this.transact(() => this.#recoverRun(this.#require('runs', runId, 'run')));
    let run = this.#require('runs', runId, 'run');
    if (this.live && !NOT_DISPATCHABLE.has(run.status) && !(await this.#livePreflight(runId))) {
      return { run: this.#require('runs', runId, 'run'), executed, idle: this.#isIdle(runId) };
    }

    for (;;) {
      run = this.#require('runs', runId, 'run');
      if (!NOT_DISPATCHABLE.has(run.status)) {
        // Readiness and slot selection happen under the lock. Each dispatch re-checks its
        // task under its own transaction, so a reload in between cannot double-dispatch.
        const readyIds = this.transact(() => {
          this.#refreshReady(runId);
          const fresh = this.#require('runs', runId, 'run');
          const slots = Math.min(this.#freeSlots(fresh), limit - executed);
          if (slots <= 0) return [];
          const activeByProvider = new Map();
          const activeByProject = new Map();
          for (const reservation of this.state.resourceReservations || []) {
            if (reservation.status !== 'active') continue;
            activeByProvider.set(reservation.providerId, (activeByProvider.get(reservation.providerId) || 0) + 1);
            activeByProject.set(reservation.projectId, (activeByProject.get(reservation.projectId) || 0) + 1);
          }
          const selectedByProvider = new Map();
          const selectedByProject = new Map();
          const selected = [];
          for (const task of this.#tasks(runId).filter((item) => item.status === TASK_STATUS.ready)) {
            if (selected.length >= slots) break;
            const providerId = task.worker || 'local';
            const cap = this.#providerConfig(providerId)?.maxConcurrency;
            const active = activeByProvider.get(providerId) || 0;
            const selectedForProvider = selectedByProvider.get(providerId) || 0;
            if (Number.isInteger(cap) && active + selectedForProvider >= cap) {
              this.#event('resource.deferred', {
                projectId: fresh.projectId,
                runId: fresh.id,
                taskId: task.id,
                payload: { attempt: task.attempts + 1, key: task.key || null, code: 'resource_capacity_exhausted', dimension: 'concurrency', scope: 'provider', limit: cap, reserved: active },
              });
              continue;
            }
            const project = this.#require('projects', fresh.projectId, 'project');
            const projectCap = project.maxConcurrency ?? null;
            const activeProject = activeByProject.get(project.id) || 0;
            const selectedForProject = selectedByProject.get(project.id) || 0;
            if (projectCap != null && activeProject + selectedForProject >= projectCap) {
              this.#event('resource.deferred', {
                projectId: fresh.projectId,
                runId: fresh.id,
                taskId: task.id,
                payload: { attempt: task.attempts + 1, key: task.key || null, code: 'resource_capacity_exhausted', dimension: 'concurrency', scope: 'project', limit: projectCap, reserved: activeProject },
              });
              continue;
            }
            selected.push(task.id);
            selectedByProvider.set(providerId, selectedForProvider + 1);
            selectedByProject.set(project.id, selectedForProject + 1);
          }
          return selected;
        });
        for (const taskId of readyIds) {
          const job = this.#executeTask(runId, taskId).catch((error) => this.#crash(runId, taskId, error));
          const tracked = job.finally(() => active.delete(tracked));
          active.add(tracked);
          executed += 1;
        }
      }
      if (active.size) {
        await Promise.race(active);
        continue;
      }
      run = this.#require('runs', runId, 'run');
      const blockedByOtherRuns = !NOT_DISPATCHABLE.has(run.status)
        && executed < limit
        && this.inflight.size > 0
        && this.#tasks(runId).some((task) => task.status === TASK_STATUS.ready);
      if (!blockedByOtherRuns) break;
      await new Promise((resolve) => this.slotWaiters.push(resolve));
    }

    return this.transact(() => {
      this.#refreshReady(runId);
      const fresh = this.#require('runs', runId, 'run');
      this.#settleRun(fresh);
      return { run: fresh, executed, idle: this.#isIdle(runId) };
    });
  }

  async #livePreflight(runId) {
    if (this.execution.mode === 'mixed') {
      const providerIds = [...new Set(this.#tasks(runId)
        .map((task) => task.worker)
        .filter((providerId) => ['codex', 'claude', 'ollama', 'command'].includes(providerId)))];
      if (!providerIds.length) return true;
      const results = {};
      for (const providerId of providerIds) {
        try {
          const result = await this.#preflightProvider(providerId);
          results[providerId] = {
            status: 'available',
            checkedAt: result.checkedAt || this.now(),
            cliVersion: result.cliVersion || null,
            authPath: result.authPath || null,
            requested: result.requested || null,
            ...(providerId === 'codex'
              ? { catalog: result.model || null, login: result.login || null }
                : providerId === 'claude'
                  ? { auth: result.auth || null, posture: result.posture || null }
                  : providerId === 'ollama'
                    ? { models: Array.isArray(result.models) ? result.models : null, transport: result.transport || 'loopback', attestation: result.attestation || 'local_response' }
                    : {
                      protocol: result.protocol,
                      provider: result.provider,
                      model: result.model,
                      sandbox: result.sandbox,
                      authType: result.authType,
                      sessionMode: result.sessionMode,
                      attestation: result.attestation,
                      verified: false,
                      strippedEnvCount: Number.isInteger(result.strippedEnvCount) ? result.strippedEnvCount : null,
                    }),
            ...(providerId === 'command' ? {} : { strippedEnv: result.strippedEnv || [] }),
          };
        } catch (error) {
          results[providerId] = {
            status: 'unavailable',
            checkedAt: this.now(),
            error: String(error?.message || 'Provider preflight failed').slice(0, 500),
          };
        }
      }
      this.transact(() => {
        const run = this.#require('runs', runId, 'run');
        run.preflight = {
          checkedAt: this.now(),
          providers: { ...(run.preflight?.providers || {}), ...redactSecrets(results) },
        };
        for (const [providerId, receipt] of Object.entries(results)) {
          this.#event(receipt.status === 'available' ? 'provider.preflight' : 'provider.preflight_failed', {
            projectId: run.projectId,
            runId: run.id,
            payload: { provider: providerId, ...redactSecrets(receipt) },
          });
        }
      });
      // A failed provider remains bound to its assigned tasks. Dispatch rejects
      // those tasks before workspace claim while other configured providers run.
      return true;
    }
    try {
      const result = await this.preflightCodex();
      this.transact(() => {
        const run = this.#require('runs', runId, 'run');
        if (run.preflight) return;
        run.preflight = {
          checkedAt: result.checkedAt,
          codexBin: result.codexBin,
          cliVersion: result.cliVersion,
          login: result.login,
          authPath: result.authPath,
          requested: result.requested,
          catalog: result.model,
          strippedEnv: result.strippedEnv,
          disabledFeatures: result.disabledFeatures,
        };
        this.#event('provider.preflight', { projectId: run.projectId, runId: run.id, payload: run.preflight });
      });
      return true;
    } catch (error) {
      this.transact(() => this.#abortRun(this.#require('runs', runId, 'run'), error.message, error.details));
      return false;
    }
  }

  // Lease-based orphan rule. A running task is an orphan only when its lease is missing,
  // its driver is on another host, the lease has expired, its driver process is dead, or
  // this very engine recorded the lease but no longer has the attempt in flight.
  #orphanReason(task) {
    if (task.status !== TASK_STATUS.running) return null;
    const lease = task.lease;
    if (!lease) return 'no lease recorded';
    // A pool claim is owned by an external worker. The engine's local inflight
    // map only tracks in-process execution and must never make a live pool claim
    // look abandoned after a restart. Until the lease expires, trust the claim;
    // once the worker records a pid/pgid, a dead process is also an orphan.
    if (lease.executorKind === 'pool') {
      if (!lease.leaseUntil || Date.parse(lease.leaseUntil) <= this.clock()) return 'lease expired';
      if (lease.workerPgid != null && !pidAlive(lease.workerPgid)) return 'worker process group dead';
      if (lease.workerPid != null && !pidAlive(lease.workerPid)) return 'worker process dead';
      return null;
    }
    if (lease.host && lease.host !== hostname()) return 'driver on another host';
    if (!lease.leaseUntil || Date.parse(lease.leaseUntil) < this.clock()) return 'lease expired';
    if (lease.driverPid === process.pid) {
      if (lease.driverId === this.driverId && !this.inflight.has(task.id)) return 'no live driver in this process';
      return null;
    }
    if (!pidAlive(lease.driverPid)) return 'driver process dead';
    return null;
  }

  #newLease(task, attempt, worker = null, { executorKind = 'in_process', claimId = null, claimRequestId = null, ownerId = null, profile = null, poolProtocol = null } = {}) {
    const timeoutMs = task.timeoutMs || this.#providerConfig(worker?.id || task.worker)?.timeoutMs || DEFAULT_LEASE_TTL_MS;
    const ttlMs = timeoutMs + LEASE_GRACE_MS;
    const now = this.now();
    return {
      attempt,
      ...(claimId ? { claimId } : {}),
      ...(claimRequestId ? { claimRequestId } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(poolProtocol ? { poolProtocol } : {}),
      executorKind,
      driverId: this.driverId,
      driverPid: process.pid,
      host: hostname(),
      workerPid: null,
      workerPgid: null,
      startedAt: now,
      heartbeatAt: now,
      leaseUntil: new Date(this.clock() + ttlMs).toISOString(),
      ttlMs,
      ...(profile ? { profile } : {}),
    };
  }

  #providerConfig(providerId) {
    return executionAdapterConfig(this.execution, providerId);
  }

  // Public to the immutable plan service and lead-planning seam. A plan never
  // gets to name a model for a role; it may only resolve a preset role that has
  // this engine-owned binding.
  roleRuntimeForPlanTask(task) {
    return this.#roleRuntimeForTask(task);
  }

  assertManagerRoleTaskLimit(run, plannedTasks = []) {
    const managerCount = (tasks) => tasks.reduce((total, task) => {
      const binding = this.#roleRuntimeForTask(task);
      return total + (binding?.class === 'manager' ? 1 : 0);
    }, 0);
    const existing = run ? managerCount(this.#tasks(run.id)) : 0;
    const proposed = managerCount(plannedTasks);
    if (existing + proposed > MANAGER_ROLE_TASK_LIMIT) {
      throw new AosError('manager_role_limit', `Run ${run?.id || '(new)'} would contain ${existing + proposed} manager-role tasks; the role policy permits at most ${MANAGER_ROLE_TASK_LIMIT}`, {
        statusCode: 409,
        details: { runId: run?.id || null, existing, proposed, limit: MANAGER_ROLE_TASK_LIMIT },
      });
    }
    return { existing, proposed, limit: MANAGER_ROLE_TASK_LIMIT };
  }

  #roleRuntimeForTask(task) {
    let source = task && typeof task === 'object' ? task : {};
    if (source.templateId && !source.presetId) {
      source = applyTemplateToTask(
        { ...source, config: null },
        source,
        this.templates.get(source.templateId, source.templateVersion ?? null),
      );
    }
    const presetId = source.presetId || PRESET_FOR_KIND[source.kind] || null;
    if (!presetId) return null;
    const preset = this.presets.effective(presetId, source.presetVersion ?? null);
    const binding = roleRuntimeFor(preset.role);
    return binding ? { ...binding, presetId: preset.id, presetVersion: preset.version } : null;
  }

  #assertCodexRoleRuntime(task) {
    const binding = this.#roleRuntimeForTask(task);
    if (!binding) {
      throw new AosError('role_runtime_unbound', `Codex task ${task?.key || task?.id || '(unknown)'} has no resolved preset role`, {
        statusCode: 409,
        details: { taskId: task?.id || null, presetId: task?.presetId || null, kind: task?.kind || null },
      });
    }
    const effective = task?.config?.effective?.harness || {};
    const model = task?.model ?? effective.model ?? null;
    const effort = task?.effort ?? effective.effort ?? null;
    if ((model != null && model !== binding.model) || (effort != null && effort !== binding.effort)) {
      throw new AosError('role_runtime_violation', `Codex role ${binding.role} must use ${binding.model}/${binding.effort}`, {
        statusCode: 409,
        details: { taskId: task?.id || null, role: binding.role, requested: { model, effort }, expected: { model: binding.model, effort: binding.effort } },
      });
    }
    return binding;
  }

  #bindCodexRoleRuntime(task) {
    const binding = this.#assertCodexRoleRuntime(task);
    task.model = binding.model;
    task.effort = binding.effort;
    task.roleRuntime = {
      version: roleRuntimePolicyView().version,
      role: binding.role,
      class: binding.class,
      presetId: binding.presetId,
      presetVersion: binding.presetVersion,
      requested: { model: binding.model, effort: binding.effort },
    };
    if (task.config?.effective?.harness) {
      task.config.effective.harness = {
        ...task.config.effective.harness,
        model: binding.model,
        effort: binding.effort,
      };
    }
    return binding;
  }

  #renderPoolPrompt(run, task) {
    if (!task.presetId) return null;
    const rendered = this.presets.render(task.presetId, {
      version: task.presetVersion ?? null,
      variables: this.#promptVariables(run, task),
    });
    return rendered.text;
  }

  #providerAdapterPoolEligible(run, task, ownerId) {
    if ((task.worker || 'local') !== 'codex') return false;
    if (task.mayDelegate === true || task.delegation || task.capabilityExecution) return false;
    const writePaths = task.config?.effective?.filesystem?.writePaths || [];
    if (Array.isArray(writePaths) && writePaths.length) return false;
    const profile = providerProfile(this.execution, task.worker, task);
    const runnerProfile = providerProfile(this.execution, task.worker);
    if (profile.fingerprint !== runnerProfile.fingerprint) return false;
    const sandbox = task.sandbox || task.config?.effective?.filesystem?.sandbox || profile.sandbox;
    if (sandbox !== profile.sandbox) return false;
    try {
      const agent = this.state.agents.find((item) => item.id === task.agentId);
      const mounts = this.capabilities.resolveTask(task, {
        projectId: run.projectId,
        roleId: task.presetId || task.kind,
        workerId: agent?.id || ownerId,
        runId: run.id,
      });
      return mounts.length === 0;
    } catch {
      return false;
    }
  }

  #claimPoolTaskInTransaction(run, task, workerId, ownerId, requestId, { protocol = null } = {}) {
    if (isTaskWorkspaceWriteRequested(task)) {
      throw new AosError('workspace_write_pool_forbidden', 'Task-workspace writes run only in the in-process deterministic engine path', { statusCode: 409, details: { taskId: task.id } });
    }
    const worker = this.workers.get(workerId);
    const refusal = this.#refuseWorker(task, worker);
    if (refusal) {
      throw new AosError(worker ? 'worker_not_allowed' : 'adapter_not_registered', refusal, { statusCode: 409, details: { worker: workerId, taskId: task.id } });
    }
    if (worker.id !== 'engine') {
      const provider = this.listProviders().find((item) => item.id === worker.id);
      if (provider || this.live) assertProviderDispatchable(provider, { workerId: worker.id });
    }

    const agent = this.state.agents.find((item) => item.id === task.agentId);
    const capabilityMounts = this.capabilities.resolveTask(task, {
      projectId: run.projectId,
      roleId: task.presetId || task.kind,
      workerId: agent?.id || ownerId,
      runId: run.id,
    });
    const mcpRequested = Boolean(task.capabilityExecution && (
      (Array.isArray(task.capabilities?.mcp) && task.capabilities.mcp.length > 0)
      || capabilityMounts.some((mount) => mount.kind === 'mcp')
    ));
    let mcpSource = null;
    if (mcpRequested) {
      assertMcpTaskAdmission(task, capabilityMounts);
      mcpSource = this.#inspectMcpSource(task);
    }

    let systemPrompt = null;
    if (task.presetId) {
      systemPrompt = this.#renderPoolPrompt(run, task);
    }

    this.#assertPoolCapacity(run, task, worker);

    const attempt = task.attempts + 1;
    const profile = providerProfile(this.execution, worker.id, task);
    const claimId = newId('claim');
    task.status = TASK_STATUS.running;
    task.attempts = attempt;
    task.sessionId = null;
    task.startedAt = task.startedAt || this.now();
    task.capabilityMounts = capabilityMounts;
    if (agent) agent.status = 'active';

    const reservation = this.#resourceGovernor(run, task).reserve(this.#resourceRequest(run, task, worker, attempt));
    task.resourceReservationId = reservation.id;
    task.resourceAttemptId = reservation.attemptId;
    task.resourceReservations = [...(task.resourceReservations || []), reservation.id];
    this.#event('resource.reserved', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: {
        attempt,
        reservationId: reservation.id,
        provider: worker.id,
        profileFingerprint: profile.fingerprint,
        reserved: reservation.reserved,
        executorKind: 'pool',
      },
    });

    let workspace;
    try {
      workspace = claimWorkspace({
        root: this.store.workspacesDir,
        runId: run.id,
        taskId: task.id,
        agentId: agent?.id || ownerId,
        now: this.now(),
      });
    } catch (error) {
      // The surrounding transaction rolls state/events back, while this explicit
      // settlement closes the reservation for callers that inspect the live object
      // before the transaction unwinds.
      try { this.#settleResource(run, task, 'workspace_claim_failed'); } catch { /* original workspace error wins */ }
      throw new AosError('workspace_claim_failed', String(error.message || 'workspace claim failed').slice(0, 500), { statusCode: 409, details: { taskId: task.id } });
    }

    let stagedMcp = null;
    if (mcpSource) stagedMcp = this.#stageMcpSource(mcpSource, workspace);
    task.workspace = workspace.dir;
    if (agent) agent.workspace = workspace.dir;
    const lease = this.#newLease(task, attempt, worker, {
      executorKind: 'pool',
      claimId,
      claimRequestId: requestId,
      ownerId,
      profile,
      poolProtocol: protocol,
    });
    lease.promptFingerprint = systemPrompt ? fingerprint(systemPrompt) : null;
    if (mcpSource) {
      lease.mcpSource = {
        relativePath: mcpSource.relativePath,
        fingerprint: mcpSource.fingerprint,
        size: mcpSource.size,
      };
    }
    lease.stagedMcpFile = stagedMcp?.relativePath || null;
    task.lease = lease;

    const eventPayload = { attempt, key: task.key || null, worker: worker.id, profile, claimId, claimRequestId: requestId, ownerId, executorKind: 'pool', ...(protocol ? { protocol } : {}) };
    const running = this.#tasks(run.id).filter((item) => item.status === TASK_STATUS.running).length;
    this.#event('worker.dispatched', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: { ...eventPayload, running, cap: run.maxConcurrency ?? null },
    });
    this.#event('task.started', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: { ...eventPayload, provider: worker.id, profileFingerprint: profile.fingerprint },
    });
    this.#event('task.claimed', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      actor: ownerId,
      payload: eventPayload,
    });
    if (systemPrompt != null) {
      this.#event('prompt.rendered', {
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        payload: { attempt, key: task.key || null, presetId: task.presetId, presetVersion: task.presetVersion ?? null, chars: systemPrompt.length, executorKind: 'pool' },
      });
    }
    return this.#poolClaimResponse(run, task, { systemPrompt, stagedMcp });
  }

  #assertPoolCapacity(run, task, worker) {
    const project = this.#require('projects', run.projectId, 'project');
    const reservations = (this.state.resourceReservations || []).filter((item) => item.status === 'active');
    const activeProvider = reservations.filter((item) => item.providerId === worker.id).length;
    const activeProject = reservations.filter((item) => item.projectId === run.projectId).length;
    const activeRun = reservations.filter((item) => item.runId === run.id).length;
    const runningProvider = this.#tasksByStatus(TASK_STATUS.running).filter((item) => (item.worker || 'local') === worker.id).length;
    const runningProject = this.#tasksByStatus(TASK_STATUS.running).filter((item) => item.projectId === run.projectId).length;
    const runningRun = this.#tasks(run.id).filter((item) => item.status === TASK_STATUS.running).length;
    const provider = this.listProviders().find((item) => item.id === worker.id);
    const providerCaps = [
      this.#providerConfig(worker.id)?.maxConcurrency,
      provider?.contract?.quota?.maxConcurrency,
    ].filter((value) => Number.isInteger(value) && value >= 0);
    const providerCap = providerCaps.length ? Math.min(...providerCaps) : null;
    if (providerCap != null && Math.max(activeProvider, runningProvider) >= providerCap) {
      throw new ResourceGovernorError('resource_capacity_exhausted', `Provider ${worker.id} has no remaining reserved capacity`, {
        details: { dimension: 'concurrency', scope: 'provider', providerId: worker.id, limit: providerCap, consumed: runningProvider, reserved: activeProvider },
      });
    }
    const projectCap = project.maxConcurrency ?? null;
    if (projectCap != null && Math.max(activeProject, runningProject) >= projectCap) {
      throw new ResourceGovernorError('resource_capacity_exhausted', `Project ${project.id} has no remaining reserved capacity`, {
        details: { dimension: 'concurrency', scope: 'project', projectId: project.id, limit: projectCap, consumed: runningProject, reserved: activeProject },
      });
    }
    const runCap = run.maxConcurrency ?? null;
    if (runCap != null && runCap > 0 && Math.max(activeRun, runningRun) >= runCap) {
      throw new ResourceGovernorError('resource_capacity_exhausted', `Run ${run.id} has no remaining reserved capacity`, {
        details: { dimension: 'concurrency', scope: 'run', runId: run.id, limit: runCap, consumed: runningRun, reserved: activeRun },
      });
    }
  }

  #revalidatePoolClaim(run, task, worker, agent) {
    try {
      if (isTaskWorkspaceWriteRequested(task)) {
        throw new AosError('workspace_write_pool_forbidden', 'Task-workspace writes run only in the in-process deterministic engine path', { statusCode: 409 });
      }
      const refusal = this.#refuseWorker(task, worker);
      if (refusal) throw new AosError('pool_claim_worker_changed', refusal, { statusCode: 409 });
      if (worker.id !== 'engine') {
        const provider = this.listProviders().find((item) => item.id === worker.id);
        if (provider || this.live) assertProviderDispatchable(provider, { workerId: worker.id });
      }
      const currentProfile = providerProfile(this.execution, worker.id);
      if (!task.lease?.profile?.fingerprint || task.lease.profile.fingerprint !== currentProfile.fingerprint) {
        throw new AosError('pool_claim_provider_changed', 'The claimed provider profile changed before completion', { statusCode: 409 });
      }
      const currentMounts = this.capabilities.resolveTask(task, {
        projectId: run.projectId,
        roleId: task.presetId || task.kind,
        workerId: agent?.id || task.lease?.ownerId || null,
        runId: run.id,
      });
      if (poolCapabilityMountFingerprint(currentMounts) !== poolCapabilityMountFingerprint(task.capabilityMounts)) {
        throw new AosError('pool_claim_capability_changed', 'The claimed capability set changed before completion', { statusCode: 409 });
      }
      if (currentMounts.some((mount) => mount.kind === 'mcp')) {
        assertMcpTaskAdmission(task, currentMounts);
        const source = this.#inspectMcpSource(task);
        if (!task.lease?.mcpSource || source.relativePath !== task.lease.mcpSource.relativePath
          || source.fingerprint !== task.lease.mcpSource.fingerprint || source.size !== task.lease.mcpSource.size) {
          throw new AosError('pool_claim_source_changed', 'The claimed MCP source changed before completion', { statusCode: 409 });
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  #validatePoolAdapterReceipt(task, normalized) {
    const profile = task.lease?.profile || {};
    const runtime = normalized.runtime;
    const fail = (message) => {
      throw new AosError('pool_adapter_receipt_invalid', message, { statusCode: 409 });
    };
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) fail('Provider-adapter completion requires a runtime receipt');
    if (task.worker !== 'codex') fail('Provider-adapter pool execution currently supports Codex only');
    if (runtime.provider !== task.worker || profile.provider !== task.worker) fail('Provider-adapter receipt provider does not match the claim');
    if (runtime.requested?.model !== profile.model) fail('Provider-adapter receipt requested model does not match the claim');
    if (runtime.verified !== true) fail('Provider-adapter receipt is not verified');
    if (runtime.requested?.effort !== profile.effort || runtime.requested?.sandbox !== profile.sandbox) {
      fail('Provider-adapter receipt requested posture does not match the claim');
    }
    if (!poolExactRuntimeValue(runtime.effective?.model, profile.model)
      || !poolExactRuntimeValue(runtime.effective?.effort, profile.effort)
      || !poolExactRuntimeValue(runtime.effective?.sandbox, profile.sandbox)) {
      fail('Provider-adapter receipt effective posture does not match the claim');
    }
    if (typeof runtime.threadId !== 'string' || !runtime.threadId.trim()) fail('Provider-adapter receipt lacks a provider session reference');
    const config = this.#providerConfig('codex');
    const evidence = readSessionEvidence({
      codexHome: codexHomeDir(config),
      threadId: runtime.threadId.trim(),
      startedAt: Date.parse(task.lease?.startedAt || '') || this.clock(),
    });
    const verdict = verifySession(evidence, config);
    if (!verdict.ok || evidence.sessionId !== runtime.threadId.trim()) {
      fail(`Codex-owned session evidence did not verify this receipt: ${verdict.problems.join('; ') || 'session id mismatch'}`);
    }
    let sessionMtime = null;
    try { sessionMtime = statSync(evidence.sessionFile).mtimeMs; } catch { /* handled below */ }
    const claimStartedAt = Date.parse(task.lease?.startedAt || '');
    if (!Number.isFinite(sessionMtime) || !Number.isFinite(claimStartedAt) || sessionMtime < claimStartedAt - 1_000) {
      fail('Codex-owned session evidence predates the claimed attempt');
    }
    return true;
  }

  #refusePoolCompletion(run, task, agent, claimId, attempt, error) {
    const code = typeof error?.code === 'string' ? error.code : 'pool_claim_admission_changed';
    if (task.resourceReservationId) {
      const settled = this.#settleResource(run, task, 'pool_claim_refused');
      if (settled) this.#event('resource.settled', {
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        payload: { attempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed },
      });
    }
    task.lease = null;
    this.#failTask(run, task, agent, 'Pool completion refused because the claimed execution authority changed.', {
      retryable: false,
      fatal: false,
      code,
    });
    this.#refreshReady(run.id);
    this.#settleRun(run);
    return { claimId, runId: run.id, taskId: task.id, attempt, status: task.status, refused: true, errorCode: code };
  }

  #tasksByStatus(status) {
    return this.state.tasks.filter((item) => item.status === status);
  }

  #requirePoolClaim(claimId) {
    const task = this.state.tasks.find((item) => item.lease?.claimId === claimId);
    if (!task) throw new AosError('pool_claim_stale', `Pool claim ${claimId} is no longer live`, { statusCode: 409, details: { claimId } });
    return task;
  }

  #assertPoolFence(task, claimId, ownerId, attempt) {
    const lease = task.lease;
    if (!lease || lease.executorKind !== 'pool' || lease.claimId !== claimId || task.status !== TASK_STATUS.running) {
      throw new AosError('pool_claim_stale', `Pool claim ${claimId} is no longer live`, { statusCode: 409, details: { claimId, taskId: task.id } });
    }
    if (lease.ownerId !== ownerId) {
      throw new AosError('pool_claim_owner_mismatch', `Pool claim ${claimId} belongs to another owner`, { statusCode: 409, details: { claimId, taskId: task.id } });
    }
    if (lease.attempt !== attempt) {
      throw new AosError('pool_claim_attempt_mismatch', `Pool claim ${claimId} is fenced to attempt ${lease.attempt}`, { statusCode: 409, details: { claimId, expectedAttempt: lease.attempt, receivedAttempt: attempt } });
    }
    if (!lease.leaseUntil || Date.parse(lease.leaseUntil) <= this.clock()) {
      throw new AosError('pool_claim_expired', `Pool claim ${claimId} has expired`, { statusCode: 409, details: { claimId, leaseUntil: lease.leaseUntil || null } });
    }
  }

  #poolClaimResponse(run, task, { systemPrompt = null, stagedMcp = null } = {}) {
    const lease = task.lease || {};
    const goal = this.#require('goals', run.goalId, 'goal');
    const agent = this.state.agents.find((item) => item.id === task.agentId);
    const profile = lease.profile || task.providerProfile || providerProfile(this.execution, task.worker || 'local', task);
    const dependencies = this.#dependencyOutputs(task).map((dependency) => ({
      id: dependency.id,
      key: dependency.key,
      title: poolSafeString(dependency.title, 240),
      kind: poolSafeString(dependency.kind, 120),
      status: dependency.status,
      summary: poolSafeString(dependency.summary, 2_000),
      findings: Array.isArray(dependency.findings) ? dependency.findings.slice(0, 20).map((finding) => ({
        kind: poolSafeString(finding.kind, 80),
        claim: poolSafeString(finding.claim, 2_000),
        evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 20).map((item) => poolSafeString(item, 512)) : [],
      })) : [],
      decision: dependency.decision ? poolSafeObject(dependency.decision) : null,
      artifact: dependency.artifact ? poolSafeString(dependency.artifact, 1_024) : null,
    }));
    const pathList = poolTaskReadPaths(task).map((path) => poolSafeString(path, 512));
    let resolvedPrompt = systemPrompt;
    if (resolvedPrompt == null && task.presetId) {
      const rendered = this.presets.render(task.presetId, {
        version: task.presetVersion ?? null,
        variables: this.#promptVariables(run, task),
      }).text;
      if (lease.promptFingerprint && fingerprint(rendered) !== lease.promptFingerprint) {
        throw new AosError('pool_claim_prompt_changed', 'The claimed system prompt changed before replay', { statusCode: 409 });
      }
      resolvedPrompt = rendered;
    }
    const safePrompt = resolvedPrompt == null ? null : redactText(resolvedPrompt).slice(0, 60_000);
    const response = {
      claimId: lease.claimId || null,
      claimRequestId: lease.claimRequestId || null,
      ownerId: lease.ownerId || null,
      protocol: lease.poolProtocol || null,
      leaseUntil: lease.leaseUntil || null,
      runId: run.id,
      projectId: run.projectId,
      goalId: run.goalId,
      taskId: task.id,
      agentId: agent?.id || task.agentId || null,
      attempt: lease.attempt ?? task.attempts,
      nonce: task.nonce,
      worker: task.worker || 'local',
      provider: task.worker || 'local',
      profile: poolSafeObject(profile),
      providerProfile: poolSafeObject(profile),
      goal: {
        id: goal.id,
        projectId: goal.projectId,
        prompt: poolSafeString(goal.prompt, 20_000),
        definitionOfDone: goal.definitionOfDone ? poolSafeString(goal.definitionOfDone, 4_000) : null,
        contextPaths: Array.isArray(goal.contextPaths) ? goal.contextPaths.slice(0, 100).map((path) => poolSafeString(path, 512)) : [],
      },
      run: { id: run.id, projectId: run.projectId, goalId: run.goalId, status: run.status },
      task: {
        id: task.id,
        planTaskId: task.planTaskId || null,
        key: task.key || null,
        title: poolSafeString(task.title, 240),
        kind: poolSafeString(task.kind, 120),
        parentId: task.parentId || null,
        branch: poolSafeString(task.branch || 'root', 120),
        brief: poolSafeString(task.brief || task.summary || task.title, 4_000),
        dependencyPolicy: task.dependencyPolicy || 'all_succeeded',
        attempts: lease.attempt ?? task.attempts,
        nonce: task.nonce,
        timeoutMs: Number.isFinite(task.timeoutMs) ? task.timeoutMs : profile.timeoutMs,
        readPaths: pathList,
        mayDelegate: task.mayDelegate === true,
        questions: Array.isArray(task.questions) ? task.questions.slice(0, 20).map((question) => ({
          id: poolSafeString(question.id, 128),
          prompt: poolSafeString(question.prompt, 500),
          answer: question.answer == null ? null : poolSafeString(question.answer, 2_000),
        })) : [],
      },
      dependencies,
      systemPrompt: safePrompt,
      workspace: task.workspace || null,
      workspacePath: task.workspace || null,
      stagedMcpFile: stagedMcp?.relativePath || lease.stagedMcpFile || null,
      capabilityMounts: poolCapabilityViews(task.capabilityMounts),
      budget: poolBudget(task.budget),
      sandbox: poolSafeString(task.sandbox || task.config?.effective?.filesystem?.sandbox || profile.sandbox || null, 80),
      readPaths: pathList,
    };
    return structuredClone(redactSecrets(response));
  }

  #providerTimeout(providerId) {
    const timeoutMs = this.#providerConfig(providerId)?.timeoutMs;
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  }

  #resourceGovernor(run, task) {
    const projectBudget = Object.fromEntries(['tokens', 'usd', 'timeMs'].map((dimension) => [dimension,
      this.settings.effective(`budget.${dimension}`, { projectId: run.projectId, runId: run.id, presetId: task.presetId || null, agentId: task.agentId || null }).value]));
    return new ResourceGovernor({
      state: this.state,
      clock: this.clock,
      idFactory: (kind) => newId(kind === 'reservation' ? 'resourceReservation' : 'resourceReceipt'),
      limits: { project: { [run.projectId]: projectBudget }, run: { [run.id]: run.ceilings || {} } },
      defaultTtlMs: task.timeoutMs || this.#providerTimeout(task.worker) || DEFAULT_LEASE_TTL_MS,
    });
  }

  #resourceRequest(run, task, worker, attempt) {
    const budget = task.budget || {};
    return {
      attemptId: `${run.id}:${task.id}:${attempt}`,
      providerId: worker.id,
      projectId: run.projectId,
      runId: run.id,
      tokens: budget.tokens ?? 0,
      usd: budget.usd ?? (worker.id === 'local' ? 0 : undefined),
      timeMs: budget.timeMs ?? task.timeoutMs ?? this.#providerTimeout(worker.id) ?? 0,
      metadata: {
        taskId: task.id,
        attempt,
        worker: worker.id,
        profileFingerprint: providerProfile(this.execution, worker.id, task).fingerprint,
      },
    };
  }

  #resourceGate(run, task, agent, error) {
    const details = error?.details || {};
    const question = {
      id: newId('task').replace(/^tsk_/, 'q_'),
      prompt: details.remediation || 'Resource capacity is unavailable. Raise the applicable limit or wait for active work to settle, then resume this task.',
      reason: `${error.code || 'resource_gate'}: ${details.dimension || 'capacity'} limit ${details.limit ?? 'unknown'}`,
      required: true, answer: null, askedAt: this.now(), askedBy: { worker: 'engine', agentId: agent?.id || null }, attempt: task.attempts, answeredAt: null, answeredBy: null,
    };
    task.status = TASK_STATUS.awaiting_user;
    task.wait = { code: error.code || 'resource_gate', questionIds: [question.id], attempt: task.attempts, at: this.now(), dimension: details.dimension || 'capacity', limit: details.limit ?? null, consumed: details.consumed ?? 0, reserved: details.reserved ?? 0, remediation: details.remediation || null };
    task.questions = [...(task.questions || []), question];
    task.error = null; task.errorCode = error.code || 'resource_gate'; task.lease = null;
    if (agent) agent.status = 'waiting_user';
    run.status = RUN_STATUS.awaiting_user; run.updatedAt = this.now();
    this.#event('resource.gated', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { attempt: task.attempts, code: error.code || 'resource_gate', dimension: details.dimension || 'capacity', limit: details.limit ?? null, consumed: details.consumed ?? 0, reserved: details.reserved ?? 0, remediation: details.remediation || null } });
  }

  #settleResource(run, task, outcome = 'settled', runtime = null) {
    const reservationId = task.resourceReservationId;
    if (!reservationId) return null;
    const governor = this.#resourceGovernor(run, task);
    const reservation = governor.get(reservationId);
    if (!reservation || reservation.status !== 'active') return reservation;
    // Provider usage is accepted only after its own attestation. Until then account
    // the full reservation so retries and failed providers cannot reset a ceiling.
    // Price is not available from the mounted adapters, so finite USD remains the
    // reservation amount rather than becoming an invented zero.
    const usageSource = runtime?.usage && typeof runtime.usage === 'object' ? runtime.usage : null;
    const tokenFields = [
      ['input_tokens', 'inputTokens'],
      ['cached_input_tokens', 'cachedTokens'],
      ['output_tokens', 'outputTokens'],
      ['reasoning_output_tokens', 'reasoningTokens'],
    ];
    const usageFields = usageSource
      ? tokenFields.map(([field]) => Number(usageSource[field]))
      : [];
    const completeUsage = usageFields.length === tokenFields.length
      && usageFields.every((value) => Number.isFinite(value) && value >= 0);
    // Ollama's local-response attestation proves the exact loopback model
    // response but intentionally does not claim external provider identity.
    // Account only counters the adapter actually returned; missing components
    // remain unknown to the runtime record and are not fabricated here.
    const ollamaUsage = task.worker === 'ollama'
      && runtime?.provider === 'ollama'
      && runtime?.attestation === 'local_response'
      && runtime?.effective?.model === this.#providerConfig('ollama')?.model
      && usageSource
      && tokenFields.some(([field]) => Number.isFinite(Number(usageSource[field])) && Number(usageSource[field]) >= 0);
    const verified = (runtime?.verified === true && completeUsage) || ollamaUsage;
    const usage = verified ? {
      ...(ollamaUsage
        ? Object.fromEntries(tokenFields
          .filter(([field]) => Number.isFinite(Number(usageSource[field])) && Number(usageSource[field]) >= 0)
          .map(([field, target]) => [target, Number(usageSource[field])]))
        : {
          inputTokens: usageFields[0],
          cachedTokens: usageFields[1],
          outputTokens: usageFields[2],
          reasoningTokens: usageFields[3],
        }),
      // A provider may attest tokens but omit price. Preserve the entire USD
      // reservation in that case; only a finite reported price may replace it.
      usd: usageSource.usd != null && usageSource.usd !== '' && Number.isFinite(Number(usageSource.usd)) && Number(usageSource.usd) >= 0
        ? Number(usageSource.usd)
        : reservation.reserved.usd,
      timeMs: Number.isFinite(runtime.durationMs) && runtime.durationMs >= 0 ? runtime.durationMs : reservation.reserved.timeMs,
    } : reservation.reserved;
    return governor.settle(reservationId, { ...usage, outcome });
  }

  #heartbeat(taskId, attempt) {
    const task = this.state.tasks.find((item) => item.id === taskId);
    const lease = task?.lease;
    if (!lease || lease.attempt !== attempt) return false;
    if (this.clock() - Date.parse(lease.heartbeatAt) < HEARTBEAT_MIN_MS) return false;
    this.transact(() => {
      const fresh = this.#require('tasks', taskId, 'task');
      if (!fresh.lease || fresh.lease.attempt !== attempt) return;
      fresh.lease.heartbeatAt = this.now();
      fresh.lease.leaseUntil = new Date(this.clock() + fresh.lease.ttlMs).toISOString();
    });
    return true;
  }

  #recordWorkerProcess(taskId, attempt, { pid = null, pgid = null } = {}) {
    this.transact(() => {
      const fresh = this.#require('tasks', taskId, 'task');
      if (!fresh.lease || fresh.lease.attempt !== attempt) return;
      fresh.lease.workerPid = pid ?? null;
      fresh.lease.workerPgid = pgid ?? pid ?? null;
    });
  }

  // Must run inside a transaction. Reaps and requeues every orphaned attempt of one run.
  #recoverRun(run) {
    let recovered = 0;
    for (const task of this.#tasks(run.id)) {
      const reason = this.#orphanReason(task);
      if (!reason) continue;
      this.#reap(run, task);
      this.#orphanTask(run, task, reason);
      recovered += 1;
    }
    if (recovered) this.#settleRun(run);
    return recovered;
  }

  #reap(run, task) {
    const pgid = task.lease?.workerPgid;
    if (!pgid || !pidAlive(pgid)) return false;
    // Never let recovery/cancellation kill the engine process that is handling
    // the request. A pool caller may report its host pid while no separate
    // worker process group exists; expiry still fences that claim without a
    // self-inflicted process termination.
    if (Number(pgid) === process.pid) return false;
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      try { process.kill(pgid, 'SIGTERM'); } catch { return false; }
    }
    const timer = setTimeout(() => {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    }, REAP_KILL_GRACE_MS);
    timer.unref?.();
    this.#event('worker.reaped', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: { attempt: task.lease.attempt, pid: task.lease.workerPid, pgid },
    });
    return true;
  }

  #orphanTask(run, task, reason) {
    const agent = this.state.agents.find((item) => item.id === task.agentId);
    const attempt = task.attempts;
    this.#reconcileTaskWorkspaceWriteBeforeTerminal(run, task, 'orphan_recovery');
    if (task.resourceReservationId) this.#settleResource(run, task, 'recovered');
    task.lease = null;
    task.error = reason;
    this.inflight.delete(task.id);
    if (attempt <= (task.maxRetries ?? 1)) {
      if (isTaskWorkspaceWriteRequested(task)) {
        task.workspaceWriteApproval = null;
        task.status = TASK_STATUS.awaiting_approval;
        if (agent) agent.status = 'waiting_approval';
        this.#event('task.workspace_write_approval_required', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          payload: { attempt: attempt + 1, key: task.key || null, reason: 'orphan_recovery' },
        });
        return;
      }
      task.status = TASK_STATUS.ready;
      if (agent) agent.status = 'queued';
      this.#event('task.requeued', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { attempt, key: task.key || null, reason } });
      return;
    }
    task.status = TASK_STATUS.failed;
    task.endedAt = this.now();
    if (agent) agent.status = 'failed';
    this.#event('task.failed', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: { attempt, key: task.key || null, error: reason, retryable: false, injected: false, fatal: false, orphaned: true },
    });
  }

  // Recovery on start: only writes when an orphaned attempt actually exists.
  recoverOrphans() {
    const runIds = new Set(this.state.tasks.filter((task) => task.status === TASK_STATUS.running).map((task) => task.runId));
    if (!runIds.size) return 0;
    const candidates = [...runIds].filter((runId) => this.state.tasks.some((task) => task.runId === runId && this.#orphanReason(task)));
    if (!candidates.length) return 0;
    return this.transact(() => {
      let recovered = 0;
      for (const runId of candidates) {
        const run = this.state.runs.find((item) => item.id === runId);
        if (run) recovered += this.#recoverRun(run);
      }
      return recovered;
    });
  }

  // This runs before generic lease expiry and orphan recovery. It is narrowly
  // limited to a still-claimed deterministic workspace effect whose target can
  // be proved byte-for-byte against its original identity and private journal.
  #recoverTaskWorkspaceWrites({ reclaimRecoverable = false } = {}) {
    let recovered = 0;
    const claims = this.effects.list({ status: reclaimRecoverable ? 'recoverable' : 'claimed' });
    for (const claim of claims) {
      try {
        const identity = claim.identity;
        const run = this.state.runs.find((item) => item.id === identity.runId);
        const task = this.state.tasks.find((item) => item.id === identity.taskId);
        if (!run || !task || task.runId !== run.id || !isTaskWorkspaceWriteRequested(task)
          || task.status !== TASK_STATUS.running || task.attempts !== identity.attempt) continue;
        let activeClaim = claim;
        if (reclaimRecoverable) {
          if (!workspaceWriteApprovalMatches(task.workspaceWriteApproval, identity)) continue;
          activeClaim = this.effects.claim({
            ...identity,
            approvalId: task.workspaceWriteApproval.approvalId,
            ownerId: this.driverId,
            requestId: `${task.nonce}:workspace-write-recovery:${identity.attempt}:${claim.fence + 1}`,
          });
        }
        const receipt = this.taskWorkspaceWrites.recover({
          claim: activeClaim,
          workspaceRoot: this.store.workspacesDir,
          workspaceDir: this.store.workspacePath(run.id, task.id),
          journalRoot: join(this.store.dataDir, TASK_WORKSPACE_WRITE_JOURNAL_DIR),
          expectedBytes: taskWorkspaceWriteBytes(identity),
          revalidate: () => this.#revalidateTaskWorkspaceWrite({ runId: run.id, taskId: task.id, attempt: identity.attempt, identity, phase: 'recovery' }),
        });
        if (!receipt) continue;
        this.transact(() => {
          const freshRun = this.#require('runs', run.id, 'run');
          const freshTask = this.#require('tasks', task.id, 'task');
          if (freshTask.status !== TASK_STATUS.running || freshTask.attempts !== identity.attempt) return;
          const agent = this.state.agents.find((item) => item.id === freshTask.agentId);
          if (freshTask.resourceReservationId) {
            const settled = this.#settleResource(freshRun, freshTask, 'succeeded');
            if (settled) this.#event('resource.settled', {
              projectId: freshRun.projectId,
              runId: freshRun.id,
              taskId: freshTask.id,
              payload: { attempt: identity.attempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed },
            });
          }
          freshTask.lease = null;
          freshTask.status = TASK_STATUS.succeeded;
          freshTask.output = this.#workspaceWriteTaskResult(receipt);
          freshTask.endedAt = this.now();
          freshTask.error = null;
          freshTask.errorCode = null;
          if (agent) agent.status = 'complete';
          this.#event('task.completed', {
            projectId: freshRun.projectId,
            runId: freshRun.id,
            taskId: freshTask.id,
            payload: { summary: freshTask.output.summary, attempt: identity.attempt, key: freshTask.key || null, recovered: true },
          });
          this.#settleRun(freshRun);
        });
        recovered += 1;
      } catch {
        // Missing bytes, a revoked capability, or a stale lease must fall into
        // normal recovery. Never fabricate a terminal receipt from ambiguity.
      }
    }
    return recovered;
  }

  // Terminal task transitions cannot hide a post-byte, pre-receipt window.
  // While the task is still running and its exact approval is current, finish
  // only a claim whose private journal and fixed target prove the original
  // bytes. Any ambiguity or revalidation refusal aborts the outer transition,
  // leaving the task/claim intact rather than stranding an unreceipted write.
  #reconcileTaskWorkspaceWriteBeforeTerminal(run, task, reason) {
    if (!isTaskWorkspaceWriteRequested(task) || task.status !== TASK_STATUS.running) return null;
    const claim = this.effects.list({ runId: run.id, taskId: task.id, status: 'claimed' }).find((item) => (
      item.identity?.projectId === run.projectId
      && item.identity?.runId === run.id
      && item.identity?.taskId === task.id
      && item.identity?.attempt === task.attempts
    ));
    if (!claim) return null;
    const receipt = this.taskWorkspaceWrites.recover({
      claim,
      workspaceRoot: this.store.workspacesDir,
      workspaceDir: this.store.workspacePath(run.id, task.id),
      journalRoot: join(this.store.dataDir, TASK_WORKSPACE_WRITE_JOURNAL_DIR),
      expectedBytes: taskWorkspaceWriteBytes(claim.identity),
      revalidate: () => this.#revalidateTaskWorkspaceWrite({
        runId: run.id,
        taskId: task.id,
        attempt: claim.identity.attempt,
        identity: claim.identity,
        phase: 'recovery',
      }),
    });
    if (!receipt) return null;
    task.output = this.#workspaceWriteTaskResult(receipt);
    this.#event('task.workspace_write_reconciled', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: {
        attempt: task.attempts,
        claimId: receipt.claimId,
        receiptId: receipt.receiptId,
        status: receipt.status,
        receiptFingerprint: receipt.receiptFingerprint,
        reason,
      },
    });
    return receipt;
  }

  #freeSlots(run) {
    const running = this.#tasks(run.id).filter((task) => task.status === TASK_STATUS.running).length;
    const cap = run.maxConcurrency == null || run.maxConcurrency <= 0 ? Infinity : run.maxConcurrency;
    return Math.max(0, cap - running);
  }

  #runConcurrency(value, explicit) {
    if (!this.live) return value;
    if (this.execution.mode === 'mixed') {
      if (value == null || value <= 0) return this.defaultConcurrency;
      if (!Number.isInteger(value)) throw new Error(`Run concurrency must be an integer; got ${value}`);
      return value;
    }
    const cap = this.execution.codex.maxConcurrency;
    if (value == null || value <= 0) return cap;
    if (!Number.isInteger(value)) throw new Error(`Run concurrency must be an integer; got ${value}`);
    if (value > cap) {
      if (explicit) throw new Error(`Live Codex runs are capped at ${cap} concurrent workers; requested ${value}`);
      return cap;
    }
    return value;
  }

  #assertLivePlan(plan) {
    if (this.execution.mode === 'mixed') {
      const providers = new Map(this.listProviders().map((provider) => [provider.id, provider]));
      for (const task of plan.tasks) {
        const effectiveTask = task.templateId
          ? applyTemplateToTask({ ...task, config: null }, task, this.templates.get(task.templateId, task.templateVersion ?? null))
          : task;
        const providerId = effectiveTask.worker || 'local';
        if (providerId === 'engine' && effectiveTask.kind === 'adopt') continue;
        const provider = providers.get(providerId);
        if (!provider?.configured) {
          throw new Error(`Mixed execution refuses task "${task.title}" on unconfigured provider "${providerId}"; there is no fallback`);
        }
        if (!provider.contract?.adapter?.implementation?.mounted) {
          throw new Error(`Mixed execution refuses task "${task.title}" on provider "${providerId}" because no worker adapter is mounted`);
        }
        const config = this.#providerConfig(providerId);
        if (['codex', 'claude', 'ollama', 'command'].includes(providerId)) {
          const codexRoleBinding = providerId === 'codex' ? this.#assertCodexRoleRuntime(effectiveTask) : null;
          const requestedModel = effectiveTask.model ?? effectiveTask.config?.effective?.harness?.model ?? effectiveTask.config?.model ?? (providerId === 'codex' ? codexRoleBinding.model : providerId === 'ollama' ? null : config?.model);
          const requestedEffort = effectiveTask.effort ?? effectiveTask.config?.effective?.harness?.effort ?? effectiveTask.config?.effort ?? (providerId === 'codex' ? codexRoleBinding.effort : config?.effort);
          if ((providerId !== 'codex' && (requestedModel !== config?.model || (!['ollama', 'command'].includes(providerId) && requestedEffort !== config?.effort) || (providerId === 'command' && requestedEffort != null)))
            || (providerId === 'codex' && (requestedModel !== codexRoleBinding.model || requestedEffort !== codexRoleBinding.effort))) {
            const expected = providerId === 'codex' ? codexRoleBinding : config;
            throw new Error(`Mixed execution task "${task.title}" must use configured ${providerId} runtime ${expected?.model}${providerId === 'ollama' ? '' : `/${expected?.effort}`}; there is no substitution`);
          }
          if (providerId === 'ollama') this.#validateOllamaTask(task, effectiveTask);
          if (providerId === 'command') this.#validateExternalHarnessTask(task, effectiveTask);
        }
      }
      return;
    }
    for (const task of plan.tasks) {
      const effectiveTask = task.templateId
        ? applyTemplateToTask({ ...task, config: null }, task, this.templates.get(task.templateId, task.templateVersion ?? null))
        : task;
      const allowed = effectiveTask.worker === 'codex' || (effectiveTask.worker === 'engine' && effectiveTask.kind === 'adopt');
      if (!allowed) {
        throw new Error(`Live Codex mode refuses task "${task.title}" on worker "${effectiveTask.worker}": worker tasks must run on codex with their exact role-bound runtime; there is no fallback`);
      }
      if (effectiveTask.worker === 'codex') this.#assertCodexRoleRuntime(effectiveTask);
    }
  }

  #refuseWorker(task, worker) {
    if (!worker) return `No worker named "${task.worker}" is registered; refusing to fall back to another worker`;
    if (worker.id === 'engine' && task.kind !== 'adopt') return 'The engine executor only applies approved proposals';
    return null;
  }

  #inspectMcpSource(task) {
    const readPaths = task.readPaths
      ?? task.config?.effective?.filesystem?.readPaths
      ?? task.config?.effective?.readPaths
      ?? [];
    if (!Array.isArray(readPaths) || readPaths.length !== 1) {
      throw new AosError('mcp_read_paths_invalid', 'MCP staged-text execution requires exactly one declared relative read path', { statusCode: 409 });
    }
    const relativePath = normalizeMcpRelativePath(readPaths[0]);
    if (!relativePath) throw new AosError('mcp_read_paths_invalid', 'MCP staged-text execution requires one relative read path', { statusCode: 409 });
    if (MCP_SENSITIVE_NAME.test(relativePath)) throw new AosError('mcp_sensitive_source', 'MCP staged-text execution refuses sensitive source files', { statusCode: 409 });

    const root = resolve(this.projectReadRoot);
    let sourcePath = resolve(root, ...relativePath.split('/'));
    const rootRelative = relative(root, sourcePath);
    if (rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
      throw new AosError('mcp_read_path_escape', 'MCP staged-text path escapes the configured project read root', { statusCode: 409 });
    }
    try {
      assertMcpPathChain(root, relativePath);
      const source = boundedMcpFileSnapshot(sourcePath);
      const text = source.bytes.toString('utf8');
      if (MCP_SENSITIVE_CONTENT.test(text)) throw new AosError('mcp_sensitive_source', 'MCP staged-text execution refuses sensitive source content', { statusCode: 409 });
      return {
        root,
        sourcePath,
        relativePath,
        fingerprint: fingerprint(source.bytes.toString('base64')),
        size: source.stat.size,
        dev: source.stat.dev,
        ino: source.stat.ino,
        mtimeMs: source.stat.mtimeMs,
        ctimeMs: source.stat.ctimeMs,
      };
    } catch (error) {
      if (error instanceof AosError) throw error;
      throw new AosError('mcp_source_unavailable', 'MCP staged-text source could not be safely inspected', { statusCode: 409 });
    }
  }

  #stageMcpSource(source, workspace) {
    const fresh = this.#inspectMcpSource({ readPaths: [source.relativePath] });
    if (!sameMcpSourceIdentity(source, fresh)) {
      throw new AosError('mcp_source_changed', 'MCP staged-text source changed before workspace staging', { statusCode: 409 });
    }
    const stagedPath = resolve(workspace.dir, MCP_STAGING_NAME);
    const workspaceRelative = relative(workspace.dir, stagedPath);
    if (workspaceRelative !== MCP_STAGING_NAME || workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative)) {
      throw new AosError('mcp_staging_invalid', 'MCP staged-text workspace staging path is invalid', { statusCode: 409 });
    }
    try {
      if (existsSync(stagedPath)) {
        const existing = lstatSync(stagedPath);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new AosError('mcp_staging_invalid', 'MCP staged-text workspace staging path is not a regular file', { statusCode: 409 });
      }
      copyFileSync(source.sourcePath, stagedPath);
      const staged = boundedMcpFileSnapshot(stagedPath);
      const after = this.#inspectMcpSource({ readPaths: [source.relativePath] });
      if (!sameMcpSourceIdentity(source, after) || staged.fingerprint !== source.fingerprint || staged.stat.size !== source.size) {
        try { unlinkSync(stagedPath); } catch { /* leave no additional failure detail */ }
        throw new AosError('mcp_source_changed', 'MCP staged-text source changed during workspace staging', { statusCode: 409 });
      }
      return { relativePath: MCP_STAGING_NAME, absolutePath: stagedPath, fingerprint: staged.fingerprint, size: staged.stat.size };
    } catch (error) {
      try { unlinkSync(stagedPath); } catch { /* staging cleanup is best effort */ }
      if (error instanceof AosError) throw error;
      throw new AosError('mcp_staging_failed', 'MCP staged-text source could not be copied into the workspace', { statusCode: 409 });
    }
  }

  async #executeTask(runId, taskId) {
    // Dispatch-time mutations happen under the lock against freshly resolved records.
    const prepared = this.transact(() => {
      const run = this.#require('runs', runId, 'run');
      const task = this.#require('tasks', taskId, 'task');
      if (task.status !== TASK_STATUS.ready) return null;
      const agent = this.state.agents.find((item) => item.id === task.agentId);
      task.status = TASK_STATUS.running;
      task.attempts += 1;
      task.sessionId = null;
      task.startedAt = task.startedAt || this.now();
      const attempt = task.attempts;
      if (agent) agent.status = 'active';
      const emitNow = (type, payload = {}) => this.#event(type, {
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        payload: { attempt, key: task.key || null, ...payload },
      });

      const worker = this.workers.get(task.worker || 'local');
      const refusal = this.#refuseWorker(task, worker);
      if (refusal) {
        const code = worker ? 'worker_not_allowed' : 'adapter_not_registered';
        emitNow('worker.refused', { worker: task.worker || null, code, reason: refusal });
        this.#failTask(run, task, agent, refusal, { retryable: false, code });
        return null;
      }
      if (worker.id !== 'engine') {
        try {
          const provider = this.listProviders().find((item) => item.id === worker.id);
          // Local mode has always allowed callers to mount deterministic worker
          // implementations directly on the registry (for example, a timed
          // test worker). Provider contracts apply to catalog-backed adapters;
          // mixed/live plans reject uncatalogued workers during plan admission.
          if (provider || this.live) assertProviderDispatchable(provider, { workerId: worker.id });
        } catch (error) {
          const code = error.code || 'adapter_unavailable';
          emitNow('worker.refused', { worker: worker.id, code, reason: error.message });
          this.#failTask(run, task, agent, error.message, { retryable: false, code });
          return null;
        }
      }
      try {
        task.capabilityMounts = this.capabilities.resolveTask(task, {
          projectId: run.projectId,
          roleId: task.presetId || task.kind,
          workerId: agent?.id || null,
          runId: run.id,
        });
      } catch (error) {
        const code = error.code || 'capability_unavailable';
        emitNow('capability.refused', { code, reason: error.message });
        this.#failTask(run, task, agent, error.message, { retryable: false, code });
        return null;
      }

      if (isTaskWorkspaceWriteRequested(task)) {
        try {
          assertTaskWorkspaceWriteAdmission(task, task.capabilityMounts);
          const identity = buildTaskWorkspaceWriteIdentity({
            projectId: run.projectId,
            runId: run.id,
            taskId: task.id,
            attempt,
            capabilityReference: task.capabilityMounts[0].reference,
            capabilityFingerprint: task.capabilityMounts[0].fingerprint,
          });
          if (!workspaceWriteApprovalMatches(task.workspaceWriteApproval, identity)) {
            this.#requireWorkspaceWriteApproval(run, task, agent, attempt, 'approval_missing_or_stale');
            return null;
          }
        } catch (error) {
          const code = error.code || 'workspace_write_admission_refused';
          emitNow('capability.refused', { code, reason: String(error.message || 'Task-workspace write admission failed').slice(0, 500) });
          this.#failTask(run, task, agent, String(error.message || 'Task-workspace write admission failed').slice(0, 500), { retryable: false, code });
          return null;
        }
      }

      let mcpSource = null;
      const mcpRequested = Boolean(task.capabilityExecution && (
        (Array.isArray(task.capabilities?.mcp) && task.capabilities.mcp.length > 0)
        || task.capabilityMounts.some((mount) => mount.kind === 'mcp')
      ));
      if (mcpRequested) {
        try {
          // This pure helper is intentionally before reservation and workspace
          // claim. It rechecks the exact mount, policy, selector and timeout.
          assertMcpTaskAdmission(task, task.capabilityMounts);
          mcpSource = this.#inspectMcpSource(task);
        } catch (error) {
          const code = error.code || 'mcp_admission_refused';
          emitNow('capability.refused', { code, reason: safeMcpErrorMessage(error) });
          this.#failTask(run, task, agent, safeMcpErrorMessage(error), { retryable: false, code });
          return null;
        }
      }

      try {
        const governor = this.#resourceGovernor(run, task);
        const contract = this.listProviders().find((item) => item.id === worker.id)?.contract;
        const providerCap = contract?.quota?.maxConcurrency ?? null;
        const projectCap = this.#require('projects', run.projectId, 'project').maxConcurrency ?? null;
        const runCap = run.maxConcurrency ?? null;
        const activeProvider = (this.state.resourceReservations || []).filter((item) => item.status === 'active' && item.providerId === worker.id).length;
        const activeProject = (this.state.resourceReservations || []).filter((item) => item.status === 'active' && item.projectId === run.projectId).length;
        const activeRun = (this.state.resourceReservations || []).filter((item) => item.status === 'active' && item.runId === run.id).length;
        if (providerCap != null && activeProvider >= providerCap) {
          throw new ResourceGovernorError('resource_capacity_exhausted', `Provider ${worker.id} has no remaining reserved capacity`, { details: { dimension: 'concurrency', limit: providerCap, consumed: 0, reserved: activeProvider, remediation: `Wait for a ${worker.id} attempt to settle or raise the enforced provider capacity.` } });
        }
        if (projectCap != null && activeProject >= projectCap) {
          throw new ResourceGovernorError('resource_capacity_exhausted', `Project ${run.projectId} has no remaining reserved capacity`, { details: { dimension: 'concurrency', limit: projectCap, consumed: 0, reserved: activeProject, remediation: 'Wait for a project attempt to settle or raise the project concurrency limit.' } });
        }
        if (runCap != null && activeRun >= runCap) {
          throw new ResourceGovernorError('resource_capacity_exhausted', `Run ${run.id} has no remaining reserved capacity`, { details: { dimension: 'concurrency', limit: runCap, consumed: 0, reserved: activeRun, remediation: 'Wait for a run attempt to settle or raise the run concurrency limit.' } });
        }
        const reservation = governor.reserve(this.#resourceRequest(run, task, worker, attempt));
        task.resourceReservationId = reservation.id;
        task.resourceAttemptId = reservation.attemptId;
        task.resourceReservations = [...(task.resourceReservations || []), reservation.id];
        this.#event('resource.reserved', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          payload: {
            attempt,
            reservationId: reservation.id,
            provider: worker.id,
            profileFingerprint: providerProfile(this.execution, worker.id, task).fingerprint,
            reserved: reservation.reserved,
          },
        });
      } catch (error) {
        if (error?.code === 'resource_capacity_exhausted') {
          task.status = TASK_STATUS.ready;
          task.attempts = Math.max(0, task.attempts - 1);
          if (task.attempts === 0) task.startedAt = null;
          task.error = null;
          task.errorCode = null;
          if (agent) agent.status = 'queued';
          emitNow('resource.deferred', {
            code: error.code,
            dimension: error.details?.dimension || 'concurrency',
            limit: error.details?.limit ?? null,
            reserved: error.details?.reserved ?? 0,
          });
          return null;
        }
        this.#resourceGate(run, task, agent, error);
        return null;
      }

      let workspace;
      try {
        workspace = claimWorkspace({
          root: this.store.workspacesDir,
          runId: run.id,
          taskId: task.id,
          agentId: agent?.id || 'engine',
          now: this.now(),
        });
      } catch (error) {
        // Workspace acquisition happens after reservation. Any failure here,
        // including filesystem/ownership errors that are not IsolationError,
        // must close that reservation before returning a terminal task result.
        if (task.resourceReservationId) {
          try {
            const settled = this.#settleResource(run, task, 'workspace_claim_failed');
            if (settled) this.#event('resource.settled', {
              projectId: run.projectId,
              runId: run.id,
              taskId: task.id,
              payload: { attempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed },
            });
          } catch {
            try {
              this.#resourceGovernor(run, task).release(task.resourceReservationId, { reason: 'workspace_claim_failed' });
            } catch {
              // Preserve the original workspace error. Recovery still sees the
              // reservation if both terminal paths fail.
            }
          }
        }
        emitNow(error instanceof IsolationError ? 'isolation.denied' : 'workspace.claim_failed', { error: String(error.message || 'workspace claim failed').slice(0, 500) });
        this.#failTask(run, task, agent, String(error.message || 'workspace claim failed').slice(0, 500), { retryable: false, code: 'workspace_claim_failed' });
        return null;
      }
      task.workspace = workspace.dir;
      if (agent) agent.workspace = workspace.dir;

      const controller = new AbortController();
      this.inflight.set(task.id, { controller, runId: run.id, worker: worker.id });
      const profile = providerProfile(this.execution, worker.id, task);
      task.lease = this.#newLease(task, attempt, worker);
      const running = this.#tasks(run.id).filter((item) => item.status === TASK_STATUS.running).length;
      emitNow('worker.dispatched', { worker: worker.id, running, cap: run.maxConcurrency ?? null, profile });
      this.#event('task.started', {
        projectId: run.projectId,
        runId: run.id,
        taskId: task.id,
        payload: { attempt, key: task.key || null, provider: worker.id, profileFingerprint: profile.fingerprint },
      });
      return { attempt, worker, workspace, controller, agentId: agent?.id ?? null, projectId: run.projectId, key: task.key || null, profile, mcpSource };
    });
    if (!prepared) return;
    const { attempt, worker, workspace, controller, agentId, projectId, key, profile, mcpSource } = prepared;
    const freshRun = () => this.#require('runs', runId, 'run');
    const freshTask = () => this.#require('tasks', taskId, 'task');
    let boundSessionId = null;
    const bindSession = (harnessReference) => {
      if (!harnessReference) return boundSessionId;
      const session = this.sessions.capture({
        provider: worker.id,
        harnessReference,
        projectId,
        runId,
        taskId,
        agentId,
        roleId: freshTask().presetId || freshTask().kind,
        attempt,
      });
      boundSessionId = session.id;
      this.transact(() => { this.#require('tasks', taskId, 'task').sessionId = session.id; });
      return session.id;
    };
    const emit = (type, payload = {}) => {
      const safePayload = { ...payload };
      if (safePayload.threadId) {
        safePayload.sessionId = bindSession(safePayload.threadId);
        delete safePayload.threadId;
      }
      return this.#event(type, { projectId, runId, taskId, payload: { attempt, key, ...safePayload } });
    };

    let stagedMcp = null;
    if (mcpSource) {
      try {
        // Source inspection happened before reservation/claim. This second
        // inspection is immediately after claim and immediately before spawn.
        stagedMcp = this.#stageMcpSource(mcpSource, workspace);
      } catch (error) {
        controller.abort();
        const code = error.code || 'mcp_staging_failed';
        const message = safeMcpErrorMessage(error);
        this.transact(() => {
          const run = freshRun();
          const task = freshTask();
          const agent = this.state.agents.find((item) => item.id === agentId);
          if (task.resourceReservationId) {
            const settled = this.#settleResource(run, task, 'mcp_staging_failed');
            if (settled) this.#event('resource.settled', { projectId, runId, taskId, payload: { attempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed } });
          }
          if (task.lease?.attempt === attempt) task.lease = null;
          this.#event('capability.refused', { projectId, runId, taskId, payload: { attempt, key, code, reason: message } });
          this.#failTask(run, task, agent, message, { retryable: false, code });
        });
        this.inflight.delete(taskId);
        this.#releaseSlot();
        return;
      }
    }

    let systemPrompt = null;
    let renderFailure = null;
    if (freshTask().presetId) {
      try {
        const rendered = this.presets.render(freshTask().presetId, { version: freshTask().presetVersion ?? null, variables: this.#promptVariables(freshRun(), freshTask()) });
        systemPrompt = rendered.text;
        emit('prompt.rendered', { presetId: rendered.id, presetVersion: rendered.version, chars: rendered.text.length });
      } catch (error) {
        renderFailure = error;
        emit('prompt.render_failed', { presetId: freshTask().presetId, code: error.code || 'error', error: error.message });
      }
    }

    const ctx = {
      goal: this.#require('goals', freshRun().goalId, 'goal'),
      run: freshRun(),
      task: freshTask(),
      workspace,
      attempt,
      signal: controller.signal,
      repoRoot: this.#providerConfig(worker.id)?.repoRoot || null,
      providerProfile: profile,
      eventsPath: this.store.eventsPath,
      dependencies: this.#dependencyOutputs(freshTask()),
      systemPrompt,
      emit,
      heartbeat: () => this.#heartbeat(taskId, attempt),
      recordWorkerProcess: (info) => this.#recordWorkerProcess(taskId, attempt, info),
      recordEvidence: (partial) => this.transact(() => this.#recordEvidence(freshRun(), freshTask(), worker, workspace, partial)),
      synthesize: () => this.transact(() => this.#synthesize(freshRun(), freshTask())),
      writeRetrospective: () => this.transact(() => this.#writeRetrospective(freshRun(), freshTask())),
      applyApprovedProposal: () => this.transact(() => this.#applyApprovedProposal(freshRun())),
    };

    let result;
    try {
      const task = freshTask();
      if (renderFailure) throw Object.assign(new Error(`Preset render failed: ${renderFailure.message}`), { fatal: false, retryable: false, code: renderFailure.code });
      const capabilityExecution = await this.#executeMountedCapability({
        run: freshRun(), task, agentId, attempt, signal: controller.signal, workspace, stagedMcp,
      });
      if (capabilityExecution?.taskWorkspaceWrite) {
        result = capabilityExecution.taskResult;
      } else if (capabilityExecution && stagedMcp) {
        result = this.#mcpTaskResult(capabilityExecution, workspace, stagedMcp);
      } else {
        if (capabilityExecution) ctx.capabilityExecution = capabilityExecution;
        result = task.injectFault && task.injectFault.attempt === attempt
          ? await this.#injectFault(freshRun(), task, workspace, controller.signal, emit)
          : await worker.execute(task, ctx);
      }
    } catch (error) {
      result = { status: 'failed', error: error.message, code: error.code, retryable: error.retryable === false ? false : !error.fatal, fatal: Boolean(error.fatal), details: error.details };
    } finally {
      this.inflight.delete(taskId);
      this.#releaseSlot();
    }
    result = result || { status: 'failed', error: 'Worker returned no result' };
    if (result.status === TASK_STATUS.awaiting_user) {
      try {
        result = { ...result, questions: validateTaskQuestions(result.questions) };
      } catch (error) {
        // Invalid worker questions fail closed as a normal, non-retryable task
        // failure. No question/wait state is touched before this conversion.
        result = {
          status: 'failed',
          retryable: false,
          fatal: false,
          code: error.code || 'task_question_payload_invalid',
          error: error.message,
          details: error.details,
        };
      }
    }
    this.transact(() => {
      const run = freshRun();
      const task = freshTask();
      const agent = this.state.agents.find((item) => item.id === agentId);
      if (result.runtime) result.runtime.profile = result.runtime.profile || profile;

      // Bind a provider reference before settling the reservation. A provider
      // receipt without an AOS session is not publishable; if binding fails,
      // convert the attempt to a terminal failure while keeping its reservation
      // terminal as well. This prevents the failed transaction from restoring an
      // active reservation that the crash path cannot see.
      if (result.runtime?.threadId && !boundSessionId) {
        try {
          boundSessionId = this.sessions.capture({
            provider: result.runtime.provider || worker.id,
            harnessReference: result.runtime.threadId,
            projectId: run.projectId,
            runId: run.id,
            taskId: task.id,
            agentId,
            roleId: task.presetId || task.kind,
            attempt,
          }).id;
        } catch (error) {
          result = {
            status: 'failed',
            retryable: false,
            fatal: true,
            code: 'session_binding_failed',
            error: `Provider session could not be bound to AOS authority: ${String(error.message || 'unknown error').slice(0, 300)}`,
          };
        }
      }
      if (task.resourceReservationId) {
        try {
          const settled = this.#settleResource(run, task, result.status || 'failed', result.runtime || null);
          if (settled) this.#event('resource.settled', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { attempt, reservationId: settled.id, status: settled.status, consumed: settled.consumed } });
        } catch (error) {
          result = { status: 'failed', retryable: false, fatal: false, code: error.code || 'resource_settlement_failed', error: error.message, details: error.details };
        }
      }
      if (result.runtime) {
        let sessionId = boundSessionId || null;
        if (sessionId) task.sessionId = sessionId;
        task.runtime = [...(task.runtime || []), summarizeRuntime(result.runtime, { sessionId })];
      }
      if (task.lease && task.lease.attempt === attempt) task.lease = null;

      if (task.status !== TASK_STATUS.running) {
        emit('worker.result_discarded', { status: result.status, taskStatus: task.status });
        return;
      }

      if (result.status === 'succeeded') {
        // A worker may only expand the graph as part of a verified successful
        // result. Delegation is processed before this task becomes terminal so a
        // rejected proposal fails the originating task atomically.
        const delegation = this.#processDelegationResult(run, task, agent, worker, attempt, result);
        if (delegation?.status === 'rejected') {
          this.#failTask(run, task, agent, `Delegation proposal rejected (${delegation.errorCode || 'delegation_rejected'})`, {
            retryable: false,
            fatal: false,
            code: delegation.errorCode || 'delegation_rejected',
          });
        } else {
          const storedResult = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
            ? (() => {
              const value = structuredClone(result.result);
              delete value.delegation;
              return value;
            })()
            : result.result;
          task.status = TASK_STATUS.succeeded;
          task.output = { summary: result.summary, artifacts: result.artifacts || [], ...(storedResult ? { result: storedResult } : {}) };
          task.endedAt = this.now();
          if (agent) agent.status = 'complete';
          if (result.result) this.#absorbResult(run, task, worker, workspace, result.result);
          this.#event('task.completed', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { summary: result.summary, attempt, key: task.key || null } });
        }
      } else if (result.status === TASK_STATUS.awaiting_user) {
        const askedAt = this.now();
        const wasManuallyPaused = run.status === RUN_STATUS.paused;
        const questions = result.questions.map((question) => ({
          id: newId('task').replace(/^tsk_/, 'q_'),
          prompt: question.prompt,
          ...(question.reason ? { reason: question.reason } : {}),
          required: true,
          answer: null,
          askedAt,
          askedBy: { worker: worker.id, agentId: agentId || null },
          attempt,
          answeredAt: null,
          answeredBy: null,
        }));
        task.status = TASK_STATUS.awaiting_user;
        // A later wait is a new open batch. Keep all earlier answered questions
        // so the operator audit and the next worker prompt remain complete.
        task.questions = [...(Array.isArray(task.questions) ? task.questions : []), ...questions];
        task.wait = { code: 'operator_question', questionIds: questions.map((question) => question.id), attempt, at: askedAt };
        task.blockedBy = null;
        task.error = null;
        task.errorCode = null;
        task.endedAt = null;
        if (agent) agent.status = 'waiting_user';
        this.#event('task.awaiting_user', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          payload: { questionIds: questions.map((question) => question.id), questionCount: questions.length, attempt },
        });
        if (!wasManuallyPaused && run.status !== RUN_STATUS.awaiting_user) {
          run.status = RUN_STATUS.awaiting_user;
          run.updatedAt = askedAt;
          this.#event('run.awaiting_user', {
            projectId: run.projectId,
            runId: run.id,
            payload: { taskId: task.id, questionIds: questions.map((question) => question.id), questionCount: questions.length },
          });
        }
      } else if (result.status === 'cancelled') {
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        if (agent) agent.status = 'cancelled';
        emit('task.cancelled', { reason: result.error || 'cancelled' });
      } else {
        const error = result.error || result.summary || 'Worker failed';
        this.#failTask(run, task, agent, error, {
          retryable: result.retryable !== false,
          injected: Boolean(result.injected),
          fatal: Boolean(result.fatal),
          code: result.code || null,
        });
        if (result.fatal) this.#abortRun(run, error, result.details);
      }
    });
  }

  #mcpTaskResult(capabilityExecution, workspace, stagedMcp) {
    const artifact = 'mcp-output.json';
    const output = capabilityExecution.output ?? null;
    workspace.write(artifact, { output, outputFingerprint: capabilityExecution.receipt?.outputFingerprint || null });
    const serialized = JSON.stringify({ output });
    return {
      status: TASK_STATUS.succeeded,
      summary: 'Read one declared project file through the AOS staged-text MCP capability.',
      artifacts: [artifact],
      result: {
        capability: capabilityExecution.receipt?.reference || null,
        artifact,
        stagedFile: stagedMcp.relativePath,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        outputFingerprint: capabilityExecution.receipt?.outputFingerprint || null,
      },
    };
  }

  #workspaceWriteTaskResult(receipt) {
    return {
      status: TASK_STATUS.succeeded,
      summary: 'Applied the approved deterministic task-workspace write.',
      artifacts: [],
      result: {
        workspaceWrite: {
          claimId: receipt.claimId,
          receiptId: receipt.receiptId,
          status: receipt.status,
          idempotent: receipt.idempotent,
          recovered: receipt.recovered,
          adapter: receipt.adapter,
          targetKind: receipt.targetKind,
          inputFingerprint: receipt.inputFingerprint,
          rollbackPlanFingerprint: receipt.rollbackPlanFingerprint,
          priorStateFingerprint: receipt.priorStateFingerprint,
          receiptFingerprint: receipt.receiptFingerprint,
        },
      },
    };
  }

  #requireWorkspaceWriteApproval(run, task, agent, attempted, reason) {
    // This branch is reached before workspace/reservation mutation. Restore the
    // counter so the next exact approval binds the same upcoming attempt.
    task.attempts = Math.max(0, attempted - 1);
    if (task.attempts === 0) task.startedAt = null;
    task.sessionId = null;
    task.workspaceWriteApproval = null;
    task.status = TASK_STATUS.awaiting_approval;
    task.error = null;
    task.errorCode = 'workspace_write_exact_approval_required';
    if (agent) agent.status = 'waiting_approval';
    this.#event('task.workspace_write_approval_required', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      payload: { attempt: attempted, key: task.key || null, reason },
    });
  }

  #revalidateTaskWorkspaceWrite({ runId, taskId, attempt, identity, phase = 'apply' } = {}) {
    const run = this.#require('runs', runId, 'run');
    const task = this.#require('tasks', taskId, 'task');
    const agent = this.state.agents.find((item) => item.id === task.agentId);
    const expectedRunning = phase === 'apply' || phase === 'recovery';
    if (expectedRunning) {
      if (run.status !== RUN_STATUS.running || task.status !== TASK_STATUS.running || task.attempts !== attempt) {
        throw new AosError('workspace_write_state_changed', 'Task-workspace write state changed before mutation or receipt completion', {
          statusCode: 409,
          details: { runId, taskId, phase },
        });
      }
    }
    const current = this.capabilities.resolve(identity.capabilityReference, {
      projectId: run.projectId,
      roleId: task.presetId || task.kind,
      workerId: agent?.id || null,
      runId: run.id,
    });
    assertTaskWorkspaceWriteAdmission(task, [current]);
    const derived = buildTaskWorkspaceWriteIdentity({
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      attempt,
      capabilityReference: current.reference,
      capabilityFingerprint: current.fingerprint,
    });
    if (!sameWorkspaceWriteIdentity(derived, identity)
      || (expectedRunning && !workspaceWriteApprovalMatches(task.workspaceWriteApproval, identity))) {
      throw new AosError('workspace_write_identity_stale', 'Task-workspace write approval no longer matches the current exact effect identity', {
        statusCode: 409,
        details: { runId, taskId, phase },
      });
    }
    return current;
  }

  // Rollback is compensating action for an already-authorized, already-written
  // effect—not a new capability invocation. It must remain available after an
  // operator cancels/retries the task or revokes the capability, but only for
  // the exact stored claim/approval/mount and only while no attempt is running.
  #revalidateTaskWorkspaceWriteRollback({ runId, taskId, claim } = {}) {
    const run = this.#require('runs', runId, 'run');
    const task = this.#require('tasks', taskId, 'task');
    const identity = claim?.identity;
    if (!identity || task.runId !== run.id || task.projectId !== run.projectId
      || identity.projectId !== run.projectId || identity.runId !== run.id || identity.taskId !== task.id
      || !isTaskWorkspaceWriteRequested(task)) {
      throw new AosError('workspace_write_claim_scope_invalid', 'Task-workspace rollback does not match its durable task scope', {
        statusCode: 409,
        details: { runId, taskId },
      });
    }
    if (task.status === TASK_STATUS.running || task.attempts !== identity.attempt) {
      throw new AosError('workspace_write_rollback_attempt_changed', 'Task-workspace rollback is unavailable while this task has a running or newer attempt', {
        statusCode: 409,
        details: { runId, taskId, claimAttempt: identity.attempt, taskAttempt: task.attempts, taskStatus: task.status },
      });
    }
    const mounts = Array.isArray(task.capabilityMounts) ? task.capabilityMounts : [];
    const mount = mounts.length === 1 ? mounts[0] : null;
    if (!mount || mount.reference !== identity.capabilityReference || mount.fingerprint !== identity.capabilityFingerprint) {
      throw new AosError('workspace_write_rollback_mount_mismatch', 'Task-workspace rollback no longer has the exact stored capability mount', {
        statusCode: 409,
        details: { runId, taskId },
      });
    }
    assertTaskWorkspaceWriteAdmission(task, [mount]);
    const derived = buildTaskWorkspaceWriteIdentity({
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      attempt: identity.attempt,
      capabilityReference: mount.reference,
      capabilityFingerprint: mount.fingerprint,
    });
    const approval = this.state.effectApprovals.find((item) => item.id === claim.approvalId);
    if (!approval || approval.decision !== 'approved' || approval.actionFingerprint !== claim.actionFingerprint
      || !sameWorkspaceWriteIdentity(derived, identity) || !sameWorkspaceWriteIdentity(approval.identity, identity)) {
      throw new AosError('workspace_write_rollback_identity_stale', 'Task-workspace rollback no longer matches its exact durable approval and effect identity', {
        statusCode: 409,
        details: { runId, taskId },
      });
    }
    return mount;
  }

  #executeTaskWorkspaceWriteCapability({ run, task, agentId, attempt, signal, workspace }) {
    if (!workspace) {
      throw new AosError('workspace_write_workspace_missing', 'Task-workspace write requires a claimed task workspace', { statusCode: 409 });
    }
    const mounted = Array.isArray(task.capabilityMounts) ? task.capabilityMounts : [];
    assertTaskWorkspaceWriteAdmission(task, mounted);
    const mount = mounted[0];
    const identity = buildTaskWorkspaceWriteIdentity({
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      attempt,
      capabilityReference: mount.reference,
      capabilityFingerprint: mount.fingerprint,
    });
    if (!workspaceWriteApprovalMatches(task.workspaceWriteApproval, identity)) {
      throw new AosError('workspace_write_exact_approval_required', 'No current exact approval exists for this task-workspace write attempt', {
        statusCode: 409,
        details: { taskId: task.id, attempt },
      });
    }
    const receipt = this.taskWorkspaceWrites.apply({
      identity,
      approvalId: task.workspaceWriteApproval.approvalId,
      ownerId: this.driverId,
      requestId: `${task.nonce}:workspace-write:${attempt}`,
      workspaceRoot: this.store.workspacesDir,
      workspaceDir: workspace.dir,
      journalRoot: join(this.store.dataDir, TASK_WORKSPACE_WRITE_JOURNAL_DIR),
      expectedBytes: taskWorkspaceWriteBytes(identity),
      signal,
      revalidate: () => this.#revalidateTaskWorkspaceWrite({ runId: run.id, taskId: task.id, attempt, identity, phase: 'apply' }),
    });
    return { taskWorkspaceWrite: true, receipt, taskResult: this.#workspaceWriteTaskResult(receipt) };
  }

  // A task opts into exactly one bounded capability call. The mounted receipt is
  // immutable, while the registry is resolved again here so revoke/test/permission
  // changes between dispatch and invocation fail closed.
  async #executeMountedCapability({ run, task, agentId, attempt, signal, workspace = null, stagedMcp = null }) {
    const requested = task.capabilityExecution;
    if (!requested) return null;
    if (isTaskWorkspaceWriteRequested(task)) {
      return this.#executeTaskWorkspaceWriteCapability({ run, task, agentId, attempt, signal, workspace });
    }
    const mounts = Array.isArray(task.capabilityMounts) ? task.capabilityMounts : [];
    const scope = {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      agentId: agentId || 'engine',
      invocationId: `${task.nonce}:capability:${attempt}`,
      harnessSessionId: task.sessionId || null,
      attempt,
    };
    const mounted = mounts.length === 1 ? mounts[0] : null;
    const mcp = mounted?.kind === 'mcp' || mounts.some((mount) => mount?.kind === 'mcp');
    const acceptedKeys = mcp ? ['selector', 'reference', 'timeoutMs'] : ['timeoutMs'];
    const invalidConfig = requested !== true && (!requested || typeof requested !== 'object' || Array.isArray(requested)
      || Object.keys(requested).some((key) => !acceptedKeys.includes(key)));
    // Inputs are engine-derived and contain no task prompt, variable, provider, or
    // user payload. Public task records therefore never become a raw tool-input log.
    const input = { task: task.planTaskId, attempt };
    const inputFingerprint = fingerprint(JSON.stringify(input));
    const idempotencyKey = `${task.nonce}:capability:${attempt}:${mounted?.reference || 'missing'}`;
    const reject = (error) => {
      const receipt = {
        id: newId('capabilityExecution'),
        reference: mounted?.reference || null,
        capabilityFingerprint: mounted?.fingerprint || null,
        adapter: mcp ? 'mcp-stdio' : mounted?.adapter?.reference || null,
        adapterVersion: mcp ? 1 : null,
        status: 'refused',
        scope,
        idempotencyKey,
        inputFingerprint,
        outputFingerprint: null,
        startedAt: this.now(),
        endedAt: this.now(),
        durationMs: 0,
        errorCode: error.code || 'capability_execution_refused',
      };
      this.#appendCapabilityExecution(receipt, run, task);
      throw Object.assign(error, { retryable: false });
    };
    if (invalidConfig) {
      return reject(new AosError('capability_execution_invalid', 'Capability execution accepts only an optional bounded timeout', { statusCode: 409 }));
    }
    if (!mounted) {
      return reject(new AosError('capability_execution_mount_count', 'Capability execution requires exactly one dispatch-mounted capability', { statusCode: 409 }));
    }
    let resolved;
    try {
      resolved = this.transact(() => {
        const current = this.capabilities.resolve(mounted.reference, {
          projectId: run.projectId,
          roleId: task.presetId || task.kind,
          workerId: agentId || null,
          runId: run.id,
        });
        return { current, existing: this.state.capabilityExecutions.find((item) => item.idempotencyKey === idempotencyKey) || null };
      });
    } catch (error) {
      return reject(error);
    }
    const { current, existing } = resolved;
    if (current.reference !== mounted.reference || current.kind !== mounted.kind || current.fingerprint !== mounted.fingerprint
      || current.adapter?.type !== mounted.adapter?.type || current.adapter?.reference !== mounted.adapter?.reference
      || JSON.stringify(current.runtime || null) !== JSON.stringify(mounted.runtime || null)
      || JSON.stringify(current.permissions || []) !== JSON.stringify(mounted.permissions || [])) {
      return reject(new AosError('capability_mount_stale', `Mounted receipt for ${mounted.reference} no longer matches the current capability version`, { statusCode: 409 }));
    }
    if (mcp) {
      try {
        assertMcpTaskAdmission(task, [current]);
      } catch (error) {
        return reject(error);
      }
      if (!workspace || !stagedMcp) return reject(new AosError('mcp_staging_invalid', 'MCP execution requires an engine-owned staged file', { statusCode: 409 }));
    }
    if (existing) {
      if (existing.status === 'succeeded') return { receipt: structuredClone(existing), output: null, idempotent: true };
      throw Object.assign(new AosError(existing.errorCode || 'capability_execution_failed', 'Capability execution already reached a terminal failure', { statusCode: 409 }), { receipt: structuredClone(existing), retryable: false });
    }
    // Receipt dedupe is durable and this adapter is pure. Separate engines may both
    // calculate the same echo before one transaction records it; do not reuse this
    // pattern for effectful adapters without a durable execution claim protocol.
    try {
      const result = await this.capabilityRuntime.execute({
        mount: current,
        scope,
        ...(mcp ? {} : { input }),
        idempotencyKey,
        timeoutMs: mcp
          ? requested.timeoutMs
          : requested === true ? Math.min(task.timeoutMs || 250, 500) : requested.timeoutMs ?? Math.min(task.timeoutMs || 250, 500),
        ...(mcp ? { workspaceDir: workspace.dir, stagedFile: stagedMcp.relativePath, sourceFingerprint: stagedMcp.fingerprint } : {}),
        signal,
      });
      const receipt = { id: newId('capabilityExecution'), ...result.receipt };
      return { ...result, receipt: this.#appendCapabilityExecution(receipt, run, task) };
    } catch (error) {
      const receipt = error.receipt || {
        reference: mounted.reference, capabilityFingerprint: mounted.fingerprint, adapter: mcp ? 'mcp-stdio' : mounted.adapter?.reference || null,
        adapterVersion: mcp ? 1 : null, status: 'failed', scope, idempotencyKey, inputFingerprint, outputFingerprint: null,
        startedAt: this.now(), endedAt: this.now(), durationMs: 0, errorCode: error.code || 'capability_execution_failed',
      };
      this.#appendCapabilityExecution({ id: newId('capabilityExecution'), ...receipt }, run, task);
      throw Object.assign(error, { retryable: false });
    }
  }

  #appendCapabilityExecution(receipt, run, task) {
    return this.transact(() => {
      const existing = this.state.capabilityExecutions.find((item) => item.idempotencyKey === receipt.idempotencyKey);
      if (existing) return structuredClone(existing);
      const stored = structuredClone(receipt);
      this.state.capabilityExecutions.push(stored);
      const currentTask = this.#require('tasks', task.id, 'task');
      currentTask.capabilityExecutionReceipts = [...(currentTask.capabilityExecutionReceipts || []), stored.id];
      this.#event('capability.executed', {
        projectId: run.projectId, runId: run.id, taskId: task.id,
        payload: { reference: stored.reference, receiptId: stored.id, status: stored.status, errorCode: stored.errorCode },
      });
      return structuredClone(stored);
    });
  }

  async #injectFault(run, task, workspace, signal, emit) {
    const fault = task.injectFault;
    const holdMs = fault.holdMs || 0;
    const startedAt = this.now();
    const error = fault.error || `Injected retryable failure on attempt ${task.attempts}`;
    emit('fault.injected', { holdMs, error });
    await abortableDelay(holdMs, signal);
    const profile = providerProfile(this.execution, task.worker, task);
    const runtime = {
      runId: run.id,
      taskId: task.id,
      taskKey: task.key || null,
      attempt: task.attempts,
      spawned: false,
      injected: true,
      provider: task.worker,
      requested: profile.model || profile.effort
        ? { model: profile.model || null, effort: profile.effort || null, sandbox: profile.sandbox }
        : null,
      profile,
      startedAt,
      endedAt: this.now(),
      cancelled: signal.aborted,
      error,
    };
    workspace.write(`attempt-${task.attempts}/runtime.json`, runtime);
    if (signal.aborted) return { status: 'cancelled', runtime };
    return { status: 'failed', retryable: true, injected: true, error, runtime };
  }

  #releaseSlot() {
    const waiters = this.slotWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #crash(runId, taskId, error) {
    this.transact(() => {
      const run = this.#require('runs', runId, 'run');
      const task = this.#require('tasks', taskId, 'task');
      this.#event('task.crashed', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { error: error.message } });
      if (task.status === TASK_STATUS.running) {
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        task.lease = null;
        this.inflight.delete(task.id);
        this.#failTask(run, task, agent, error.message, { retryable: false });
      }
    });
  }

  #failTask(run, task, agent, error, { retryable = true, injected = false, fatal = false, code = null } = {}) {
    this.#reconcileTaskWorkspaceWriteBeforeTerminal(run, task, 'task_failed');
    task.error = error;
    task.errorCode = code || null;
    const payload = { attempt: task.attempts, key: task.key || null, error, retryable, injected, fatal, ...(code ? { code } : {}) };
    if (retryable && !fatal && task.attempts <= (task.maxRetries ?? 1)) {
      if (isTaskWorkspaceWriteRequested(task)) {
        task.workspaceWriteApproval = null;
        task.status = TASK_STATUS.awaiting_approval;
        if (agent) agent.status = 'waiting_approval';
        this.#event('task.retried', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { ...payload, requiresApproval: true } });
        this.#event('task.workspace_write_approval_required', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          payload: { attempt: task.attempts + 1, key: task.key || null, reason: 'retry' },
        });
        return;
      }
      task.status = TASK_STATUS.ready;
      if (agent) agent.status = 'queued';
      this.#event('task.retried', { projectId: run.projectId, runId: run.id, taskId: task.id, payload });
      return;
    }
    task.status = TASK_STATUS.failed;
    task.endedAt = this.now();
    if (agent) agent.status = 'failed';
    this.#event('task.failed', { projectId: run.projectId, runId: run.id, taskId: task.id, payload });
  }

  // Fatal provider problems (not logged in, model substituted) stop the whole run.
  #abortRun(run, reason, details = null) {
    if (run.error) return;
    for (const task of this.#tasks(run.id)) {
      this.inflight.get(task.id)?.controller.abort();
      if (!TERMINAL.has(task.status)) {
        this.#reconcileTaskWorkspaceWriteBeforeTerminal(run, task, 'run_aborted');
        if (task.lease?.executorKind === 'pool') this.#reap(run, task);
        if (task.resourceReservationId) this.#settleResource(run, task, 'aborted');
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        task.lease = null;
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        if (agent) agent.status = 'cancelled';
        this.#event('task.cancelled', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { reason: 'run aborted' } });
      }
    }
    run.status = RUN_STATUS.failed;
    run.error = redactSecrets({ reason, details: details || null });
    run.endedAt = this.now();
    run.updatedAt = this.now();
    this.#event('run.aborted', { projectId: run.projectId, runId: run.id, payload: run.error });
  }

  // Fails a run start before any mutation when a planned task names a missing template or
  // preset, or when its preset requires variables that neither the engine nor the task supplies.
  #validatePlannedTasks(goal, plannedTasks = goal.plan.tasks) {
    for (const planned of plannedTasks) {
      let scratch = { ...planned };
      if (planned.templateId) {
        scratch = applyTemplateToTask({ ...planned, config: null }, planned, this.templates.get(planned.templateId, planned.templateVersion ?? null));
      } else if (planned.presetId) {
        scratch.presetId = planned.presetId;
        scratch.presetVersion = planned.presetVersion ?? null;
      }
      const harness = scratch.worker || 'local';
      if (harness === 'codex') this.#assertCodexRoleRuntime(scratch);
      if (this.execution.mode === 'mixed' && ['codex', 'claude', 'ollama', 'command'].includes(harness)) {
        const configured = this.#providerConfig(harness);
        if (!configured) {
          throw new AosError('plan_provider_unconfigured', `Plan task ${planned.id} selects ${harness}, but that provider is not configured for this engine`, { statusCode: 409, details: { taskId: planned.id, harness } });
        }
        const codexRoleBinding = harness === 'codex' ? this.#assertCodexRoleRuntime(scratch) : null;
        const requestedModel = scratch.model ?? scratch.config?.effective?.harness?.model ?? scratch.config?.model ?? (harness === 'codex' ? codexRoleBinding.model : harness === 'ollama' ? null : configured.model);
        const requestedEffort = scratch.effort ?? scratch.config?.effective?.harness?.effort ?? scratch.config?.effort ?? (harness === 'codex' ? codexRoleBinding.effort : configured.effort);
        if ((harness !== 'codex' && (requestedModel !== configured.model || (!['ollama', 'command'].includes(harness) && requestedEffort !== configured.effort) || (harness === 'command' && requestedEffort != null)))
          || (harness === 'codex' && (requestedModel != null && requestedModel !== codexRoleBinding.model || requestedEffort != null && requestedEffort !== codexRoleBinding.effort))) {
          const expected = harness === 'codex' ? codexRoleBinding : configured;
          throw new AosError('plan_provider_config_invalid', `Plan task ${planned.id} must use the configured ${harness} runtime ${expected.model}${['ollama', 'command'].includes(harness) ? '' : `/${expected.effort}`}`, { statusCode: 409, details: { taskId: planned.id, harness, requested: { model: requestedModel, ...(['ollama', 'command'].includes(harness) ? {} : { effort: requestedEffort }) }, expected: { model: expected.model, ...(['ollama', 'command'].includes(harness) ? {} : { effort: expected.effort }) } } });
        }
        if (harness === 'ollama') this.#validateOllamaTask(planned, scratch);
        if (harness === 'command') this.#validateExternalHarnessTask(planned, scratch);
      }
      if (!scratch.presetId) continue;
      const composed = this.presets.effective(scratch.presetId, scratch.presetVersion ?? null);
      const supplied = new Set([...ENGINE_PROMPT_VARIABLES, ...Object.keys(ENGINE_DERIVED_VARIABLES), ...Object.keys(scratch.variables || {})]);
      const missing = Object.entries(composed.variables).filter(([name, spec]) => spec.required && !supplied.has(name)).map(([name]) => name);
      const unknown = Object.keys(scratch.variables || {}).filter((name) => !composed.variables[name]);
      if (missing.length || unknown.length) {
        throw invalid(`Task ${planned.key || planned.id} uses preset ${scratch.presetId} but ${missing.length ? `lacks required variables ${missing.join(', ')}` : ''}${missing.length && unknown.length ? ' and ' : ''}${unknown.length ? `sets undeclared variables ${unknown.join(', ')}` : ''}`, { taskId: planned.id, presetId: scratch.presetId, missing, unknown });
      }
    }
  }

  #validateOllamaTask(planned, effective) {
    const presetRole = effective.presetId
      ? this.presets.effective(effective.presetId, effective.presetVersion ?? null).role
      : null;
    return assertOllamaTaskAdmission(planned, effective, { presetRole });
  }

  #validateExternalHarnessTask(planned, effective) {
    return assertExternalHarnessTaskAdmission(planned, effective);
  }

  // Values the engine supplies to a preset render, limited to what the preset declares.
  #promptVariables(run, task) {
    const goal = this.#require('goals', run.goalId, 'goal');
    const composed = this.presets.effective(task.presetId, task.presetVersion ?? null);
    const deps = this.#dependencyOutputs(task);
    const output = task.config?.effective?.output || {};
    const delegation = task.delegation || {};
    const depsText = deps.length
      ? deps.map((dep) => [`${dep.key || dep.id} (${dep.status}): ${dep.summary || '(no summary)'}`, ...(dep.findings || []).map((finding) => `  - [${finding.kind}] ${finding.claim}`)].join('\n')).join('\n')
      : undefined;
    const brief = task.brief || task.summary || task.title;
    const derived = {};
    for (const [name, source] of Object.entries(ENGINE_DERIVED_VARIABLES)) {
      if (!composed.variables[name]) continue;
      derived[name] = source === 'deps' ? (depsText || brief) : source === 'brief' ? brief : source === 'run_record' ? summarizeRunRecord(this.runtimeTelemetry(run.id)) : source;
    }
    const candidate = {
      ...derived,
      goal: goal.prompt,
      definition_of_done: goal.definitionOfDone || undefined,
      run_id: run.id,
      task_key: task.key || task.id,
      task_nonce: task.nonce,
      brief: task.brief || task.summary || task.title,
      context_paths: [...(goal.contextPaths || []), ...(task.readPaths || [])],
      dependency_results: depsText,
      memory_context: composed.variables.memory_context ? (this.memory.retrieveForTask(run, task).text ?? undefined) : undefined,
      capabilities: formatCapabilities(task.capabilities),
      budget: formatBudget(task.budget),
      sandbox: task.sandbox || undefined,
      max_findings: output.maxFindings,
      max_summary_words: output.maxSummaryWords,
      escalation_target: task.escalation?.target ? `the ${task.escalation.target}` : undefined,
      delegation: task.mayDelegate
        ? `You may delegate: ${delegation.maxChildren === null ? 'an unlimited number of children' : `at most ${delegation.maxChildren ?? 0} children`} and ${delegation.maxDepth === null ? 'unlimited depth' : `a depth of ${delegation.maxDepth ?? 0}`} below you, bounded by your budget.`
        : undefined,
      ...(task.variables || {}),
    };
    const variables = {};
    for (const [name, value] of Object.entries(candidate)) {
      if (value !== undefined && (composed.variables[name] || (task.variables || {})[name] !== undefined)) variables[name] = value;
    }
    return variables;
  }

  #dependencyOutputs(task) {
    return this.state.dependencies
      .filter((dep) => dep.taskId === task.id)
      .map((dep) => this.state.tasks.find((item) => item.id === dep.dependsOnTaskId))
      .filter(Boolean)
      .map((parent) => ({
        id: parent.id,
        key: parent.key || null,
        title: parent.title,
        kind: parent.kind,
        status: parent.status,
        summary: parent.output?.summary || parent.error || null,
        findings: parent.output?.result?.findings || [],
        decision: parent.output?.result?.decision || null,
        artifact: parent.workspace && parent.output?.artifacts?.includes('artifact.md') ? `${parent.workspace}/artifact.md` : null,
      }));
  }

  #delegationReceipts() {
    if (!Array.isArray(this.state.delegationReceipts)) this.state.delegationReceipts = [];
    return this.state.delegationReceipts;
  }

  #pendingDelegationReceipts(runId) {
    const receipts = Array.isArray(this.state.delegationReceipts) ? this.state.delegationReceipts : [];
    return receipts.filter((item) => item.runId === runId && item.status === 'awaiting_approval');
  }

  #restoreDelegationRun(run) {
    const pending = this.#pendingDelegationReceipts(run.id);
    if (pending.length) {
      run.status = RUN_STATUS.awaiting_approval;
      run.updatedAt = this.now();
      return;
    }
    if (run.status !== RUN_STATUS.awaiting_approval) return;
    const tasks = this.#tasks(run.id);
    if (tasks.some((item) => item.status === TASK_STATUS.awaiting_user)) run.status = RUN_STATUS.awaiting_user;
    else if (tasks.some((item) => item.status === TASK_STATUS.awaiting_approval)) run.status = RUN_STATUS.awaiting_approval;
    else {
      run.status = RUN_STATUS.running;
      this.#refreshReady(run.id);
    }
    run.updatedAt = this.now();
    this.#settleRun(run);
  }

  #revalidateDelegationReceipt(run, receipt) {
    const candidate = receipt.candidatePatch;
    if (!candidate || receipt.candidateFingerprint !== delegationPatchFingerprint(candidate)) {
      throw new AosError('delegation_stale', 'Stored delegation candidate is missing or has changed', { statusCode: 409 });
    }
    if (candidate.id !== receipt.patchId || candidate.baseVersion !== receipt.baseVersion) {
      throw new AosError('delegation_stale', 'Stored delegation candidate identity no longer matches its receipt', { statusCode: 409 });
    }
    if (!run.plan || run.plan.id !== receipt.basePlanId || run.plan.version !== receipt.baseVersion) {
      throw new AosError('delegation_stale', 'The delegation candidate is based on an older plan version', { statusCode: 409 });
    }
    const base = this.state.planVersions.find((item) => item.runId === run.id && item.id === run.plan.id && item.version === run.plan.version);
    if (!base) throw new AosError('delegation_stale', 'The delegation candidate base plan is unavailable', { statusCode: 409 });
    const task = this.state.tasks.find((item) => item.id === receipt.taskId && item.runId === run.id);
    if (!task || task.planTaskId !== receipt.parentPlanTaskId || task.mayDelegate !== true) {
      throw new AosError('delegation_stale', 'The delegating task is no longer authorized', { statusCode: 409 });
    }
    if (!receipt.authorityFingerprint || delegationAuthorityFingerprint(task) !== receipt.authorityFingerprint) {
      throw new AosError('delegation_stale', 'The delegating task authority has changed', { statusCode: 409 });
    }
    const pins = task.delegation?.childTemplateVersions;
    const storedPins = receipt.templateVersions || receipt.templates?.versions;
    if (!pins || !storedPins || stableDelegationStringify(pins) !== stableDelegationStringify(storedPins)) {
      throw new AosError('delegation_stale', 'Pinned child template versions have changed', { statusCode: 409 });
    }

    const additions = candidate.additions;
    if (!additions || !Array.isArray(additions.tasks) || !Array.isArray(additions.dependencies) || !additions.tasks.length) {
      throw new AosError('delegation_stale', 'Stored delegation candidate is not a canonical plan patch', { statusCode: 409 });
    }
    const childIds = new Set();
    const plannedBudgets = [];
    const allowedTaskKeys = new Set(['id', 'key', 'title', 'kind', 'summary', 'branch', 'brief', 'parentId', 'dependencyPolicy', 'optional', 'templateId', 'templateVersion', 'budget', 'mayDelegate', 'delegation']);
    for (const child of additions.tasks) {
      if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child).some((key) => !allowedTaskKeys.has(key))) {
        throw new AosError('delegation_stale', 'Stored delegation candidate contains non-engine task fields', { statusCode: 409 });
      }
      if (childIds.has(child.id) || base.tasks.some((item) => item.id === child.id) || child.parentId !== receipt.parentPlanTaskId) {
        throw new AosError('delegation_stale', 'Stored delegation candidate no longer names fresh direct children', { statusCode: 409 });
      }
      const templateId = child.templateId;
      const expectedVersion = pins?.[templateId];
      if (!templateId || !Number.isInteger(expectedVersion) || child.templateVersion !== expectedVersion) {
        throw new AosError('delegation_stale', 'Stored delegation candidate no longer matches its exact template pins', { statusCode: 409 });
      }
      const template = this.templates.get(templateId, expectedVersion);
      if (template.archived === true) throw new AosError('delegation_stale', `Pinned child template ${templateId}@${expectedVersion} is archived`, { statusCode: 409 });
      const scratch = applyTemplateToTask({ ...child }, child, template);
      const expectedOperatorPaced = delegationIsOperatorPaced(task) || delegationIsUnbounded(template.config.delegation);
      if ((child.delegation?.operatorPaced === true) !== expectedOperatorPaced) {
        throw new AosError('delegation_stale', 'Stored delegation candidate has an invalid operator-paced ancestry flag', { statusCode: 409 });
      }
      this.#validateDelegationCapabilities(run, scratch);
      const budget = child.budget && typeof child.budget === 'object' && !Array.isArray(child.budget) ? child.budget : {};
      plannedBudgets.push({ budget: Object.fromEntries(['tokens', 'usd', 'timeMs'].map((dimension) => [dimension, budget[dimension] ?? template.config.budget?.[dimension] ?? null])) });
      childIds.add(child.id);
    }

    const dependencyKeys = new Set();
    const hasParentDependency = new Set();
    for (const dependency of additions.dependencies) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) throw new AosError('delegation_stale', 'Stored delegation candidate contains an invalid dependency', { statusCode: 409 });
      if (!childIds.has(dependency.taskId) || (dependency.dependsOnTaskId !== receipt.parentPlanTaskId && !childIds.has(dependency.dependsOnTaskId))) {
        throw new AosError('delegation_stale', 'Stored delegation candidate contains an out-of-scope dependency', { statusCode: 409 });
      }
      const key = `${dependency.taskId}|${dependency.dependsOnTaskId}`;
      if (dependencyKeys.has(key)) throw new AosError('delegation_stale', 'Stored delegation candidate contains duplicate dependencies', { statusCode: 409 });
      dependencyKeys.add(key);
      if (dependency.dependsOnTaskId === receipt.parentPlanTaskId) hasParentDependency.add(dependency.taskId);
    }
    for (const id of childIds) {
      if (!hasParentDependency.has(id)) throw new AosError('delegation_stale', 'Stored delegation candidate is missing a parent dependency', { statusCode: 409 });
    }
    const parent = task.delegation;
    if (parent.maxChildren !== null && additions.tasks.length + this.#tasks(run.id).filter((item) => item.parentId === task.id).length > parent.maxChildren) {
      throw new AosError('delegation_stale', 'The parent fan-out limit has changed', { statusCode: 409 });
    }
    this.#assertDelegationBudget(run, task, plannedBudgets);
    try {
      validatePlan({ title: base.title, tasks: [...base.tasks, ...additions.tasks], dependencies: [...base.dependencies, ...additions.dependencies] });
    } catch (error) {
      throw new AosError('delegation_stale', 'Stored delegation candidate no longer forms a valid plan', { statusCode: 409, details: { reason: String(error?.message || 'invalid plan').slice(0, 240) } });
    }
    return structuredClone(candidate);
  }

  #validateDelegationCapabilities(run, task) {
    const capabilities = task.capabilities || {};
    for (const refs of Object.values(capabilities)) {
      if (!Array.isArray(refs)) continue;
      for (const reference of refs) {
        const current = this.capabilities.get(reference);
        if (current.state === 'revoked' || current.tested !== true) {
          throw new AosError('delegation_capability_stale', `Capability ${reference} is no longer active and tested`, { statusCode: 409, details: { reference } });
        }
        const enabled = this.settings.effective('capabilities.enabled', { projectId: run.projectId, runId: run.id, presetId: task.presetId || null }).value;
        if (!Array.isArray(enabled) || !enabled.includes(reference)) {
          throw new AosError('delegation_capability_stale', `Capability ${reference} is no longer enabled by policy`, { statusCode: 409, details: { reference } });
        }
      }
    }
  }

  #pinDelegationTemplateVersions(task) {
    const delegation = task?.delegation;
    if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) return;
    const operatorPaced = delegationIsOperatorPaced(task);
    if (operatorPaced) task.operatorPaced = true;
    if (task?.mayDelegate !== true || !Array.isArray(delegation.childTemplates)) {
      if (operatorPaced) task.delegation = { ...delegation, operatorPaced: true };
      return;
    }
    const childTemplateVersions = {};
    for (const templateId of delegation.childTemplates) {
      const template = this.templates.get(templateId);
      childTemplateVersions[templateId] = template.version;
    }
    task.delegation = {
      ...delegation,
      ...(operatorPaced ? { operatorPaced: true } : {}),
      childTemplateVersions,
    };
  }

  #processDelegationResult(run, task, agent, worker, attempt, result) {
    const proposal = result?.delegation !== undefined
      ? result.delegation
      : result?.result && typeof result.result === 'object' && !Array.isArray(result.result) && result.result.delegation !== undefined
        ? result.result.delegation
        : undefined;
    if (proposal === undefined || proposal === null) return null;

    const actor = agent?.id || task.agentId || 'agent';
    const parentPlanTaskId = task.planTaskId || task.id;
    let proposalValidationError = null;
    try {
      assertDelegationTextSafe(proposal, 'delegation');
    } catch (error) {
      proposalValidationError = error;
    }
    const proposalFingerprint = proposalValidationError
      ? delegationFingerprint({ rejected: proposalValidationError.code || 'delegation_secret_content', runId: run.id, taskId: task.id, attempt })
      : delegationFingerprint(proposal);
    const idempotencyKey = `delegation:${run.id}:${task.id}:${attempt}:${proposalFingerprint}`;
    const existing = this.#delegationReceipts().find((item) => item.idempotencyKey === idempotencyKey);
    if (existing) return structuredClone(existing);

    const patchId = `delegation-${fingerprint(idempotencyKey)}`;
    const baseVersion = Number.isInteger(run.plan?.version) ? run.plan.version : null;
    const context = { run, task, agent, worker, attempt, actor, parentPlanTaskId, proposalFingerprint, idempotencyKey, patchId, baseVersion };
    this.#event('delegation.proposed', {
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      actor,
      payload: { idempotencyKey, proposalFingerprint, patchId, baseVersion, parentTaskId: task.id },
    });

    try {
      if (proposalValidationError) throw proposalValidationError;
      // Local deterministic workers are mounted by the engine and have no provider
      // attestation record. Every other worker must carry an explicit verified
      // runtime receipt before it can influence the plan graph.
      if (worker?.id !== 'local' && result.runtime?.verified !== true) {
        throw new AosError('delegation_unverified_result', 'Delegation requires a verified worker result', { statusCode: 409 });
      }
      const childTemplateVersions = task.delegation?.childTemplateVersions || null;
      const normalized = normalizeDelegationProposal(proposal, {
        mayDelegate: task.mayDelegate === true,
        maxChildren: task.delegation?.maxChildren,
        maxDepth: task.delegation?.maxDepth,
        budget: task.budget || {},
        childTemplates: task.delegation?.childTemplates || [],
        childTemplateVersions,
      });
      const candidate = this.#prepareDelegationPatch(run, task, normalized, patchId, baseVersion);
      assertDelegationTextSafe(candidate.patch);
      // Candidate patches are the only proposal data that may survive this
      // transaction. Redact the canonical copy before hashing, persisting, or
      // applying it; the raw worker proposal is never stored.
      candidate.patch = redactSecrets(candidate.patch);
      candidate.patchFingerprint = delegationPatchFingerprint(candidate.patch);
      context.candidate = candidate;

      const approvalGate = this.#delegationApprovalGate(run, task);
      if (approvalGate) {
        const receipt = this.#appendDelegationReceipt(context, {
          status: 'awaiting_approval',
          childCount: candidate.tasks.length,
          childPlanTaskIds: candidate.tasks.map((item) => item.id),
          templateIds: candidate.templateIds,
          templateVersions: candidate.templateVersions,
          candidatePatch: candidate.patch,
          candidateFingerprint: candidate.patchFingerprint,
          approvalGate,
          authorityFingerprint: delegationAuthorityFingerprint(task),
          planId: run.plan?.id || null,
          planVersion: baseVersion,
        });
        run.status = RUN_STATUS.awaiting_approval;
        run.updatedAt = this.now();
        if (!receipt.existing) {
          this.#event('delegation.awaiting_approval', {
            projectId: run.projectId,
            runId: run.id,
            taskId: task.id,
            actor,
            payload: { receiptId: receipt.id, patchId, baseVersion, childCount: candidate.tasks.length, approvalGate },
          });
        }
        return receipt.value;
      }

      let patched;
      try {
        patched = this.plans.patch(run.id, candidate.patch, { actor, source: 'delegation' });
      } catch (error) {
        return this.#rejectDelegation(context, error);
      }
      const receipt = this.#appendDelegationReceipt(context, {
        status: 'accepted',
        childCount: candidate.tasks.length,
        childPlanTaskIds: candidate.tasks.map((item) => item.id),
        templateIds: candidate.templateIds,
        templateVersions: candidate.templateVersions,
        candidatePatch: candidate.patch,
        candidateFingerprint: candidate.patchFingerprint,
        authorityFingerprint: delegationAuthorityFingerprint(task),
        planId: patched.plan.id,
        planVersion: patched.plan.version,
      });
      if (!receipt.existing) {
        this.#event('delegation.accepted', {
          projectId: run.projectId,
          runId: run.id,
          taskId: task.id,
          actor,
          payload: { receiptId: receipt.id, patchId, baseVersion, version: patched.plan.version, childCount: candidate.tasks.length },
        });
      }
      return receipt.value;
    } catch (error) {
      return this.#rejectDelegation(context, error);
    }
  }

  #delegationApprovalGate(run, task) {
    if (this.#effectiveHumanGates(run).includes('on_expansion')) return 'on_expansion';
    const delegation = task?.delegation || {};
    const unbounded = delegation.unlimited === true
      || !Number.isInteger(delegation.maxChildren)
      || !Number.isInteger(delegation.maxDepth);
    if (unbounded) return 'unbounded_delegation';
    return delegationIsOperatorPaced(task) ? 'operator_paced_delegation' : null;
  }

  #prepareDelegationPatch(run, task, normalized, patchId, baseVersion) {
    if (!run.plan || !Number.isInteger(baseVersion)) {
      throw new AosError('delegation_plan_unavailable', 'Delegation requires a current immutable plan version', { statusCode: 409 });
    }
    const base = this.state.planVersions.find((item) => item.runId === run.id && item.id === run.plan.id && item.version === baseVersion);
    const parentPlanTaskId = task.planTaskId || task.id;
    if (!base || !base.tasks.some((item) => item.id === parentPlanTaskId)) {
      throw new AosError('delegation_parent_unavailable', 'Delegating task is not present in the current immutable plan', { statusCode: 409 });
    }

    const delegation = task.delegation;
    if (task.mayDelegate !== true || !delegation || !Array.isArray(delegation.childTemplates)) {
      throw new AosError('delegation_not_authorized', 'Task is not authorized to delegate through a permitted template set', { statusCode: 409 });
    }
    const pinnedTemplateVersions = delegation.childTemplateVersions;
    if (!pinnedTemplateVersions || typeof pinnedTemplateVersions !== 'object' || Array.isArray(pinnedTemplateVersions)) {
      throw new AosError('delegation_template_pins_missing', 'Delegation requires engine-pinned child template versions', { statusCode: 409 });
    }
    const maxChildren = delegation.maxChildren;
    if (maxChildren !== null && (!Number.isInteger(maxChildren) || maxChildren < 0)) {
      throw new AosError('delegation_limit_invalid', 'Delegation maxChildren is not a finite engine-derived bound', { statusCode: 409 });
    }
    const children = delegationChildren(normalized);
    if (!children.length) throw new AosError('delegation_invalid', 'Delegation proposal must contain at least one child', { statusCode: 409 });
    const existingChildren = this.#tasks(run.id).filter((item) => item.parentId === task.id).length;
    if (maxChildren !== null && existingChildren + children.length > maxChildren) {
      throw new AosError('delegation_max_children', `Delegation would exceed the parent maxChildren bound of ${maxChildren}`, { statusCode: 409, details: { maxChildren, existingChildren, proposedChildren: children.length } });
    }
    if (delegation.maxDepth !== null && (!Number.isInteger(delegation.maxDepth) || delegation.maxDepth < 1)) {
      throw new AosError('delegation_max_depth', 'Delegation maxDepth does not permit a child', { statusCode: 409 });
    }

    const operatorPaced = delegationIsOperatorPaced(task);
    const permitted = new Set(delegation.childTemplates);
    const ids = new Set();
    const aliases = new Map();
    const templateVersions = {};
    const tasks = children.map((child, index) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} must be an object`, { statusCode: 409 });
      }
      const templateId = String(child.templateId ?? child.template?.id ?? '').trim();
      if (!templateId || !permitted.has(templateId)) {
        throw new AosError('delegation_template_unpermitted', `Delegated child ${index + 1} does not use a permitted child template`, { statusCode: 409, details: { templateId: templateId || null } });
      }
      const pinnedVersion = pinnedTemplateVersions[templateId];
      if (!Number.isInteger(pinnedVersion) || pinnedVersion < 1) {
        throw new AosError('delegation_template_pins_missing', `Delegated child template ${templateId} has no valid engine pin`, { statusCode: 409, details: { templateId } });
      }
      if (!Number.isInteger(child.templateVersion) || child.templateVersion !== pinnedVersion) {
        throw new AosError('delegation_template_version_mismatch', `Delegated child ${index + 1} must use pinned template ${templateId}@${pinnedVersion}`, { statusCode: 409, details: { templateId, expected: pinnedVersion, received: child.templateVersion ?? null } });
      }
      const template = this.templates.get(templateId, pinnedVersion);
      if (template.archived === true) {
        throw new AosError('delegation_template_archived', `Delegated child template ${templateId}@${pinnedVersion} is archived`, { statusCode: 409, details: { templateId, version: pinnedVersion } });
      }
      templateVersions[templateId] = pinnedVersion;
      const suppliedId = child.id == null ? '' : String(child.id).trim();
      const id = suppliedId || `delegated-${fingerprint(`${patchId}|${index}`)}`;
      if (!IDENTIFIER.test(id) || ids.has(id)) throw new AosError('delegation_child_id_invalid', `Delegated child ${index + 1} has a duplicate or invalid plan id`, { statusCode: 409, details: { taskId: id } });
      ids.add(id);

      const title = child.title == null ? '' : child.title;
      if (typeof title !== 'string' || !title.trim() || title.length > 240) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} needs a bounded title`, { statusCode: 409 });
      const brief = child.brief ?? child.summary ?? title;
      if (typeof brief !== 'string' || !brief.trim() || brief.length > 4000) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} needs a bounded brief`, { statusCode: 409 });
      const key = child.key == null ? id : child.key;
      if (typeof key !== 'string' || !key.trim() || key.length > 128) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} has an invalid key`, { statusCode: 409 });
      const kind = child.kind == null ? 'research' : child.kind;
      if (typeof kind !== 'string' || !kind.trim() || kind.length > 120) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} has an invalid kind`, { statusCode: 409 });
      const branch = child.branch == null ? task.branch || 'root' : child.branch;
      if (typeof branch !== 'string' || branch.length > 120) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} has an invalid branch`, { statusCode: 409 });
      const dependencyPolicy = child.dependencyPolicy == null ? 'all_succeeded' : child.dependencyPolicy;
      if (!['all_succeeded', 'all_terminal'].includes(dependencyPolicy)) throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} has an invalid dependency policy`, { statusCode: 409 });
      if (child.optional !== undefined && typeof child.optional !== 'boolean') throw new AosError('delegation_child_invalid', `Delegated child ${index + 1} optional must be boolean`, { statusCode: 409 });
      const planned = {
        id,
        key: key.trim(),
        title: title.trim(),
        kind: kind.trim(),
        summary: typeof child.summary === 'string' ? child.summary.slice(0, 500) : brief.trim().slice(0, 500),
        branch: branch || 'root',
        brief: brief.trim(),
        parentId: parentPlanTaskId,
        dependencyPolicy,
        optional: child.optional === true,
        templateId: template.id,
        templateVersion: pinnedVersion,
      };
      if (child.budget && typeof child.budget === 'object' && Object.keys(child.budget).length) planned.budget = cloneForReceipt(child.budget);

      // A child can inherit a template that delegates, but it cannot retain
      // depth beyond what the parent granted. The override is engine-derived,
      // not a worker-selected runtime configuration.
      const childDelegation = template.config.delegation || {};
      const childUnbounded = delegationIsUnbounded(childDelegation);
      const childOperatorPaced = operatorPaced || childUnbounded;
      if (delegation.maxDepth !== null) {
        const remainingDepth = delegation.maxDepth - 1;
        if (remainingDepth < 1 || !childDelegation.mayDelegate) {
          planned.mayDelegate = false;
          planned.delegation = { maxChildren: 0, maxDepth: 0, childTemplates: [], unlimited: false, ...(childOperatorPaced ? { operatorPaced: true } : {}) };
        } else {
          const childMaxDepth = childDelegation.maxDepth === null ? remainingDepth : Math.min(childDelegation.maxDepth, remainingDepth);
          planned.mayDelegate = true;
          planned.delegation = {
            maxChildren: childDelegation.maxChildren,
            maxDepth: childMaxDepth,
            childTemplates: [...childDelegation.childTemplates],
            unlimited: childUnbounded || childMaxDepth === null,
            ...(childOperatorPaced ? { operatorPaced: true } : {}),
          };
        }
      } else if (childOperatorPaced) {
        // An unlimited ancestor still paces every descendant, even when the
        // selected child template itself has finite delegation limits.
        planned.delegation = { operatorPaced: true };
      }
      const templateBudget = template.config.budget || {};
      aliases.set(id, id);
      if (aliases.has(key.trim()) && aliases.get(key.trim()) !== id) {
        throw new AosError('delegation_alias_collision', `Delegated child ${index + 1} key collides with another child id or key`, { statusCode: 409, details: { key: key.trim() } });
      }
      aliases.set(key.trim(), id);
      const effectiveBudget = Object.fromEntries(['tokens', 'usd', 'timeMs'].map((dimension) => [
        dimension,
        child.budget?.[dimension] ?? templateBudget[dimension] ?? null,
      ]));
      return { planned, child, effectiveBudget };
    });

    this.#assertDelegationBudget(run, task, tasks.map((item) => ({ budget: item.effectiveBudget })));

    const dependencies = [];
    const seenDependencies = new Set();
    const addDependency = (taskAlias, dependencyAlias) => {
      const taskId = aliases.get(String(taskAlias || '').trim());
      const dependsOnTaskId = aliases.get(String(dependencyAlias || '').trim());
      if (!taskId || !dependsOnTaskId || taskId === dependsOnTaskId) throw new AosError('delegation_dependency_scope', 'Delegated dependencies must be non-cyclic sibling edges', { statusCode: 409 });
      const key = `${taskId}|${dependsOnTaskId}`;
      if (seenDependencies.has(key)) return;
      seenDependencies.add(key);
      dependencies.push({ taskId, dependsOnTaskId });
    };
    for (const item of tasks) {
      dependencies.push({ taskId: item.planned.id, dependsOnTaskId: parentPlanTaskId });
      seenDependencies.add(`${item.planned.id}|${parentPlanTaskId}`);
    }
    const topLevelDependencies = delegationDependencies(normalized);
    for (const dependency of topLevelDependencies) {
      const taskAlias = dependency && typeof dependency === 'object' && !Array.isArray(dependency)
        ? dependency.taskId ?? dependency.childId ?? dependency.id
        : null;
      const dependsOn = dependency && typeof dependency === 'object' && !Array.isArray(dependency)
        ? dependency.dependsOnTaskId ?? dependency.dependsOn
        : null;
      if (Array.isArray(dependsOn)) for (const sibling of dependsOn) addDependency(taskAlias, sibling);
      else addDependency(taskAlias, dependsOn);
    }
    for (const item of tasks) {
      const local = item.child?.dependencies ?? item.child?.dependsOn ?? [];
      const entries = Array.isArray(local) ? local : [local];
      for (const dependency of entries) {
        if (typeof dependency === 'string') addDependency(item.planned.id, dependency);
        else if (dependency && typeof dependency === 'object' && !Array.isArray(dependency)) addDependency(item.planned.id, dependency.dependsOnTaskId ?? dependency.dependsOn ?? dependency.id);
        else throw new AosError('delegation_dependency_scope', 'Delegated dependencies must be sibling identifiers', { statusCode: 409 });
      }
    }

    return {
      tasks: tasks.map((item) => item.planned),
      dependencies,
      templateIds: [...new Set(tasks.map((item) => item.planned.templateId))],
      templateVersions,
      patch: {
        id: patchId,
        baseVersion,
        reason: `Agent ${task.agentId || 'agent'} proposed ${tasks.length} bounded child task${tasks.length === 1 ? '' : 's'}`,
        additions: { tasks: tasks.map((item) => item.planned), dependencies },
      },
    };
  }

  #assertDelegationBudget(run, task, proposed) {
    const parentBudget = task.budget || {};
    for (const dimension of ['tokens', 'usd', 'timeMs']) {
      const ceiling = parentBudget[dimension];
      if (ceiling == null || !Number.isFinite(ceiling)) continue;
      let total = 0;
      const existing = this.#tasks(run.id).filter((item) => item.parentId === task.id);
      for (const child of [...existing, ...(proposed || [])]) {
        const value = child.budget?.[dimension];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new AosError('delegation_budget_unbounded', `Delegated children have no finite ${dimension} budget under the parent bound`, { statusCode: 409, details: { dimension, ceiling } });
        }
        total += value;
      }
      if (total > ceiling) {
        throw new AosError('delegation_budget_exceeded', `Delegated children require ${total} ${dimension}, above the parent bound of ${ceiling}`, { statusCode: 409, details: { dimension, ceiling, total } });
      }
    }
  }

  #effectiveHumanGates(run) {
    const explicit = run?.policies?.gates?.human;
    if (Array.isArray(explicit)) return explicit;
    try {
      const value = this.settings.effective('approvals.humanGates', { projectId: run.projectId, runId: run.id }).value;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  #appendDelegationReceipt(context, details) {
    const receipts = this.#delegationReceipts();
    const existing = receipts.find((item) => item.idempotencyKey === context.idempotencyKey);
    if (existing) return { existing: true, id: existing.id, value: structuredClone(existing) };
    const candidatePatch = details.candidatePatch ?? context.candidate?.patch ?? null;
    const candidateFingerprint = details.candidateFingerprint
      ?? context.candidate?.patchFingerprint
      ?? (candidatePatch ? delegationPatchFingerprint(candidatePatch) : null);
    const templateVersions = details.templateVersions ?? context.candidate?.templateVersions ?? {};
    const effective = context.task.config?.effective || {};
    const harness = context.task.worker || context.worker?.id || 'local';
    const harnessConfig = effective.harness || {};
    const filesystem = effective.filesystem || {};
    const network = effective.network || {};
    const parentTemplateId = context.task.config?.templateId || context.task.templateId || null;
    const receipt = {
      id: newId('delegationReceipt'),
      schemaVersion: 1,
      kind: 'delegation',
      status: details.status,
      runId: context.run.id,
      projectId: context.run.projectId,
      taskId: context.task.id,
      parentTaskId: context.task.id,
      parentPlanTaskId: context.parentPlanTaskId,
      agentId: context.actor,
      actor: context.actor,
      actorType: 'agent',
      provider: harness,
      harness,
      model: context.task.model ?? harnessConfig.model ?? this.#providerConfig(harness)?.model ?? null,
      effort: context.task.effort ?? harnessConfig.effort ?? this.#providerConfig(harness)?.effort ?? null,
      capabilities: cloneForReceipt(context.task.capabilities ?? effective.capabilities ?? null),
      sandbox: context.task.sandbox ?? filesystem.sandbox ?? null,
      workspacePolicy: {
        sandbox: context.task.sandbox ?? filesystem.sandbox ?? null,
        readPaths: cloneForReceipt(context.task.readPaths ?? filesystem.readPaths ?? []),
        writePaths: cloneForReceipt(filesystem.writePaths ?? []),
        network: { allowed: network.allowed === true, allowlist: cloneForReceipt(network.allowlist ?? []) },
      },
      templates: {
        parent: parentTemplateId,
        children: [...(details.templateIds || [])],
        versions: cloneForReceipt(templateVersions),
      },
      templateVersions: cloneForReceipt(templateVersions),
      idempotencyKey: context.idempotencyKey,
      proposalFingerprint: context.proposalFingerprint,
      patchId: context.patchId,
      basePlanId: context.run.plan?.id ?? null,
      baseVersion: context.baseVersion,
      candidatePatch: cloneForReceipt(candidatePatch),
      candidateFingerprint,
      approvalGate: details.approvalGate || null,
      authorityFingerprint: details.authorityFingerprint || null,
      planId: details.planId ?? context.run.plan?.id ?? null,
      planVersion: details.planVersion ?? null,
      childCount: details.childCount ?? 0,
      childPlanTaskIds: [...(details.childPlanTaskIds || [])],
      errorCode: details.errorCode || null,
      decision: details.decision || null,
      requestedDecision: details.requestedDecision || null,
      requestId: details.requestId || null,
      decidedAt: details.decidedAt || null,
      decidedBy: details.decidedBy || null,
      at: this.now(),
    };
    receipts.push(receipt);
    return { existing: false, id: receipt.id, value: structuredClone(receipt) };
  }

  #rejectDelegation(context, error) {
    const code = safeDelegationCode(error?.code, 'delegation_rejected');
    const receipt = this.#appendDelegationReceipt(context, {
      status: 'rejected',
      errorCode: code,
      childCount: context.candidate?.tasks?.length || 0,
      childPlanTaskIds: context.candidate?.tasks?.map((item) => item.id) || [],
      templateIds: context.candidate?.templateIds || [],
      planId: context.run.plan?.id || null,
      planVersion: context.baseVersion,
    });
    if (!receipt.existing) {
      this.#event('delegation.rejected', {
        projectId: context.run.projectId,
        runId: context.run.id,
        taskId: context.task.id,
        actor: context.actor,
        payload: { receiptId: receipt.id, patchId: context.patchId, baseVersion: context.baseVersion, code },
      });
    }
    return receipt.value;
  }

  #absorbResult(run, task, worker, workspace, result) {
    for (const finding of result.findings || []) {
      this.#recordEvidence(run, task, worker, workspace, {
        type: ['supported', 'conflict'].includes(finding.kind) ? finding.kind : 'note',
        claim: `${task.key ? `${task.key}: ` : ''}${finding.claim}`,
        confidence: finding.confidence,
        sources: (finding.evidence || []).map((path, index) => ({ id: `${task.key || 'SRC'}-${index + 1}`, path })),
        artifact: 'artifact.json',
      });
    }
    if (Array.isArray(result.memory_writes) && result.memory_writes.length) this.memory.absorbWrites(run, task, result.memory_writes, { source: 'worker' });
    if (task.kind === 'synthesis' && result.decision) this.#recordDecision(run, task, result.decision);
    if (task.kind === 'retrospective' && result.retrospective) this.#recordWorkerRetrospective(run, task, result.retrospective);
  }

  #refreshReady(runId) {
    const tasks = this.#tasks(runId);
    // A patch can add a child before its newly-added prerequisite. Repeat until
    // all newly blocked descendants have seen the terminal parent.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (task.status !== TASK_STATUS.pending && task.status !== TASK_STATUS.ready && task.status !== TASK_STATUS.awaiting_approval) continue;
        const blockers = this.#dependencyBlockers(task);
        if (blockers.length && task.dependencyPolicy !== 'all_terminal') {
          task.status = TASK_STATUS.blocked;
          const blocker = blockers[0];
          const code = blocker.status === TASK_STATUS.cancelled
            ? 'dependency_cancelled'
            : blocker.status === TASK_STATUS.blocked
              ? 'dependency_blocked'
              : 'dependency_failed';
          const blockedAt = this.now();
          task.blockedBy = {
            code,
            dependencyTaskId: blocker.id,
            dependencyPlanTaskId: blocker.planTaskId || null,
            dependencyStatus: blocker.status,
            at: blockedAt,
          };
          task.wait = null;
          task.lease = null;
          task.endedAt = this.now();
          const agent = this.state.agents.find((item) => item.id === task.agentId);
          if (agent) agent.status = 'blocked';
          this.#event('task.blocked', {
            projectId: task.projectId,
            runId: task.runId,
            taskId: task.id,
            payload: {
              code,
              dependencyTaskId: blocker.id,
              dependencyPlanTaskId: blocker.planTaskId || null,
              dependencyStatus: blocker.status,
              prerequisiteIds: blockers.map((item) => item.id),
              prerequisiteCount: blockers.length,
            },
          });
          changed = true;
          continue;
        }
        if (!this.#depsSatisfied(task)) continue;
        if (task.requiresApproval && task.status !== TASK_STATUS.ready && task.status !== TASK_STATUS.running) {
          if (task.status !== TASK_STATUS.awaiting_approval) {
            task.status = TASK_STATUS.awaiting_approval;
            this.#event('task.approval_required', { projectId: task.projectId, runId: task.runId, taskId: task.id, payload: { key: task.key || null } });
          }
          continue;
        }
        if (task.status === TASK_STATUS.pending) {
          task.status = TASK_STATUS.ready;
          this.#event('task.ready', { projectId: task.projectId, runId: task.runId, taskId: task.id, payload: { key: task.key || null } });
          changed = true;
        }
      }
    }
  }

  #dependencyBlockers(task) {
    if (task.dependencyPolicy === 'all_terminal') return [];
    const parentIds = this.state.dependencies.filter((item) => item.taskId === task.id).map((item) => item.dependsOnTaskId);
    return parentIds
      .map((id) => this.state.tasks.find((item) => item.id === id))
      .filter((item) => item && [TASK_STATUS.failed, TASK_STATUS.cancelled, TASK_STATUS.blocked].includes(item.status));
  }

  #depsSatisfied(task) {
    const deps = this.state.dependencies.filter((item) => item.taskId === task.id);
    if (!deps.length) return true;
    const parents = deps.map((dep) => this.state.tasks.find((item) => item.id === dep.dependsOnTaskId)).filter(Boolean);
    if (task.dependencyPolicy === 'all_terminal') {
      return parents.every((item) => TERMINAL.has(item.status));
    }
    return parents.every((item) => item.status === TASK_STATUS.succeeded);
  }

  #isIdle(runId) {
    const tasks = this.#tasks(runId);
    const run = this.state.runs.find((item) => item.id === runId);
    if (run?.status === RUN_STATUS.awaiting_user || tasks.some((task) => task.status === TASK_STATUS.awaiting_user)) return true;
    const active = tasks.some((task) => task.status === TASK_STATUS.running || task.status === TASK_STATUS.ready);
    return !active;
  }

  #settleRun(run) {
    if (run.status === RUN_STATUS.cancelled || run.error) return;
    const tasks = this.#tasks(run.id);
    if (this.#pendingDelegationReceipts(run.id).length) {
      run.status = RUN_STATUS.awaiting_approval;
      run.updatedAt = this.now();
      return;
    }
    if (run.status === RUN_STATUS.paused) return;
    const waitingUser = tasks.some((task) => task.status === TASK_STATUS.awaiting_user);
    if (waitingUser) {
      run.status = RUN_STATUS.awaiting_user;
      run.updatedAt = this.now();
      return;
    }
    const waiting = tasks.some((task) => task.status === TASK_STATUS.awaiting_approval);
    const active = tasks.some((task) => task.status === TASK_STATUS.running || task.status === TASK_STATUS.ready);
    const failed = tasks.some((task) => (task.status === TASK_STATUS.failed || task.status === TASK_STATUS.blocked) && !task.optional);
    if (active) {
      run.status = RUN_STATUS.running;
      return;
    }
    if (waiting) {
      run.status = RUN_STATUS.awaiting_approval;
      run.updatedAt = this.now();
      return;
    }
    const status = failed ? RUN_STATUS.failed : RUN_STATUS.completed;
    if (run.status === status && run.endedAt) return;
    run.status = status;
    run.endedAt = this.now();
    run.updatedAt = this.now();
    this.#event(failed ? 'run.failed' : 'run.completed', { projectId: run.projectId, runId: run.id });
    this.memory.reflectRun(run);
  }

  #recordEvidence(run, task, worker, workspace, partial) {
    const record = {
      id: newId('evidence'),
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      createdAt: this.now(),
      type: partial.type || 'note',
      claim: partial.claim,
      confidence: partial.confidence ?? null,
      sources: partial.sources || [],
      provenance: {
        worker: worker.id,
        agentId: task.agentId,
        workspace: workspace.dir,
        artifact: partial.artifact || null,
      },
    };
    this.state.evidence.push(record);
    this.#event('evidence.recorded', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { evidenceId: record.id } });
    return record;
  }

  #synthesize(run, task) {
    const evidence = this.state.evidence.filter((item) => item.runId === run.id);
    const supported = evidence.filter((item) => item.type === 'supported');
    const conclusion = supported.length
      ? supported[0].claim
      : 'Insufficient supported evidence to close the question.';
    const objection = evidence.find((item) => item.type === 'conflict')?.claim || 'No independent objection was recorded.';
    const confidence = supported.length ? supported.reduce((sum, item) => sum + (item.confidence || 0), 0) / supported.length : 0.2;
    return this.#storeDecision(run, task, { conclusion, objection, confidence });
  }

  #recordDecision(run, task, decision) {
    return this.#storeDecision(run, task, {
      conclusion: decision.recommendation,
      objection: decision.objection || 'No independent objection was recorded.',
      confidence: Math.min(1, Math.max(0, Number(decision.confidence) || 0)),
      source: 'worker',
    });
  }

  #storeDecision(run, task, { conclusion, objection, confidence, source = 'engine' }) {
    const evidence = this.state.evidence.filter((item) => item.runId === run.id);
    const conflicts = evidence.filter((item) => item.type === 'conflict');
    const decision = {
      id: newId('decision'),
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      createdAt: this.now(),
      source,
      conclusion,
      objection,
      confidence,
      evidenceIds: evidence.map((item) => item.id),
      checks: [
        { name: 'Evidence present', status: evidence.length ? 'pass' : 'open' },
        { name: 'Independent objection', status: conflicts.length ? 'open' : 'pass' },
        { name: 'Provenance', status: evidence.every((item) => item.provenance?.workspace) ? 'pass' : 'open' },
      ],
    };
    this.state.decisions.push(decision);
    this.#event('decision.recorded', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { decisionId: decision.id } });
    return decision;
  }

  #writeRetrospective(run, task) {
    const tasks = this.#tasks(run.id);
    const failed = tasks.filter((item) => item.status === TASK_STATUS.failed);
    const retried = this.state.events.filter((item) => item.runId === run.id && item.type === 'task.retried');
    const whatFailed = failed.length
      ? failed.map((item) => `${item.title}: ${item.error || 'failed'}`).join('; ')
      : 'No task failed. Remaining uncertainty is an unmatched boundary condition in the evidence.';
    const why = failed.length
      ? 'A worker returned a terminal failure after retries, or a live provider was not enabled.'
      : 'The deterministic local worker completed, but the critique still found an untested constraint.';
    const shouldImprove = failed.length
      ? 'Fail closed on missing live workers and surface provider configuration before dispatch.'
      : 'Stop expanding a branch when the critique repeats the same unmatched constraint.';
    const proposal = {
      id: newId('proposal'),
      projectId: run.projectId,
      runId: run.id,
      createdAt: this.now(),
      status: 'proposed',
      decidedAt: null,
      type: 'policy',
      title: failed.length ? 'Do not dispatch disabled live workers' : 'Cap unproductive branch expansion',
      change: shouldImprove,
      payload: failed.length
        ? { key: 'maxRetries', value: 1 }
        : { key: 'maxConcurrency', value: Math.max(1, (run.maxConcurrency ?? 2) ) },
      selfModification: false,
      evaluationRequired: true,
      evaluationId: null,
      evaluationStatus: 'pending',
    };
    this.state.proposals.push(proposal);
    const retro = {
      id: newId('retro'),
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      createdAt: this.now(),
      whatFailed,
      why,
      shouldImprove,
      proposalId: proposal.id,
      retries: retried.length,
      failedTaskIds: failed.map((item) => item.id),
    };
    this.state.retrospectives.push(retro);
    this.#event('retrospective.recorded', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { retroId: retro.id } });
    this.#event('proposal.created', { projectId: run.projectId, runId: run.id, payload: { proposalId: proposal.id } });
    return retro;
  }

  // Worker proposals are recommendations: approving one records consent but never
  // changes runtime state, because only allowlisted policy proposals can apply.
  #recordWorkerRetrospective(run, task, retro) {
    const tasks = this.#tasks(run.id);
    const failed = tasks.filter((item) => item.status === TASK_STATUS.failed);
    const retries = this.store.readEventLog().filter((item) => item.runId === run.id && item.type === 'task.retried').length;
    const proposals = (retro.proposals || []).map((item) => ({
      id: newId('proposal'),
      projectId: run.projectId,
      runId: run.id,
      createdAt: this.now(),
      status: 'proposed',
      decidedAt: null,
      type: 'recommendation',
      title: item.title,
      change: item.change,
      rationale: item.rationale,
      risk: item.risk,
      payload: null,
      selfModification: false,
      evaluationRequired: true,
      evaluationId: null,
      evaluationStatus: 'pending',
      source: { taskId: task.id, taskKey: task.key || null },
    }));
    this.state.proposals.push(...proposals);
    const record = {
      id: newId('retro'),
      projectId: run.projectId,
      runId: run.id,
      taskId: task.id,
      createdAt: this.now(),
      source: 'worker',
      whatFailed: retro.what_failed,
      why: retro.why,
      shouldImprove: retro.should_improve,
      proposalId: proposals[0]?.id || null,
      proposalIds: proposals.map((item) => item.id),
      retries,
      failedTaskIds: failed.map((item) => item.id),
    };
    this.state.retrospectives.push(record);
    this.#event('retrospective.recorded', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { retroId: record.id } });
    for (const proposal of proposals) {
      this.#event('proposal.created', { projectId: run.projectId, runId: run.id, payload: { proposalId: proposal.id, title: proposal.title } });
    }
    return record;
  }

  #applyApprovedProposal(run) {
    const proposal = this.state.proposals.find((item) => item.runId === run.id && item.status === 'approved');
    if (!proposal) {
      return { summary: 'No approved proposal to apply', applied: false };
    }
    if (proposal.type === 'policy' && ALLOWED_POLICY_KEYS.has(proposal.payload?.key)) {
      const project = this.#require('projects', run.projectId, 'project');
      const preparedPromotion = this.improvements.preparePromotion(proposal, project);
      project[proposal.payload.key] = proposal.payload.value;
      proposal.applied = true;
      this.improvements.recordPromotion(proposal, project, preparedPromotion);
      this.#event('proposal.applied', {
        projectId: run.projectId,
        runId: run.id,
        payload: { proposalId: proposal.id, key: proposal.payload.key },
      });
      return { summary: `Applied policy ${proposal.payload.key}=${proposal.payload.value}`, applied: true };
    }
    proposal.applied = false;
    return {
      summary: 'Proposal approved but not applied: only allowlisted policy keys may change runtime state. Code is never self-modified.',
      applied: false,
    };
  }

  #tasks(runId) {
    return this.state.tasks.filter((item) => item.runId === runId);
  }

  #require(collection, id, label) {
    const item = (this.state[collection] || []).find((entry) => entry.id === id);
    if (!item) throw notFound(label, id);
    return item;
  }

  // Public event hook for registries and subsystems that live outside this class.
  recordEvent(type, fields = {}) {
    return this.#event(type, fields);
  }

  #event(type, fields = {}) {
    const event = { type, ...fields, ts: this.now() };
    return this.transactionDepth > 0 ? this.store.appendEvent(event) : this.store.appendEventAtomic(event);
  }

  #seedPolicies(projectId) {
    const specs = [
      { name: 'Evidence before synthesis', scope: 'run', state: 'enforced', detail: 'Synthesis waits until research branches are terminal and records provenance.' },
      { name: 'No automatic adoption', scope: 'project', state: 'enforced', detail: 'Improvement proposals require an explicit approve or reject. Default is proposal-only.' },
      { name: 'Local-first workers', scope: 'global', state: 'enforced', detail: 'Acceptance uses the deterministic local worker. Live Codex execution runs only when explicitly configured, and never falls back to another worker or model.' },
    ];
    for (const spec of specs) {
      this.state.policies.push({ id: newId('policy'), projectId, createdAt: this.now(), ...spec });
    }
  }
}

// Role variables the engine derives when a task does not set them: from the dependency
// results, from the brief, from the run record, or a fixed default. Task variables win.
const ENGINE_DERIVED_VARIABLES = Object.freeze({
  target: 'deps',
  branch_findings: 'deps',
  claims_under_test: 'deps',
  current_conclusion: 'deps',
  audit_scope: 'deps',
  objections: 'deps',
  verification: 'deps',
  analysis_question: 'brief',
  branch_question: 'brief',
  incident: 'brief',
  capability_request: 'brief',
  units: 'brief',
  unit_procedure: 'brief',
  proposed_writes: 'deps',
  existing_items: 'deps',
  run_record: 'run_record',
  memory_scope: 'run',
});

function summarizeRunRecord(telemetry) {
  if (!telemetry) return 'No run record available.';
  const counts = Object.entries(telemetry.counts || {}).map(([status, count]) => `${status}=${count}`).join(', ');
  return `Run ${telemetry.runId}: status ${telemetry.status}; tasks ${counts}; retries ${telemetry.retries?.total ?? 0} (injected ${telemetry.retries?.injected ?? 0}); verified attempts ${telemetry.verified ?? 0}/${telemetry.spawned ?? 0}; tokens in ${telemetry.tokens?.input ?? 0} out ${telemetry.tokens?.output ?? 0}; duration ${telemetry.durationMs ?? 0} ms.`;
}

// Variables the engine can supply to any preset render; see #promptVariables.
const ENGINE_PROMPT_VARIABLES = Object.freeze([
  'goal', 'definition_of_done', 'run_id', 'task_key', 'task_nonce', 'brief', 'context_paths', 'dependency_results',
  'memory_context', 'capabilities', 'budget', 'sandbox', 'max_findings', 'max_summary_words', 'escalation_target', 'delegation', 'language',
]);

function formatCapabilities(capabilities) {
  if (!capabilities) return undefined;
  const parts = [];
  for (const [kind, ids] of Object.entries(capabilities)) {
    if (Array.isArray(ids) && ids.length) parts.push(`${kind}: ${ids.join(', ')}`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

function formatBudget(budget) {
  if (!budget) return undefined;
  const parts = [];
  if (budget.tokens != null) parts.push(`${budget.tokens} tokens`);
  if (budget.usd != null) parts.push(`${budget.usd} USD`);
  if (budget.timeMs != null) parts.push(`${Math.round(budget.timeMs / 1000)} s wall clock`);
  return parts.length ? `At most ${parts.join(', ')} for this task.` : undefined;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function normalizeMcpRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null;
  const candidate = value.trim().replaceAll('\\', '/');
  if (!candidate || candidate.startsWith('/') || win32.isAbsolute(candidate) || isAbsolute(candidate)) return null;
  const pieces = candidate.split('/');
  if (pieces.some((piece) => !piece || piece === '..')) return null;
  return pieces.join('/');
}

function assertMcpPathChain(root, relativePath) {
  let current = root;
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new AosError('mcp_read_root_invalid', 'MCP project read root is not a real directory', { statusCode: 409 });
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    const item = lstatSync(current);
    if (item.isSymbolicLink()) throw new AosError('mcp_symlink_refused', 'MCP staged-text source path contains a symlink', { statusCode: 409 });
  }
}

function boundedMcpFileSnapshot(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const initial = fstatSync(fd);
    if (!initial.isFile()) throw new AosError('mcp_source_nonregular', 'MCP staged-text source must be a regular file', { statusCode: 409 });
    if (initial.size > MCP_MAX_SOURCE_BYTES) throw new AosError('mcp_source_oversize', 'MCP staged-text source exceeds the 64 KiB limit', { statusCode: 409 });
    const buffer = Buffer.alloc(MCP_MAX_SOURCE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const final = fstatSync(fd);
    if (!sameMcpStat(initial, final) || offset !== final.size) throw new AosError('mcp_source_changed', 'MCP staged-text source changed during inspection', { statusCode: 409 });
    if (offset > MCP_MAX_SOURCE_BYTES) throw new AosError('mcp_source_oversize', 'MCP staged-text source exceeds the 64 KiB limit', { statusCode: 409 });
    return { bytes: buffer.subarray(0, offset), stat: final, fingerprint: fingerprint(buffer.subarray(0, offset).toString('base64')) };
  } catch (error) {
    if (error instanceof AosError) throw error;
    throw new AosError('mcp_source_unavailable', 'MCP staged-text source could not be safely inspected', { statusCode: 409 });
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the primary result */ }
    }
  }
}

function sameMcpStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameMcpSourceIdentity(left, right) {
  return left.sourcePath === right.sourcePath && left.relativePath === right.relativePath
    && left.fingerprint === right.fingerprint && left.size === right.size
    && left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function safeMcpErrorMessage(error) {
  const allowed = new Set([
    'mcp_mount_count_invalid', 'mcp_mount_invalid', 'mcp_mount_reference_invalid', 'mcp_mount_version_invalid',
    'mcp_mount_fingerprint_invalid', 'mcp_mount_runtime_invalid', 'mcp_mount_source_invalid', 'mcp_sandbox_invalid',
    'mcp_read_paths_invalid', 'mcp_permissions_invalid', 'mcp_network_invalid', 'mcp_mount_unbound', 'mcp_execution_invalid',
    'mcp_selector_invalid', 'mcp_timeout_invalid', 'mcp_read_path_escape', 'mcp_read_root_invalid', 'mcp_symlink_refused',
    'mcp_source_nonregular', 'mcp_source_oversize', 'mcp_source_changed', 'mcp_sensitive_source', 'mcp_source_unavailable',
  ]);
  return allowed.has(error?.code) ? error.message : 'MCP capability admission was refused';
}

function cloneForReceipt(value) {
  if (value === undefined) return null;
  try { return structuredClone(value); } catch { return null; }
}

function delegationFingerprint(value) {
  try { return fingerprint(stableDelegationStringify(value)); } catch { return fingerprint(Object.prototype.toString.call(value)); }
}

function stableDelegationStringify(value, ancestors = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? String(value) : primitive;
  }
  if (ancestors.has(value)) return '"[cycle]"';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableDelegationStringify(item, ancestors)).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableDelegationStringify(value[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function delegationPatchFingerprint(value) {
  return fingerprint(stableDelegationStringify(value));
}

function assertDelegationTextSafe(value, path = 'candidatePatch', ancestors = new WeakSet()) {
  if (typeof value === 'string') {
    if (redactText(value) !== value) {
      throw new AosError('delegation_secret_content', `Delegation candidate contains secret-like content at ${path}`, {
        statusCode: 409,
        details: { field: path },
      });
    }
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return;
  ancestors.add(value);
  try {
    for (const [key, child] of Object.entries(value)) {
      if (redactText(key) !== key) {
        throw new AosError('delegation_secret_content', `Delegation candidate contains secret-like property metadata at ${path}`, {
          statusCode: 409,
          details: { field: `${path}.<property-name>` },
        });
      }
      assertDelegationTextSafe(child, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function delegationIsUnbounded(delegation) {
  return Boolean(delegation && typeof delegation === 'object' && !Array.isArray(delegation)
    && (delegation.unlimited === true
      || !Number.isInteger(delegation.maxChildren)
      || !Number.isInteger(delegation.maxDepth)));
}

function delegationIsOperatorPaced(task) {
  return task?.operatorPaced === true
    || task?.delegation?.operatorPaced === true
    || delegationIsUnbounded(task?.delegation);
}

function delegationAuthorityFingerprint(task) {
  const effective = task?.config?.effective || {};
  const filesystem = effective.filesystem || {};
  const network = effective.network || {};
  return delegationPatchFingerprint({
    worker: task?.worker || null,
    model: task?.model ?? effective.harness?.model ?? null,
    effort: task?.effort ?? effective.harness?.effort ?? null,
    capabilities: task?.capabilities ?? effective.capabilities ?? null,
    sandbox: task?.sandbox ?? filesystem.sandbox ?? null,
    readPaths: task?.readPaths ?? filesystem.readPaths ?? [],
    writePaths: filesystem.writePaths ?? [],
    network: { allowed: network.allowed === true, allowlist: network.allowlist ?? [] },
    mayDelegate: task?.mayDelegate === true,
    delegation: task?.delegation
      ? {
        maxChildren: task.delegation.maxChildren ?? null,
        maxDepth: task.delegation.maxDepth ?? null,
        childTemplates: task.delegation.childTemplates ?? [],
        childTemplateVersions: task.delegation.childTemplateVersions ?? {},
        unlimited: task.delegation.unlimited === true,
        operatorPaced: delegationIsOperatorPaced(task),
      }
      : null,
  });
}

function normalizeDelegationDecision(value) {
  const decision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['approve', 'approved', 'accept', 'accepted'].includes(decision)) return 'approve';
  if (['reject', 'rejected', 'deny', 'denied'].includes(decision)) return 'reject';
  throw new AosError('delegation_decision_invalid', 'Delegation decision must be approve or reject', { statusCode: 400, details: { decision: value ?? null } });
}

function normalizeDelegationRequestId(value) {
  const requestId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(requestId)) {
    throw new AosError('delegation_request_invalid', 'Delegation decision requestId must be a bounded identifier', { statusCode: 400 });
  }
  return requestId;
}

function delegationChildren(normalized) {
  if (Array.isArray(normalized)) return normalized;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return [];
  if (Array.isArray(normalized.children)) return normalized.children;
  if (Array.isArray(normalized.tasks)) return normalized.tasks;
  if (Array.isArray(normalized.additions?.tasks)) return normalized.additions.tasks;
  return [];
}

function delegationDependencies(normalized) {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return [];
  if (Array.isArray(normalized.dependencies)) return normalized.dependencies;
  if (Array.isArray(normalized.additions?.dependencies)) return normalized.additions.dependencies;
  return [];
}

function safeDelegationCode(value, fallback) {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(code) ? code : fallback;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function summarizeRuntime(runtime, { sessionId = null } = {}) {
  return {
    attempt: runtime.attempt,
    spawned: Boolean(runtime.spawned),
    injected: Boolean(runtime.injected),
    provider: runtime.provider || null,
    // Provider session references are captured behind HarnessSessionRegistry;
    // never fall back to exposing the provider's opaque id in public telemetry.
    threadId: null,
    sessionId,
    profile: runtime.profile || null,
    requested: runtime.requested || null,
    effective: runtime.effective
      ? {
        model: runtime.effective.model,
        effort: runtime.effective.effort,
        modelProvider: runtime.effective.modelProvider || null,
        source: runtime.effective.source || null,
        planType: runtime.effective.planType,
        sandbox: runtime.effective.sandbox,
        usedPercent: runtime.effective.usedPercent ?? null,
        ...(runtime.provider === 'command' ? {
          protocol: runtime.effective.protocol === EXTERNAL_HARNESS_PROTOCOL ? EXTERNAL_HARNESS_PROTOCOL : null,
          attestation: runtime.effective.attestation === EXTERNAL_HARNESS_ATTESTATION ? EXTERNAL_HARNESS_ATTESTATION : null,
          authType: runtime.effective.authType || null,
          sessionMode: runtime.effective.sessionMode || null,
        } : {}),
      }
      : null,
    verified: Boolean(runtime.verified),
    ...(runtime.provider === 'command' ? {
      protocol: runtime.protocol === EXTERNAL_HARNESS_PROTOCOL ? EXTERNAL_HARNESS_PROTOCOL : null,
      attestation: runtime.attestation === EXTERNAL_HARNESS_ATTESTATION ? EXTERNAL_HARNESS_ATTESTATION : null,
      externalVerified: runtime.externalVerified === false ? false : null,
    } : {}),
    exitCode: runtime.exitCode ?? null,
    signal: runtime.signal ?? null,
    timedOut: Boolean(runtime.timedOut),
    cancelled: Boolean(runtime.cancelled),
    startedAt: runtime.startedAt || null,
    endedAt: runtime.endedAt || null,
    durationMs: runtime.durationMs ?? null,
    usage: runtime.provider === 'ollama' ? summarizeOllamaUsage(runtime.usage) : summarizeUsage(runtime.usage),
    artifact: runtime.artifact || null,
    error: runtime.error ? String(runtime.error).slice(0, 500) : null,
  };
}

function buildWorkerTelemetry({ store, run, task, events, dependencies, agent, clock = () => Date.now() }) {
  const taskEvents = events.filter((event) => event.taskId === task.id);
  const runtime = hydrateRuntime(store, run, task);
  const currentAttempt = Number(task.attempts) || 0;
  if (task.status === TASK_STATUS.running && currentAttempt > 0 && !runtime.some((item) => item.attempt === currentAttempt)) {
    runtime.push(runtimeFromEvents(run, task, taskEvents, currentAttempt));
  }
  runtime.sort((a, b) => (a.attempt || 0) - (b.attempt || 0));
  const latest = runtime.at(-1) || null;
  const usage = runtime.reduce((total, item) => addUsage(total, item.usage), emptyUsage());
  const requested = latest?.requested || (task.worker === 'codex' ? { model: run.execution?.model || null, effort: run.execution?.effort || null } : null);
  const effective = latest?.effective || null;
  const latestEvent = taskEvents.at(-1) || null;

  return {
    taskId: task.id,
    taskCode: task.key || null,
    parentId: task.parentId || null,
    title: task.title,
    kind: task.kind,
    branch: task.branch || 'root',
    status: task.status,
    provider: task.worker || agent?.provider || 'local',
    profile: latest?.profile || task.providerProfile || null,
    execution: summarizeExecutionTelemetry(task.lease, clock),
    agentId: agent?.id || task.agentId || null,
    attempts: currentAttempt,
    model: effective?.model || requested?.model || (task.worker === 'local' ? 'local deterministic' : task.worker || 'unknown'),
    effort: effective?.effort || requested?.effort || null,
    planType: effective?.planType || null,
    verified: Boolean(latest?.verified),
    threadId: latest?.threadId || null,
    sessionId: latest?.sessionId || task.sessionId || null,
    startedAt: latest?.startedAt || task.startedAt || null,
    endedAt: latest?.endedAt || task.endedAt || null,
    durationMs: latest?.durationMs ?? null,
    usage,
    dependsOn: dependencies.filter((item) => item.taskId === task.id).map((item) => item.dependsOnTaskId),
    latestEvent: latestEvent ? { type: latestEvent.type, ts: latestEvent.ts } : null,
    runtime,
  };
}

function summarizeExecutionTelemetry(lease, clock) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return null;
  const executorKind = typeof lease?.executorKind === 'string' && lease.executorKind.trim()
    ? lease.executorKind.trim()
    : 'in_process';
  if (executorKind !== 'pool') return { kind: executorKind };

  const leaseUntil = typeof lease.leaseUntil === 'string' ? lease.leaseUntil : null;
  const leaseUntilMs = Date.parse(leaseUntil || '');
  const nowMs = Number(clock());
  const execution = {
    kind: executorKind,
    claimId: boundedTelemetryLeaseId(lease.claimId),
    ownerId: boundedTelemetryLeaseId(lease.ownerId),
    protocol: lease.poolProtocol === 'provider-adapter-v1' ? lease.poolProtocol : null,
    heartbeatAt: typeof lease.heartbeatAt === 'string' ? lease.heartbeatAt : null,
    leaseUntil,
    leaseState: Number.isFinite(leaseUntilMs) && Number.isFinite(nowMs) && leaseUntilMs > nowMs ? 'live' : 'expired',
  };
  if (Number.isInteger(lease.workerPid)) execution.workerPid = lease.workerPid;
  if (Number.isInteger(lease.workerPgid)) execution.workerPgid = lease.workerPgid;
  return execution;
}

function boundedTelemetryLeaseId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= POOL_ID_MAX_CHARS ? normalized : null;
}

function sameWorkspaceWriteIdentity(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return [
    'projectId',
    'runId',
    'taskId',
    'attempt',
    'capabilityReference',
    'capabilityFingerprint',
    'inputFingerprint',
    'effectType',
    'isolationMode',
    'isolationFingerprint',
    'rollbackPlanFingerprint',
  ].every((field) => left[field] === right[field]);
}

function workspaceWriteApprovalMatches(approval, identity) {
  if (!approval || typeof approval !== 'object' || !approval.approvalId) return false;
  return approval.attempt === identity.attempt
    && approval.capabilityReference === identity.capabilityReference
    && approval.capabilityFingerprint === identity.capabilityFingerprint
    && approval.inputFingerprint === identity.inputFingerprint
    && approval.isolationFingerprint === identity.isolationFingerprint
    && approval.rollbackPlanFingerprint === identity.rollbackPlanFingerprint;
}

function workspaceWriteApprovalView(record) {
  return {
    approvalId: record.approvalId,
    requestId: record.requestId,
    actor: record.actor,
    attempt: record.attempt,
    actionFingerprint: record.actionFingerprint,
    capabilityReference: record.capabilityReference,
    capabilityFingerprint: record.capabilityFingerprint,
    inputFingerprint: record.inputFingerprint,
    isolationFingerprint: record.isolationFingerprint,
    rollbackPlanFingerprint: record.rollbackPlanFingerprint,
  };
}

function publicTaskView(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
  const { lease: _lease, nonce: _nonce, runtime: _runtime, children: _children, ...publicTask } = task;
  return publicTask;
}

function publicTaskTreeNode(task) {
  return {
    ...publicTaskView(task),
    children: Array.isArray(task?.children) ? task.children.map(publicTaskTreeNode) : [],
  };
}

function hydrateRuntime(store, run, task) {
  const records = new Map((task.runtime || []).map((item) => [item.attempt, item]));
  for (let attempt = 1; attempt <= (Number(task.attempts) || 0); attempt += 1) {
    const path = join(store.workspacePath(run.id, task.id), `attempt-${attempt}`, 'runtime.json');
    if (!existsSync(path)) continue;
    try {
      records.set(attempt, summarizeRuntime(JSON.parse(readFileSync(path, 'utf8')), { sessionId: task.sessionId || null }));
    } catch {
      /* A worker may still be atomically finishing this record. */
    }
  }
  return [...records.values()];
}

function runtimeFromEvents(run, task, events, attempt) {
  const relevant = events.filter((event) => Number(event.payload?.attempt) === attempt);
  const latest = (type) => [...relevant].reverse().find((event) => event.type === type);
  const dispatched = latest('worker.dispatched');
  const spawned = latest('worker.spawned');
  const verified = latest('worker.verified');
  const exited = latest('worker.exited');
  const profile = dispatched?.payload?.profile || null;
  return {
    attempt,
    spawned: Boolean(spawned),
    injected: Boolean(latest('fault.injected')),
    provider: task.worker || null,
    // Event payloads are public; provider references must not be reconstructed
    // when an older or malformed event bypassed the capture wrapper.
    threadId: null,
    sessionId: verified?.payload?.sessionId || task.sessionId || null,
    requested: verified?.payload?.requested || (profile ? { model: profile.model, effort: profile.effort, sandbox: profile.sandbox } : task.worker === 'codex' ? { model: run.execution?.model || null, effort: run.execution?.effort || null } : null),
    effective: verified?.payload?.effective || null,
    profile,
    verified: Boolean(verified),
    exitCode: exited?.payload?.exitCode ?? null,
    signal: exited?.payload?.signal ?? null,
    timedOut: Boolean(exited?.payload?.timedOut),
    cancelled: Boolean(exited?.payload?.cancelled),
    startedAt: dispatched?.ts || task.startedAt || null,
    endedAt: exited?.ts || null,
    durationMs: exited?.payload?.durationMs ?? null,
    usage: null,
    artifact: null,
    error: null,
  };
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const values = {
    input_tokens: Number(usage.input_tokens),
    cached_input_tokens: Number(usage.cached_input_tokens),
    output_tokens: Number(usage.output_tokens),
    reasoning_output_tokens: Number(usage.reasoning_output_tokens),
  };
  return Object.values(values).every((value) => Number.isFinite(value) && value >= 0) ? values : null;
}

function summarizeOllamaUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const values = {};
  for (const field of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const value = Number(usage[field]);
    if (Number.isFinite(value) && value >= 0) values[field] = value;
  }
  if (usage.usd != null) {
    const usd = Number(usage.usd);
    if (Number.isFinite(usd) && usd >= 0) values.usd = usd;
  }
  return Object.keys(values).length ? values : null;
}

function emptyUsage() {
  return { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
}

function addUsage(total, usage) {
  if (!usage) return total;
  total.input_tokens += Number(usage.input_tokens) || 0;
  total.cached_input_tokens += Number(usage.cached_input_tokens) || 0;
  total.output_tokens += Number(usage.output_tokens) || 0;
  total.reasoning_output_tokens += Number(usage.reasoning_output_tokens) || 0;
  return total;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (!ms || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function normalizePoolId(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > POOL_ID_MAX_CHARS) {
    throw new AosError('pool_input_invalid', `${field} must be a non-empty string of at most ${POOL_ID_MAX_CHARS} characters`, { statusCode: 400, details: { field } });
  }
  return value.trim();
}

function normalizePoolProtocol(value) {
  if (value == null) return null;
  if (value !== 'provider-adapter-v1') {
    throw new AosError('pool_input_invalid', 'Unsupported worker-pool protocol', { statusCode: 400, details: { field: 'protocol' } });
  }
  return value;
}

function normalizePoolProfileFingerprint(value, protocol) {
  if (!protocol) {
    if (value != null) throw new AosError('pool_input_invalid', 'profileFingerprint requires a worker-pool protocol', { statusCode: 400, details: { field: 'profileFingerprint' } });
    return null;
  }
  const fingerprintValue = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-f0-9]{16}$/.test(fingerprintValue)) {
    throw new AosError('pool_input_invalid', 'profileFingerprint must be an AOS profile fingerprint', { statusCode: 400, details: { field: 'profileFingerprint' } });
  }
  return fingerprintValue;
}

function poolExactRuntimeValue(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const observed = value.split(',').map((item) => item.trim()).filter(Boolean);
  return observed.length > 0 && observed.every((item) => item === expected);
}

function normalizePoolAttempt(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new AosError('pool_input_invalid', 'attempt must be a positive integer', { statusCode: 400, details: { field: 'attempt' } });
  }
  return value;
}

function normalizePoolPid(value, field) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 2 ** 31 - 1) {
    throw new AosError('pool_input_invalid', `${field} must be a positive process id or null`, { statusCode: 400, details: { field } });
  }
  return value;
}

function normalizePoolResult(input, task) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AosError('pool_result_invalid', 'Pool completion result must be an object', { statusCode: 400, details: { field: 'result' } });
  }
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new AosError('pool_result_invalid', 'Pool completion result must be JSON-serializable', { statusCode: 400, details: { field: 'result' } });
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > POOL_RESULT_MAX_BYTES) {
    throw new AosError('pool_result_invalid', `Pool completion result exceeds ${POOL_RESULT_MAX_BYTES} bytes`, { statusCode: 400, details: { field: 'result', maxBytes: POOL_RESULT_MAX_BYTES } });
  }
  const bounded = boundedPoolValue(input);
  const status = bounded.status;
  if (!['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(status)) {
    throw new AosError('pool_result_invalid', 'Pool completion result has an unsupported status', { statusCode: 400, details: { field: 'result.status', status: status || null } });
  }
  const nonce = bounded.task_nonce ?? bounded.taskNonce ?? bounded.nonce
    ?? (bounded.result && typeof bounded.result === 'object' && !Array.isArray(bounded.result)
      ? bounded.result.task_nonce ?? bounded.result.taskNonce ?? bounded.result.nonce
      : undefined);
  if (['succeeded', 'awaiting_user'].includes(status) && nonce !== task.nonce) {
    throw new AosError('pool_result_nonce_mismatch', 'Successful or awaiting-user pool results must echo the task nonce', { statusCode: 409, details: { taskId: task.id } });
  }
  if (nonce !== undefined && nonce !== task.nonce) {
    throw new AosError('pool_result_nonce_mismatch', 'Pool completion result carried another task nonce', { statusCode: 409, details: { taskId: task.id } });
  }
  if (status === 'awaiting_user') {
    try {
      bounded.questions = validateTaskQuestions(bounded.questions);
    } catch (error) {
      throw new AosError(error.code || 'pool_result_invalid', error.message, { statusCode: error.statusCode || 409, details: error.details || { field: 'result.questions' } });
    }
  }
  if (bounded.summary !== undefined && typeof bounded.summary !== 'string') {
    throw new AosError('pool_result_invalid', 'Pool completion summary must be a string', { statusCode: 400, details: { field: 'result.summary' } });
  }
  if (bounded.error !== undefined && typeof bounded.error !== 'string') {
    throw new AosError('pool_result_invalid', 'Pool completion error must be a string', { statusCode: 400, details: { field: 'result.error' } });
  }
  bounded.summary = poolSafeString(bounded.summary || '', 2_000);
  bounded.error = bounded.error ? poolSafeString(bounded.error, 4_000) : null;
  bounded.artifacts = Array.isArray(bounded.artifacts)
    ? bounded.artifacts.map((artifact) => poolSafeString(artifact, 512))
    : [];
  bounded.runtime = bounded.runtime && typeof bounded.runtime === 'object' && !Array.isArray(bounded.runtime)
    ? bounded.runtime
    : null;
  for (const key of ['task_nonce', 'taskNonce', 'nonce']) delete bounded[key];
  return bounded;
}

function boundedPoolValue(value, depth = 0) {
  if (depth > POOL_RESULT_MAX_DEPTH) {
    throw new AosError('pool_result_invalid', 'Pool completion result is nested too deeply', { statusCode: 400, details: { maxDepth: POOL_RESULT_MAX_DEPTH } });
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > POOL_RESULT_MAX_STRING_CHARS) {
      throw new AosError('pool_result_invalid', `Pool completion strings must be at most ${POOL_RESULT_MAX_STRING_CHARS} characters`, { statusCode: 400, details: { maxLength: POOL_RESULT_MAX_STRING_CHARS } });
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AosError('pool_result_invalid', 'Pool completion numbers must be finite', { statusCode: 400 });
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > POOL_RESULT_MAX_ENTRIES) throw new AosError('pool_result_invalid', `Pool completion arrays must contain at most ${POOL_RESULT_MAX_ENTRIES} items`, { statusCode: 400 });
    return value.map((item) => boundedPoolValue(item, depth + 1));
  }
  if (typeof value !== 'object') throw new AosError('pool_result_invalid', 'Pool completion result contains an unsupported value', { statusCode: 400 });
  const keys = Object.keys(value);
  if (keys.length > POOL_RESULT_MAX_ENTRIES) throw new AosError('pool_result_invalid', `Pool completion objects must contain at most ${POOL_RESULT_MAX_ENTRIES} fields`, { statusCode: 400 });
  return Object.fromEntries(keys.map((key) => {
    if (typeof key !== 'string' || key.length > 128) throw new AosError('pool_result_invalid', 'Pool completion field names are bounded', { statusCode: 400 });
    return [key, boundedPoolValue(value[key], depth + 1)];
  }));
}

function poolSafeString(value, max = POOL_RESULT_MAX_STRING_CHARS) {
  if (value == null) return null;
  return redactText(String(value)).slice(0, max);
}

function poolSafeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value == null ? null : {};
  try {
    return redactSecrets(boundedPoolValue(value));
  } catch {
    return {};
  }
}

function poolCapabilityMountFingerprint(mounts) {
  const normalized = Array.isArray(mounts)
    ? mounts.map((mount) => ({
      id: mount?.id || null,
      version: mount?.version ?? null,
      reference: mount?.reference || null,
      kind: mount?.kind || null,
      fingerprint: mount?.fingerprint || null,
      permissions: Array.isArray(mount?.permissions) ? [...mount.permissions].sort() : [],
      adapter: mount?.adapter || null,
      runtime: mount?.runtime || null,
      testReceiptId: mount?.testReceiptId || null,
      permissionId: mount?.permissionId || null,
    })).sort((left, right) => String(left.reference).localeCompare(String(right.reference)))
    : [];
  return delegationPatchFingerprint(normalized);
}

function poolCapabilityViews(mounts) {
  if (!Array.isArray(mounts)) return [];
  return mounts.slice(0, 20).map((mount) => ({
    id: poolSafeString(mount?.id, 128),
    version: Number.isInteger(mount?.version) ? mount.version : null,
    reference: poolSafeString(mount?.reference, 256),
    kind: poolSafeString(mount?.kind, 80),
    fingerprint: poolSafeString(mount?.fingerprint, 128),
    permissions: Array.isArray(mount?.permissions) ? mount.permissions.slice(0, 20).map((permission) => poolSafeString(permission, 120)) : [],
    testReceiptId: poolSafeString(mount?.testReceiptId, 128),
    permissionId: poolSafeString(mount?.permissionId, 128),
    adapter: mount?.adapter && typeof mount.adapter === 'object' ? poolSafeObject(mount.adapter) : null,
    runtime: mount?.runtime && typeof mount.runtime === 'object' ? poolSafeObject(mount.runtime) : null,
  }));
}

function poolBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return {};
  return Object.fromEntries(['tokens', 'usd', 'timeMs'].map((dimension) => [dimension,
    typeof budget[dimension] === 'number' && Number.isFinite(budget[dimension]) ? budget[dimension] : null]));
}

function poolTaskReadPaths(task) {
  const paths = task.readPaths
    ?? task.config?.effective?.filesystem?.readPaths
    ?? task.config?.effective?.readPaths
    ?? [];
  return Array.isArray(paths) ? paths.filter((path) => typeof path === 'string').slice(0, 100) : [];
}

function poolStoredResult(result) {
  const direct = {};
  for (const key of ['findings', 'risks', 'confidence', 'decision', 'retrospective', 'memory_writes', 'delegation']) {
    if (result[key] !== undefined) direct[key] = result[key];
  }
  const source = result.result !== undefined ? result.result : Object.keys(direct).length ? direct : undefined;
  if (source === undefined) return undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
  const value = structuredClone(source);
  delete value.task_nonce;
  delete value.taskNonce;
  delete value.nonce;
  delete value.delegation;
  return redactSecrets(value);
}

export { IsolationError };
