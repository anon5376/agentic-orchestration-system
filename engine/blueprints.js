// Swarm blueprints: versioned descriptions of a whole swarm's hierarchy and policy.
// A blueprint names the lead template, the templates that may be instantiated below it,
// depth and concurrency limits (with an explicit "unlimited" switch instead of a fixed
// product cap), routing, capability bindings, context and messaging rules, memory scopes,
// verification and human gates, failure and stop policy, and run ceilings.
import { nowIso } from './ids.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';
import { KNOWN_HARNESSES, MEMORY_SCOPES, PRESET_FOR_KIND, deepMerge } from './templates.js';

export const BLUEPRINT_SCHEMA_VERSION = 1;
export const BLUEPRINT_EXPORT_FORMAT = 'aos-blueprints/1';
export const HUMAN_GATE_TRIGGERS = Object.freeze(['before_synthesis', 'before_adopt', 'on_budget_exhausted', 'on_conflict', 'on_expansion']);

const templateRef = () => t.object({ templateId: identifier(), templateVersion: t.optional(t.nullable(t.integer({ min: 1 }))) });
const idList = (max) => t.array(t.string({ minLength: 1, maxLength: 200 }), { maxItems: max, unique: true });

export const BLUEPRINT_CONFIG_SCHEMA = t.object({
  lead: templateRef(),
  childTemplates: idList(100),
  depth: t.optional(t.object({ max: t.optional(t.nullable(t.oneOf([t.integer({ min: 0 }), t.literal('unlimited')]))), unlimited: t.optional(t.boolean()) })),
  concurrency: t.optional(t.object({ global: t.optional(t.nullable(t.oneOf([t.integer({ min: 1 }), t.literal('unlimited')]))), perBranch: t.optional(t.nullable(t.integer({ min: 1 }))), unlimited: t.optional(t.boolean()) })),
  priority: t.optional(t.object({ policy: t.optional(t.enumOf(['fifo', 'critical_path', 'priority_field'])), default: t.optional(t.integer({ min: 0, max: 100 })) })),
  routing: t.optional(t.object({
    rules: t.optional(t.array(t.object({ match: t.object({ templateId: t.optional(identifier()), role: t.optional(t.string({ maxLength: 60 })), kind: t.optional(t.string({ maxLength: 60 })) }), harness: t.enumOf(KNOWN_HARNESSES), model: t.optional(t.nullable(t.string({ maxLength: 120 }))), effort: t.optional(t.nullable(t.string({ maxLength: 40 }))) }), { maxItems: 100 })),
    fallback: t.optional(t.array(t.object({ harness: t.enumOf(KNOWN_HARNESSES), model: t.optional(t.nullable(t.string({ maxLength: 120 }))) }), { maxItems: 5 })),
  })),
  capabilities: t.optional(t.object({ bindings: t.optional(t.array(t.object({ templateId: identifier(), skills: t.optional(idList(200)), mcp: t.optional(idList(200)), plugins: t.optional(idList(200)), tools: t.optional(idList(200)) }), { maxItems: 100 })) })),
  contextPartition: t.optional(t.object({ policy: t.optional(t.enumOf(['inherit', 'branch', 'isolated'])), shareDependencyResults: t.optional(t.boolean()) })),
  messaging: t.optional(t.object({ policy: t.optional(t.enumOf(['engine_only', 'branch', 'open'])), maxMessageChars: t.optional(t.integer({ min: 100, max: 100_000 })) })),
  artifacts: t.optional(t.object({ shared: t.optional(t.boolean()), siblingsReadOnly: t.optional(t.boolean()) })),
  memory: t.optional(t.object({ scopes: t.optional(t.array(t.enumOf(MEMORY_SCOPES), { maxItems: MEMORY_SCOPES.length, unique: true })), readByDefault: t.optional(t.boolean()), writeByDefault: t.optional(t.boolean()) })),
  gates: t.optional(t.object({
    verification: t.optional(t.array(t.object({ afterKind: t.string({ minLength: 1, maxLength: 60 }), verifierTemplateId: identifier() }), { maxItems: 20 })),
    human: t.optional(t.array(t.enumOf(HUMAN_GATE_TRIGGERS), { maxItems: HUMAN_GATE_TRIGGERS.length, unique: true })),
  })),
  failure: t.optional(t.object({ onBranchFailure: t.optional(t.enumOf(['continue', 'pause', 'fail_run'])), maxReplans: t.optional(t.integer({ min: 0, max: 100 })), retryPolicy: t.optional(t.enumOf(['template', 'none'])) })),
  stop: t.optional(t.object({ criteria: t.optional(t.array(t.string({ minLength: 1, maxLength: 500 }), { maxItems: 50 })), stopOnBudget: t.optional(t.boolean()) })),
  ceilings: t.optional(t.object({ tasks: t.optional(t.nullable(t.integer({ min: 1 }))), tokens: t.optional(t.nullable(t.integer({ min: 1 }))), usd: t.optional(t.nullable(t.number({ min: 0 }))), timeMs: t.optional(t.nullable(t.integer({ min: 1000 }))), unlimited: t.optional(t.boolean()) })),
  kindTemplates: t.optional(t.record(identifier(), { keyPattern: /^[a-z][a-z_-]{0,40}$/, maxKeys: 40 })),
});

export const BLUEPRINT_INPUT_SCHEMA = t.object({
  id: identifier(),
  name: t.string({ minLength: 1, maxLength: 120 }),
  description: t.optional(t.nullable(t.string({ maxLength: 1000 }))),
  config: BLUEPRINT_CONFIG_SCHEMA,
  note: t.optional(t.nullable(t.string({ maxLength: 500 }))),
  createdBy: t.optional(t.nullable(t.string({ maxLength: 120 }))),
});

export const DEFAULT_BLUEPRINT_CONFIG = Object.freeze({
  depth: { max: 3, unlimited: false },
  concurrency: { global: 4, perBranch: 2, unlimited: false },
  priority: { policy: 'fifo', default: 50 },
  routing: { rules: [], fallback: [] },
  capabilities: { bindings: [] },
  contextPartition: { policy: 'branch', shareDependencyResults: true },
  messaging: { policy: 'engine_only', maxMessageChars: 8000 },
  artifacts: { shared: false, siblingsReadOnly: true },
  memory: { scopes: ['agent', 'run'], readByDefault: false, writeByDefault: false },
  gates: { verification: [], human: ['before_adopt'] },
  failure: { onBranchFailure: 'continue', maxReplans: 3, retryPolicy: 'template' },
  stop: { criteria: [], stopOnBudget: true },
  ceilings: { tasks: 200, tokens: 2_000_000, usd: 50, timeMs: 6 * 3_600_000, unlimited: false },
  kindTemplates: {},
});

export function normalizeBlueprintConfig(config) {
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_BLUEPRINT_CONFIG)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value, ...(config[key] || {}) } : (config[key] ?? value);
  }
  merged.lead = { templateId: config.lead.templateId, templateVersion: config.lead.templateVersion ?? null };
  merged.childTemplates = [...(config.childTemplates || [])];
  // The literal 'unlimited' is the explicit boundary form; null plus unlimited: true is canonical.
  if (merged.depth.max === 'unlimited') merged.depth = { ...merged.depth, max: null, unlimited: true };
  if (merged.concurrency.global === 'unlimited') merged.concurrency = { ...merged.concurrency, global: null, unlimited: true };
  if (merged.depth.unlimited) merged.depth.max = null;
  if (merged.concurrency.unlimited) merged.concurrency.global = null;
  return merged;
}

function builtin(id, name, description, config) {
  return Object.freeze({ id, version: 1, name, description, schemaVersion: BLUEPRINT_SCHEMA_VERSION, config: normalizeBlueprintConfig(config), builtin: true, source: 'builtin', note: null, createdAt: null, createdBy: 'aos', parentVersion: null, forkedFrom: null, archived: false, archivedAt: null, provenance: { via: 'builtin' } });
}

const KIND_MAP = { intake: 'default-lead', plan: 'default-lead', research: 'default-researcher', critique: 'default-critic', synthesis: 'default-synthesizer', retrospective: 'default-retrospective', verify: 'default-verifier' };

export const BUILTIN_BLUEPRINTS = Object.freeze([
  builtin('default-research-swarm', 'Default research swarm', 'A lead with up to twelve children, branch managers one level down, critique and verification gates, bounded ceilings.', {
    lead: { templateId: 'default-lead' },
    childTemplates: ['default-branch-manager', 'default-worker', 'default-researcher', 'default-analyst', 'default-critic', 'default-verifier', 'default-synthesizer', 'default-retrospective', 'default-bulk'],
    gates: { verification: [{ afterKind: 'research', verifierTemplateId: 'default-verifier' }], human: ['before_adopt', 'on_budget_exhausted'] },
    kindTemplates: KIND_MAP,
  }),
  builtin('unbounded-research-swarm', 'Unbounded research swarm', 'Same hierarchy with no product-level caps. Execution is still bounded by provider limits, budgets and the sandbox.', {
    lead: { templateId: 'default-lead' },
    childTemplates: ['default-branch-manager', 'default-worker', 'default-researcher', 'default-analyst', 'default-critic', 'default-verifier', 'default-synthesizer', 'default-retrospective', 'default-bulk'],
    depth: { max: null, unlimited: true },
    concurrency: { global: null, perBranch: null, unlimited: true },
    ceilings: { tasks: null, tokens: null, usd: null, timeMs: null, unlimited: true },
    gates: { human: ['before_adopt', 'on_expansion'] },
    kindTemplates: KIND_MAP,
  }),
  builtin('small-audit-swarm', 'Small audit swarm', 'One branch manager leading up to six workers and a verifier, one level deep, two at a time.', {
    lead: { templateId: 'default-branch-manager' },
    childTemplates: ['default-worker', 'default-verifier'],
    depth: { max: 1 },
    concurrency: { global: 2, perBranch: 2 },
    ceilings: { tasks: 20, tokens: 300_000, usd: 5 },
    kindTemplates: { research: 'default-worker', verify: 'default-verifier' },
  }),
]);

export class BlueprintRegistry {
  constructor({ engine, clock = () => Date.now() } = {}) {
    if (!engine) throw new Error('BlueprintRegistry requires an engine');
    this.engine = engine;
    this.clock = clock;
    this.builtin = BUILTIN_BLUEPRINTS;
  }

  get stored() {
    if (!Array.isArray(this.engine.state.blueprints)) this.engine.state.blueprints = [];
    return this.engine.state.blueprints;
  }

  #versions(id) {
    return [...this.builtin.filter((item) => item.id === id), ...this.stored.filter((item) => item.id === id)].sort((a, b) => a.version - b.version);
  }

  #ids() {
    return [...new Set([...this.builtin.map((item) => item.id), ...this.stored.map((item) => item.id)])].sort();
  }

  get(id, version = null) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('blueprint', id);
    if (version == null) {
      const head = [...versions].reverse().find((item) => !item.archived);
      if (!head) throw new AosError('blueprint_archived', `Every version of blueprint ${id} is archived`, { statusCode: 409, details: { id } });
      return head;
    }
    const exact = versions.find((item) => item.version === version);
    if (!exact) throw notFound('blueprint version', `${id}@${version}`);
    return exact;
  }

  list({ includeArchived = false } = {}) {
    return this.#ids().map((id) => {
      const versions = this.#versions(id);
      const head = [...versions].reverse().find((item) => !item.archived) || null;
      const shown = head || versions.at(-1);
      return { id, name: shown.name, description: shown.description, lead: shown.config.lead, builtin: versions.some((item) => item.builtin), headVersion: head ? head.version : null, versions: versions.length, unlimited: Boolean(shown.config.depth.unlimited || shown.config.concurrency.unlimited || shown.config.ceilings.unlimited) };
    }).filter((item) => includeArchived || item.headVersion !== null);
  }

  history(id) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('blueprint', id);
    return versions.map((item) => ({ version: item.version, source: item.source, builtin: item.builtin, name: item.name, note: item.note, createdAt: item.createdAt, createdBy: item.createdBy, parentVersion: item.parentVersion, forkedFrom: item.forkedFrom, archived: item.archived, archivedAt: item.archivedAt }));
  }

  // Structural validation, referential checks against templates, and impossible-policy checks.
  validate(input) {
    const errors = [...check(BLUEPRINT_INPUT_SCHEMA, input)];
    if (errors.length) return { ok: false, errors };
    const config = normalizeBlueprintConfig(input.config);
    const templates = this.engine.templates;
    const push = (path, code, message) => errors.push({ path, code, message });
    let lead = null;
    try {
      lead = templates.get(config.lead.templateId, config.lead.templateVersion);
    } catch (error) {
      push('$.config.lead', error.code || 'template', error.message);
    }
    for (const childId of config.childTemplates) {
      try { templates.get(childId); } catch (error) { push('$.config.childTemplates', 'unknown_template', `child template ${childId} does not exist`); }
    }
    for (const [kind, templateId] of Object.entries(config.kindTemplates)) {
      if (!config.childTemplates.includes(templateId) && templateId !== config.lead.templateId) push(`$.config.kindTemplates.${kind}`, 'not_permitted', `template ${templateId} is not the lead and not in childTemplates`);
    }
    for (const gate of config.gates.verification) {
      try { templates.get(gate.verifierTemplateId); } catch { push('$.config.gates.verification', 'unknown_template', `verifier template ${gate.verifierTemplateId} does not exist`); }
    }
    for (const binding of config.capabilities.bindings) {
      if (binding.templateId !== config.lead.templateId && !config.childTemplates.includes(binding.templateId)) push('$.config.capabilities.bindings', 'not_permitted', `binding for ${binding.templateId}, which the blueprint does not use`);
    }
    if (!config.depth.unlimited && config.depth.max == null) push('$.config.depth', 'limit_required', 'set depth.max or depth.unlimited: true');
    if (!config.concurrency.unlimited && config.concurrency.global == null) push('$.config.concurrency', 'limit_required', 'set concurrency.global or concurrency.unlimited: true');
    if (!config.ceilings.unlimited && config.ceilings.tasks == null && config.ceilings.tokens == null && config.ceilings.usd == null && config.ceilings.timeMs == null) push('$.config.ceilings', 'limit_required', 'set at least one ceiling or ceilings.unlimited: true');
    if (config.concurrency.global != null && config.concurrency.perBranch != null && config.concurrency.perBranch > config.concurrency.global) push('$.config.concurrency.perBranch', 'impossible', 'perBranch cannot exceed global');
    if (lead) {
      if (lead.config.delegation.mayDelegate && config.depth.max === 0) push('$.config.depth.max', 'impossible', 'lead may delegate but depth is 0');
      if (!lead.config.delegation.mayDelegate && config.childTemplates.length) push('$.config.lead', 'impossible', 'lead template cannot delegate, so child templates can never be instantiated');
      if (lead.config.delegation.mayDelegate && config.childTemplates.length === 0 && !config.kindTemplates) push('$.config.childTemplates', 'impossible', 'lead may delegate but no child template is permitted');
    }
    if (config.ceilings.tasks != null && config.ceilings.tasks < 1) push('$.config.ceilings.tasks', 'impossible', 'tasks ceiling below 1');
    return { ok: errors.length === 0, errors, config };
  }

  #materialize(input, { version, source, provenance, parentVersion = null, forkedFrom = null }) {
    const validated = this.validate(input);
    if (!validated.ok) throw invalid(`blueprint failed validation: ${validated.errors[0].path} ${validated.errors[0].message}`, { errors: validated.errors });
    return { id: input.id, version, name: input.name, description: input.description || null, schemaVersion: BLUEPRINT_SCHEMA_VERSION, config: validated.config, builtin: false, source, note: input.note || null, createdAt: nowIso(this.clock), createdBy: input.createdBy || 'operator', parentVersion, forkedFrom, archived: false, archivedAt: null, provenance };
  }

  #commit(record, eventType, payload = {}) {
    return this.engine.transact(() => {
      this.engine.state.blueprints = [...this.stored, record];
      this.engine.recordEvent(eventType, { payload: { blueprintId: record.id, version: record.version, ...payload } });
      return record;
    });
  }

  create(input) {
    if (this.#versions(input?.id || '').length) throw new AosError('blueprint_exists', `Blueprint ${input.id} already exists; use edit or fork`, { statusCode: 409, details: { id: input.id } });
    return this.#commit(this.#materialize(input, { version: 1, source: 'user', provenance: { via: 'create' } }), 'blueprint.created');
  }

  edit(id, patch = {}) {
    const head = this.get(id);
    const next = this.#versions(id).at(-1).version + 1;
    const merged = { id, name: patch.name ?? head.name, description: patch.description === undefined ? head.description : patch.description, config: patch.config ? deepMerge(head.config, patch.config) : head.config, note: patch.note ?? null, createdBy: patch.createdBy ?? null };
    return this.#commit(this.#materialize(merged, { version: next, source: 'user', provenance: { via: 'edit', from: `${id}@${head.version}` }, parentVersion: head.version }), 'blueprint.edited', { parentVersion: head.version });
  }

  fork({ fromId, fromVersion = null, id, name = null, note = null, createdBy = null }) {
    const origin = this.get(fromId, fromVersion);
    if (this.#versions(id || '').length) throw new AosError('blueprint_exists', `Blueprint ${id} already exists`, { statusCode: 409, details: { id } });
    return this.#commit(this.#materialize({ id, name: name || `${origin.name} (fork)`, description: origin.description, config: origin.config, note, createdBy }, { version: 1, source: 'user', provenance: { via: 'fork', from: `${origin.id}@${origin.version}` }, forkedFrom: { id: origin.id, version: origin.version } }), 'blueprint.forked');
  }

  archive(id, version = null) {
    return this.engine.transact(() => {
      const target = this.get(id, version);
      if (target.builtin) throw new AosError('blueprint_builtin', `Built-in blueprint ${id}@${target.version} cannot be archived; use restoreDefault`, { statusCode: 409, details: { id } });
      const stored = this.stored.find((item) => item.id === id && item.version === target.version);
      stored.archived = true;
      stored.archivedAt = nowIso(this.clock);
      this.engine.recordEvent('blueprint.archived', { payload: { blueprintId: id, version: target.version } });
      return stored;
    });
  }

  restoreDefault(id) {
    return this.engine.transact(() => {
      if (!this.builtin.some((item) => item.id === id)) throw new AosError('blueprint_not_builtin', `Blueprint ${id} has no built-in default`, { statusCode: 409, details: { id } });
      let archived = 0;
      for (const item of this.stored) if (item.id === id && !item.archived) { item.archived = true; item.archivedAt = nowIso(this.clock); archived += 1; }
      this.engine.recordEvent('blueprint.restored', { payload: { blueprintId: id, archivedVersions: archived } });
      return this.get(id);
    });
  }

  exportBlueprints({ ids = null, includeBuiltin = false } = {}) {
    const blueprints = [];
    for (const id of this.#ids().filter((item) => !ids || ids.includes(item))) {
      for (const record of this.#versions(id)) {
        if ((record.builtin && !includeBuiltin) || record.archived) continue;
        blueprints.push({ id: record.id, version: record.version, name: record.name, description: record.description, config: record.config, note: record.note, builtin: record.builtin, schemaVersion: record.schemaVersion });
      }
    }
    return { format: BLUEPRINT_EXPORT_FORMAT, exportedAt: nowIso(this.clock), blueprints };
  }

  importBlueprints(payload, { createdBy = 'import' } = {}) {
    if (!payload || payload.format !== BLUEPRINT_EXPORT_FORMAT || !Array.isArray(payload.blueprints)) throw invalid(`import payload must have format ${BLUEPRINT_EXPORT_FORMAT} and a blueprints array`);
    const report = { imported: [], skipped: [], errors: [] };
    for (const entry of payload.blueprints) {
      try {
        if (entry.builtin) { report.skipped.push({ id: entry.id, version: entry.version, reason: 'built-in blueprints are not importable' }); continue; }
        const input = { id: entry.id, name: entry.name, description: entry.description ?? null, config: entry.config, note: entry.note ?? null, createdBy };
        const existing = this.#versions(entry.id);
        const record = existing.length
          ? this.#materialize(input, { version: existing.at(-1).version + 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null }, parentVersion: existing.at(-1).version })
          : this.#materialize(input, { version: 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null } });
        this.#commit(record, 'blueprint.imported');
        report.imported.push({ id: record.id, version: record.version });
      } catch (error) {
        report.errors.push({ id: entry?.id ?? null, code: error.code || 'error', message: error.message });
      }
    }
    return report;
  }

  // Fully resolved view: every template reference replaced by its head record summary.
  effective(id, version = null) {
    const blueprint = this.get(id, version);
    const templates = this.engine.templates;
    const summarize = (record) => ({ id: record.id, version: record.version, preset: record.config.preset, harness: record.config.harness, delegation: record.config.delegation, budget: record.config.budget, sandbox: record.config.filesystem.sandbox });
    const lead = templates.get(blueprint.config.lead.templateId, blueprint.config.lead.templateVersion);
    return {
      id: blueprint.id,
      version: blueprint.version,
      name: blueprint.name,
      config: blueprint.config,
      lead: summarize(lead),
      childTemplates: blueprint.config.childTemplates.map((childId) => summarize(templates.get(childId))),
      kindTemplates: Object.fromEntries(Object.entries(blueprint.config.kindTemplates).map(([kind, templateId]) => [kind, summarize(templates.get(templateId))])),
      limits: {
        depth: blueprint.config.depth.unlimited ? 'unlimited' : blueprint.config.depth.max,
        concurrency: blueprint.config.concurrency.unlimited ? 'unlimited' : blueprint.config.concurrency.global,
        ceilings: blueprint.config.ceilings.unlimited ? 'unlimited' : blueprint.config.ceilings,
      },
    };
  }

  // Dry-run expansion: walks lead -> permitted child templates -> their permitted children,
  // bounding agents per level by each template's maxChildren. Unlimited blueprints are
  // estimated to the requested depth and flagged as unbounded.
  estimate(id, { version = null, depth = null } = {}) {
    const blueprint = this.get(id, version);
    const templates = this.engine.templates;
    const permitted = new Set(blueprint.config.childTemplates);
    const maxDepth = blueprint.config.depth.unlimited ? (depth ?? 3) : Math.min(blueprint.config.depth.max ?? 0, depth ?? blueprint.config.depth.max ?? 0);
    const warnings = [];
    if (blueprint.config.depth.unlimited) warnings.push(`depth is unlimited; estimated to depth ${maxDepth}`);
    if (blueprint.config.concurrency.unlimited) warnings.push('concurrency is unlimited; actual parallelism is bounded by provider limits and budgets');
    if (blueprint.config.ceilings.unlimited) warnings.push('ceilings are unlimited; cost is bounded only by provider limits and the sandbox');
    const lead = templates.get(blueprint.config.lead.templateId, blueprint.config.lead.templateVersion);
    // Worst case per level: every agent at a level is the permitted template with the largest
    // fan-out, and each of its children is the most expensive permitted child template.
    // An unlimited fan-out makes the count indeterminate from that level on; no finite
    // number is invented for it.
    const levels = [{ depth: 0, templates: [lead.id], maxAgents: 1, maxTokens: lead.config.budget.tokens ?? 0, indeterminate: false }];
    let frontier = [lead];
    let indeterminate = false;
    for (let level = 1; level <= maxDepth; level += 1) {
      const delegating = frontier.filter((template) => template.config.delegation.mayDelegate && (template.config.delegation.maxChildren === null || template.config.delegation.maxChildren > 0));
      if (!delegating.length) break;
      const nextIds = new Set();
      for (const template of delegating) {
        const allowed = template.config.delegation.childTemplates.length ? template.config.delegation.childTemplates : [...permitted];
        for (const childId of allowed) if (permitted.has(childId)) nextIds.add(childId);
      }
      if (!nextIds.size) break;
      const next = [...nextIds].map((childId) => templates.get(childId));
      const fanouts = delegating.map((template) => template.config.delegation.maxChildren);
      if (indeterminate || fanouts.some((fanout) => fanout === null) || levels.at(-1).maxAgents === null) {
        indeterminate = true;
        levels.push({ depth: level, templates: [...nextIds], maxAgents: null, maxTokens: null, indeterminate: true });
      } else {
        const fanout = Math.max(...fanouts);
        const maxAgents = levels.at(-1).maxAgents * fanout;
        const maxChildTokens = Math.max(...next.map((template) => template.config.budget.tokens ?? 0));
        levels.push({ depth: level, templates: [...nextIds], maxAgents, maxTokens: maxAgents * maxChildTokens, indeterminate: false });
      }
      frontier = next;
    }
    const totalAgents = indeterminate ? null : levels.reduce((sum, item) => sum + item.maxAgents, 0);
    const totalTokens = indeterminate ? null : levels.reduce((sum, item) => sum + item.maxTokens, 0);
    const ceilings = blueprint.config.ceilings;
    if (indeterminate) warnings.push('a template in the hierarchy has unlimited fan-out; agent and token counts are indeterminate and bounded only by budgets, provider limits and the sandbox');
    if (!ceilings.unlimited && totalAgents !== null) {
      if (ceilings.tasks != null && totalAgents > ceilings.tasks) warnings.push(`worst-case agents ${totalAgents} exceed the tasks ceiling ${ceilings.tasks}; the ceiling will stop expansion first`);
      if (ceilings.tokens != null && totalTokens > ceilings.tokens) warnings.push(`worst-case tokens ${totalTokens} exceed the tokens ceiling ${ceilings.tokens}`);
    }
    return { id: blueprint.id, version: blueprint.version, depthEstimated: maxDepth, levels, totalAgents, totalTokens, indeterminate, unbounded: Boolean(blueprint.config.depth.unlimited || blueprint.config.ceilings.unlimited || indeterminate), warnings };
  }

  // Given the plan tasks of a goal, returns copies with the blueprint's templates assigned by
  // kind (lead for the root, kindTemplates for the rest) wherever the plan did not choose one.
  applyToPlan(blueprint, plannedTasks) {
    const roots = plannedTasks.filter((task) => !task.parentId);
    return plannedTasks.map((task) => {
      if (task.templateId || task.kind === 'adopt') return task;
      const isRoot = roots.length === 1 ? task === roots[0] : Boolean(!task.parentId && ['intake', 'plan'].includes(task.kind));
      const templateId = isRoot ? blueprint.config.lead.templateId : blueprint.config.kindTemplates[task.kind];
      if (!templateId) return task;
      const record = this.engine.templates.get(templateId, isRoot ? blueprint.config.lead.templateVersion : null);
      return { ...task, templateId: record.id, templateVersion: record.version, presetId: task.presetId ?? undefined };
    });
  }

  runSettings(blueprint) {
    const { concurrency, ceilings, gates, failure, stop, memory, contextPartition, messaging, artifacts, routing, priority } = blueprint.config;
    return {
      blueprint: { id: blueprint.id, version: blueprint.version },
      maxConcurrency: concurrency.unlimited ? null : concurrency.global,
      perBranchConcurrency: concurrency.unlimited ? null : concurrency.perBranch,
      ceilings: ceilings.unlimited ? { unlimited: true } : { ...ceilings },
      depth: blueprint.config.depth,
      gates, failure, stop, memory, contextPartition, messaging, artifacts, routing, priority,
    };
  }
}

export { PRESET_FOR_KIND };
