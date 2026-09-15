import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './store.js';
import { fingerprint, newId, nowIso } from './ids.js';
import { identifyAmbiguities, interpretGoal, questionsFromAmbiguities, validatePlan } from './intake.js';
import { claimWorkspace, createWorkerRegistry, IsolationError } from './workers.js';
import { applyExecutionToProviders, defaultProviders, publicProviderView, redactSecrets, refreshProviderSecrets } from './providers.js';
import { CODEX_AUTH_PATH, resolveCodexConfig } from './codex.js';
import { notFound } from './schema.js';
import { PresetRegistry } from './presets/registry.js';
import { TemplateRegistry, applyTemplateToTask } from './templates.js';
import { BlueprintRegistry } from './blueprints.js';
import { MemoryService } from './memory/index.js';
import { SettingsRegistry } from './settings.js';
import { AosError, invalid } from './schema.js';

export const TASK_STATUS = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  awaiting_approval: 'awaiting_approval',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const RUN_STATUS = {
  planning: 'planning',
  running: 'running',
  paused: 'paused',
  awaiting_approval: 'awaiting_approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const TERMINAL = new Set([TASK_STATUS.succeeded, TASK_STATUS.failed, TASK_STATUS.cancelled]);
const NOT_DISPATCHABLE = new Set([RUN_STATUS.paused, RUN_STATUS.cancelled, RUN_STATUS.failed, RUN_STATUS.completed]);

const ALLOWED_POLICY_KEYS = new Set(['maxConcurrency', 'maxRetries', 'retentionDays']);

// Attempt leases: a running task carries the driver that owns it and an expiry. Another
// process may take the task over only when the lease is missing, expired, or its driver is dead.
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const LEASE_GRACE_MS = 60_000;
const HEARTBEAT_MIN_MS = 5_000;
const REAP_KILL_GRACE_MS = 5_000;

export function resolveExecution(input) {
  if (!input || input === 'local' || input.mode === 'local') return Object.freeze({ mode: 'local' });
  if (input.mode !== 'codex') throw new Error(`Unknown execution mode: ${input.mode}`);
  return Object.freeze({ mode: 'codex', codex: resolveCodexConfig(input.codex || {}) });
}

export class AosEngine {
  constructor({ dataDir, clock = () => Date.now(), concurrency = 2, execution = null, memory = null } = {}) {
    if (!dataDir) throw new Error('dataDir is required');
    this.clock = clock;
    this.defaultConcurrency = concurrency;
    this.execution = resolveExecution(execution);
    this.providerReadiness = { codex: this.live ? { status: 'unverified', checkedAt: null } : null };
    this.store = new JsonStore({ dataDir, clock });
    this.workers = createWorkerRegistry({ codex: this.execution.codex || null });
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
  }

  get state() {
    return this.store.state;
  }

  get live() {
    return this.execution.mode === 'codex';
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
      this.transactionDepth = 1;
      const result = fn();
      this.store.save();
      return result;
    } finally {
      this.transactionDepth = 0;
      unlock();
    }
  }

  // Only seeds an empty store. Read-only callers (CLI watchers) never rewrite state.
  load() {
    this.store.load();
    let changed = false;
    if (!this.state.providers.length) {
      this.state.providers = defaultProviders();
      changed = true;
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
        interpreted = interpretGoal({ prompt, contextPaths, execution: this.execution.mode });
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

  answerQuestions(goalId, answers = []) {
    return this.transact(() => {
      const goal = this.#require('goals', goalId, 'goal');
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
      goal.status = remaining.length ? 'awaiting_user' : 'planned';
      goal.updatedAt = this.now();
      this.#event('goal.questions_answered', {
        projectId: goal.projectId,
        payload: { goalId, answeredQuestionIds: [...byId.keys()], remainingRequired: remaining.length },
      });
      if (previousStatus === 'awaiting_user' && goal.status === 'planned') {
        this.#event('goal.ready', { projectId: goal.projectId, payload: { goalId } });
      }
      return goal;
    });
  }

  startRun({ goalId, projectId, maxConcurrency, blueprintId = null, blueprintVersion = null } = {}) {
    return this.transact(() => {
    const goal = this.#require('goals', goalId, 'goal');
    if (goal.status === 'awaiting_user') {
      const remaining = goal.questions.filter((question) => question.required && !String(question.answer || '').trim());
      const error = new Error(`Goal ${goal.id} is awaiting user input for ${remaining.length} required question${remaining.length === 1 ? '' : 's'}`);
      error.statusCode = 409;
      error.code = 'goal_awaiting_user';
      error.details = { goalId: goal.id, questionIds: remaining.map((question) => question.id) };
      throw error;
    }
    const project = this.#require('projects', projectId || goal.projectId, 'project');
    const blueprint = blueprintId ? this.blueprints.get(blueprintId, blueprintVersion) : null;
    const settings = blueprint ? this.blueprints.runSettings(blueprint) : null;
    const plannedTasks = blueprint ? this.blueprints.applyToPlan(blueprint, goal.plan.tasks) : goal.plan.tasks;
    const requestedCap = maxConcurrency != null ? maxConcurrency : settings ? settings.maxConcurrency : project.maxConcurrency;
    const cap = this.#runConcurrency(requestedCap, maxConcurrency != null);
    if (this.live) this.#assertLivePlan(goal.plan);
    if (settings && settings.ceilings.tasks != null && plannedTasks.length > settings.ceilings.tasks) {
      throw new AosError('blueprint_ceiling', `Plan has ${plannedTasks.length} tasks; blueprint ${blueprint.id} allows ${settings.ceilings.tasks}`, { statusCode: 409, details: { blueprintId: blueprint.id, tasks: plannedTasks.length, ceiling: settings.ceilings.tasks } });
    }
    this.#validatePlannedTasks(goal, plannedTasks);
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
      ceilings: settings?.ceilings ?? null,
      policies: settings ? { depth: settings.depth, perBranchConcurrency: settings.perBranchConcurrency, gates: settings.gates, failure: settings.failure, stop: settings.stop, memory: settings.memory, contextPartition: settings.contextPartition, messaging: settings.messaging, artifacts: settings.artifacts, routing: settings.routing, priority: settings.priority } : null,
    };
    this.state.runs.push(run);

    const idMap = new Map();
    for (const planned of plannedTasks) {
      const task = {
        ...planned,
        id: newId('task'),
        key: planned.key ?? null,
        runId: run.id,
        projectId: project.id,
        goalId: goal.id,
        status: TASK_STATUS.pending,
        attempts: 0,
        agentId: null,
        workspace: null,
        lease: null,
        output: null,
        error: null,
        startedAt: null,
        endedAt: null,
      };
      task.nonce = `aos-${fingerprint(`${run.id}|${task.id}|${planned.id}`)}`;
      task.planTaskId = planned.id;
      if (planned.templateId) {
        applyTemplateToTask(task, planned, this.templates.get(planned.templateId, planned.templateVersion ?? null));
      } else if (planned.presetId) {
        task.presetId = planned.presetId;
        task.presetVersion = planned.presetVersion ?? null;
      }
      idMap.set(planned.id, task.id);
      this.state.tasks.push(task);
      const agent = {
        id: newId('agent'),
        projectId: project.id,
        runId: run.id,
        taskId: task.id,
        name: planned.title,
        role: planned.kind,
        provider: planned.worker || 'local',
        status: 'queued',
        workspace: null,
      };
      this.state.agents.push(agent);
      task.agentId = agent.id;
    }

    for (const task of this.state.tasks.filter((item) => item.runId === run.id && item.parentId)) {
      task.parentId = idMap.get(task.parentId) || null;
    }

    for (const dep of goal.plan.dependencies) {
      this.state.dependencies.push({
        id: newId('dep'),
        runId: run.id,
        taskId: idMap.get(dep.taskId),
        dependsOnTaskId: idMap.get(dep.dependsOnTaskId),
      });
    }

    this.#refreshReady(run.id);
    this.#event('run.started', {
      projectId: project.id,
      runId: run.id,
      payload: { goalId: goal.id, maxConcurrency: cap, execution: run.execution, taskCount: plannedTasks.length, blueprint: run.blueprint },
    });
    return run;
    });
  }

  // One driver per run. A second call while the run is being driven joins the first.
  advanceRun(runId, options = {}) {
    const existing = this.drivers.get(runId);
    if (existing) return existing;
    const driver = this.#drive(runId, options).finally(() => this.drivers.delete(runId));
    this.drivers.set(runId, driver);
    return driver;
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
      run.status = RUN_STATUS.running;
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
    run.status = RUN_STATUS.cancelled;
    run.endedAt = this.now();
    run.updatedAt = this.now();
    for (const task of this.#tasks(run.id)) {
      if (!TERMINAL.has(task.status)) {
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        task.lease = null;
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        if (agent) agent.status = 'cancelled';
        this.inflight.get(task.id)?.controller.abort();
        this.#event('task.cancelled', { projectId: run.projectId, runId: run.id, taskId: task.id });
      }
    }
    this.#event('run.cancelled', { projectId: run.projectId, runId: run.id });
    return run;
    });
  }

  cancelTask(taskId) {
    return this.transact(() => {
    const task = this.#require('tasks', taskId, 'task');
    if (!TERMINAL.has(task.status)) {
      task.status = TASK_STATUS.cancelled;
      task.endedAt = this.now();
      task.lease = null;
      this.inflight.get(task.id)?.controller.abort();
      this.#event('task.cancelled', { projectId: task.projectId, runId: task.runId, taskId: task.id });
      this.#refreshReady(task.runId);
    }
    return task;
    });
  }

  approveTask(taskId) {
    return this.transact(() => {
    const task = this.#require('tasks', taskId, 'task');
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

  approveProposal(proposalId) {
    return this.transact(() => {
    const proposal = this.#require('proposals', proposalId, 'proposal');
    if (proposal.status !== 'proposed') throw new Error(`Proposal ${proposalId} is not pending`);
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

  executionSummary() {
    if (!this.live) return { mode: 'local' };
    const { model, effort, maxConcurrency, timeoutMs } = this.execution.codex;
    return { mode: 'codex', provider: 'codex', authPath: CODEX_AUTH_PATH, model, effort, sandbox: 'read-only', maxConcurrency, timeoutMs };
  }

  runtimeTelemetry(runId, allEvents = this.store.readEventLog()) {
    const run = this.#require('runs', runId, 'run');
    const tasks = this.#tasks(run.id);
    const events = allEvents.filter((event) => event.runId === run.id);
    const dependencies = this.state.dependencies.filter((item) => item.runId === run.id);
    const agents = new Map(this.state.agents.filter((item) => item.runId === run.id).map((item) => [item.taskId, item]));
    const workers = tasks.map((task) => buildWorkerTelemetry({ store: this.store, run, task, events, dependencies, agent: agents.get(task.id) }));
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
    const tree = run ? this.getRunTree(run.id) : { roots: [], tasks: [] };
    const project = this.defaultProject();
    const eventLog = this.store.readEventLog();
    return redactSecrets({
      generatedAt: this.now(),
      mode: 'live',
      execution: this.executionSummary(),
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
      policies: this.state.policies,
      providers: this.listProviders(),
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
      this.providerReadiness.codex,
    ).map(publicProviderView);
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
          return this.#tasks(runId)
            .filter((task) => task.status === TASK_STATUS.ready)
            .slice(0, Math.max(0, slots))
            .map((task) => task.id);
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
    try {
      const result = await this.workers.get('codex').preflight();
      this.providerReadiness.codex = {
        status: 'available',
        checkedAt: result.checkedAt,
        model: result.model?.slug || result.requested?.model || this.execution.codex.model,
        effort: result.requested?.effort || this.execution.codex.effort,
      };
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
      this.providerReadiness.codex = {
        status: 'unavailable',
        checkedAt: new Date(this.clock()).toISOString(),
      };
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
    if (lease.host && lease.host !== hostname()) return 'driver on another host';
    if (!lease.leaseUntil || Date.parse(lease.leaseUntil) < this.clock()) return 'lease expired';
    if (lease.driverPid === process.pid) {
      if (lease.driverId === this.driverId && !this.inflight.has(task.id)) return 'no live driver in this process';
      return null;
    }
    if (!pidAlive(lease.driverPid)) return 'driver process dead';
    return null;
  }

  #newLease(task, attempt) {
    const ttlMs = (task.timeoutMs || this.execution.codex?.timeoutMs || DEFAULT_LEASE_TTL_MS) + LEASE_GRACE_MS;
    const now = this.now();
    return {
      attempt,
      driverId: this.driverId,
      driverPid: process.pid,
      host: hostname(),
      workerPid: null,
      workerPgid: null,
      startedAt: now,
      heartbeatAt: now,
      leaseUntil: new Date(this.clock() + ttlMs).toISOString(),
      ttlMs,
    };
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
    task.lease = null;
    task.error = reason;
    this.inflight.delete(task.id);
    if (attempt <= (task.maxRetries ?? 1)) {
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

  #freeSlots(run) {
    const running = this.#tasks(run.id).filter((task) => task.status === TASK_STATUS.running).length;
    const cap = run.maxConcurrency == null || run.maxConcurrency <= 0 ? Infinity : run.maxConcurrency;
    let free = cap - running;
    if (this.live) free = Math.min(free, this.execution.codex.maxConcurrency - this.inflight.size);
    return Math.max(0, free);
  }

  #runConcurrency(value, explicit) {
    if (!this.live) return value;
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
    const { model, effort } = this.execution.codex;
    for (const task of plan.tasks) {
      const allowed = task.worker === 'codex' || (task.worker === 'engine' && task.kind === 'adopt');
      if (!allowed) {
        throw new Error(`Live Codex mode refuses task "${task.title}" on worker "${task.worker}": worker tasks must run on codex ${model}/${effort}; there is no fallback`);
      }
    }
  }

  #refuseWorker(task, worker) {
    if (!worker) return `No worker named "${task.worker}" is registered; refusing to fall back to another worker`;
    if (worker.id === 'engine' && task.kind !== 'adopt') return 'The engine executor only applies approved proposals';
    if (this.live && worker.id !== 'codex' && worker.id !== 'engine') {
      return `Live Codex mode refuses worker "${worker.id}" for ${task.kind}; there is no fallback`;
    }
    return null;
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
        emitNow('worker.refused', { worker: task.worker || null, reason: refusal });
        this.#failTask(run, task, agent, refusal, { retryable: false });
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
        if (error instanceof IsolationError) {
          emitNow('isolation.denied', { error: error.message });
          this.#failTask(run, task, agent, error.message, { retryable: false });
          return null;
        }
        throw error;
      }
      task.workspace = workspace.dir;
      if (agent) agent.workspace = workspace.dir;

      const controller = new AbortController();
      this.inflight.set(task.id, { controller, runId: run.id, worker: worker.id });
      task.lease = this.#newLease(task, attempt);
      const running = this.#tasks(run.id).filter((item) => item.status === TASK_STATUS.running).length;
      emitNow('worker.dispatched', { worker: worker.id, running, cap: run.maxConcurrency ?? null });
      this.#event('task.started', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { attempt, key: task.key || null } });
      return { attempt, worker, workspace, controller, agentId: agent?.id ?? null, projectId: run.projectId, key: task.key || null };
    });
    if (!prepared) return;
    const { attempt, worker, workspace, controller, agentId, projectId, key } = prepared;
    const emit = (type, payload = {}) => this.#event(type, { projectId, runId, taskId, payload: { attempt, key, ...payload } });
    const freshRun = () => this.#require('runs', runId, 'run');
    const freshTask = () => this.#require('tasks', taskId, 'task');

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
      repoRoot: this.execution.codex?.repoRoot || null,
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
      result = task.injectFault && task.injectFault.attempt === attempt
        ? await this.#injectFault(freshRun(), task, workspace, controller.signal, emit)
        : await worker.execute(task, ctx);
    } catch (error) {
      result = { status: 'failed', error: error.message, retryable: error.retryable === false ? false : !error.fatal, fatal: Boolean(error.fatal), details: error.details };
    } finally {
      this.inflight.delete(taskId);
      this.#releaseSlot();
    }
    result = result || { status: 'failed', error: 'Worker returned no result' };
    this.transact(() => {
      const run = freshRun();
      const task = freshTask();
      const agent = this.state.agents.find((item) => item.id === agentId);
      if (result.runtime) task.runtime = [...(task.runtime || []), summarizeRuntime(result.runtime)];
      if (task.lease && task.lease.attempt === attempt) task.lease = null;

      if (task.status !== TASK_STATUS.running) {
        emit('worker.result_discarded', { status: result.status, taskStatus: task.status });
        return;
      }

      if (result.status === 'succeeded') {
        task.status = TASK_STATUS.succeeded;
        task.output = { summary: result.summary, artifacts: result.artifacts || [], ...(result.result ? { result: result.result } : {}) };
        task.endedAt = this.now();
        if (agent) agent.status = 'complete';
        if (result.result) this.#absorbResult(run, task, worker, workspace, result.result);
        this.#event('task.completed', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { summary: result.summary, attempt, key: task.key || null } });
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
        });
        if (result.fatal) this.#abortRun(run, error, result.details);
      }
    });
  }

  async #injectFault(run, task, workspace, signal, emit) {
    const fault = task.injectFault;
    const holdMs = fault.holdMs || 0;
    const startedAt = this.now();
    const error = fault.error || `Injected retryable failure on attempt ${task.attempts}`;
    emit('fault.injected', { holdMs, error });
    await abortableDelay(holdMs, signal);
    const runtime = {
      runId: run.id,
      taskId: task.id,
      taskKey: task.key || null,
      attempt: task.attempts,
      spawned: false,
      injected: true,
      provider: task.worker,
      requested: this.live ? { model: this.execution.codex.model, effort: this.execution.codex.effort } : null,
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

  #failTask(run, task, agent, error, { retryable = true, injected = false, fatal = false } = {}) {
    task.error = error;
    const payload = { attempt: task.attempts, key: task.key || null, error, retryable, injected, fatal };
    if (retryable && !fatal && task.attempts <= (task.maxRetries ?? 1)) {
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
    run.status = RUN_STATUS.failed;
    run.error = redactSecrets({ reason, details: details || null });
    run.endedAt = this.now();
    run.updatedAt = this.now();
    for (const task of this.#tasks(run.id)) {
      this.inflight.get(task.id)?.controller.abort();
      if (!TERMINAL.has(task.status)) {
        task.status = TASK_STATUS.cancelled;
        task.endedAt = this.now();
        task.lease = null;
        const agent = this.state.agents.find((item) => item.id === task.agentId);
        if (agent) agent.status = 'cancelled';
        this.#event('task.cancelled', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { reason: 'run aborted' } });
      }
    }
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
    for (const task of tasks) {
      if (task.status !== TASK_STATUS.pending && task.status !== TASK_STATUS.ready && task.status !== TASK_STATUS.awaiting_approval) {
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
      }
    }
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
    const active = tasks.some((task) => task.status === TASK_STATUS.running || task.status === TASK_STATUS.ready);
    return !active;
  }

  #settleRun(run) {
    if (run.status === RUN_STATUS.cancelled || run.status === RUN_STATUS.paused || run.error) return;
    const tasks = this.#tasks(run.id);
    const waiting = tasks.some((task) => task.status === TASK_STATUS.awaiting_approval);
    const active = tasks.some((task) => task.status === TASK_STATUS.running || task.status === TASK_STATUS.ready);
    const failed = tasks.some((task) => task.status === TASK_STATUS.failed && !task.optional);
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
      project[proposal.payload.key] = proposal.payload.value;
      proposal.applied = true;
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
    return this.store.appendEvent({ type, ...fields, ts: this.now() });
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function summarizeRuntime(runtime) {
  return {
    attempt: runtime.attempt,
    spawned: Boolean(runtime.spawned),
    injected: Boolean(runtime.injected),
    provider: runtime.provider || null,
    threadId: runtime.threadId || null,
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
      }
      : null,
    verified: Boolean(runtime.verified),
    exitCode: runtime.exitCode ?? null,
    signal: runtime.signal ?? null,
    timedOut: Boolean(runtime.timedOut),
    cancelled: Boolean(runtime.cancelled),
    startedAt: runtime.startedAt || null,
    endedAt: runtime.endedAt || null,
    durationMs: runtime.durationMs ?? null,
    usage: summarizeUsage(runtime.usage),
    artifact: runtime.artifact || null,
    error: runtime.error ? String(runtime.error).slice(0, 500) : null,
  };
}

function buildWorkerTelemetry({ store, run, task, events, dependencies, agent }) {
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
    agentId: agent?.id || task.agentId || null,
    attempts: currentAttempt,
    model: effective?.model || requested?.model || (task.worker === 'local' ? 'local deterministic' : task.worker || 'unknown'),
    effort: effective?.effort || requested?.effort || null,
    planType: effective?.planType || null,
    verified: Boolean(latest?.verified),
    threadId: latest?.threadId || null,
    startedAt: latest?.startedAt || task.startedAt || null,
    endedAt: latest?.endedAt || task.endedAt || null,
    durationMs: latest?.durationMs ?? null,
    usage,
    dependsOn: dependencies.filter((item) => item.taskId === task.id).map((item) => item.dependsOnTaskId),
    latestEvent: latestEvent ? { type: latestEvent.type, ts: latestEvent.ts } : null,
    runtime,
  };
}

function hydrateRuntime(store, run, task) {
  const records = new Map((task.runtime || []).map((item) => [item.attempt, item]));
  for (let attempt = 1; attempt <= (Number(task.attempts) || 0); attempt += 1) {
    const path = join(store.workspacePath(run.id, task.id), `attempt-${attempt}`, 'runtime.json');
    if (!existsSync(path)) continue;
    try {
      records.set(attempt, summarizeRuntime(JSON.parse(readFileSync(path, 'utf8'))));
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
  const thread = latest('worker.thread');
  const verified = latest('worker.verified');
  const exited = latest('worker.exited');
  return {
    attempt,
    spawned: Boolean(spawned),
    injected: Boolean(latest('fault.injected')),
    provider: task.worker || null,
    threadId: thread?.payload?.threadId || verified?.payload?.threadId || null,
    requested: verified?.payload?.requested || (task.worker === 'codex' ? { model: run.execution?.model || null, effort: run.execution?.effort || null } : null),
    effective: verified?.payload?.effective || null,
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
  return {
    input_tokens: Number(usage.input_tokens) || 0,
    cached_input_tokens: Number(usage.cached_input_tokens) || 0,
    output_tokens: Number(usage.output_tokens) || 0,
    reasoning_output_tokens: Number(usage.reasoning_output_tokens) || 0,
  };
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

export { IsolationError };
