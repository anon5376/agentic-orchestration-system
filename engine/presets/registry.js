// Role preset registry: versioned system-prompt definitions for agent roles.
//
// Built-in presets live as files under ./builtin and are immutable. User edits create
// derived versions stored in state.presets. A preset is a set of named sections plus
// typed variables; presets may extend one parent, and sections compose with a
// deterministic rule (child replaces, or appends when the heading says so).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso } from '../ids.js';
import { AosError, check, identifier, invalid, notFound, t } from '../schema.js';

export const REQUIRED_SECTIONS = Object.freeze([
  'Mission',
  'Responsibilities',
  'Inputs',
  'Outputs',
  'Operating loop',
  'Delegation authority',
  'Tool and capability policy',
  'Evidence standard',
  'Uncertainty rules',
  'Communication protocol',
  'Escalation rules',
  'Stop conditions',
  'Prohibited behavior',
  'Memory policy',
  'Budget behavior',
  'Completion contract',
]);

export const ROLE_KINDS = Object.freeze([
  'base',
  'lead',
  'coordinator',
  'planner',
  'branch-manager',
  'worker',
  'researcher',
  'analyst',
  'experiment-designer',
  'critic',
  'verifier',
  'evidence-auditor',
  'synthesizer',
  'toolsmith',
  'memory-curator',
  'retrospective-analyst',
  'recovery-operator',
  'bulk-worker',
]);

export const PRESET_LIMITS = Object.freeze({
  bodyMaxChars: 60_000,
  sectionMaxChars: 20_000,
  sectionMaxCount: 40,
  variableMaxCount: 50,
  variableValueMaxChars: 20_000,
  inheritanceMaxDepth: 8,
});

export const PRESET_EXPORT_FORMAT = 'aos-presets/1';

const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'builtin');
const SECTION_NAME = /^[A-Z][A-Za-z ]{1,60}$/;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const HEADING = /^## (.+?)(?:\s+\((append)\))?\s*$/;

// Control characters other than tab and newline are stripped from variable values.
function stripControl(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += ch;
  }
  return out;
}

const VARIABLE_SCHEMA = t.record(
  t.object({
    type: t.enumOf(['string', 'integer', 'number', 'boolean', 'enum', 'list']),
    required: t.optional(t.boolean()),
    default: t.optional(t.any()),
    description: t.optional(t.string({ maxLength: 500 })),
    values: t.optional(t.array(t.string({ maxLength: 200 }), { maxItems: 100 })),
    maxLength: t.optional(t.integer({ min: 1, max: PRESET_LIMITS.variableValueMaxChars })),
  }),
  { keyPattern: VARIABLE_NAME, maxKeys: PRESET_LIMITS.variableMaxCount },
);

const SECTIONS_SCHEMA = t.record(t.string({ maxLength: PRESET_LIMITS.sectionMaxChars }), { keyPattern: SECTION_NAME, maxKeys: PRESET_LIMITS.sectionMaxCount });
const MODES_SCHEMA = t.record(t.enumOf(['replace', 'append']), { keyPattern: SECTION_NAME, maxKeys: PRESET_LIMITS.sectionMaxCount });

export const PRESET_INPUT_SCHEMA = t.object({
  id: identifier(),
  version: t.optional(t.integer({ min: 1 })),
  name: t.string({ minLength: 1, maxLength: 120 }),
  role: t.enumOf(ROLE_KINDS),
  extends: t.optional(t.nullable(t.object({ id: identifier(), version: t.optional(t.integer({ min: 1 })) }))),
  abstract: t.optional(t.boolean()),
  variables: t.optional(VARIABLE_SCHEMA),
  sections: t.optional(SECTIONS_SCHEMA),
  sectionModes: t.optional(MODES_SCHEMA),
  body: t.optional(t.string({ maxLength: PRESET_LIMITS.bodyMaxChars })),
  note: t.optional(t.nullable(t.string({ maxLength: 500 }))),
  createdBy: t.optional(t.nullable(t.string({ maxLength: 120 }))),
});

export function parseSections(body) {
  const sections = {};
  const modes = {};
  const order = [];
  let current = null;
  let preamble = [];
  for (const line of String(body || '').split('\n')) {
    const match = line.match(HEADING);
    if (match) {
      current = match[1].trim();
      if (!SECTION_NAME.test(current)) throw invalid(`Section heading "${current}" is not allowed`, { section: current });
      if (sections[current] !== undefined) throw invalid(`Section "${current}" appears twice`, { section: current });
      sections[current] = [];
      modes[current] = match[2] === 'append' ? 'append' : 'replace';
      order.push(current);
      continue;
    }
    if (current === null) preamble.push(line);
    else sections[current].push(line);
  }
  for (const name of order) sections[name] = sections[name].join('\n').trim();
  preamble = preamble.join('\n').trim();
  return { sections, modes, order, preamble };
}

export function joinSections(sections, order = Object.keys(sections), modes = {}) {
  return order
    .filter((name) => sections[name] !== undefined)
    .map((name) => `## ${name}${modes[name] === 'append' ? ' (append)' : ''}\n\n${String(sections[name]).trim()}\n`)
    .join('\n');
}

export function parsePresetFile(text, { file = null } = {}) {
  const source = String(text);
  if (!source.startsWith('---\n')) throw invalid(`Preset file ${file || ''} must start with a JSON front matter block`);
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) throw invalid(`Preset file ${file || ''} front matter is not closed`);
  let meta;
  try {
    meta = JSON.parse(source.slice(4, end));
  } catch (error) {
    throw invalid(`Preset file ${file || ''} front matter is not valid JSON: ${error.message}`);
  }
  const body = source.slice(end + 5);
  const parsed = parseSections(body);
  return { meta, ...parsed, body };
}

function loadBuiltins(dir) {
  const records = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const { meta, sections, modes, order } = parsePresetFile(readFileSync(join(dir, file), 'utf8'), { file });
    const input = { ...meta, sections, sectionModes: modes };
    const errors = check(PRESET_INPUT_SCHEMA, input);
    if (errors.length) throw invalid(`Built-in preset ${file} is invalid: ${errors[0].path} ${errors[0].message}`, { file, errors });
    if (`${meta.id}.md` !== file) throw invalid(`Built-in preset ${file} declares id ${meta.id}; file name must match`);
    records.push(Object.freeze({
      id: meta.id,
      version: Number.isInteger(meta.version) ? meta.version : 1,
      name: meta.name,
      role: meta.role,
      builtin: true,
      source: 'builtin',
      abstract: Boolean(meta.abstract),
      extends: meta.extends || null,
      variables: meta.variables || {},
      sections: Object.freeze({ ...sections }),
      sectionModes: Object.freeze({ ...modes }),
      order: Object.freeze([...order]),
      note: meta.note || null,
      createdAt: null,
      createdBy: 'aos',
      parentVersion: null,
      forkedFrom: null,
      archived: false,
      archivedAt: null,
      file,
    }));
  }
  return records;
}

function coerceValue(name, spec, raw) {
  if (raw === undefined || raw === null) return null;
  switch (spec.type) {
    case 'string':
      if (typeof raw !== 'string') throw invalid(`Variable ${name} must be a string`, { variable: name });
      return raw;
    case 'integer':
      if (!Number.isInteger(raw)) throw invalid(`Variable ${name} must be an integer`, { variable: name });
      return String(raw);
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw invalid(`Variable ${name} must be a number`, { variable: name });
      return String(raw);
    case 'boolean':
      if (typeof raw !== 'boolean') throw invalid(`Variable ${name} must be a boolean`, { variable: name });
      return raw ? 'true' : 'false';
    case 'enum':
      if (!Array.isArray(spec.values) || !spec.values.includes(raw)) throw invalid(`Variable ${name} must be one of ${(spec.values || []).join(', ')}`, { variable: name });
      return String(raw);
    case 'list':
      if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) throw invalid(`Variable ${name} must be a list of strings`, { variable: name });
      return raw.length ? raw.map((item) => `- ${item}`).join('\n') : '(none)';
    default:
      throw invalid(`Variable ${name} has unknown type ${spec.type}`, { variable: name });
  }
}

// Values are text. They are inserted in one pass and never re-scanned, so a value that
// itself contains {{...}} or "## Heading" stays literal and cannot add sections or variables.
function sanitizeValue(name, spec, text) {
  const cleaned = stripControl(text);
  const limit = spec.maxLength || PRESET_LIMITS.variableValueMaxChars;
  if (cleaned.length > limit) throw invalid(`Variable ${name} exceeds ${limit} characters`, { variable: name, length: cleaned.length });
  return cleaned;
}

export class PresetRegistry {
  constructor({ engine, builtinDir = BUILTIN_DIR, clock = () => Date.now() } = {}) {
    if (!engine) throw new Error('PresetRegistry requires an engine');
    this.engine = engine;
    this.clock = clock;
    this.builtin = loadBuiltins(builtinDir);
    for (const record of this.builtin) {
      if (!record.abstract) this.effective(record.id, record.version);
    }
  }

  get stored() {
    if (!Array.isArray(this.engine.state.presets)) this.engine.state.presets = [];
    return this.engine.state.presets;
  }

  #versions(id) {
    return [...this.builtin.filter((item) => item.id === id), ...this.stored.filter((item) => item.id === id)]
      .sort((a, b) => a.version - b.version);
  }

  #ids() {
    return [...new Set([...this.builtin.map((item) => item.id), ...this.stored.map((item) => item.id)])].sort();
  }

  get(id, version = null) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('preset', id);
    if (version == null) {
      const head = [...versions].reverse().find((item) => !item.archived);
      if (!head) throw new AosError('preset_archived', `Every version of preset ${id} is archived`, { statusCode: 409, details: { id } });
      return head;
    }
    const exact = versions.find((item) => item.version === version);
    if (!exact) throw notFound('preset version', `${id}@${version}`);
    return exact;
  }

  history(id) {
    const versions = this.#versions(id);
    if (!versions.length) throw notFound('preset', id);
    return versions.map((item) => ({
      version: item.version,
      source: item.source,
      builtin: item.builtin,
      name: item.name,
      role: item.role,
      note: item.note,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      parentVersion: item.parentVersion,
      forkedFrom: item.forkedFrom,
      archived: item.archived,
      archivedAt: item.archivedAt,
      extends: item.extends,
    }));
  }

  list({ includeArchived = false, role = null } = {}) {
    return this.#ids().map((id) => {
      const versions = this.#versions(id);
      const head = [...versions].reverse().find((item) => !item.archived) || null;
      const shown = head || versions.at(-1);
      return {
        id,
        name: shown.name,
        role: shown.role,
        abstract: Boolean(shown.abstract),
        builtin: versions.some((item) => item.builtin),
        headVersion: head ? head.version : null,
        versions: versions.length,
        archivedVersions: versions.filter((item) => item.archived).length,
        userVersions: versions.filter((item) => !item.builtin).length,
        extends: shown.extends,
      };
    }).filter((item) => (includeArchived || item.headVersion !== null) && (!role || item.role === role));
  }

  // Composes the inheritance chain root-first. Child sections replace, or append when
  // the child marked the section "(append)". Variables merge with the child winning.
  effective(id, version = null) {
    const chain = [];
    const seen = new Set();
    let current = this.get(id, version);
    while (current) {
      const key = `${current.id}@${current.version}`;
      if (seen.has(key)) throw new AosError('preset_cycle', `Preset inheritance cycle at ${key}`, { statusCode: 400, details: { chain: [...seen, key] } });
      seen.add(key);
      chain.push(current);
      if (chain.length > PRESET_LIMITS.inheritanceMaxDepth) {
        throw new AosError('preset_depth', `Preset inheritance deeper than ${PRESET_LIMITS.inheritanceMaxDepth}`, { statusCode: 400, details: { chain: [...seen] } });
      }
      current = current.extends ? this.get(current.extends.id, current.extends.version ?? null) : null;
    }
    const sections = {};
    const order = [];
    const variables = {};
    for (const record of [...chain].reverse()) {
      for (const [name, spec] of Object.entries(record.variables || {})) variables[name] = { ...spec };
      for (const name of record.order) {
        const text = record.sections[name];
        const mode = record.sectionModes?.[name] || 'replace';
        if (mode === 'append' && sections[name]) sections[name] = `${sections[name]}\n\n${text}`;
        else sections[name] = text;
        if (!order.includes(name)) order.push(name);
      }
    }
    const leaf = chain[0];
    const missing = leaf.abstract ? [] : REQUIRED_SECTIONS.filter((name) => !String(sections[name] || '').trim());
    if (missing.length) {
      throw new AosError('preset_incomplete', `Preset ${leaf.id}@${leaf.version} is missing sections: ${missing.join(', ')}`, { statusCode: 400, details: { id: leaf.id, version: leaf.version, missing } });
    }
    const orderedNames = [...REQUIRED_SECTIONS.filter((name) => sections[name] !== undefined), ...order.filter((name) => !REQUIRED_SECTIONS.includes(name))];
    const body = joinSections(sections, orderedNames);
    if (body.length > PRESET_LIMITS.bodyMaxChars) {
      throw new AosError('preset_too_long', `Effective preset ${leaf.id}@${leaf.version} is ${body.length} characters; limit ${PRESET_LIMITS.bodyMaxChars}`, { statusCode: 400, details: { length: body.length } });
    }
    const declared = new Set(Object.keys(variables));
    const used = new Set();
    for (const match of body.matchAll(PLACEHOLDER)) used.add(match[1]);
    const undeclared = [...used].filter((name) => !declared.has(name));
    if (undeclared.length) {
      throw new AosError('preset_undeclared_variable', `Preset ${leaf.id}@${leaf.version} uses undeclared variables: ${undeclared.join(', ')}`, { statusCode: 400, details: { undeclared } });
    }
    return {
      id: leaf.id,
      version: leaf.version,
      name: leaf.name,
      role: leaf.role,
      abstract: Boolean(leaf.abstract),
      chain: chain.map((item) => ({ id: item.id, version: item.version, builtin: item.builtin })),
      sections,
      order: orderedNames,
      variables,
      usedVariables: [...used].sort(),
      body,
    };
  }

  render(id, { version = null, variables = {} } = {}) {
    const composed = this.effective(id, version);
    if (composed.abstract) throw new AosError('preset_abstract', `Preset ${id} is abstract and cannot be rendered directly`, { statusCode: 400, details: { id } });
    if (variables && (typeof variables !== 'object' || Array.isArray(variables))) throw invalid('variables must be an object');
    const unknown = Object.keys(variables || {}).filter((name) => !composed.variables[name]);
    if (unknown.length) throw invalid(`Unknown variables: ${unknown.join(', ')}`, { unknown });
    const resolved = {};
    const missing = [];
    for (const [name, spec] of Object.entries(composed.variables)) {
      const raw = variables[name] !== undefined ? variables[name] : spec.default;
      const value = coerceValue(name, spec, raw);
      if (value === null) {
        if (spec.required) missing.push(name);
        continue;
      }
      resolved[name] = sanitizeValue(name, spec, value);
    }
    const unresolved = composed.usedVariables.filter((name) => resolved[name] === undefined);
    if (unresolved.length) {
      throw new AosError('preset_unresolved_variable', `Unresolved variables: ${unresolved.join(', ')}`, { statusCode: 400, details: { unresolved, missingRequired: missing } });
    }
    const text = composed.body.replace(PLACEHOLDER, (match, name) => resolved[name]);
    return { id: composed.id, version: composed.version, role: composed.role, text, resolved, chain: composed.chain, sections: composed.order };
  }

  preview(id, options) {
    return this.render(id, options);
  }

  validate(input) {
    const problems = [...check(PRESET_INPUT_SCHEMA, input)];
    let sections = input?.sections;
    let modes = input?.sectionModes || {};
    if (!problems.length && input?.body !== undefined && sections === undefined) {
      try {
        const parsed = parseSections(input.body);
        sections = parsed.sections;
        modes = parsed.modes;
      } catch (error) {
        problems.push({ path: '$.body', code: 'sections', message: error.message });
      }
    }
    if (!problems.length && sections) {
      for (const [name, text] of Object.entries(sections)) {
        if (!SECTION_NAME.test(name)) problems.push({ path: `$.sections.${name}`, code: 'name', message: 'section name not allowed' });
        if (String(text).length > PRESET_LIMITS.sectionMaxChars) problems.push({ path: `$.sections.${name}`, code: 'maxLength', message: `section over ${PRESET_LIMITS.sectionMaxChars} characters` });
      }
      if (Object.keys(sections).length > PRESET_LIMITS.sectionMaxCount) problems.push({ path: '$.sections', code: 'maxKeys', message: 'too many sections' });
    }
    return { ok: problems.length === 0, errors: problems, sections, sectionModes: modes };
  }

  #materialize(input, { version, source, provenance, parentVersion = null, forkedFrom = null, base = null }) {
    const validated = this.validate(input);
    if (!validated.ok) throw invalid(`preset failed validation: ${validated.errors[0].path} ${validated.errors[0].message}`, { errors: validated.errors });
    const sections = validated.sections || base?.sections || {};
    const modes = validated.sectionModes || base?.sectionModes || {};
    const order = Object.keys(sections);
    return {
      id: input.id,
      version,
      name: input.name,
      role: input.role,
      builtin: false,
      source,
      abstract: Boolean(input.abstract ?? base?.abstract ?? false),
      extends: input.extends === undefined ? (base?.extends ?? null) : input.extends,
      variables: input.variables ?? base?.variables ?? {},
      sections: { ...sections },
      sectionModes: { ...modes },
      order,
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
      // Prove the composition before storing it, so a broken parent chain never persists.
      const previous = this.engine.state.presets;
      this.engine.state.presets = [...previous, record];
      try {
        if (!record.abstract) this.effective(record.id, record.version);
        else this.get(record.id, record.version);
      } catch (error) {
        this.engine.state.presets = previous;
        throw error;
      }
      this.engine.recordEvent(eventType, { payload: { presetId: record.id, version: record.version, ...payload } });
      return record;
    });
  }

  create(input) {
    if (this.#versions(input?.id || '').length) throw new AosError('preset_exists', `Preset ${input.id} already exists; use edit or fork`, { statusCode: 409, details: { id: input.id } });
    const record = this.#materialize(input, { version: 1, source: 'user', provenance: { via: 'create' } });
    return this.#commit(record, 'preset.created');
  }

  edit(id, patch = {}) {
    const head = this.get(id);
    const versions = this.#versions(id);
    const next = versions.at(-1).version + 1;
    const merged = {
      id,
      name: patch.name ?? head.name,
      role: patch.role ?? head.role,
      extends: patch.extends === undefined ? head.extends : patch.extends,
      abstract: patch.abstract ?? head.abstract,
      variables: patch.variables ?? head.variables,
      note: patch.note ?? null,
      createdBy: patch.createdBy ?? null,
    };
    if (patch.body !== undefined) merged.body = patch.body;
    else if (patch.sections !== undefined) {
      merged.sections = patch.sections;
      merged.sectionModes = patch.sectionModes ?? {};
    } else {
      merged.sections = { ...head.sections };
      merged.sectionModes = { ...(head.sectionModes || {}) };
    }
    const record = this.#materialize(merged, { version: next, source: 'user', provenance: { via: 'edit', from: `${id}@${head.version}` }, parentVersion: head.version, base: head });
    return this.#commit(record, 'preset.edited', { parentVersion: head.version });
  }

  fork({ fromId, fromVersion = null, id, name = null, note = null, createdBy = null }) {
    const origin = this.get(fromId, fromVersion);
    if (this.#versions(id || '').length) throw new AosError('preset_exists', `Preset ${id} already exists`, { statusCode: 409, details: { id } });
    const input = {
      id,
      name: name || `${origin.name} (fork)`,
      role: origin.role,
      extends: origin.extends,
      abstract: origin.abstract,
      variables: origin.variables,
      sections: { ...origin.sections },
      sectionModes: { ...(origin.sectionModes || {}) },
      note,
      createdBy,
    };
    const record = this.#materialize(input, { version: 1, source: 'user', provenance: { via: 'fork', from: `${origin.id}@${origin.version}` }, forkedFrom: { id: origin.id, version: origin.version } });
    return this.#commit(record, 'preset.forked', { forkedFrom: record.forkedFrom });
  }

  archive(id, version = null) {
    return this.engine.transact(() => {
      const target = this.get(id, version);
      if (target.builtin) throw new AosError('preset_builtin', `Built-in preset ${id}@${target.version} cannot be archived; use restoreDefault to drop user versions`, { statusCode: 409, details: { id, version: target.version } });
      const stored = this.stored.find((item) => item.id === id && item.version === target.version);
      stored.archived = true;
      stored.archivedAt = nowIso(this.clock);
      this.engine.recordEvent('preset.archived', { payload: { presetId: id, version: target.version } });
      return stored;
    });
  }

  restoreDefault(id) {
    return this.engine.transact(() => {
      if (!this.builtin.some((item) => item.id === id)) throw new AosError('preset_not_builtin', `Preset ${id} has no built-in default to restore`, { statusCode: 409, details: { id } });
      let archived = 0;
      for (const item of this.stored) {
        if (item.id === id && !item.archived) {
          item.archived = true;
          item.archivedAt = nowIso(this.clock);
          archived += 1;
        }
      }
      this.engine.recordEvent('preset.restored', { payload: { presetId: id, archivedVersions: archived } });
      return this.get(id);
    });
  }

  exportPresets({ ids = null, includeBuiltin = false } = {}) {
    const selected = this.#ids().filter((id) => !ids || ids.includes(id));
    const presets = [];
    for (const id of selected) {
      for (const record of this.#versions(id)) {
        if (record.builtin && !includeBuiltin) continue;
        if (record.archived) continue;
        presets.push({
          id: record.id,
          version: record.version,
          name: record.name,
          role: record.role,
          abstract: record.abstract,
          extends: record.extends,
          variables: record.variables,
          sections: record.sections,
          sectionModes: record.sectionModes || {},
          note: record.note,
          builtin: record.builtin,
        });
      }
    }
    return { format: PRESET_EXPORT_FORMAT, exportedAt: nowIso(this.clock), presets };
  }

  // Imports user presets. Each entry is validated and composed before it is stored;
  // built-in ids receive a new derived version, unknown ids are created.
  importPresets(payload, { createdBy = 'import' } = {}) {
    if (!payload || payload.format !== PRESET_EXPORT_FORMAT || !Array.isArray(payload.presets)) {
      throw invalid(`import payload must have format ${PRESET_EXPORT_FORMAT} and a presets array`);
    }
    const report = { imported: [], skipped: [], errors: [] };
    for (const entry of payload.presets) {
      try {
        if (entry.builtin) {
          report.skipped.push({ id: entry.id, version: entry.version, reason: 'built-in presets are not importable' });
          continue;
        }
        const input = { id: entry.id, name: entry.name, role: entry.role, extends: entry.extends ?? null, abstract: entry.abstract, variables: entry.variables || {}, sections: entry.sections || {}, sectionModes: entry.sectionModes || {}, note: entry.note || null, createdBy };
        const existing = this.#versions(entry.id);
        const record = existing.length
          ? this.#materialize(input, { version: existing.at(-1).version + 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null }, parentVersion: existing.at(-1).version })
          : this.#materialize(input, { version: 1, source: 'import', provenance: { via: 'import', importedVersion: entry.version ?? null } });
        this.#commit(record, 'preset.imported', { importedVersion: entry.version ?? null });
        report.imported.push({ id: record.id, version: record.version });
      } catch (error) {
        report.errors.push({ id: entry?.id ?? null, code: error.code || 'error', message: error.message });
      }
    }
    return report;
  }
}
