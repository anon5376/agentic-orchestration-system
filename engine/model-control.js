// Model and harness control is deliberately a thin boundary around the existing
// engine registries. It does not start workers, inspect credentials, or widen any
// adapter's implementation or model allowlist. A model assignment is a template
// fork for a built-in or a new version for a user template.
import { CODEX_EFFORT_ALLOWLIST, CODEX_MODEL_ALLOWLIST } from './codex.js';
import { isProviderMounted } from './provider-contracts.js';
import { KNOWN_HARNESSES } from './templates.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';
import { redactSecrets } from './providers.js';

export const MODEL_CONTROL_SCHEMA_VERSION = 1;

const ADAPTER_DESCRIPTIONS = Object.freeze({
  local: { name: 'Deterministic local worker', kind: 'local', authType: 'none' },
  codex: { name: 'Codex', kind: 'cli_session', authType: 'cli_session' },
  claude: { name: 'Claude Code', kind: 'cli_session', authType: 'cli_session' },
  api: { name: 'Generic HTTP worker', kind: 'api_key', authType: 'unsupported_oauth' },
  ollama: { name: 'Ollama', kind: 'local_http', authType: 'none' },
  command: { name: 'External harness (protocol)', kind: 'external_cli', authType: 'external_cli_session' },
  grok: { name: 'Grok', kind: 'api_key', authType: 'api_key' },
});

const ASSIGNMENT_INPUT_SCHEMA = t.object({
  templateId: identifier(),
  templateVersion: t.optional(t.integer({ min: 1 })),
  // `version` is accepted as a small HTTP/CLI convenience alias.
  version: t.optional(t.integer({ min: 1 })),
  harness: t.enumOf(KNOWN_HARNESSES),
  model: t.optional(t.nullable(t.string({ maxLength: 120, nonEmpty: true }))),
  effort: t.optional(t.nullable(t.string({ maxLength: 40, nonEmpty: true }))),
  projectId: t.optional(identifier()),
  newId: t.optional(identifier()),
  newName: t.optional(t.string({ minLength: 1, maxLength: 120 })),
  // `name` is an alias used by a top-level fork request.
  name: t.optional(t.string({ minLength: 1, maxLength: 120 })),
  note: t.optional(t.nullable(t.string({ maxLength: 500 }))),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
  fork: t.optional(t.object({
    id: t.optional(identifier()),
    name: t.optional(t.string({ minLength: 1, maxLength: 120 })),
    note: t.optional(t.nullable(t.string({ maxLength: 500 }))),
  })),
});

const HARNESS_LABELS = Object.freeze({
  local: 'local',
  codex: 'Codex',
  claude: 'Claude Code',
  api: 'Generic HTTP worker',
  ollama: 'Ollama',
  command: 'External harness (protocol)',
  grok: 'Grok',
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function publicClone(value) {
  // Template variables are intentionally arbitrary. Reuse the provider redactor
  // so a malformed/user-authored template cannot make a secret-looking value part
  // of the Models page response.
  return redactSecrets(clone(value));
}

function validationError(errors, message = 'model assignment failed validation') {
  return invalid(`${message}: ${errors[0]?.path || '$'} ${errors[0]?.message || 'invalid value'}`, { errors });
}

function statusForReadiness(provider) {
  if (provider?.readiness && typeof provider.readiness.status === 'string') return provider.readiness.status;
  if (provider?.liveExecutionEnabled) return 'available';
  if (provider?.configured) return 'configured';
  return 'not_live';
}

function syntheticProvider(id) {
  const details = ADAPTER_DESCRIPTIONS[id] || { name: HARNESS_LABELS[id] || id, kind: 'unknown', authType: 'none' };
  return {
    id,
    name: details.name,
    kind: details.kind,
    authType: details.authType,
    secretEnv: null,
    session: null,
    liveAuthSupported: false,
    liveExecutionEnabled: false,
    configured: false,
    secretPresent: false,
    readiness: { status: 'not_live', checkedAt: null },
    note: `No provider view or mounted adapter exists for ${id}; assignment is configuration-only and will fail closed at dispatch.`,
  };
}

function adapterImplementation(provider) {
  const known = isProviderMounted(provider.id);
  // Unknown provider views are not promoted to implemented solely because a
  // producer set a flag. Only the three adapters mounted by this engine count.
  const implemented = known;
  const status = implemented ? 'implemented' : 'pending';
  return {
    status,
    implemented,
    source: implemented ? 'engine_worker_registry' : 'typed_boundary',
    note: implemented
      ? 'An engine worker implementation is mounted; readiness and policy still gate dispatch.'
      : 'No runnable engine adapter is mounted. Configuration does not imply implementation.',
  };
}

function adapterView(provider) {
  const readinessStatus = statusForReadiness(provider);
  const implementation = adapterImplementation(provider);
  const liveReady = Boolean(provider.liveExecutionEnabled) && readinessStatus === 'available';
  const contractDispatch = provider.contract?.dispatch || null;
  // This is intentionally stricter than `configured`: a configured-only
  // provider must never be presented as runnable.
  const runnable = implementation.implemented
    && Boolean(provider.configured)
    && liveReady
    && (contractDispatch ? contractDispatch.runnable === true : true);
  let status;
  if (!implementation.implemented) status = 'pending_adapter';
  else if (runnable) status = 'available';
  else if (contractDispatch && contractDispatch.status !== 'available') status = contractDispatch.status;
  else if (provider.configured && !liveReady) status = 'configured_not_ready';
  else status = 'not_configured';

  const authType = provider.authType || 'none';
  const readiness = clone(provider.readiness || { status: readinessStatus, checkedAt: null });
  const auth = {
    type: authType,
    // These are public provider-view fields: a session label or env var name,
    // never the credential value.
    session: provider.session || null,
    secretEnv: provider.secretEnv || null,
  };
  return {
    ...publicClone(provider),
    implementation,
    readiness,
    live: { enabled: Boolean(provider.liveExecutionEnabled), ready: liveReady },
    configured: Boolean(provider.configured),
    authType,
    auth,
    runnable,
    status,
    pending: !implementation.implemented,
    configuredOnly: Boolean(provider.configured) && !runnable,
  };
}

function buildProviderViews(providerViews = []) {
  const byId = new Map();
  for (const item of Array.isArray(providerViews) ? providerViews : []) {
    if (!item || typeof item.id !== 'string' || byId.has(item.id)) continue;
    byId.set(item.id, item);
  }
  // Keep provider truth from the engine and add absent known harnesses as
  // explicitly pending, so an allowed Ollama (for example) cannot disappear.
  for (const id of KNOWN_HARNESSES) if (!byId.has(id)) byId.set(id, syntheticProvider(id));
  return [...byId.values()].map(adapterView);
}

function effectiveSetting(engine, key, context) {
  if (!engine.settings?.effective) throw new Error('ModelControlService requires engine.settings.effective');
  return publicClone(engine.settings.effective(key, context));
}

function projectFor(engine, projectId = null) {
  const projects = Array.isArray(engine.state?.projects) ? engine.state.projects : [];
  const chosenId = projectId ?? engine.defaultProject?.()?.id ?? projects[0]?.id ?? null;
  if (chosenId && !projects.some((project) => project.id === chosenId)) throw notFound('project', chosenId);
  return projects.find((project) => project.id === chosenId) || null;
}

function policyFor(engine, projectId = null, presetId = null) {
  const context = { projectId: projectId ?? null };
  const allowedHarnesses = effectiveSetting(engine, 'execution.allowedHarnesses', context);
  const allowedModels = effectiveSetting(engine, 'execution.allowedModels', context);
  const defaultEffort = effectiveSetting(engine, 'execution.defaultEffort', { ...context, ...(presetId ? { presetId } : {}) });
  return {
    allowedHarnesses: Array.isArray(allowedHarnesses.value) ? allowedHarnesses.value : [],
    allowedModels: allowedModels.value && typeof allowedModels.value === 'object' ? allowedModels.value : {},
    defaultEffort: defaultEffort.value ?? null,
    effective: { allowedHarnesses, allowedModels, defaultEffort },
  };
}

function providerById(providers, id) {
  return providers.find((provider) => provider.id === id) || adapterView(syntheticProvider(id));
}

function modelRule(allowedModels, harness, model) {
  const list = Array.isArray(allowedModels?.[harness]) ? allowedModels[harness] : null;
  if (model == null) {
    return { specified: false, allowed: true, status: 'unspecified', allowedValues: list ? [...list] : null };
  }
  return {
    specified: true,
    allowed: Boolean(list?.includes(model)),
    status: list?.includes(model) ? 'allowed' : list ? 'not_allowed' : 'no_allowlist',
    allowedValues: list ? [...list] : null,
  };
}

function hardAdapterRule(harness, model, effort) {
  const modelAllowed = harness !== 'codex' || model == null || CODEX_MODEL_ALLOWLIST.includes(model);
  const effortAllowed = harness !== 'codex' || effort == null || CODEX_EFFORT_ALLOWLIST.includes(effort);
  return {
    model: { allowed: modelAllowed, allowedValues: harness === 'codex' ? [...CODEX_MODEL_ALLOWLIST] : null, specified: model != null },
    effort: { allowed: effortAllowed, allowedValues: harness === 'codex' ? [...CODEX_EFFORT_ALLOWLIST] : null, specified: effort != null },
    allowed: modelAllowed && effortAllowed,
  };
}

function selectionView({ template, harness, model, effort, policy, providers }) {
  const modelPolicy = modelRule(policy.allowedModels, harness, model);
  const hard = hardAdapterRule(harness, model, effort);
  const harnessAllowed = policy.allowedHarnesses.includes(harness);
  const policyAllowed = harnessAllowed && modelPolicy.allowed;
  const adapter = providerById(providers, harness);
  const pendingAdapter = !adapter.implementation.implemented;
  let status;
  if (!policyAllowed || !hard.allowed) status = 'disallowed';
  else if (pendingAdapter) status = 'pending_adapter';
  else if (adapter.status === 'configured_not_ready') status = 'configured_not_ready';
  else if (!adapter.runnable) status = 'not_ready';
  else status = 'available';
  return {
    templateId: template.id,
    templateVersion: template.version,
    templateName: template.name,
    harness,
    model: model ?? null,
    effort: effort ?? null,
    requested: { harness, model: model ?? null, effort: effort ?? null },
    status,
    adapterStatus: adapter.status,
    adapter: clone(adapter),
    runnable: Boolean(policyAllowed && hard.allowed && adapter.runnable),
    pendingAdapter,
    policyAllowed,
    policy: {
      allowed: policyAllowed,
      harness: { requested: harness, allowed: harnessAllowed, allowedValues: [...policy.allowedHarnesses] },
      model: { requested: model ?? null, ...modelPolicy },
      defaultEffort: policy.defaultEffort,
      hardAdapter: hard,
    },
  };
}

function templateView(template, policy, providers, defaultEffort) {
  const config = template.config || {};
  const harnessConfig = config.harness || {};
  const assignment = selectionView({
    template,
    harness: harnessConfig.id || 'local',
    model: harnessConfig.model ?? null,
    effort: harnessConfig.effort ?? defaultEffort ?? null,
    policy,
    providers,
  });
  return {
    id: template.id,
    version: template.version,
    name: template.name,
    description: template.description ?? null,
    schemaVersion: template.schemaVersion ?? null,
    builtin: Boolean(template.builtin),
    source: template.source || null,
    note: template.note ?? null,
    createdAt: template.createdAt ?? null,
    createdBy: template.createdBy ?? null,
    parentVersion: template.parentVersion ?? null,
    forkedFrom: publicClone(template.forkedFrom || null),
    archived: Boolean(template.archived),
    archivedAt: template.archivedAt ?? null,
    provenance: publicClone(template.provenance || null),
    config: publicClone(config),
    harness: {
      id: harnessConfig.id || null,
      model: harnessConfig.model ?? null,
      effort: harnessConfig.effort ?? null,
      fallback: publicClone(harnessConfig.fallback || []),
    },
    assignment,
  };
}

function normalizeAssignmentInput(input) {
  const errors = check(ASSIGNMENT_INPUT_SCHEMA, input);
  if (errors.length) throw validationError(errors);
  if (input.templateVersion != null && input.version != null && input.templateVersion !== input.version) {
    throw new AosError('invalid_assignment', 'templateVersion and version must match when both are supplied', { statusCode: 400, details: { templateVersion: input.templateVersion, version: input.version } });
  }
  const templateVersion = input.templateVersion ?? input.version ?? null;
  let fork = null;
  const hasTopForkFields = ['newId', 'newName', 'name'].some((key) => hasOwn(input, key));
  if (input.fork !== undefined && hasTopForkFields) {
    throw new AosError('invalid_fork', 'fork cannot be combined with newId, newName, or name', { statusCode: 400, details: { fields: ['fork', 'newId', 'newName', 'name'] } });
  }
  if (input.fork !== undefined) {
    fork = { id: input.fork.id, name: input.fork.name, note: input.fork.note ?? input.note ?? null };
  } else if (hasTopForkFields) {
    fork = { id: input.newId, name: input.newName ?? input.name, note: input.note ?? null };
  }
  return {
    ...input,
    templateVersion,
    projectId: input.projectId ?? null,
    actor: input.actor || 'operator',
    fork,
  };
}

function assignmentMeta(selection, operation, origin) {
  return {
    operation,
    from: origin ? { id: origin.id, version: origin.version } : null,
    harness: selection.harness,
    model: selection.model,
    effort: selection.effort,
    status: selection.status,
    pendingAdapter: selection.pendingAdapter,
    policyAllowed: selection.policyAllowed,
  };
}

export class ModelControlService {
  constructor(options = {}) {
    const config = options && options.engine ? options : { engine: options };
    if (!config.engine) throw new Error('ModelControlService requires an engine');
    this.engine = config.engine;
    this.clock = config.clock || (() => Date.now());
  }

  snapshot({ projectId = null } = {}) {
    const project = projectFor(this.engine, projectId);
    const resolvedProjectId = project?.id ?? projectId ?? null;
    const basePolicy = policyFor(this.engine, resolvedProjectId);
    const providers = buildProviderViews(this.engine.listProviders?.() || []);
    const execution = publicClone(this.engine.executionSummary?.() || { mode: 'unknown' });
    const records = this.engine.templates?.list?.({ includeArchived: false }) || [];
    const templates = records.map((summary) => {
      if (summary.headVersion == null) return null;
      const template = this.engine.templates.get(summary.id, summary.headVersion);
      const templatePolicy = policyFor(this.engine, resolvedProjectId, template.config?.preset?.id || null);
      return templateView(template, templatePolicy, providers, templatePolicy.defaultEffort);
    }).filter(Boolean);
    const assignments = templates.map((template) => template.assignment);
    const policy = {
      allowedHarnesses: clone(basePolicy.allowedHarnesses),
      allowedModels: clone(basePolicy.allowedModels),
      defaultEffort: basePolicy.defaultEffort,
      effective: publicClone(basePolicy.effective),
    };
    return publicClone({
      schemaVersion: MODEL_CONTROL_SCHEMA_VERSION,
      generatedAt: this.engine.now?.() || new Date(this.clock()).toISOString(),
      projectId: resolvedProjectId,
      project: project ? publicClone(project) : null,
      execution,
      runtime: execution,
      mode: execution.mode || 'unknown',
      policy,
      // Top-level aliases keep the object easy to consume from a small HTTP
      // adapter while `policy.effective` retains setting provenance.
      allowedHarnesses: policy.allowedHarnesses,
      allowedModels: policy.allowedModels,
      defaultEffort: policy.defaultEffort,
      constraints: {
        codex: {
          models: [...CODEX_MODEL_ALLOWLIST],
          efforts: [...CODEX_EFFORT_ALLOWLIST],
        },
      },
      providers,
      adapters: providers,
      templates,
      assignments,
      workerAssignments: assignments,
    });
  }

  getSnapshot(options = {}) {
    return this.snapshot(options);
  }

  assign(input = {}) {
    const request = normalizeAssignmentInput(input);
    const project = projectFor(this.engine, request.projectId);
    const projectId = project?.id ?? request.projectId ?? null;
    let origin = this.engine.templates.get(request.templateId, request.templateVersion);
    const requestedVersion = request.templateVersion;
    if (!origin.builtin && requestedVersion != null) {
      const head = this.engine.templates.get(request.templateId);
      if (head.version !== origin.version) {
        throw new AosError('stale_template_version', `Template ${request.templateId} is at version ${head.version}; assignment must target the current version`, { statusCode: 409, details: { id: request.templateId, requestedVersion, currentVersion: head.version } });
      }
    }

    if (origin.builtin && !request.fork) {
      throw new AosError('invalid_fork', `Built-in template ${origin.id} must be forked before assignment`, { statusCode: 400, details: { templateId: origin.id, requires: ['newId', 'name'] } });
    }
    if (!origin.builtin && request.fork) {
      throw new AosError('invalid_fork', `Custom template ${origin.id} receives a new version; fork is only required for built-ins`, { statusCode: 400, details: { templateId: origin.id, builtin: false } });
    }
    if (request.fork && (!request.fork.id || !request.fork.name)) {
      throw new AosError('invalid_fork', 'A built-in fork requires a supplied new id and name', { statusCode: 400, details: { templateId: origin.id, requires: ['newId', 'name'] } });
    }

    // Changing a custom template always versions the current head. The optional
    // version above is an optimistic-concurrency check, not a way to edit history.
    if (!origin.builtin) origin = this.engine.templates.get(origin.id);
    const currentHarness = origin.config?.harness || {};
    const nextModel = hasOwn(request, 'model')
      ? request.model
      : request.harness === currentHarness.id ? (currentHarness.model ?? null) : null;
    const rolePolicy = policyFor(this.engine, projectId, origin.config?.preset?.id || null);
    const nextEffort = hasOwn(request, 'effort')
      ? request.effort
      : (currentHarness.effort ?? rolePolicy.defaultEffort ?? null);
    const providers = buildProviderViews(this.engine.listProviders?.() || []);
    const selection = selectionView({ template: origin, harness: request.harness, model: nextModel, effort: nextEffort, policy: rolePolicy, providers });
    if (!selection.policyAllowed) {
      throw new AosError('assignment_not_allowed', `Assignment ${request.harness}/${nextModel ?? 'default model'} is outside execution policy`, { statusCode: 409, details: { templateId: origin.id, ...selection.policy, allowedHarnesses: rolePolicy.allowedHarnesses, allowedModels: rolePolicy.allowedModels } });
    }
    if (!selection.policy.hardAdapter.allowed) {
      const failed = !selection.policy.hardAdapter.model.allowed ? 'model' : 'effort';
      throw new AosError('adapter_constraint', `Codex ${failed} is not allowlisted by the mounted adapter`, { statusCode: 409, details: { templateId: origin.id, harness: request.harness, model: nextModel, effort: nextEffort, hardAdapter: selection.policy.hardAdapter } });
    }

    const nextConfig = clone(origin.config);
    nextConfig.harness = {
      ...nextConfig.harness,
      id: request.harness,
      model: nextModel,
      effort: nextEffort,
    };
    const targetId = request.fork?.id || origin.id;
    const targetName = request.fork?.name || origin.name;
    const candidate = this.engine.templates.validate({
      id: targetId,
      name: targetName,
      description: origin.description,
      config: nextConfig,
      note: request.fork?.note ?? request.note ?? origin.note ?? null,
      createdBy: request.actor,
    });
    if (!candidate.ok) throw validationError(candidate.errors, 'assigned template failed validation');

    let record;
    let operation;
    if (origin.builtin) {
      operation = 'fork';
      // TemplateRegistry.fork nests into this transaction, so ancestry creation
      // and assignment share one outer state commit. Keep the pre-existing
      // records to restore in-memory state if a later callback fails: engine
      // transactions intentionally do not provide object-level rollback.
      record = this.engine.transact(() => {
        const beforeRecords = new Set(this.engine.state.templates || []);
        const beforeEvents = Array.isArray(this.engine.state.events) ? [...this.engine.state.events] : null;
        const eventCheckpoint = this.engine.store.eventCheckpoint();
        try {
          const forked = this.engine.templates.fork({
            fromId: origin.id,
            fromVersion: origin.version,
            id: targetId,
            name: targetName,
            note: request.fork.note ?? request.note ?? null,
            createdBy: request.actor,
          });
          const stored = this.engine.state.templates.find((item) => item.id === forked.id && item.version === forked.version);
          if (!stored) throw notFound('template', `${forked.id}@${forked.version}`);
          stored.config = candidate.config;
          stored.provenance = {
            ...(stored.provenance || {}),
            via: 'model_assignment_fork',
            assignment: assignmentMeta(selection, operation, origin),
          };
          this.engine.recordEvent('template.assigned', { projectId, payload: { templateId: stored.id, version: stored.version, ...assignmentMeta(selection, operation, origin) } });
          return stored;
        } catch (error) {
          this.engine.state.templates = (this.engine.state.templates || []).filter((item) => beforeRecords.has(item));
          if (beforeEvents) this.engine.state.events = beforeEvents;
          this.engine.store.rollbackEventLog(eventCheckpoint);
          throw error;
        }
      });
    } else {
      record = this.engine.templates.edit(origin.id, {
        config: { harness: nextConfig.harness },
        note: request.note ?? origin.note ?? null,
        createdBy: request.actor,
      });
      operation = 'version';
      record = this.engine.transact(() => {
        const stored = this.engine.state.templates.find((item) => item.id === record.id && item.version === record.version);
        if (!stored) throw notFound('template', `${record.id}@${record.version}`);
        stored.provenance = {
          ...(stored.provenance || {}),
          via: 'model_assignment_version',
          assignment: assignmentMeta(selection, operation, origin),
        };
        this.engine.recordEvent('template.assigned', { projectId, payload: { templateId: stored.id, version: stored.version, ...assignmentMeta(selection, operation, origin) } });
        return stored;
      });
    }

    const finalSelection = selectionView({
      template: record,
      harness: record.config.harness.id,
      model: record.config.harness.model,
      effort: record.config.harness.effort,
      policy: rolePolicy,
      providers,
    });
    const result = {
      ok: true,
      operation,
      versioned: { operation, templateId: record.id, version: record.version, parentVersion: record.parentVersion ?? null },
      template: publicClone(record),
      assignment: finalSelection,
      adapter: finalSelection.adapter,
      pendingAdapter: finalSelection.pendingAdapter,
      policy: finalSelection.policy,
    };
    return publicClone(result);
  }

  assignTemplate(input = {}) {
    return this.assign(input);
  }
}

// Small functional entry points make direct HTTP integration possible without
// storing another object on AosEngine.
export function modelControlSnapshot(engine, options = {}) {
  return new ModelControlService({ engine }).snapshot(options);
}

export function buildModelControlSnapshot(engine, options = {}) {
  return modelControlSnapshot(engine, options);
}

export function assignTemplate(engine, input = {}) {
  return new ModelControlService({ engine }).assign(input);
}

export const ModelControl = ModelControlService;
