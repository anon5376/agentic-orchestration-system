// Shared action layer: every operator surface (HTTP, CLI) calls these functions with one
// params object, so validation and state changes are identical regardless of the door.
import { invalid } from './schema.js';

function need(params, name) {
  if (params?.[name] === undefined || params?.[name] === null || params?.[name] === '') throw invalid(`${name} is required`, { field: name });
  return params[name];
}

function optionalInt(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw invalid(`${name} must be an integer`, { field: name });
  return number;
}

export function apiActions(engine) {
  const presets = engine.presets;
  const templates = engine.templates;
  const blueprints = engine.blueprints;
  const memory = engine.memory;
  const settings = engine.settings;
  return {
    settings: {
      manifest: () => settings.manifest(),
      diagnostics: () => settings.diagnostics(),
      list: (p = {}) => settings.list({ scope: p.scope ?? null, scopeId: p.scopeId ?? null }),
      get: (p) => settings.get(need(p, 'key'), { scope: p.scope, scopeId: p.scopeId ?? null }),
      effective: (p) => settings.effective(need(p, 'key'), { projectId: p.projectId ?? engine.defaultProject()?.id ?? null, blueprintId: p.blueprintId ?? null, presetId: p.presetId ?? null, agentId: p.agentId ?? null, runId: p.runId ?? null }),
      set: (p) => settings.set(need(p, 'key'), need(p, 'value'), { scope: need(p, 'scope'), scopeId: p.scopeId ?? null, actor: p.actor ?? 'operator' }),
      unset: (p) => settings.unset(need(p, 'key'), { scope: need(p, 'scope'), scopeId: p.scopeId ?? null, actor: p.actor ?? 'operator' }),
      validate: (p) => settings.validate(need(p, 'key'), p.value),
      preview: (p) => settings.preview(need(p, 'key'), need(p, 'value'), { scope: need(p, 'scope'), scopeId: p.scopeId ?? null, context: p.context ?? { projectId: engine.defaultProject()?.id ?? null } }),
      export: (p = {}) => settings.exportSettings({ scope: p.scope ?? null }),
      import: (p) => settings.importSettings(need(p, 'payload'), { actor: p.actor ?? 'import' }),
    },
    presets: {
      list: (p = {}) => presets.list({ includeArchived: Boolean(p.includeArchived), role: p.role ?? null }),
      get: (p) => presets.get(need(p, 'id'), optionalInt(p.version, 'version')),
      history: (p) => presets.history(need(p, 'id')),
      effective: (p) => presets.effective(need(p, 'id'), optionalInt(p.version, 'version')),
      preview: (p) => presets.preview(need(p, 'id'), { version: optionalInt(p.version, 'version'), variables: p.variables ?? {} }),
      create: (p) => presets.create(need(p, 'input')),
      edit: (p) => presets.edit(need(p, 'id'), need(p, 'input')),
      fork: (p) => presets.fork({ fromId: need(p, 'id'), fromVersion: optionalInt(p.version, 'version'), id: need(p, 'newId'), name: p.name ?? null, note: p.note ?? null, createdBy: p.actor ?? null }),
      archive: (p) => presets.archive(need(p, 'id'), optionalInt(p.version, 'version')),
      restore: (p) => presets.restoreDefault(need(p, 'id')),
      validate: (p) => presets.validate(need(p, 'input')),
      export: (p = {}) => presets.exportPresets({ ids: p.ids ?? null, includeBuiltin: Boolean(p.includeBuiltin) }),
      import: (p) => presets.importPresets(need(p, 'payload'), { createdBy: p.actor ?? 'import' }),
    },
    templates: {
      list: (p = {}) => templates.list({ includeArchived: Boolean(p.includeArchived) }),
      get: (p) => templates.get(need(p, 'id'), optionalInt(p.version, 'version')),
      history: (p) => templates.history(need(p, 'id')),
      create: (p) => templates.create(need(p, 'input')),
      edit: (p) => templates.edit(need(p, 'id'), need(p, 'input')),
      fork: (p) => templates.fork({ fromId: need(p, 'id'), fromVersion: optionalInt(p.version, 'version'), id: need(p, 'newId'), name: p.name ?? null, note: p.note ?? null, createdBy: p.actor ?? null }),
      archive: (p) => templates.archive(need(p, 'id'), optionalInt(p.version, 'version')),
      restore: (p) => templates.restoreDefault(need(p, 'id')),
      validate: (p) => templates.validate(need(p, 'input')),
      fromTask: (p) => templates.saveFromAgent({ taskId: need(p, 'taskId'), id: need(p, 'newId'), name: p.name ?? null, description: p.description ?? null, note: p.note ?? null, createdBy: p.actor ?? null }),
      export: (p = {}) => templates.exportTemplates({ ids: p.ids ?? null, includeBuiltin: Boolean(p.includeBuiltin) }),
      import: (p) => templates.importTemplates(need(p, 'payload'), { createdBy: p.actor ?? 'import' }),
    },
    blueprints: {
      list: (p = {}) => blueprints.list({ includeArchived: Boolean(p.includeArchived) }),
      get: (p) => blueprints.get(need(p, 'id'), optionalInt(p.version, 'version')),
      history: (p) => blueprints.history(need(p, 'id')),
      effective: (p) => blueprints.effective(need(p, 'id'), optionalInt(p.version, 'version')),
      estimate: (p) => blueprints.estimate(need(p, 'id'), { version: optionalInt(p.version, 'version'), depth: optionalInt(p.depth, 'depth') }),
      create: (p) => blueprints.create(need(p, 'input')),
      edit: (p) => blueprints.edit(need(p, 'id'), need(p, 'input')),
      fork: (p) => blueprints.fork({ fromId: need(p, 'id'), fromVersion: optionalInt(p.version, 'version'), id: need(p, 'newId'), name: p.name ?? null, note: p.note ?? null, createdBy: p.actor ?? null }),
      archive: (p) => blueprints.archive(need(p, 'id'), optionalInt(p.version, 'version')),
      restore: (p) => blueprints.restoreDefault(need(p, 'id')),
      validate: (p) => blueprints.validate(need(p, 'input')),
      export: (p = {}) => blueprints.exportBlueprints({ ids: p.ids ?? null, includeBuiltin: Boolean(p.includeBuiltin) }),
      import: (p) => blueprints.importBlueprints(need(p, 'payload'), { createdBy: p.actor ?? 'import' }),
    },
    memory: {
      stats: () => memory.stats(),
      policy: (p = {}) => ({ scope: p.scope ?? 'global', scopeId: p.scopeId ?? null, effective: memory.policyFor({ project: p.scope === 'project' && p.scopeId ? { id: p.scopeId } : null }), record: (engine.state.settings || []).find((item) => item.key === 'memory' && item.scope === (p.scope ?? 'global') && (item.scopeId ?? null) === (p.scopeId ?? null)) ?? null }),
      setPolicy: (p) => memory.setPolicy(p.scope ?? 'global', p.scopeId ?? null, need(p, 'value'), { actor: p.actor ?? 'operator' }),
      search: (p = {}) => memory.search({ scope: p.scope ?? null, namespace: p.namespace ?? null, query: p.query ?? '', tags: p.tags ?? [], limit: optionalInt(p.limit, 'limit') ?? 20, includeProposed: Boolean(p.includeProposed), includeInactive: Boolean(p.includeInactive) }),
      show: (p) => memory.inspect(need(p, 'id')),
      add: (p) => memory.add(need(p, 'scope'), need(p, 'namespace'), need(p, 'input'), { actor: p.actor ?? 'operator' }),
      correct: (p) => memory.correct(need(p, 'id'), need(p, 'input'), { actor: p.actor ?? 'operator' }),
      commit: (p) => memory.commit(need(p, 'id'), { actor: p.actor ?? 'curator' }),
      pin: (p) => memory.pin(need(p, 'id'), true, { actor: p.actor ?? 'operator' }),
      unpin: (p) => memory.pin(need(p, 'id'), false, { actor: p.actor ?? 'operator' }),
      forget: (p) => memory.forget(need(p, 'id'), p.reason ?? 'forgotten by operator', { actor: p.actor ?? 'operator' }),
      promote: (p) => memory.promote(need(p, 'id'), need(p, 'toScope'), { actor: p.actor ?? 'operator', reason: p.reason ?? null }),
      clear: (p) => memory.clearScope(need(p, 'scope'), need(p, 'namespace'), { confirm: Boolean(p.confirm), actor: p.actor ?? 'operator', reason: p.reason ?? 'clear scope' }),
      retention: () => memory.runRetention(),
      export: (p) => memory.exportScope(need(p, 'scope'), need(p, 'namespace'), { includeInactive: Boolean(p.includeInactive) }),
      import: (p) => memory.importScope(need(p, 'payload'), { actor: p.actor ?? 'import', scope: p.scope ?? null, namespace: p.namespace ?? null }),
    },
    runs: {
      patch: (p) => settings.patchRun(need(p, 'runId'), { key: need(p, 'key'), value: need(p, 'value'), reason: p.reason ?? null, actor: p.actor ?? 'operator' }),
      patches: (p) => settings.runPatches(need(p, 'runId')),
    },
  };
}

// Resource routes shared by HTTP and CLI: [method, path pattern, resource, action, param names, status].
// Literal paths come before parameterised ones so "export" is never read as an id.
export const RESOURCE_ROUTES = Object.freeze([
  ['GET', /^\/api\/v1\/settings\/manifest$/, 'settings', 'manifest', []],
  ['GET', /^\/api\/v1\/settings\/diagnostics$/, 'settings', 'diagnostics', []],
  ['GET', /^\/api\/v1\/settings\/export$/, 'settings', 'export', []],
  ['POST', /^\/api\/v1\/settings\/import$/, 'settings', 'import', []],
  ['POST', /^\/api\/v1\/settings\/validate$/, 'settings', 'validate', []],
  ['POST', /^\/api\/v1\/settings\/preview$/, 'settings', 'preview', []],
  ['GET', /^\/api\/v1\/settings$/, 'settings', 'list', []],
  ['GET', /^\/api\/v1\/settings\/([^/]+)\/effective$/, 'settings', 'effective', ['key']],
  ['GET', /^\/api\/v1\/settings\/([^/]+)$/, 'settings', 'get', ['key']],
  ['PUT', /^\/api\/v1\/settings\/([^/]+)$/, 'settings', 'set', ['key']],
  ['DELETE', /^\/api\/v1\/settings\/([^/]+)$/, 'settings', 'unset', ['key']],
  ...['presets', 'templates', 'blueprints'].flatMap((resource) => [
    ['GET', new RegExp(`^/api/v1/${resource}/export$`), resource, 'export', []],
    ['POST', new RegExp(`^/api/v1/${resource}/import$`), resource, 'import', []],
    ['POST', new RegExp(`^/api/v1/${resource}/validate$`), resource, 'validate', []],
    ...(resource === 'templates' ? [['POST', /^\/api\/v1\/templates\/from-task$/, 'templates', 'fromTask', []]] : []),
    ['GET', new RegExp(`^/api/v1/${resource}$`), resource, 'list', []],
    ['POST', new RegExp(`^/api/v1/${resource}$`), resource, 'create', [], 201],
    ['GET', new RegExp(`^/api/v1/${resource}/([^/]+)/history$`), resource, 'history', ['id']],
    ...(resource !== 'templates' ? [['GET', new RegExp(`^/api/v1/${resource}/([^/]+)/effective$`), resource, 'effective', ['id']]] : []),
    ...(resource === 'presets' ? [['POST', /^\/api\/v1\/presets\/([^/]+)\/preview$/, 'presets', 'preview', ['id']]] : []),
    ...(resource === 'blueprints' ? [['GET', /^\/api\/v1\/blueprints\/([^/]+)\/estimate$/, 'blueprints', 'estimate', ['id']]] : []),
    ['POST', new RegExp(`^/api/v1/${resource}/([^/]+)/versions$`), resource, 'edit', ['id'], 201],
    ['POST', new RegExp(`^/api/v1/${resource}/([^/]+)/fork$`), resource, 'fork', ['id'], 201],
    ['POST', new RegExp(`^/api/v1/${resource}/([^/]+)/archive$`), resource, 'archive', ['id']],
    ['POST', new RegExp(`^/api/v1/${resource}/([^/]+)/restore$`), resource, 'restore', ['id']],
    ['GET', new RegExp(`^/api/v1/${resource}/([^/]+)$`), resource, 'get', ['id']],
  ]),
  ['GET', /^\/api\/v1\/memory\/stats$/, 'memory', 'stats', []],
  ['GET', /^\/api\/v1\/memory\/policy$/, 'memory', 'policy', []],
  ['PUT', /^\/api\/v1\/memory\/policy$/, 'memory', 'setPolicy', []],
  ['GET', /^\/api\/v1\/memory\/search$/, 'memory', 'search', []],
  ['GET', /^\/api\/v1\/memory\/export$/, 'memory', 'export', []],
  ['POST', /^\/api\/v1\/memory\/import$/, 'memory', 'import', []],
  ['POST', /^\/api\/v1\/memory\/retention$/, 'memory', 'retention', []],
  ['POST', /^\/api\/v1\/memory\/clear$/, 'memory', 'clear', []],
  ['POST', /^\/api\/v1\/memory\/items$/, 'memory', 'add', [], 201],
  ['GET', /^\/api\/v1\/memory\/items\/([^/]+)$/, 'memory', 'show', ['id']],
  ...['correct', 'commit', 'pin', 'unpin', 'forget', 'promote'].map((action) => ['POST', new RegExp(`^/api/v1/memory/items/([^/]+)/${action}$`), 'memory', action, ['id']]),
  ['POST', /^\/api\/v1\/runs\/([^/]+)\/patch$/, 'runs', 'patch', ['runId']],
  ['GET', /^\/api\/v1\/runs\/([^/]+)\/patches$/, 'runs', 'patches', ['runId']],
]);

// Resolves an HTTP request against the route table. Returns null when no resource route matches.
export function matchResourceRoute(method, path) {
  for (const [routeMethod, pattern, resource, action, paramNames = [], status = 200] of RESOURCE_ROUTES) {
    if (routeMethod !== method) continue;
    const match = path.match(pattern);
    if (!match) continue;
    const params = {};
    paramNames.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
    return { resource, action, params, status };
  }
  return null;
}
