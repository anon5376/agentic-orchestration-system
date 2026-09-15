// Memory policy: off by default at every level. The global switch gates everything; the
// project, swarm (blueprint), run and task (template) layers can only narrow what the
// layer above allows. "Disabled" means no retrieval and no writes.
export const MEMORY_SCOPES = Object.freeze(['agent', 'role', 'run', 'swarm', 'project', 'global']);
export const MEMORY_TYPES = Object.freeze(['fact', 'decision', 'procedure', 'preference', 'failure_lesson', 'evidence_reference', 'summary', 'unresolved_question']);
export const SENSITIVITY_LEVELS = Object.freeze(['normal', 'sensitive']);
export const PROMOTION_MODES = Object.freeze(['auto', 'curator', 'approval', 'never']);

export const DEFAULT_MEMORY_POLICY = Object.freeze({
  enabled: false,
  read: true,
  write: true,
  reflect: true,
  scopes: ['agent', 'run', 'role', 'project'],
  autoCommitScopes: ['agent', 'run'],
  retentionDays: { agent: 1, run: 30, role: 90, swarm: 90, project: 365, global: null },
  maxItemsPerScope: { agent: 200, run: 500, role: 500, swarm: 500, project: 5000, global: 5000 },
  maxItemsPerQuery: 8,
  maxCharsPerQuery: 6000,
  maxContentChars: 4000,
  promotion: {
    agent_to_run: 'auto',
    run_to_role: 'curator',
    run_to_swarm: 'curator',
    run_to_project: 'curator',
    role_to_project: 'curator',
    swarm_to_project: 'curator',
    project_to_global: 'approval',
    role_to_global: 'approval',
    swarm_to_global: 'approval',
  },
});

function mergeLayer(base, layer) {
  if (!layer || typeof layer !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) out[key] = { ...base[key], ...value };
    else out[key] = value;
  }
  return out;
}

// Layers, outermost first: global setting, project setting, swarm setting, role setting,
// run policy (from the blueprint), task memory (from the template). Each layer may disable, narrow
// the scope list, or turn read/write off; none can re-enable what an outer layer disabled.
export function resolveMemoryPolicy({ globalSetting = null, projectSetting = null, swarmSetting = null, roleSetting = null, runPolicy = null, taskMemory = null } = {}) {
  let policy = { ...DEFAULT_MEMORY_POLICY, scopes: [...DEFAULT_MEMORY_POLICY.scopes], autoCommitScopes: [...DEFAULT_MEMORY_POLICY.autoCommitScopes] };
  const layers = [globalSetting, projectSetting, swarmSetting, roleSetting];
  let enabled = Boolean(globalSetting?.enabled);
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.enabled === false) enabled = false;
    policy = mergeLayer(policy, { ...layer, enabled: undefined });
  }
  if (runPolicy) {
    if (runPolicy.enabled === false) enabled = false;
    if (Array.isArray(runPolicy.scopes)) policy.scopes = policy.scopes.filter((scope) => runPolicy.scopes.includes(scope));
    if (runPolicy.readByDefault === false) policy.read = false;
    if (runPolicy.writeByDefault === false) policy.write = false;
  }
  if (taskMemory) {
    if (taskMemory.read === false) policy.read = false;
    if (taskMemory.write === false) policy.write = false;
    if (Array.isArray(taskMemory.scopes)) policy.scopes = policy.scopes.filter((scope) => taskMemory.scopes.includes(scope));
    if (taskMemory.retentionDays != null) policy.taskRetentionDays = taskMemory.retentionDays;
  }
  policy.enabled = enabled;
  policy.scopes = policy.scopes.filter((scope) => MEMORY_SCOPES.includes(scope));
  policy.autoCommitScopes = policy.autoCommitScopes.filter((scope) => policy.scopes.includes(scope));
  return policy;
}
