// Immutable per-run plan snapshots and the one operator-only expansion seam.
// Runtime task records are materialised by AosEngine; this service owns validation,
// versioning and receipts so no caller can silently rewrite an existing plan.
import { fingerprint, newId } from './ids.js';
import { applyTemplateToTask } from './templates.js';
import { validatePlan } from './intake.js';
import { assertOllamaTaskAdmission } from './provider-contracts.js';
import { AosError, invalid, notFound } from './schema.js';

export const PLAN_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ACTIVE_RUNS = new Set(['running', 'paused']);
const TERMINAL_RUNS = new Set(['completed', 'failed', 'cancelled']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validationFailure(error) {
  const message = error?.message || String(error);
  let code = 'plan_invalid';
  if (/duplicate plan task id/i.test(message)) code = 'plan_duplicate_task_id';
  else if (/dependencies contain a cycle|depends on itself/i.test(message)) code = 'plan_cycle';
  else if (/unknown task|unknown parent|references an unknown/i.test(message)) code = 'plan_reference';
  return new AosError(code, message, { statusCode: 409, details: { reason: message } });
}

function validatePatchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('plan patch must be an object');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw invalid('plan patch id must be a valid identifier', { field: 'id' });
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1) throw invalid('plan patch baseVersion must be a positive integer', { field: 'baseVersion' });
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw invalid('plan patch reason must be a non-empty string of at most 500 characters', { field: 'reason' });
  const additions = input.additions;
  if (!additions || typeof additions !== 'object' || Array.isArray(additions)) throw invalid('plan patch additions must be an object', { field: 'additions' });
  if (!Array.isArray(additions.tasks) || !additions.tasks.length) throw invalid('plan patch additions.tasks must contain at least one task', { field: 'additions.tasks' });
  if (!Array.isArray(additions.dependencies)) throw invalid('plan patch additions.dependencies must be an array', { field: 'additions.dependencies' });
  if (additions.tasks.length > 500) throw invalid('plan patch cannot add more than 500 tasks', { field: 'additions.tasks' });
  if (additions.dependencies.length > 1000) throw invalid('plan patch cannot add more than 1000 dependencies', { field: 'additions.dependencies' });
  const dependencies = additions.dependencies.map((dependency) => {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) return dependency;
    if (dependency.dependsOnTaskId === undefined && dependency.dependsOn !== undefined) {
      const { dependsOn, ...rest } = dependency;
      return { ...rest, dependsOnTaskId: dependsOn };
    }
    return dependency;
  });
  return {
    id: input.id,
    baseVersion: input.baseVersion,
    reason: input.reason.trim(),
    additions: { tasks: clone(additions.tasks), dependencies: clone(dependencies) },
  };
}

function compactVersion(record, patch = null) {
  return {
    id: record.id,
    version: record.version,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    source: record.source,
    patchId: patch?.id || record.patchId || null,
    taskCount: record.tasks.length,
    dependencyCount: record.dependencies.length,
  };
}

export class PlanService {
  constructor({ engine, clock = () => Date.now() } = {}) {
    if (!engine) throw new Error('PlanService requires an engine');
    this.engine = engine;
    this.clock = clock;
  }

  get versions() {
    if (!Array.isArray(this.engine.state.planVersions)) this.engine.state.planVersions = [];
    return this.engine.state.planVersions;
  }

  get patches() {
    if (!Array.isArray(this.engine.state.planPatches)) this.engine.state.planPatches = [];
    return this.engine.state.planPatches;
  }

  createInitial({ run, goal, plan, blueprint = null, actor = 'engine' } = {}) {
    if (!run?.id || !goal?.id || !plan) throw new Error('initial plan needs a run, goal and plan');
    const record = deepFreeze({
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: newId('plan').replace(/^id_/, 'plan_'),
      version: 1,
      runId: run.id,
      projectId: run.projectId,
      goalId: goal.id,
      status: 'complete',
      immutable: true,
      createdAt: run.createdAt,
      createdBy: actor,
      source: 'startRun',
      patchId: null,
      title: plan.title || null,
      ambiguities: clone(plan.ambiguities || []),
      branches: clone(plan.branches || []),
      tasks: clone(plan.tasks || []),
      dependencies: clone(plan.dependencies || []),
      blueprint: blueprint ? { id: blueprint.id, version: blueprint.version } : null,
      execution: clone(run.execution || null),
      ceilings: clone(run.ceilings || null),
      policies: clone(run.policies || null),
    });
    this.versions.push(record);
    return record;
  }

  get(runId, version = null) {
    const run = this.engine.getRun(runId);
    const versions = this.versions.filter((item) => item.runId === run.id).sort((a, b) => a.version - b.version);
    if (!versions.length) throw new AosError('plan_unavailable', `Run ${run.id} has no immutable plan snapshot`, { statusCode: 409, details: { runId: run.id } });
    const selectedVersion = version == null ? run.plan?.version ?? versions.at(-1).version : version;
    if (!Number.isInteger(selectedVersion) || selectedVersion < 1) throw invalid('plan version must be a positive integer', { field: 'version' });
    const selected = versions.find((item) => item.version === selectedVersion);
    if (!selected) throw notFound('plan version', `${run.id}@${selectedVersion}`);
    const receipts = this.patches.filter((item) => item.runId === run.id).sort((a, b) => a.version - b.version);
    const current = run.plan ? clone(run.plan) : { id: selected.id, version: versions.at(-1).version };
    const history = versions.map((item) => compactVersion(item, receipts.find((receipt) => receipt.version === item.version)));
    return {
      run: { id: run.id, status: run.status, plan: current },
      current,
      snapshot: clone(selected),
      version: clone(selected),
      history,
      versions: history,
      patches: clone(receipts),
    };
  }

  patch(runId, input, { actor = 'operator', source = 'patch', allowAwaitingApproval = false } = {}) {
    const request = validatePatchInput(input);
    const bodyFingerprint = fingerprint(stableStringify(request));
    return this.engine.transact(() => {
      const run = this.engine.getRun(runId);
      const existing = this.patches.find((item) => item.id === request.id);
      if (existing) {
        if (existing.fingerprint === bodyFingerprint && existing.runId === run.id) return clone(existing);
        throw new AosError('plan_patch_id_mismatch', `Plan patch ${request.id} already exists with a different body`, { statusCode: 409, details: { id: request.id, existingFingerprint: existing.fingerprint, fingerprint: bodyFingerprint } });
      }
      if (TERMINAL_RUNS.has(run.status)) throw new AosError('run_terminal', `run ${run.id} is ${run.status}; plan patches apply to running or paused runs only`, { statusCode: 409, details: { runId: run.id, status: run.status } });
      const allowPendingDelegation = allowAwaitingApproval === true && actor === 'operator' && source === 'delegation';
      if (run.status === 'awaiting_approval' && !allowPendingDelegation) {
        throw new AosError('run_awaiting_approval', `run ${run.id} is awaiting approval; plan patches are paused at an approval gate`, { statusCode: 409, details: { runId: run.id, status: run.status } });
      }
      if (!ACTIVE_RUNS.has(run.status) && !allowPendingDelegation) throw new AosError('run_not_patchable', `run ${run.id} is ${run.status}; plan patches apply to running or paused runs only`, { statusCode: 409, details: { runId: run.id, status: run.status } });

      const currentPointer = run.plan;
      if (!currentPointer || !Number.isInteger(currentPointer.version)) throw new AosError('plan_unavailable', `Run ${run.id} has no current immutable plan snapshot`, { statusCode: 409, details: { runId: run.id } });
      if (request.baseVersion !== currentPointer.version) {
        throw new AosError('plan_version_conflict', `Plan patch ${request.id} is based on v${request.baseVersion}; run ${run.id} is at v${currentPointer.version}`, { statusCode: 409, details: { runId: run.id, expected: currentPointer.version, received: request.baseVersion } });
      }
      const base = this.versions.find((item) => item.runId === run.id && item.id === currentPointer.id && item.version === currentPointer.version);
      if (!base) throw new AosError('plan_unavailable', `Run ${run.id} points to missing plan v${currentPointer.version}`, { statusCode: 409, details: { runId: run.id, plan: currentPointer } });

      const priorTaskIds = new Set(base.tasks.map((task) => task.id));
      const additionIds = new Set();
      for (const task of request.additions.tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) throw invalid('every added plan task must be an object', { field: 'additions.tasks' });
        if (typeof task.id !== 'string' || !task.id) throw invalid('every added plan task needs a string id', { field: 'additions.tasks.id' });
        if (priorTaskIds.has(task.id) || additionIds.has(task.id)) {
          throw new AosError('plan_duplicate_task_id', `Plan task id ${task.id} already exists`, { statusCode: 409, details: { taskId: task.id } });
        }
        additionIds.add(task.id);
      }
      for (const dependency of request.additions.dependencies) {
        if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) throw invalid('every added dependency must be an object', { field: 'additions.dependencies' });
        if (!additionIds.has(dependency.taskId)) {
          throw new AosError('plan_dependency_target', `New dependency taskId ${dependency.taskId || '(missing)'} must name a task added by this patch`, { statusCode: 409, details: { dependency } });
        }
      }

      let validated;
      try {
        validated = validatePlan({
          title: base.title,
          ambiguities: base.ambiguities,
          branches: base.branches,
          tasks: [...base.tasks, ...request.additions.tasks],
          dependencies: [...base.dependencies, ...request.additions.dependencies],
        });
      } catch (error) {
        throw validationFailure(error);
      }
      const baseTaskCount = base.tasks.length;
      const baseDependencyCount = base.dependencies.length;
      let additions = validated.tasks.slice(baseTaskCount);
      const additionsDependencies = validated.dependencies.slice(baseDependencyCount);
      const blueprint = run.blueprint ? this.engine.blueprints.get(run.blueprint.id, run.blueprint.version) : null;
      if (blueprint) additions = this.engine.blueprints.applyToPlan(blueprint, additions).map(clone);
      const mergedTasks = [...clone(base.tasks), ...additions];
      const mergedDependencies = [...clone(base.dependencies), ...clone(additionsDependencies)];
      try {
        validatePlan({ title: base.title, tasks: mergedTasks, dependencies: mergedDependencies });
      } catch (error) {
        throw validationFailure(error);
      }
      const goal = this.engine.getGoal(run.goalId);
      try {
        this.engine.validatePlanTasks(goal, additions);
      } catch (error) {
        if (error instanceof AosError && error.code !== 'invalid_input') throw error;
        if (this.engine.execution.mode === 'codex' && /Live Codex mode refuses/i.test(error?.message || '')) {
          throw new AosError('plan_live_codex_invalid', error.message, { statusCode: 409, details: { reason: error.message } });
        }
        if (this.engine.execution.mode === 'mixed' && /Mixed execution/i.test(error?.message || '')) {
          throw new AosError('plan_execution_invalid', error.message, { statusCode: 409, details: { reason: error.message } });
        }
        throw new AosError('plan_template_invalid', error.message, { statusCode: 409, details: error.details || null });
      }
      this.#validateAssignments(run, additions);
      this.#validateCeilings(run, mergedTasks, additions);

      const version = currentPointer.version + 1;
      const record = deepFreeze({
        schemaVersion: PLAN_SCHEMA_VERSION,
        id: currentPointer.id,
        version,
        runId: run.id,
        projectId: run.projectId,
        goalId: run.goalId,
        status: 'complete',
        immutable: true,
        createdAt: this.engine.now(),
        createdBy: actor,
        source,
        patchId: request.id,
        title: base.title,
        ambiguities: clone(base.ambiguities || []),
        branches: clone(base.branches || []),
        tasks: clone(mergedTasks),
        dependencies: clone(mergedDependencies),
        blueprint: clone(base.blueprint),
        execution: clone(base.execution),
        ceilings: clone(run.ceilings ?? base.ceilings),
        policies: clone(run.policies ?? base.policies),
      });
      const receipt = {
        id: request.id,
        runId: run.id,
        planId: record.id,
        version,
        baseVersion: request.baseVersion,
        reason: request.reason,
        actor,
        fingerprint: bodyFingerprint,
        additions: { tasks: clone(additions), dependencies: clone(additionsDependencies) },
        at: record.createdAt,
      };
      // Materialise only the new records after every validation has passed. The outer
      // engine transaction restores this append and its event if any invariant fails.
      this.engine.materializePlanTasks(run, additions, additionsDependencies, version);
      this.versions.push(record);
      this.patches.push(receipt);
      run.plan = { id: record.id, version };
      run.updatedAt = record.createdAt;
      this.engine.recordEvent('plan.patched', {
        projectId: run.projectId,
        runId: run.id,
        actor,
        payload: { planId: record.id, version, patchId: request.id, taskCount: additions.length, dependencyCount: additionsDependencies.length, reason: request.reason },
      });
      return { run, plan: clone(record), patch: clone(receipt) };
    });
  }

  #validateAssignments(run, additions) {
    const context = { projectId: run.projectId };
    const allowedHarnesses = this.engine.settings.effective('execution.allowedHarnesses', context).value || [];
    const allowedModels = this.engine.settings.effective('execution.allowedModels', context).value || {};
    for (const planned of additions) {
      let effective = { ...planned };
      if (planned.templateId) {
        const template = this.engine.templates.get(planned.templateId, planned.templateVersion ?? null);
        effective = applyTemplateToTask({ ...planned }, planned, template);
      }
      const harness = effective.worker || 'local';
      const isAdoptEngine = harness === 'engine' && planned.kind === 'adopt';
      if (!isAdoptEngine && !allowedHarnesses.includes(harness)) {
        throw new AosError('plan_policy', `Harness ${harness} is not allowed for plan task ${planned.id}`, { statusCode: 409, details: { taskId: planned.id, harness, allowedHarnesses } });
      }
      const model = effective.model ?? null;
      const allowed = Array.isArray(allowedModels[harness]) ? allowedModels[harness] : null;
      if (model != null && allowed && !allowed.includes(model)) {
        throw new AosError('plan_policy', `Model ${model} is not allowed for harness ${harness}`, { statusCode: 409, details: { taskId: planned.id, harness, model, allowedModels: allowed } });
      }
      if (this.engine.execution.mode === 'mixed' && !isAdoptEngine && ['codex', 'claude', 'ollama'].includes(harness)) {
        const configured = this.engine.execution[harness];
        if (!configured) {
          throw new AosError('plan_provider_unconfigured', `Plan task ${planned.id} selects ${harness}, but that provider is not configured for this engine`, { statusCode: 409, details: { taskId: planned.id, harness } });
        }
        const requestedModel = model ?? configured.model;
        const requestedEffort = effective.effort ?? configured.effort;
        if (requestedModel !== configured.model || (harness !== 'ollama' && requestedEffort !== configured.effort)) {
          throw new AosError('plan_provider_config_invalid', `Plan task ${planned.id} must use the configured ${harness} runtime ${configured.model}${harness === 'ollama' ? '' : `/${configured.effort}`}`, { statusCode: 409, details: { taskId: planned.id, harness, requested: { model: requestedModel, ...(harness === 'ollama' ? {} : { effort: requestedEffort }) }, expected: { model: configured.model, ...(harness === 'ollama' ? {} : { effort: configured.effort }) } } });
        }
        if (harness === 'ollama') {
          const presetRole = effective.presetId
            ? this.engine.presets.effective(effective.presetId, effective.presetVersion ?? null).role
            : null;
          assertOllamaTaskAdmission(planned, effective, { presetRole });
        }
      }
      if (this.engine.live) {
        if (this.engine.execution.mode === 'codex') {
          const live = this.engine.execution.codex;
          if (!isAdoptEngine && harness !== 'codex') {
            throw new AosError('plan_live_codex_invalid', `Live Codex runs refuse plan task ${planned.id} on harness ${harness}; there is no fallback`, { statusCode: 409, details: { taskId: planned.id, harness, expected: 'codex' } });
          }
          if (harness === 'codex') {
            const requestedModel = model ?? live.model;
            const requestedEffort = effective.effort ?? live.effort;
            if (requestedModel !== live.model || requestedEffort !== live.effort) {
              throw new AosError('plan_live_codex_invalid', `Live Codex plan task ${planned.id} must use ${live.model}/${live.effort}`, { statusCode: 409, details: { taskId: planned.id, requested: { model: requestedModel, effort: requestedEffort }, expected: { model: live.model, effort: live.effort } } });
            }
            const provider = this.engine.listProviders().find((item) => item.id === 'codex');
            if (provider?.readiness?.status === 'unavailable') {
              throw new AosError('plan_live_codex_unavailable', 'Live Codex is configured but its last preflight was unavailable', { statusCode: 409, details: { taskId: planned.id, readiness: provider.readiness } });
            }
          }
        } else if (!isAdoptEngine) {
          const provider = this.engine.listProviders().find((item) => item.id === harness);
          if (!provider?.configured) {
            throw new AosError('plan_provider_unconfigured', `Plan task ${planned.id} selects ${harness}, but that provider is not configured for this engine`, { statusCode: 409, details: { taskId: planned.id, harness } });
          }
          if (!provider.contract?.adapter?.implementation?.mounted) {
            throw new AosError('plan_provider_unmounted', `Plan task ${planned.id} selects ${harness}, but no worker adapter is mounted`, { statusCode: 409, details: { taskId: planned.id, harness } });
          }
        }
      }
    }
  }

  #validateCeilings(run, mergedTasks, additions) {
    const ceilings = run.ceilings;
    if (!ceilings || ceilings.unlimited) return;
    if (ceilings.tasks != null && mergedTasks.length > ceilings.tasks) {
      throw new AosError('plan_ceiling', `Plan has ${mergedTasks.length} tasks; run allows ${ceilings.tasks}`, { statusCode: 409, details: { runId: run.id, tasks: mergedTasks.length, ceiling: ceilings.tasks } });
    }
    const depth = run.policies?.depth;
    const maxDepth = depth && !depth.unlimited ? depth.max : null;
    if (maxDepth != null) {
      const byId = new Map(mergedTasks.map((task) => [task.id, task]));
      const levels = new Map();
      const levelOf = (task, trail = new Set()) => {
        if (!task.parentId) return 0;
        if (levels.has(task.id)) return levels.get(task.id);
        if (trail.has(task.id)) return maxDepth + 1;
        const parent = byId.get(task.parentId);
        const level = parent ? levelOf(parent, new Set([...trail, task.id])) + 1 : maxDepth + 1;
        levels.set(task.id, level);
        return level;
      };
      for (const task of additions) {
        const level = levelOf(task);
        if (level > maxDepth) throw new AosError('plan_ceiling', `Plan task ${task.id} exceeds the run depth ceiling ${maxDepth}`, { statusCode: 409, details: { runId: run.id, taskId: task.id, depth: level, ceiling: maxDepth } });
      }
    }
    for (const task of additions) {
      let effective = { ...task };
      if (task.templateId) effective = applyTemplateToTask({ ...task }, task, this.engine.templates.get(task.templateId, task.templateVersion ?? null));
      const delegation = effective.delegation || {};
      const boundedDelegation = Number.isInteger(delegation.maxChildren) && delegation.maxChildren >= 0
        && Number.isInteger(delegation.maxDepth) && delegation.maxDepth >= 0;
      if (effective.mayDelegate && (!boundedDelegation || delegation.maxChildren === null || delegation.maxDepth === null || delegation.unlimited)) {
        throw new AosError('plan_unbounded', `Plan task ${task.id} has unbounded delegation under finite run ceilings`, { statusCode: 409, details: { runId: run.id, taskId: task.id } });
      }
    }

    // A finite run budget is only enforceable when every plan task has a finite
    // effective bound for that dimension. Sum the immutable plan's effective
    // per-task budgets, including existing tasks, before materialising additions.
    for (const dimension of ['tokens', 'usd', 'timeMs']) {
      const ceiling = ceilings[dimension];
      if (ceiling == null || !Number.isFinite(ceiling)) continue;
      let total = 0;
      for (const task of mergedTasks) {
        let effective = { ...task };
        if (task.templateId) effective = applyTemplateToTask({ ...task }, task, this.engine.templates.get(task.templateId, task.templateVersion ?? null));
        const bound = effective.budget?.[dimension];
        if (typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0) {
          throw new AosError('plan_unbounded', `Plan task ${task.id} has no finite ${dimension} budget under the run ceiling`, { statusCode: 409, details: { runId: run.id, taskId: task.id, dimension, ceiling, budget: bound ?? null } });
        }
        total += bound;
        if (!Number.isFinite(total)) {
          throw new AosError('plan_unbounded', `Plan ${dimension} budget cannot be proven finite under the run ceiling`, { statusCode: 409, details: { runId: run.id, taskId: task.id, dimension, ceiling } });
        }
      }
      if (total > ceiling) {
        throw new AosError('plan_ceiling', `Plan ${dimension} budget ${total} exceeds the run ceiling ${ceiling}`, { statusCode: 409, details: { runId: run.id, dimension, total, ceiling } });
      }
    }
  }
}

export { stableStringify };
