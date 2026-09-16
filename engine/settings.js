// Settings and system access: one catalog of setting definitions grouped the way the
// operator thinks about them, per-scope records with version history, effective values
// with layer provenance, validation and preview, export and import, and explicit
// versioned patches for active runs. Registries (presets, templates, blueprints, memory)
// keep their own operations; the manifest describes all of it for a dashboard.
import { newId, nowIso } from './ids.js';
import { AosError, check, invalid, notFound, t } from './schema.js';
import { MEMORY_SCOPES, PROMOTION_MODES } from './memory/policy.js';
import { KNOWN_HARNESSES, SANDBOX_TIERS, TEMPLATE_INPUT_SCHEMA, TEMPLATE_CONFIG_SCHEMA } from './templates.js';
import { PRESET_INPUT_SCHEMA, PRESET_LIMITS, REQUIRED_SECTIONS, ROLE_KINDS } from './presets/registry.js';
import { BLUEPRINT_INPUT_SCHEMA, BLUEPRINT_CONFIG_SCHEMA, HUMAN_GATE_TRIGGERS } from './blueprints.js';
import { MEMORY_WRITE_SCHEMA, MEMORY_TYPES } from './memory/index.js';
import { RESOURCE_ROUTES } from './api.js';
import { CAPABILITY_INPUT_SCHEMA, CAPABILITY_KINDS, CAPABILITY_PERMISSIONS, CAPABILITY_SCOPES } from './capabilities.js';
import { DETERMINISTIC_IMPROVEMENT_EVALUATION_INPUT_SCHEMA, IMPROVEMENT_EVALUATION_INPUT_SCHEMA } from './improvements.js';

export const SETTING_SCOPES = Object.freeze(['global', 'project', 'swarm', 'role', 'agent', 'run']);
export const SETTINGS_EXPORT_FORMAT = 'aos-settings/1';
export const SETTING_GROUPS = Object.freeze([
  { id: 'agents_roles', name: 'Agents and roles', description: 'Role presets: system-prompt definitions, versions, inheritance and variables.' },
  { id: 'templates', name: 'Subagent templates', description: 'Reusable agent configurations applied when tasks are instantiated.' },
  { id: 'swarms', name: 'Swarm blueprints', description: 'Hierarchy and policy for a whole run: lead, children, depth, concurrency, gates, ceilings.' },
  { id: 'models_harnesses', name: 'Models and harnesses', description: 'Execution mode, allowed harnesses and models, default effort.' },
  { id: 'capabilities', name: 'Capabilities', description: 'Skills, MCP servers, plugins and generated tools available to workers.' },
  { id: 'memory', name: 'Memory', description: 'Continuous memory policy per scope: enabled, read, write, retention, promotion.' },
  { id: 'budgets_concurrency', name: 'Budgets and concurrency', description: 'Concurrency caps, retries, token, cost and time ceilings.' },
  { id: 'approvals_safety', name: 'Approvals and safety', description: 'Human gates, improvement mode, sandbox defaults, destructive-action confirmation.' },
  { id: 'storage_retention', name: 'Storage and retention', description: 'Run and workspace retention, event log size, backups.' },
  { id: 'diagnostics', name: 'Diagnostics', description: 'Read-only store, migration, memory and recovery diagnostics.' },
]);

const memoryPolicySchema = t.object({
  enabled: t.optional(t.boolean()), read: t.optional(t.boolean()), write: t.optional(t.boolean()), reflect: t.optional(t.boolean()),
  scopes: t.optional(t.array(t.enumOf(MEMORY_SCOPES), { unique: true })), autoCommitScopes: t.optional(t.array(t.enumOf(MEMORY_SCOPES), { unique: true })),
  retentionDays: t.optional(t.record(t.nullable(t.integer({ min: 0 })))), maxItemsPerScope: t.optional(t.record(t.integer({ min: 1 }))),
  maxItemsPerQuery: t.optional(t.integer({ min: 1, max: 100 })), maxCharsPerQuery: t.optional(t.integer({ min: 200, max: 200_000 })), maxContentChars: t.optional(t.integer({ min: 100, max: 20_000 })),
  promotion: t.optional(t.record(t.enumOf(PROMOTION_MODES))),
});

// Every setting the engine honours. `scopes` lists where a value may be set; `runPatchable`
// marks settings an operator may change on an active run through a versioned patch.
export const SETTING_DEFINITIONS = Object.freeze([
  { key: 'execution.mode', group: 'models_harnesses', schema: t.enumOf(['local', 'codex', 'mixed']), default: 'local', scopes: [], readOnly: true, description: 'Execution mode of the running engine (from AOS_EXECUTION at start). Read-only here.' },
  { key: 'execution.allowedHarnesses', group: 'models_harnesses', schema: t.array(t.enumOf(KNOWN_HARNESSES), { unique: true, minItems: 1 }), default: ['local', 'codex', 'claude'], scopes: ['global', 'project'], description: 'Harnesses a template may select. Adapters still fail closed until configured and ready.' },
  { key: 'execution.allowedModels', group: 'models_harnesses', schema: t.record(t.array(t.string({ maxLength: 120 }), { unique: true })), default: { codex: ['gpt-5.6-terra', 'gpt-5.6-luna'], claude: ['opus'] }, scopes: ['global', 'project'], description: 'Per-harness model allowlist. Codex role policy further pins manager roles to Terra/max and worker roles to Luna/max.' },
  { key: 'execution.defaultEffort', group: 'models_harnesses', schema: t.nullable(t.string({ maxLength: 40 })), default: null, scopes: ['global', 'project', 'role'], description: 'Default reasoning effort when a template does not set one.' },
  { key: 'capabilities.enabled', group: 'capabilities', schema: t.array(t.string({ maxLength: 200 }), { unique: true }), default: [], scopes: ['global', 'project', 'swarm', 'role'], description: 'Version-pinned capability references workers may mount, such as search-skill@2. Registry tests, permissions and revocation still gate dispatch.' },
  { key: 'memory', group: 'memory', schema: memoryPolicySchema, default: { enabled: false }, scopes: ['global', 'project', 'swarm', 'role'], runPatchable: true, description: 'Memory policy layer for this scope. Outer layers can only be narrowed. Off by default.' },
  { key: 'maxConcurrency', group: 'budgets_concurrency', schema: t.nullable(t.integer({ min: 1 })), default: 2, scopes: ['global', 'project'], runPatchable: true, description: 'Default concurrent workers per run; null means no engine cap (providers and budgets still bound it).' },
  { key: 'maxRetries', group: 'budgets_concurrency', schema: t.integer({ min: 0, max: 20 }), default: 1, scopes: ['global', 'project', 'role'], description: 'Default retries per task when the template does not set one.' },
  { key: 'budget.tokens', group: 'budgets_concurrency', schema: t.nullable(t.integer({ min: 1 })), default: null, scopes: ['global', 'project', 'swarm', 'role', 'agent'], runPatchable: true, description: 'Token ceiling; null means unlimited by policy (still bounded by provider quotas).' },
  { key: 'budget.usd', group: 'budgets_concurrency', schema: t.nullable(t.number({ min: 0 })), default: null, scopes: ['global', 'project', 'swarm', 'role', 'agent'], runPatchable: true, description: 'Cost ceiling in USD; null means unlimited by policy.' },
  { key: 'budget.timeMs', group: 'budgets_concurrency', schema: t.nullable(t.integer({ min: 1000 })), default: null, scopes: ['global', 'project', 'swarm', 'role', 'agent'], runPatchable: true, description: 'Wall-clock ceiling; null means unlimited by policy.' },
  { key: 'approvals.improvementMode', group: 'approvals_safety', schema: t.enumOf(['manual', 'auto_safe', 'auto_all']), default: 'manual', scopes: ['global', 'project'], description: 'How evaluated improvement proposals are adopted. Benchmark gating is implemented; automatic modes remain recorded as manual until promotion safety policy ships.' },
  { key: 'approvals.humanGates', group: 'approvals_safety', schema: t.array(t.enumOf(['before_synthesis', 'before_adopt', 'on_budget_exhausted', 'on_conflict', 'on_expansion']), { unique: true }), default: ['before_adopt'], scopes: ['global', 'project', 'swarm'], runPatchable: true, description: 'Points where a run waits for a human.' },
  { key: 'approvals.defaultSandbox', group: 'approvals_safety', schema: t.enumOf(SANDBOX_TIERS), default: 'read_only', scopes: ['global', 'project', 'role'], description: 'Sandbox tier when a template does not set one.' },
  { key: 'approvals.destructiveConfirmation', group: 'approvals_safety', schema: t.boolean(), default: true, scopes: ['global', 'project'], description: 'Whether destructive memory operations need an explicit confirmation or the approval gate.' },
  { key: 'retentionDays', group: 'storage_retention', schema: t.integer({ min: 1, max: 3650 }), default: 30, scopes: ['global', 'project'], description: 'Retention of run workspaces and artifacts in days.' },
  { key: 'storage.eventLogMaxLines', group: 'storage_retention', schema: t.integer({ min: 1000 }), default: 200_000, scopes: ['global', 'project'], description: 'Rotation threshold for the append-only event log (rotation ships with the event stream).' },
  { key: 'storage.keepStateBackups', group: 'storage_retention', schema: t.integer({ min: 1, max: 20 }), default: 1, scopes: ['global', 'project'], description: 'How many pre-migration state backups to keep.' },
]);

const DEFINITION_BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

// Operations a dashboard must gate. `gate` says what the backend requires: an explicit
// confirmation flag, the proposal approval gate, or a warning because the action is reversible.
const DESTRUCTIVE = Object.freeze({
  'settings.unset': { gate: 'confirm', reversible: true, note: 'Removes one scope record; the effective value falls back to the outer layer.' },
  'presets.archive': { gate: 'confirm', reversible: true, note: 'Archives a user version; restore by editing or restore-default for built-ins.' },
  'presets.restore': { gate: 'confirm', reversible: false, note: 'Archives every user version of a built-in preset.' },
  'templates.archive': { gate: 'confirm', reversible: true },
  'templates.restore': { gate: 'confirm', reversible: false },
  'blueprints.archive': { gate: 'confirm', reversible: true },
  'blueprints.restore': { gate: 'confirm', reversible: false },
  'memory.forget': { gate: 'confirm', reversible: false, note: 'Tombstones an item; pinned items need the operator.' },
  'memory.clear': { gate: 'approval', reversible: false, note: 'Without confirm=true the backend creates a memory_clear proposal for the approval gate.' },
  'memory.promote': { gate: 'policy', reversible: true, note: 'Curator-gated or approval-gated by the promotion policy; sensitive items never promote.' },
  'memory.retention': { gate: 'confirm', reversible: false, note: 'Expires and evicts by policy, then compacts.' },
  'runs.patch': { gate: 'confirm', reversible: true, note: 'Explicit versioned change to an active run; recorded as run.patched.' },
});

export function settingDefinition(key) {
  const definition = DEFINITION_BY_KEY.get(key);
  if (!definition) throw notFound('setting', key);
  return definition;
}

// Layer order from least to most specific. A run patch is the most specific layer of all.
const LAYER_ORDER = ['builtin', 'global', 'project', 'swarm', 'role', 'agent', 'run'];

export class SettingsRegistry {
  constructor({ engine, clock = () => Date.now() } = {}) {
    if (!engine) throw new Error('SettingsRegistry requires an engine');
    this.engine = engine;
    this.clock = clock;
  }

  get records() {
    if (!Array.isArray(this.engine.state.settings)) this.engine.state.settings = [];
    return this.engine.state.settings;
  }

  manifest() {
    return {
      version: 1,
      groups: SETTING_GROUPS.map((group) => ({ ...group, settings: SETTING_DEFINITIONS.filter((definition) => definition.group === group.id).map((definition) => describe(definition)) })),
      scopes: SETTING_SCOPES,
      enumerations: {
        roleKinds: ROLE_KINDS, harnesses: KNOWN_HARNESSES, sandboxTiers: SANDBOX_TIERS, memoryScopes: MEMORY_SCOPES, memoryTypes: MEMORY_TYPES,
        promotionModes: PROMOTION_MODES, humanGateTriggers: HUMAN_GATE_TRIGGERS, settingScopes: SETTING_SCOPES, requiredPresetSections: REQUIRED_SECTIONS, presetLimits: PRESET_LIMITS,
        capabilityKinds: CAPABILITY_KINDS, capabilityPermissions: CAPABILITY_PERMISSIONS, capabilityScopes: CAPABILITY_SCOPES,
      },
      inputSchemas: {
        preset: describeSchema(PRESET_INPUT_SCHEMA),
        template: describeSchema(TEMPLATE_INPUT_SCHEMA),
        templateConfig: describeSchema(TEMPLATE_CONFIG_SCHEMA),
        blueprint: describeSchema(BLUEPRINT_INPUT_SCHEMA),
        blueprintConfig: describeSchema(BLUEPRINT_CONFIG_SCHEMA),
        memoryWrite: describeSchema(MEMORY_WRITE_SCHEMA),
        memoryPolicy: describeSchema(memoryPolicySchema),
        capability: describeSchema(CAPABILITY_INPUT_SCHEMA),
        improvementEvaluation: describeSchema(IMPROVEMENT_EVALUATION_INPUT_SCHEMA),
        deterministicImprovementEvaluation: describeSchema(DETERMINISTIC_IMPROVEMENT_EVALUATION_INPUT_SCHEMA),
      },
      routes: RESOURCE_ROUTES.map(([method, pattern, resource, action, params, status = 200]) => { const names = [...params]; return { method, path: pattern.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, () => `:${names.shift() || 'id'}`), resource, action, status, ...(DESTRUCTIVE[`${resource}.${action}`] ? { destructive: DESTRUCTIVE[`${resource}.${action}`] } : {}) }; }),
      registries: {
        presets: { group: 'agents_roles', operations: ['list', 'get', 'history', 'effective', 'preview', 'create', 'edit', 'fork', 'archive', 'restore', 'validate', 'export', 'import'], http: '/api/v1/presets', cli: 'aos preset <action>' },
        templates: { group: 'templates', operations: ['list', 'get', 'history', 'create', 'edit', 'fork', 'archive', 'restore', 'validate', 'from-task', 'export', 'import'], http: '/api/v1/templates', cli: 'aos template <action>' },
        blueprints: { group: 'swarms', operations: ['list', 'get', 'history', 'effective', 'estimate', 'create', 'edit', 'fork', 'archive', 'restore', 'validate', 'export', 'import'], http: '/api/v1/blueprints', cli: 'aos blueprint <action>' },
        memory: { group: 'memory', operations: ['stats', 'policy', 'search', 'show', 'add', 'correct', 'commit', 'pin', 'unpin', 'forget', 'promote', 'clear', 'retention', 'export', 'import'], http: '/api/v1/memory', cli: 'aos memory <action>' },
        capabilities: { group: 'capabilities', operations: ['list', 'get', 'history', 'create', 'edit', 'test', 'probe', 'enable', 'revoke', 'permissions', 'grant', 'revoke-permission'], http: '/api/v1/capabilities', cli: 'aos capability <action>' },
        sessions: { group: 'models_harnesses', operations: ['list', 'get', 'reset', 'retention'], http: '/api/v1/sessions', cli: 'aos session <action>' },
        improvements: { group: 'approvals_safety', operations: ['evaluate', 'run-deterministic', 'evaluations', 'genome', 'rollback'], http: '/api/v1/improvements', cli: 'aos improvement <action>' },
        runs: { group: 'budgets_concurrency', operations: ['patch', 'patches'], http: '/api/v1/runs/:id/patch', cli: 'aos run patch <runId> <key> <json>' },
      },
      diagnostics: this.diagnostics(),
    };
  }

  diagnostics() {
    return {
      store: { version: this.engine.state.version, migrations: this.engine.state.migrations || [], diagnostics: this.engine.store.diagnostics },
      memory: this.engine.memory.stats().diagnostics,
      counts: { projects: this.engine.state.projects.length, goals: this.engine.state.goals.length, runs: this.engine.state.runs.length, tasks: this.engine.state.tasks.length, presets: this.engine.state.presets.length, templates: this.engine.state.templates.length, blueprints: this.engine.state.blueprints.length, capabilities: this.engine.state.capabilities.length, harnessSessions: this.engine.state.harnessSessions.length, improvementEvaluations: this.engine.state.improvementEvaluations.length, genomeVersions: this.engine.state.genomeVersions.length, settings: this.records.length, memoryIndex: (this.engine.state.memoryIndex || []).length },
      execution: this.engine.executionSummary(),
    };
  }

  validate(key, value) {
    const definition = settingDefinition(key);
    if (definition.readOnly) return { ok: false, errors: [{ path: '$', code: 'read_only', message: `${key} is read-only` }] };
    const errors = check(definition.schema, value);
    return { ok: errors.length === 0, errors };
  }

  #record(key, scope, scopeId) {
    return this.records.find((item) => item.key === key && item.scope === scope && (item.scopeId ?? null) === (scopeId ?? null)) || null;
  }

  list({ scope = null, scopeId = null } = {}) {
    return this.records.filter((item) => (!scope || item.scope === scope) && (scope === null || (item.scopeId ?? null) === (scopeId ?? null))).map((item) => ({ ...item }));
  }

  get(key, { scope, scopeId = null } = {}) {
    settingDefinition(key);
    if (!SETTING_SCOPES.includes(scope)) throw invalid(`scope must be one of ${SETTING_SCOPES.join(', ')}`);
    const record = this.#record(key, scope, scopeId);
    if (!record) throw notFound('setting record', `${key}@${scope}/${scopeId ?? '-'}`);
    return record;
  }

  set(key, value, { scope, scopeId = null, actor = 'operator' } = {}) {
    const definition = settingDefinition(key);
    if (definition.readOnly) throw new AosError('setting_read_only', `${key} is read-only`, { statusCode: 400, details: { key } });
    if (!definition.scopes.includes(scope)) throw new AosError('setting_scope', `${key} cannot be set at scope ${scope}; allowed: ${definition.scopes.join(', ') || 'none (read-only)'}`, { statusCode: 400, details: { key, scope, allowed: definition.scopes } });
    if (scope !== 'global' && !scopeId) throw invalid(`scope ${scope} needs a scopeId`);
    const verdict = this.validate(key, value);
    if (!verdict.ok) throw invalid(`${key} failed validation: ${verdict.errors[0].path} ${verdict.errors[0].message}`, { errors: verdict.errors });
    return this.engine.transact(() => {
      let record = this.#record(key, scope, scopeId);
      const at = nowIso(this.clock);
      if (!record) {
        record = { id: newId('setting'), key, scope, scopeId: scopeId ?? null, value: null, version: 0, updatedAt: null, updatedBy: null, history: [] };
        this.records.push(record);
      }
      record.value = definition.schema.kind === 'object' && record.value && typeof record.value === 'object' ? { ...record.value, ...value } : value;
      record.version += 1;
      record.updatedAt = at;
      record.updatedBy = actor;
      record.history = [...(record.history || []).slice(-19), { version: record.version, value: record.value, at, by: actor }];
      this.engine.recordEvent('setting.changed', { projectId: scope === 'project' ? scopeId : null, payload: { key, scope, scopeId: scopeId ?? null, version: record.version, actor } });
      return record;
    });
  }

  unset(key, { scope, scopeId = null, actor = 'operator' } = {}) {
    settingDefinition(key);
    return this.engine.transact(() => {
      const position = this.records.findIndex((item) => item.key === key && item.scope === scope && (item.scopeId ?? null) === (scopeId ?? null));
      if (position === -1) throw notFound('setting record', `${key}@${scope}/${scopeId ?? '-'}`);
      const [removed] = this.records.splice(position, 1);
      this.engine.recordEvent('setting.removed', { projectId: scope === 'project' ? scopeId : null, payload: { key, scope, scopeId: scopeId ?? null, lastVersion: removed.version, actor } });
      return removed;
    });
  }

  // Effective value for a context, with the value each layer contributed. Object-valued
  // settings (memory) merge across layers; scalar settings take the most specific layer.
  effective(key, context = {}) {
    const definition = settingDefinition(key);
    const layers = [{ layer: 'builtin', value: definition.default, source: 'built-in default' }];
    const scopeIds = { global: null, project: context.projectId ?? null, swarm: context.blueprintId ?? null, role: context.presetId ?? null, agent: context.agentId ?? null };
    for (const scope of ['global', 'project', 'swarm', 'role', 'agent']) {
      if (scope !== 'global' && !scopeIds[scope]) continue;
      const record = this.#record(key, scope, scopeIds[scope]);
      if (record) layers.push({ layer: scope, value: record.value, source: `${scope} setting v${record.version}`, scopeId: scopeIds[scope] });
    }
    if (context.runId) {
      const run = this.engine.state.runs.find((item) => item.id === context.runId);
      const patch = (run?.patches || []).filter((item) => item.key === key).at(-1);
      if (patch) layers.push({ layer: 'run', value: patch.value, source: `run patch v${patch.version}`, scopeId: context.runId });
    }
    let value = layers[0].value;
    let provenance = layers[0];
    for (const entry of layers.slice(1)) {
      if (entry.value === undefined) continue;
      if (definition.schema.kind === 'object' && value && typeof value === 'object' && entry.value && typeof entry.value === 'object') value = { ...value, ...entry.value };
      else value = entry.value;
      provenance = entry;
    }
    return { key, value, provenance: { layer: provenance.layer, source: provenance.source, scopeId: provenance.scopeId ?? null }, layers, runPatchable: Boolean(definition.runPatchable), readOnly: Boolean(definition.readOnly) };
  }

  preview(key, value, { scope, scopeId = null, context = {} } = {}) {
    const verdict = this.validate(key, value);
    if (!verdict.ok) throw invalid(`${key} failed validation: ${verdict.errors[0].path} ${verdict.errors[0].message}`, { errors: verdict.errors });
    const before = this.effective(key, context);
    const layerIndex = LAYER_ORDER.indexOf(scope);
    const after = { ...before, layers: [...before.layers] };
    const definition = settingDefinition(key);
    const existing = after.layers.findIndex((entry) => entry.layer === scope);
    const entry = { layer: scope, value, source: `${scope} setting (preview)`, scopeId };
    if (existing === -1) {
      const insertAt = after.layers.findIndex((item) => LAYER_ORDER.indexOf(item.layer) > layerIndex);
      after.layers.splice(insertAt === -1 ? after.layers.length : insertAt, 0, entry);
    } else after.layers[existing] = entry;
    let merged = after.layers[0].value;
    let provenance = after.layers[0];
    for (const item of after.layers.slice(1)) {
      if (definition.schema.kind === 'object' && merged && typeof merged === 'object' && item.value && typeof item.value === 'object') merged = { ...merged, ...item.value };
      else merged = item.value;
      provenance = item;
    }
    return { key, before: before.value, after: merged, provenance: { layer: provenance.layer, source: provenance.source }, layers: after.layers };
  }

  // Explicit, versioned change to an active run; never a silent mutation of run fields.
  patchRun(runId, { key, value, reason = null, actor = 'operator' } = {}) {
    const definition = settingDefinition(key);
    if (!definition.runPatchable) throw new AosError('setting_not_run_patchable', `${key} cannot be patched on a run`, { statusCode: 400, details: { key } });
    const verdict = this.validate(key, value);
    if (!verdict.ok) throw invalid(`${key} failed validation: ${verdict.errors[0].path} ${verdict.errors[0].message}`, { errors: verdict.errors });
    return this.engine.transact(() => {
      const run = this.engine.getRun(runId);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new AosError('run_terminal', `run ${runId} is ${run.status}; patches apply to active runs only`, { statusCode: 409, details: { runId, status: run.status } });
      run.patches = Array.isArray(run.patches) ? run.patches : [];
      const patch = { version: run.patches.length + 1, key, value, reason, at: nowIso(this.clock), by: actor };
      run.patches.push(patch);
      if (key === 'maxConcurrency') run.maxConcurrency = value;
      if (key === 'approvals.humanGates') run.policies = { ...(run.policies || {}), gates: { ...(run.policies?.gates || {}), human: value } };
      if (key === 'memory') run.policies = { ...(run.policies || {}), memory: { ...(run.policies?.memory || {}), ...value } };
      if (key.startsWith('budget.')) run.ceilings = { ...(run.ceilings || {}), [key.slice('budget.'.length)]: value, unlimited: false };
      run.updatedAt = patch.at;
      this.engine.recordEvent('run.patched', { projectId: run.projectId, runId: run.id, payload: { version: patch.version, key, actor, reason } });
      return patch;
    });
  }

  runPatches(runId) {
    return [...(this.engine.getRun(runId).patches || [])];
  }

  exportSettings({ scope = null } = {}) {
    return { format: SETTINGS_EXPORT_FORMAT, exportedAt: nowIso(this.clock), settings: this.list(scope ? { scope } : {}).map((item) => ({ key: item.key, scope: item.scope, scopeId: item.scopeId, value: item.value })) };
  }

  importSettings(payload, { actor = 'import' } = {}) {
    if (!payload || payload.format !== SETTINGS_EXPORT_FORMAT || !Array.isArray(payload.settings)) throw invalid(`import payload must have format ${SETTINGS_EXPORT_FORMAT} and a settings array`);
    const report = { imported: [], errors: [] };
    for (const entry of payload.settings) {
      try {
        const record = this.set(entry.key, entry.value, { scope: entry.scope, scopeId: entry.scopeId ?? null, actor });
        report.imported.push({ key: record.key, scope: record.scope, scopeId: record.scopeId, version: record.version });
      } catch (error) {
        report.errors.push({ key: entry?.key ?? null, code: error.code || 'error', message: error.message });
      }
    }
    return report;
  }
}

function describe(definition) {
  return { key: definition.key, group: definition.group, scopes: definition.scopes, default: definition.default, readOnly: Boolean(definition.readOnly), runPatchable: Boolean(definition.runPatchable), description: definition.description, schema: describeSchema(definition.schema) };
}

function describeSchema(schema) {
  if (!schema) return null;
  const base = { kind: schema.kind };
  if (schema.nullable) base.nullable = true;
  if (schema.optional) base.optional = true;
  if (schema.kind === 'enum') base.values = schema.values;
  if (schema.kind === 'integer' || schema.kind === 'number') { if (schema.min != null) base.min = schema.min; if (schema.max != null) base.max = schema.max; }
  if (schema.kind === 'string') { if (schema.maxLength != null) base.maxLength = schema.maxLength; }
  if (schema.kind === 'array') { base.items = describeSchema(schema.items); if (schema.unique) base.unique = true; }
  if (schema.kind === 'object') base.fields = Object.fromEntries(Object.entries(schema.shape).map(([key, child]) => [key, describeSchema(child)]));
  if (schema.kind === 'record') base.values = describeSchema(schema.values);
  if (schema.kind === 'oneOf') base.alternatives = schema.schemas.map(describeSchema);
  return base;
}
