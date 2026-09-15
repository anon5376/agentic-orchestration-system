// Subagent templates: versioned, user-editable descriptions of an agent's whole
// effective configuration. A template selects a role preset and fixes harness and
// model policy, effort, capabilities, filesystem and network policy, memory policy,
// context inputs, output contract, delegation limits, concurrency, retry and timeout,
// budgets, escalation and termination. The engine applies a template when a plan
// task names it, and can save a live task's effective configuration as a new template.
import { nowIso } from './ids.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';

export const TEMPLATE_SCHEMA_VERSION = 1;
export const TEMPLATE_EXPORT_FORMAT = 'aos-templates/1';
export const KNOWN_HARNESSES = Object.freeze(['local', 'codex', 'claude', 'api', 'ollama', 'command']);
export const SANDBOX_TIERS = Object.freeze(['read_only', 'workspace_write', 'network']);
export const MEMORY_SCOPES = Object.freeze(['agent', 'role', 'run', 'swarm', 'project', 'global']);
// List-size sanity limits only. Delegation fan-out and depth have no product-level cap:
// null (or the literal 'unlimited' at the boundary) means unlimited.
export const TEMPLATE_LIMITS = Object.freeze({ maxCapabilities: 200, maxPaths: 500, maxCriteria: 50 });
export const UNLIMITED = null;

const idList = (max) => t.array(t.string({ minLength: 1, maxLength: 200 }), { maxItems: max, unique: true });

export const TEMPLATE_CONFIG_SCHEMA = t.object({
  preset: t.object({ id: identifier(), version: t.optional(t.nullable(t.integer({ min: 1 }))) }),
  harness: t.object({
    id: t.enumOf(KNOWN_HARNESSES),
    model: t.optional(t.nullable(t.string({ maxLength: 120 }))),
    effort: t.optional(t.nullable(t.string({ maxLength: 40 }))),
    fallback: t.optional(t.array(t.object({ id: t.enumOf(KNOWN_HARNESSES), model: t.optional(t.nullable(t.string({ maxLength: 120 }))) }), { maxItems: 5 })),
  }),
  capabilities: t.optional(t.object({
    skills: t.optional(idList(TEMPLATE_LIMITS.maxCapabilities)),
    mcp: t.optional(idList(TEMPLATE_LIMITS.maxCapabilities)),
    plugins: t.optional(idList(TEMPLATE_LIMITS.maxCapabilities)),
    tools: t.optional(idList(TEMPLATE_LIMITS.maxCapabilities)),
  })),
  filesystem: t.optional(t.object({
    sandbox: t.enumOf(SANDBOX_TIERS),
    readPaths: t.optional(idList(TEMPLATE_LIMITS.maxPaths)),
    writePaths: t.optional(idList(TEMPLATE_LIMITS.maxPaths)),
  })),
  network: t.optional(t.object({ allowed: t.boolean(), allowlist: t.optional(idList(200)) })),
  memory: t.optional(t.object({
    read: t.boolean(),
    write: t.boolean(),
    scopes: t.optional(t.array(t.enumOf(MEMORY_SCOPES), { maxItems: MEMORY_SCOPES.length, unique: true })),
    retentionDays: t.optional(t.nullable(t.integer({ min: 0, max: 3650 }))),
  })),
  context: t.optional(t.object({
    inputs: t.optional(t.array(t.enumOf(['goal', 'definition_of_done', 'brief', 'context_paths', 'dependency_results', 'memory', 'capabilities', 'budget']), { maxItems: 8, unique: true })),
    maxTokens: t.optional(t.nullable(t.integer({ min: 1 }))),
  })),
  output: t.optional(t.object({
    contract: t.optional(t.enumOf(['worker_output_v2'])),
    maxFindings: t.optional(t.integer({ min: 1, max: 500 })),
    maxSummaryWords: t.optional(t.integer({ min: 10, max: 2000 })),
  })),
  delegation: t.optional(t.object({
    mayDelegate: t.boolean(),
    maxChildren: t.optional(t.nullable(t.oneOf([t.integer({ min: 0 }), t.literal('unlimited')]))),
    maxDepth: t.optional(t.nullable(t.oneOf([t.integer({ min: 0 }), t.literal('unlimited')]))),
    unlimited: t.optional(t.boolean()),
    childTemplates: t.optional(idList(50)),
  })),
  concurrency: t.optional(t.nullable(t.integer({ min: 1 }))),
  retry: t.optional(t.object({ maxRetries: t.integer({ min: 0, max: 20 }) })),
  timeoutMs: t.optional(t.nullable(t.integer({ min: 1000 }))),
  budget: t.optional(t.object({
    tokens: t.optional(t.nullable(t.integer({ min: 0 }))),
    usd: t.optional(t.nullable(t.number({ min: 0 }))),
    timeMs: t.optional(t.nullable(t.integer({ min: 0 }))),
  })),
  escalation: t.optional(t.object({ target: t.string({ minLength: 1, maxLength: 120 }) })),
  termination: t.optional(t.object({
    criteria: t.optional(t.array(t.string({ minLength: 1, maxLength: 500 }), { maxItems: TEMPLATE_LIMITS.maxCriteria })),
    stopOnBudget: t.optional(t.boolean()),
  })),
  variables: t.optional(t.record(t.any(), { keyPattern: /^[a-z][a-z0-9_]{0,63}$/, maxKeys: 50 })),
});

export const TEMPLATE_INPUT_SCHEMA = t.object({
  id: identifier(),
  name: t.string({ minLength: 1, maxLength: 120 }),
  description: t.optional(t.nullable(t.string({ maxLength: 1000 }))),
  config: TEMPLATE_CONFIG_SCHEMA,
  note: t.optional(t.nullable(t.string({ maxLength: 500 }))),
  createdBy: t.optional(t.nullable(t.string({ maxLength: 120 }))),
});

export const DEFAULT_CONFIG = Object.freeze({
  capabilities: { skills: [], mcp: [], plugins: [], tools: [] },
  filesystem: { sandbox: 'read_only', readPaths: [], writePaths: [] },
  network: { allowed: false, allowlist: [] },
  memory: { read: false, write: false, scopes: ['agent'], retentionDays: 30 },
  context: { inputs: ['goal', 'definition_of_done', 'brief', 'context_paths', 'dependency_results', 'memory', 'capabilities', 'budget'], maxTokens: null },
  output: { contract: 'worker_output_v2', maxFindings: 5, maxSummaryWords: 120 },
  delegation: { mayDelegate: false, maxChildren: 0, maxDepth: 0, childTemplates: [] },
  concurrency: null,
  retry: { maxRetries: 1 },
  timeoutMs: null,
  budget: { tokens: null, usd: null, timeMs: null },
  escalation: { target: 'lead' },
  termination: { criteria: [], stopOnBudget: true },
  variables: {},
});

function builtin(id, name, description, config) {
  return Object.freeze({
    id,
    version: 1,
    name,
    description,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    config: normalizeConfig(config),
    builtin: true,
    source: 'builtin',
    note: null,
    createdAt: null,
    createdBy: 'aos',
    parentVersion: null,
    forkedFrom: null,
    archived: false,
    archivedAt: null,
    provenance: { via: 'builtin' },
  });
}

export function normalizeConfig(config) {
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merged[key] = { ...value, ...(config[key] || {}) };
    else merged[key] = config[key] !== undefined ? config[key] : value;
  }
  merged.preset = { id: config.preset.id, version: config.preset.version ?? null };
  merged.harness = { id: config.harness.id, model: config.harness.model ?? null, effort: config.harness.effort ?? null, fallback: config.harness.fallback ?? [] };
  // Canonical internal form for unlimited fan-out or depth is null.
  if (merged.delegation.maxChildren === 'unlimited') merged.delegation.maxChildren = UNLIMITED;
  if (merged.delegation.maxDepth === 'unlimited') merged.delegation.maxDepth = UNLIMITED;
  merged.delegation.unlimited = merged.delegation.maxChildren === UNLIMITED || merged.delegation.maxDepth === UNLIMITED;
  return merged;
}

export const BUILTIN_TEMPLATES = Object.freeze([
  builtin('default-lead', 'Default lead', 'Lead investigator that plans, delegates up to twelve children three levels deep, and decides.', {
    preset: { id: 'lead-investigator' }, harness: { id: 'local' },
    delegation: { mayDelegate: true, maxChildren: 12, maxDepth: 3, childTemplates: ['default-branch-manager', 'default-worker', 'default-researcher', 'default-analyst', 'default-critic', 'default-verifier', 'default-synthesizer', 'default-bulk'] },
    retry: { maxRetries: 1 }, budget: { tokens: 400_000 }, escalation: { target: 'operator' },
    termination: { criteria: ['definition of done met by the synthesizer decision', 're-planning budget exhausted'] },
  }),
  builtin('default-branch-manager', 'Default branch manager', 'Owns one line of evidence and delegates to up to six workers one level down.', {
    preset: { id: 'branch-manager' }, harness: { id: 'local' },
    delegation: { mayDelegate: true, maxChildren: 6, maxDepth: 1, childTemplates: ['default-worker', 'default-researcher', 'default-analyst'] },
    budget: { tokens: 150_000 },
  }),
  builtin('default-worker', 'Default worker', 'Bounded single task, read-only sandbox, no delegation.', {
    preset: { id: 'general-worker' }, harness: { id: 'local' }, budget: { tokens: 60_000 },
  }),
  builtin('default-researcher', 'Default researcher', 'Source scout with read-only access and no network unless granted.', {
    preset: { id: 'researcher-source-scout' }, harness: { id: 'local' }, budget: { tokens: 80_000 },
  }),
  builtin('default-analyst', 'Default analyst', 'Deep analysis of one question from raw sources.', {
    preset: { id: 'deep-analyst' }, harness: { id: 'local' }, budget: { tokens: 100_000 },
  }),
  builtin('default-critic', 'Default critic', 'Adversarial critique, never assigned to its own authors.', {
    preset: { id: 'adversarial-critic' }, harness: { id: 'local' }, budget: { tokens: 80_000 }, output: { maxFindings: 8 },
  }),
  builtin('default-verifier', 'Default verifier', 'Reproduces claims; pass, fail, or could not verify.', {
    preset: { id: 'verifier-evaluator' }, harness: { id: 'local' }, budget: { tokens: 80_000 }, output: { maxFindings: 20 },
  }),
  builtin('default-synthesizer', 'Default synthesizer', 'Integrates branches, objections and verdicts into a decision record.', {
    preset: { id: 'synthesizer' }, harness: { id: 'local' }, budget: { tokens: 120_000 },
  }),
  builtin('default-retrospective', 'Default retrospective analyst', 'Post-run analysis with typed proposals; never the run lead.', {
    preset: { id: 'retrospective-analyst' }, harness: { id: 'local' }, budget: { tokens: 80_000 },
  }),
  builtin('default-bulk', 'Default bulk worker', 'Many mechanical units on the cheapest configured harness.', {
    preset: { id: 'low-cost-bulk-worker' }, harness: { id: 'local' }, retry: { maxRetries: 0 }, budget: { tokens: 30_000 }, output: { maxFindings: 50, maxSummaryWords: 60 },
  }),
]);

export class TemplateRegistry {
  constructor({ engine, clock = () => Date.now() } = {}) {
    if (!engine) throw new Error('TemplateRegistry requires an engine');
    this.engine = engine;
    this.clock = clock;
    this.builtin = BUILTIN_TEMPLATES;
  }

  get stored() {
    if (!Array.isArray(this.engine.state.templates)) this.engine.state.templates = [];
    return this.engine.state.templates;
  }

  #versions(id) {
    return [...this.builtin.filter((item) => item.id === id), ...this.stored.filter((item) => item.id === id)].sort((a, b) => a.version - b.version);
  }

  #ids() {
    return [...new Set([...this.builtin.map((item) => item.id), ...this.stored.map((item) => item.id)])].sort();
  }

  get(id, version = null) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('template', id);
    if (version == null) {
      const head = [...versions].reverse().find((item) => !item.archived);
      if (!head) throw new AosError('template_archived', `Every version of template ${id} is archived`, { statusCode: 409, details: { id } });
      return head;
    }
    const exact = versions.find((item) => item.version === version);
    if (!exact) throw notFound('template version', `${id}@${version}`);
    return exact;
  }

  list({ includeArchived = false } = {}) {
    return this.#ids().map((id) => {
      const versions = this.#versions(id);
      const head = [...versions].reverse().find((item) => !item.archived) || null;
      const shown = head || versions.at(-1);
      return {
        id,
        name: shown.name,
        description: shown.description,
        preset: shown.config.preset,
        harness: shown.config.harness.id,
        builtin: versions.some((item) => item.builtin),
        headVersion: head ? head.version : null,
        versions: versions.length,
        archivedVersions: versions.filter((item) => item.archived).length,
        mayDelegate: shown.config.delegation.mayDelegate,
      };
    }).filter((item) => includeArchived || item.headVersion !== null);
  }

  history(id) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('template', id);
    return versions.map((item) => ({ version: item.version, source: item.source, builtin: item.builtin, name: item.name, note: item.note, createdAt: item.createdAt, createdBy: item.createdBy, parentVersion: item.parentVersion, forkedFrom: item.forkedFrom, archived: item.archived, archivedAt: item.archivedAt, provenance: item.provenance }));
  }

  // Structural validation plus referential checks: the preset must exist and compose,
  // child templates must exist, and delegation limits must be coherent.
  validate(input) {
    const errors = [...check(TEMPLATE_INPUT_SCHEMA, input)];
    if (errors.length) return { ok: false, errors };
    const config = normalizeConfig(input.config);
    try {
      this.engine.presets.effective(config.preset.id, config.preset.version);
    } catch (error) {
      errors.push({ path: '$.config.preset', code: error.code || 'preset', message: error.message });
    }
    for (const child of config.delegation.childTemplates) {
      if (child === input.id) continue;
      if (!this.#versions(child).length) errors.push({ path: '$.config.delegation.childTemplates', code: 'unknown_template', message: `child template ${child} does not exist` });
    }
    if (!config.delegation.mayDelegate && (config.delegation.maxChildren === UNLIMITED || config.delegation.maxChildren > 0 || config.delegation.childTemplates.length)) {
      errors.push({ path: '$.config.delegation', code: 'inconsistent', message: 'mayDelegate is false but children are configured' });
    }
    if (config.delegation.mayDelegate && config.delegation.maxChildren === 0) {
      errors.push({ path: '$.config.delegation.maxChildren', code: 'inconsistent', message: 'mayDelegate is true but maxChildren is 0' });
    }
    if (config.filesystem.sandbox === 'read_only' && config.filesystem.writePaths.length) {
      errors.push({ path: '$.config.filesystem.writePaths', code: 'inconsistent', message: 'read_only sandbox cannot have write paths' });
    }
    if (config.network.allowed && config.filesystem.sandbox !== 'network') {
      errors.push({ path: '$.config.network', code: 'inconsistent', message: 'network access needs the network sandbox tier' });
    }
    return { ok: errors.length === 0, errors, config };
  }

  #materialize(input, { version, source, provenance, parentVersion = null, forkedFrom = null }) {
    const validated = this.validate(input);
    if (!validated.ok) throw invalid(`template failed validation: ${validated.errors[0].path} ${validated.errors[0].message}`, { errors: validated.errors });
    return {
      id: input.id,
      version,
      name: input.name,
      description: input.description || null,
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
      config: validated.config,
      builtin: false,
      source,
      note: input.note || null,
      createdAt: nowIso(this.clock),
      createdBy: input.createdBy || 'operator',
      parentVersion,
      forkedFrom,
      archived: false,
      archivedAt: null,
      provenance,
    };
  }

  #commit(record, eventType, payload = {}) {
    return this.engine.transact(() => {
      this.engine.state.templates = [...this.stored, record];
      this.engine.recordEvent(eventType, { payload: { templateId: record.id, version: record.version, ...payload } });
      return record;
    });
  }

  create(input) {
    if (this.#versions(input?.id || '').length) throw new AosError('template_exists', `Template ${input.id} already exists; use edit or fork`, { statusCode: 409, details: { id: input.id } });
    return this.#commit(this.#materialize(input, { version: 1, source: 'user', provenance: { via: 'create' } }), 'template.created');
  }

  edit(id, patch = {}) {
    const head = this.get(id);
    const next = this.#versions(id).at(-1).version + 1;
    const merged = {
      id,
      name: patch.name ?? head.name,
      description: patch.description === undefined ? head.description : patch.description,
      config: patch.config ? deepMerge(head.config, patch.config) : head.config,
      note: patch.note ?? null,
      createdBy: patch.createdBy ?? null,
    };
    const record = this.#materialize(merged, { version: next, source: 'user', provenance: { via: 'edit', from: `${id}@${head.version}` }, parentVersion: head.version });
    return this.#commit(record, 'template.edited', { parentVersion: head.version });
  }

  fork({ fromId, fromVersion = null, id, name = null, note = null, createdBy = null }) {
    const origin = this.get(fromId, fromVersion);
    if (this.#versions(id || '').length) throw new AosError('template_exists', `Template ${id} already exists`, { statusCode: 409, details: { id } });
    const record = this.#materialize(
      { id, name: name || `${origin.name} (fork)`, description: origin.description, config: origin.config, note, createdBy },
      { version: 1, source: 'user', provenance: { via: 'fork', from: `${origin.id}@${origin.version}` }, forkedFrom: { id: origin.id, version: origin.version } },
    );
    return this.#commit(record, 'template.forked', { forkedFrom: record.forkedFrom });
  }

  archive(id, version = null) {
    return this.engine.transact(() => {
      const target = this.get(id, version);
      if (target.builtin) throw new AosError('template_builtin', `Built-in template ${id}@${target.version} cannot be archived; use restoreDefault`, { statusCode: 409, details: { id, version: target.version } });
      const stored = this.stored.find((item) => item.id === id && item.version === target.version);
      stored.archived = true;
      stored.archivedAt = nowIso(this.clock);
      this.engine.recordEvent('template.archived', { payload: { templateId: id, version: target.version } });
      return stored;
    });
  }

  restoreDefault(id) {
    return this.engine.transact(() => {
      if (!this.builtin.some((item) => item.id === id)) throw new AosError('template_not_builtin', `Template ${id} has no built-in default`, { statusCode: 409, details: { id } });
      let archived = 0;
      for (const item of this.stored) {
        if (item.id === id && !item.archived) {
          item.archived = true;
          item.archivedAt = nowIso(this.clock);
          archived += 1;
        }
      }
      this.engine.recordEvent('template.restored', { payload: { templateId: id, archivedVersions: archived } });
      return this.get(id);
    });
  }

  exportTemplates({ ids = null, includeBuiltin = false } = {}) {
    const templates = [];
    for (const id of this.#ids().filter((item) => !ids || ids.includes(item))) {
      for (const record of this.#versions(id)) {
        if ((record.builtin && !includeBuiltin) || record.archived) continue;
        templates.push({ id: record.id, version: record.version, name: record.name, description: record.description, config: record.config, note: record.note, builtin: record.builtin, schemaVersion: record.schemaVersion });
      }
    }
    return { format: TEMPLATE_EXPORT_FORMAT, exportedAt: nowIso(this.clock), templates };
  }

  importTemplates(payload, { createdBy = 'import' } = {}) {
    if (!payload || payload.format !== TEMPLATE_EXPORT_FORMAT || !Array.isArray(payload.templates)) {
      throw invalid(`import payload must have format ${TEMPLATE_EXPORT_FORMAT} and a templates array`);
    }
    const report = { imported: [], skipped: [], errors: [] };
    for (const entry of payload.templates) {
      try {
        if (entry.builtin) {
          report.skipped.push({ id: entry.id, version: entry.version, reason: 'built-in templates are not importable' });
          continue;
        }
        const input = { id: entry.id, name: entry.name, description: entry.description ?? null, config: entry.config, note: entry.note ?? null, createdBy };
        const existing = this.#versions(entry.id);
        const record = existing.length
          ? this.#materialize(input, { version: existing.at(-1).version + 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null }, parentVersion: existing.at(-1).version })
          : this.#materialize(input, { version: 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null } });
        this.#commit(record, 'template.imported', { importedVersion: entry.version ?? null });
        report.imported.push({ id: record.id, version: record.version });
      } catch (error) {
        report.errors.push({ id: entry?.id ?? null, code: error.code || 'error', message: error.message });
      }
    }
    return report;
  }

  // The effective configuration of a task, as the engine applied it, with provenance.
  effectiveForTask(task) {
    if (!task?.config?.templateId) return null;
    const template = this.get(task.config.templateId, task.config.templateVersion);
    return { template: { id: template.id, version: template.version }, config: task.config.effective, overrides: task.config.overrides };
  }

  // Captures a live (or finished) task's effective configuration as a new template.
  saveFromAgent({ taskId, id, name = null, description = null, note = null, createdBy = null }) {
    const task = this.engine.getTask(taskId);
    const run = this.engine.getRun(task.runId);
    const config = task.config?.effective ? structuredClone(task.config.effective) : configFromLegacyTask(task, run, this.engine);
    const latest = (task.runtime || []).at(-1);
    if (latest?.effective?.model) {
      config.harness = { ...config.harness, model: latest.effective.model, effort: latest.effective.effort ?? config.harness.effort };
    }
    const record = this.#materialize(
      { id, name: name || `${task.title} (saved)`, description: description || `Saved from task ${task.key || task.id} of run ${run.id}`, config, note, createdBy },
      { version: 1, source: 'user', provenance: { via: 'save_from_agent', runId: run.id, taskId: task.id, attempt: task.attempts, templateId: task.config?.templateId ?? null } },
    );
    return this.#commit(record, 'template.saved_from_agent', { runId: run.id, taskId: task.id });
  }
}

// Tasks planned without a template still have a configuration the engine applied;
// this reconstructs it so any task can be saved as a template.
function configFromLegacyTask(task, run, engine) {
  const presetId = task.presetId || PRESET_FOR_KIND[task.kind] || 'general-worker';
  return normalizeConfig({
    preset: { id: presetId, version: task.presetVersion ?? null },
    harness: { id: KNOWN_HARNESSES.includes(task.worker) ? task.worker : 'local', model: run.execution?.model ?? null, effort: run.execution?.effort ?? null },
    filesystem: { sandbox: task.sandbox || (run.execution?.sandbox === 'read-only' ? 'read_only' : 'read_only'), readPaths: task.readPaths || [] },
    retry: { maxRetries: task.maxRetries ?? 1 },
    timeoutMs: task.timeoutMs ?? null,
    budget: task.budget || {},
    delegation: task.delegation ? { mayDelegate: Boolean(task.mayDelegate), ...task.delegation } : { mayDelegate: Boolean(task.mayDelegate) },
    escalation: task.escalation || {},
    variables: task.variables || {},
  });
}

export const PRESET_FOR_KIND = Object.freeze({
  intake: 'planner-decomposer',
  plan: 'planner-decomposer',
  research: 'researcher-source-scout',
  critique: 'adversarial-critic',
  synthesis: 'synthesizer',
  retrospective: 'retrospective-analyst',
  adopt: 'recovery-operator',
  verify: 'verifier-evaluator',
});

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

// Applies a template to a plan task at instantiation. Explicit plan-task fields win over
// the template and are recorded as overrides so the provenance of every value is visible.
export function applyTemplateToTask(task, planned, template) {
  const config = structuredClone(template.config);
  const overrides = [];
  const take = (field, planValue, apply) => {
    if (planValue !== undefined && planValue !== null) {
      overrides.push(field);
      apply(planValue);
    }
  };
  take('worker', planned.worker && planned.worker !== 'local' ? planned.worker : undefined, (value) => { config.harness.id = value; });
  take('presetId', planned.presetId, (value) => { config.preset = { id: value, version: planned.presetVersion ?? null }; });
  take('maxRetries', planned.maxRetries, (value) => { config.retry.maxRetries = value; });
  take('timeoutMs', planned.timeoutMs, (value) => { config.timeoutMs = value; });
  take('budget', planned.budget, (value) => { config.budget = { ...config.budget, ...value }; });
  take('sandbox', planned.sandbox, (value) => { config.filesystem.sandbox = value; });
  take('readPaths', planned.readPaths, (value) => { config.filesystem.readPaths = [...new Set([...config.filesystem.readPaths, ...value])]; });
  take('capabilities', planned.capabilities, (value) => { config.capabilities = { ...config.capabilities, ...value }; });
  take('mayDelegate', planned.mayDelegate, (value) => { config.delegation.mayDelegate = value; });
  take('delegation', planned.delegation, (value) => { config.delegation = { ...config.delegation, ...value }; });
  take('model', planned.model, (value) => { config.harness.model = value; });
  take('effort', planned.effort, (value) => { config.harness.effort = value; });
  take('variables', planned.variables, (value) => { config.variables = { ...config.variables, ...value }; });
  take('escalation', planned.escalation, (value) => { config.escalation = { ...config.escalation, ...value }; });
  take('memory', planned.memory, (value) => { config.memory = { ...config.memory, ...value }; });

  task.worker = config.harness.id;
  task.presetId = config.preset.id;
  task.presetVersion = config.preset.version;
  task.maxRetries = config.retry.maxRetries;
  task.timeoutMs = config.timeoutMs ?? task.timeoutMs ?? null;
  task.budget = config.budget;
  task.sandbox = config.filesystem.sandbox;
  task.readPaths = config.filesystem.readPaths;
  task.capabilities = config.capabilities;
  task.mayDelegate = config.delegation.mayDelegate;
  task.delegation = { maxChildren: config.delegation.maxChildren, maxDepth: config.delegation.maxDepth, childTemplates: config.delegation.childTemplates, unlimited: config.delegation.unlimited };
  task.model = config.harness.model;
  task.effort = config.harness.effort;
  task.variables = config.variables;
  task.escalation = config.escalation;
  task.memory = config.memory;
  task.config = { templateId: template.id, templateVersion: template.version, effective: config, overrides };
  return task;
}
