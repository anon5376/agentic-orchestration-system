import { AosError } from './schema.js';

// Worker delegation is a proposal wire contract. It is intentionally much
// smaller than a plan: the engine supplies parent identity, provider, sandbox,
// capabilities, and every other execution policy when (and if) it materialises
// an approved child.
export const DELEGATION_SCHEMA_VERSION = 1;
export const DELEGATION_LIMITS = Object.freeze({
  maxTasks: 32,
  maxDependencies: 32,
  maxIdLength: 128,
  maxKeyLength: 128,
  maxTitleLength: 200,
  maxKindLength: 80,
  maxBriefLength: 4000,
  maxTemplateIdLength: 128,
  maxBudgetFields: 3,
});

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const BUDGET_KEYS = new Set(['tokens', 'usd', 'timeMs']);
const PROPOSAL_KEYS = new Set(['tasks', 'dependencies']);
const TASK_KEYS = new Set([
  'id', 'key', 'title', 'kind', 'brief',
  'templateId', 'templateVersion', 'budget', 'dependencies',
  'mayDelegate', 'delegation',
]);
const DEPENDENCY_KEYS = new Set(['taskId', 'dependsOnTaskId']);
const CHILD_DELEGATION_KEYS = new Set(['maxChildren', 'maxDepth']);

function fail(code, message, details = null) {
  throw new AosError(code, message, { statusCode: 409, details });
}

function ensureObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('delegation_invalid', `${field} must be an object`, { field });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('delegation_invalid', `${field} must be a plain object`, { field });
  }
}

function ensureKeys(value, allowed, field) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    fail('delegation_unknown_field', `${field} contains unsupported fields`, { field, extraKeys: extra });
  }
}

function text(value, field, { max, identifier = false, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('delegation_invalid', `${field} must be a nonblank string`, { field });
    return null;
  }
  if (typeof value !== 'string') fail('delegation_invalid', `${field} must be a string`, { field });
  const trimmed = value.trim();
  if (!trimmed || (max != null && trimmed.length > max) || /[\u0000\u007f]/.test(trimmed)) {
    fail('delegation_invalid', `${field} must be a nonblank string of at most ${max} characters`, { field, max });
  }
  if (identifier && !IDENTIFIER.test(trimmed)) {
    fail('delegation_invalid', `${field} must be a valid local identifier`, { field });
  }
  return trimmed;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    fail('delegation_invalid', `${field} must be a positive integer`, { field });
  }
  return value;
}

function boundedInteger(value, field, { max = DELEGATION_LIMITS.maxTasks } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail('delegation_authority', `${field} must be an integer from 0 to ${max}`, { field, max });
  }
  return value;
}

function boundedAuthorityInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    fail('delegation_authority', `${field} must be a nonnegative integer`, { field });
  }
  // Existing template authority may be larger than the worker wire cap. The
  // proposal contract remains bounded rather than rejecting that valid parent
  // configuration outright.
  return Math.min(value, DELEGATION_LIMITS.maxTasks);
}

function normalizeBudget(value, field, parentBudget = {}) {
  if (value === undefined || value === null) return null;
  ensureObject(value, field);
  ensureKeys(value, BUDGET_KEYS, field);
  const normalized = {};
  for (const key of BUDGET_KEYS) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
      fail('delegation_budget_invalid', `${field}.${key} must be a finite positive number`, { field: `${field}.${key}` });
    }
    if (typeof parentBudget[key] === 'number' && Number.isFinite(parentBudget[key]) && value[key] > parentBudget[key]) {
      fail('delegation_budget_invalid', `${field}.${key} exceeds the inherited budget`, {
        field: `${field}.${key}`,
        inherited: parentBudget[key],
        received: value[key],
      });
    }
    normalized[key] = value[key];
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeLocalDependencies(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > DELEGATION_LIMITS.maxDependencies) {
    fail('delegation_invalid', `${field} must contain at most ${DELEGATION_LIMITS.maxDependencies} sibling ids`, {
      field,
      maxItems: DELEGATION_LIMITS.maxDependencies,
    });
  }
  const seen = new Set();
  return value.map((item, index) => {
    const dependency = text(item, `${field}[${index}]`, { max: DELEGATION_LIMITS.maxIdLength, identifier: true });
    if (seen.has(dependency)) {
      fail('delegation_reference', `${field} contains duplicate dependency ${dependency}`, { field, dependency });
    }
    seen.add(dependency);
    return dependency;
  });
}

function authoritySource(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return {};
  if (authority.task && typeof authority.task === 'object' && !Array.isArray(authority.task)) return authority.task;
  if (authority.parentTask && typeof authority.parentTask === 'object' && !Array.isArray(authority.parentTask)) return authority.parentTask;
  return authority;
}

function authorityTemplateId(value, field) {
  if (typeof value !== 'string') {
    fail('delegation_authority', `${field} must be a template id string`, { field });
  }
  return text(value, field, { max: DELEGATION_LIMITS.maxTemplateIdLength, identifier: true });
}

function authorityTemplateVersion(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    fail('delegation_authority', `${field} must be a positive integer`, { field });
  }
  return value;
}

function addTemplatePin(pins, templateId, templateVersion, field) {
  const existing = pins.get(templateId);
  if (existing !== undefined && existing !== templateVersion) {
    fail('delegation_authority', `${field} contains conflicting pins for ${templateId}`, {
      field,
      templateId,
      versions: [existing, templateVersion],
    });
  }
  pins.set(templateId, templateVersion);
}

function normalizeVersionedTemplateRef(value, field) {
  ensureObject(value, field);
  ensureKeys(value, new Set(['id', 'templateId', 'version', 'templateVersion']), field);
  const rawId = value.templateId ?? value.id;
  const rawVersion = value.templateVersion ?? value.version;
  if (rawId === undefined || rawVersion === undefined) {
    fail('delegation_authority', `${field} must include a template id and pinned version`, { field });
  }
  return {
    templateId: authorityTemplateId(rawId, `${field}.templateId`),
    templateVersion: authorityTemplateVersion(rawVersion, `${field}.templateVersion`),
  };
}

function normalizeTemplateVersionPins(value, field) {
  const pins = new Map();
  if (value === undefined || value === null) return pins;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const ref = normalizeVersionedTemplateRef(item, `${field}[${index}]`);
      addTemplatePin(pins, ref.templateId, ref.templateVersion, field);
    });
    return pins;
  }
  ensureObject(value, field);
  for (const [rawId, rawVersion] of Object.entries(value)) {
    const templateId = authorityTemplateId(rawId, `${field}.${rawId}`);
    const templateVersion = rawVersion && typeof rawVersion === 'object' && !Array.isArray(rawVersion)
      ? (() => {
          ensureKeys(rawVersion, new Set(['version', 'templateVersion']), `${field}.${rawId}`);
          return authorityTemplateVersion(rawVersion.templateVersion ?? rawVersion.version, `${field}.${rawId}`);
        })()
      : authorityTemplateVersion(rawVersion, `${field}.${rawId}`);
    addTemplatePin(pins, templateId, templateVersion, field);
  }
  return pins;
}

function normalizeTemplateAuthority(source, configured) {
  const rawTemplates = source.childTemplates ?? configured.childTemplates;
  const rawRefs = source.childTemplateRefs ?? configured.childTemplateRefs;
  const rawPins = source.childTemplateVersions ?? configured.childTemplateVersions;
  const childTemplates = rawTemplates === undefined || rawTemplates === null ? null : new Set();
  const childTemplateVersions = new Map();

  const addTemplate = (rawId, rawVersion, field) => {
    const templateId = authorityTemplateId(rawId, `${field}.templateId`);
    childTemplates?.add(templateId);
    if (rawVersion !== undefined && rawVersion !== null) {
      const templateVersion = authorityTemplateVersion(rawVersion, `${field}.templateVersion`);
      addTemplatePin(childTemplateVersions, templateId, templateVersion, field);
    }
  };

  if (Array.isArray(rawTemplates)) {
    rawTemplates.forEach((item, index) => {
      if (typeof item === 'string') addTemplate(item, undefined, `childTemplates[${index}]`);
      else {
        const ref = normalizeVersionedTemplateRef(item, `childTemplates[${index}]`);
        addTemplate(ref.templateId, ref.templateVersion, `childTemplates[${index}]`);
      }
    });
  } else if (rawTemplates !== undefined && rawTemplates !== null) {
    ensureObject(rawTemplates, 'childTemplates');
    for (const [rawId, rawVersion] of Object.entries(rawTemplates)) addTemplate(rawId, rawVersion, `childTemplates.${rawId}`);
  }

  if (rawRefs !== undefined && rawRefs !== null) {
    if (!Array.isArray(rawRefs)) fail('delegation_authority', 'childTemplateRefs must be an array', { field: 'childTemplateRefs' });
    rawRefs.forEach((item, index) => {
      const ref = normalizeVersionedTemplateRef(item, `childTemplateRefs[${index}]`);
      addTemplatePin(childTemplateVersions, ref.templateId, ref.templateVersion, `childTemplateRefs[${index}]`);
    });
  }

  const mappedPins = normalizeTemplateVersionPins(rawPins, 'childTemplateVersions');
  for (const [templateId, templateVersion] of mappedPins) {
    addTemplatePin(childTemplateVersions, templateId, templateVersion, 'childTemplateVersions');
  }

  // A version map or versioned refs are themselves an exact permitted-template
  // list when no separate childTemplates list was supplied.
  const hasExplicitPins = rawPins !== undefined && rawPins !== null;
  const hasExplicitRefs = rawRefs !== undefined && rawRefs !== null;
  const permitted = childTemplates || (hasExplicitPins || hasExplicitRefs ? new Set(childTemplateVersions.keys()) : null);
  return { childTemplates: permitted, childTemplateVersions };
}

function normalizeAuthority(authority = {}) {
  const wrapper = authority && typeof authority === 'object' && !Array.isArray(authority) ? authority : {};
  const source = authoritySource(authority);
  const configured = source.delegation && typeof source.delegation === 'object' && !Array.isArray(source.delegation)
    ? source.delegation
    : wrapper.delegation && typeof wrapper.delegation === 'object' && !Array.isArray(wrapper.delegation)
      ? wrapper.delegation
      : {};
  const mayDelegate = source.mayDelegate === true || configured.mayDelegate === true || wrapper.mayDelegate === true;
  const rawChildren = source.maxChildren ?? configured.maxChildren ?? wrapper.maxChildren;
  const rawDepth = source.maxDepth ?? configured.maxDepth ?? wrapper.maxDepth;
  const maxChildren = rawChildren === null || rawChildren === 'unlimited'
    ? DELEGATION_LIMITS.maxTasks
    : rawChildren === undefined
      ? mayDelegate ? DELEGATION_LIMITS.maxTasks : 0
      : boundedAuthorityInteger(rawChildren, 'inherited delegation.maxChildren');
  const maxDepth = rawDepth === null || rawDepth === 'unlimited'
    ? DELEGATION_LIMITS.maxTasks
    : rawDepth === undefined
      ? mayDelegate ? 1 : 0
      : boundedAuthorityInteger(rawDepth, 'inherited delegation.maxDepth');
  const parentBudget = source.budget && typeof source.budget === 'object' && !Array.isArray(source.budget)
    ? source.budget
    : wrapper.budget && typeof wrapper.budget === 'object' && !Array.isArray(wrapper.budget) ? wrapper.budget : {};
  const templateAuthority = normalizeTemplateAuthority({
    childTemplates: source.childTemplates ?? configured.childTemplates ?? wrapper.childTemplates,
    childTemplateRefs: source.childTemplateRefs ?? configured.childTemplateRefs ?? wrapper.childTemplateRefs,
    childTemplateVersions: source.childTemplateVersions ?? configured.childTemplateVersions ?? wrapper.childTemplateVersions,
  }, {});
  return {
    mayDelegate,
    maxChildren,
    maxDepth,
    parentBudget,
    childTemplates: templateAuthority.childTemplates,
    childTemplateVersions: templateAuthority.childTemplateVersions,
  };
}

function normalizeChildDelegation(value, mayDelegateValue, authority, field) {
  if (value !== undefined && value !== null) {
    ensureObject(value, field);
    ensureKeys(value, CHILD_DELEGATION_KEYS, field);
  }

  const requestedChildren = value?.maxChildren;
  const requestedDepth = value?.maxDepth;
  if (requestedChildren !== undefined) boundedInteger(requestedChildren, `${field}.maxChildren`);
  if (requestedDepth !== undefined) boundedInteger(requestedDepth, `${field}.maxDepth`);

  const explicitlyFalse = mayDelegateValue === false;
  const explicitlyTrue = mayDelegateValue === true;
  const hasPositiveLimit = (requestedChildren ?? 0) > 0 || (requestedDepth ?? 0) > 0;
  const mayDelegate = explicitlyTrue || (!explicitlyFalse && hasPositiveLimit);
  if (!mayDelegate) {
    if (hasPositiveLimit) {
      fail('delegation_authority', `${field} requests child delegation while mayDelegate is false`, { field });
    }
    return { mayDelegate: false, delegation: null };
  }

  if (!authority.mayDelegate || authority.maxDepth < 2 || authority.maxChildren < 1) {
    fail('delegation_authority', `${field} exceeds the inherited delegation authority`, {
      field,
      inherited: { mayDelegate: authority.mayDelegate, maxChildren: authority.maxChildren, maxDepth: authority.maxDepth },
    });
  }
  const maxChildren = authority.maxChildren;
  const maxDepth = authority.maxDepth - 1;
  const childChildren = requestedChildren === undefined ? maxChildren : requestedChildren;
  const childDepth = requestedDepth === undefined ? maxDepth : requestedDepth;
  if (childChildren < 1 || childChildren > maxChildren || childDepth < 1 || childDepth > maxDepth) {
    fail('delegation_authority', `${field} exceeds the inherited delegation authority`, {
      field,
      inherited: { maxChildren, maxDepth },
      received: { maxChildren: childChildren, maxDepth: childDepth },
    });
  }
  return { mayDelegate: true, delegation: { maxChildren: childChildren, maxDepth: childDepth } };
}

function normalizeTask(task, index, authority) {
  const field = `delegation.tasks[${index}]`;
  ensureObject(task, field);
  ensureKeys(task, TASK_KEYS, field);
  const id = text(task.id, `${field}.id`, { max: DELEGATION_LIMITS.maxIdLength, identifier: true });
  const key = text(task.key, `${field}.key`, { max: DELEGATION_LIMITS.maxKeyLength, identifier: true });
  const title = text(task.title, `${field}.title`, { max: DELEGATION_LIMITS.maxTitleLength });
  const kind = text(task.kind, `${field}.kind`, { max: DELEGATION_LIMITS.maxKindLength });
  const brief = text(task.brief, `${field}.brief`, { max: DELEGATION_LIMITS.maxBriefLength });
  const templateId = text(task.templateId, `${field}.templateId`, {
    max: DELEGATION_LIMITS.maxTemplateIdLength,
    identifier: true,
  });
  const templateVersion = positiveInteger(task.templateVersion, `${field}.templateVersion`);
  if (authority.childTemplates && !authority.childTemplates.has(templateId)) {
    fail('delegation_authority', `${field}.templateId is not an approved child template`, { field, templateId });
  }
  const pinnedVersion = authority.childTemplateVersions.get(templateId);
  if (pinnedVersion !== undefined && templateVersion !== pinnedVersion) {
    fail('delegation_authority', `${field}.templateVersion must exactly match the approved template pin`, {
      field,
      templateId,
      expected: pinnedVersion,
      received: templateVersion,
    });
  }

  const dependencies = normalizeLocalDependencies(task.dependencies, `${field}.dependencies`);
  const budget = normalizeBudget(task.budget, `${field}.budget`, authority.parentBudget);
  const childDelegation = normalizeChildDelegation(task.delegation, task.mayDelegate, authority, `${field}.delegation`);
  return {
    id,
    key,
    title,
    kind,
    brief,
    templateId,
    templateVersion,
    budget,
    dependencies,
    mayDelegate: childDelegation.mayDelegate,
    delegation: childDelegation.delegation,
  };
}

function normalizeDependency(value, index) {
  const field = `delegation.dependencies[${index}]`;
  ensureObject(value, field);
  ensureKeys(value, DEPENDENCY_KEYS, field);
  return {
    taskId: text(value.taskId, `${field}.taskId`, { max: DELEGATION_LIMITS.maxIdLength, identifier: true }),
    dependsOnTaskId: text(value.dependsOnTaskId, `${field}.dependsOnTaskId`, { max: DELEGATION_LIMITS.maxIdLength, identifier: true }),
  };
}

function validateGraph(tasks, dependencies) {
  const ids = new Set(tasks.map((task) => task.id));
  const keys = new Set();
  for (const task of tasks) {
    if (keys.has(task.key)) fail('delegation_duplicate_key', `Duplicate delegation task key ${task.key}`, { key: task.key });
    keys.add(task.key);
  }

  const edges = [];
  const seenEdges = new Set();
  const addEdge = (taskId, dependsOnTaskId) => {
    if (!ids.has(taskId) || !ids.has(dependsOnTaskId)) {
      fail('delegation_reference', `Delegation dependency ${taskId} -> ${dependsOnTaskId} references a non-sibling`, { taskId, dependsOnTaskId });
    }
    if (taskId === dependsOnTaskId) {
      fail('delegation_reference', `Delegation task ${taskId} depends on itself`, { taskId });
    }
    const edgeKey = `${taskId}\u0000${dependsOnTaskId}`;
    if (seenEdges.has(edgeKey)) {
      fail('delegation_reference', `Duplicate delegation dependency ${taskId} -> ${dependsOnTaskId}`, { taskId, dependsOnTaskId });
    }
    seenEdges.add(edgeKey);
    edges.push({ taskId, dependsOnTaskId });
  };

  for (const task of tasks) {
    for (const dependsOnTaskId of task.dependencies) addEdge(task.id, dependsOnTaskId);
  }
  for (const dependency of dependencies) addEdge(dependency.taskId, dependency.dependsOnTaskId);
  if (edges.length > DELEGATION_LIMITS.maxDependencies) {
    fail('delegation_size', `Delegation dependencies contain at most ${DELEGATION_LIMITS.maxDependencies} total sibling edges`, {
      field: 'delegation.dependencies',
      maxDependencies: DELEGATION_LIMITS.maxDependencies,
      totalDependencies: edges.length,
    });
  }

  const outgoing = new Map([...ids].map((id) => [id, []]));
  const incoming = new Map([...ids].map((id) => [id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.dependsOnTaskId).push(edge.taskId);
    incoming.set(edge.taskId, incoming.get(edge.taskId) + 1);
  }
  const queue = [...ids].filter((id) => incoming.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== ids.size) fail('delegation_cycle', 'Delegation dependencies contain a cycle');

  const byTask = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) task.dependencies = [];
  for (const edge of edges) byTask.get(edge.taskId).dependencies.push(edge.dependsOnTaskId);
  return edges;
}

// Normalize an optional worker proposal. Missing or null delegation is a valid
// no-op, including for non-delegating tasks. A caller with no parent record gets
// only the bounded wire default; adapters and engines should pass the actual
// parent task so inherited authority is enforced as well.
export function normalizeDelegationProposal(proposal, authority = undefined) {
  if (proposal === undefined || proposal === null) return null;
  ensureObject(proposal, 'delegation');
  ensureKeys(proposal, PROPOSAL_KEYS, 'delegation');
  const normalizedAuthority = normalizeAuthority(authority === undefined
    ? { mayDelegate: true, delegation: { maxChildren: DELEGATION_LIMITS.maxTasks, maxDepth: 1 } }
    : authority);
  if (!normalizedAuthority.mayDelegate) {
    fail('delegation_authority', 'Worker is not authorized to propose child work');
  }
  if (!Array.isArray(proposal.tasks) || proposal.tasks.length < 1 || proposal.tasks.length > DELEGATION_LIMITS.maxTasks) {
    fail('delegation_size', `delegation.tasks must contain 1 to ${DELEGATION_LIMITS.maxTasks} tasks`, {
      field: 'delegation.tasks',
      maxTasks: DELEGATION_LIMITS.maxTasks,
    });
  }
  if (proposal.tasks.length > normalizedAuthority.maxChildren) {
    fail('delegation_authority', `delegation.tasks exceeds the inherited child limit of ${normalizedAuthority.maxChildren}`, {
      field: 'delegation.tasks',
      maxChildren: normalizedAuthority.maxChildren,
    });
  }
  if (normalizedAuthority.maxDepth < 1) {
    fail('delegation_authority', 'Worker has no remaining delegation depth');
  }
  const tasks = proposal.tasks.map((task, index) => normalizeTask(task, index, normalizedAuthority));
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) fail('delegation_duplicate_id', `Duplicate delegation task id ${task.id}`, { id: task.id });
    ids.add(task.id);
  }

  let dependencies = [];
  if (proposal.dependencies !== undefined && proposal.dependencies !== null) {
    if (!Array.isArray(proposal.dependencies) || proposal.dependencies.length > DELEGATION_LIMITS.maxDependencies) {
      fail('delegation_size', `delegation.dependencies must contain at most ${DELEGATION_LIMITS.maxDependencies} items`, {
        field: 'delegation.dependencies',
        maxDependencies: DELEGATION_LIMITS.maxDependencies,
      });
    }
    dependencies = proposal.dependencies.map(normalizeDependency);
  }
  dependencies = validateGraph(tasks, dependencies);
  return { tasks, dependencies };
}

// These aliases keep the contract discoverable to callers that use “validate”
// or “worker delegation” terminology; they retain the same fail-closed return.
export const validateDelegationProposal = normalizeDelegationProposal;
export const normalizeWorkerDelegation = normalizeDelegationProposal;
export const normalizeDelegation = normalizeDelegationProposal;

const IDENTIFIER_SCHEMA = { type: 'string', minLength: 1, maxLength: DELEGATION_LIMITS.maxIdLength, pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,127}$' };
const BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tokens', 'usd', 'timeMs'],
  properties: {
    tokens: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    usd: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
    timeMs: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
  },
};
const CHILD_DELEGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['maxChildren', 'maxDepth'],
  properties: {
    maxChildren: { type: 'integer', minimum: 0, maximum: DELEGATION_LIMITS.maxTasks },
    maxDepth: { type: 'integer', minimum: 0, maximum: DELEGATION_LIMITS.maxTasks },
  },
};
const DEPENDENCY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'dependsOnTaskId'],
  properties: {
    taskId: IDENTIFIER_SCHEMA,
    dependsOnTaskId: IDENTIFIER_SCHEMA,
  },
};
const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'key', 'title', 'kind', 'brief', 'templateId', 'templateVersion', 'budget', 'dependencies', 'mayDelegate', 'delegation'],
  properties: {
    id: IDENTIFIER_SCHEMA,
    key: { ...IDENTIFIER_SCHEMA, maxLength: DELEGATION_LIMITS.maxKeyLength },
    title: { type: 'string', minLength: 1, maxLength: DELEGATION_LIMITS.maxTitleLength },
    kind: { type: 'string', minLength: 1, maxLength: DELEGATION_LIMITS.maxKindLength },
    brief: { type: 'string', minLength: 1, maxLength: DELEGATION_LIMITS.maxBriefLength },
    templateId: { type: 'string', minLength: 1, maxLength: DELEGATION_LIMITS.maxTemplateIdLength, pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,127}$' },
    templateVersion: { type: 'integer', minimum: 1 },
    budget: { anyOf: [BUDGET_SCHEMA, { type: 'null' }] },
    dependencies: { anyOf: [{ type: 'array', maxItems: DELEGATION_LIMITS.maxDependencies, items: IDENTIFIER_SCHEMA }, { type: 'null' }] },
    mayDelegate: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    delegation: { anyOf: [CHILD_DELEGATION_SCHEMA, { type: 'null' }] },
  },
};

// All properties are required at every object level for provider strict JSON
// output. Optional semantics are represented with nullable values; the runtime
// normalizer also accepts legacy omissions for compatibility.
export const DELEGATION_PROPOSAL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'dependencies'],
  properties: {
    tasks: { type: 'array', minItems: 1, maxItems: DELEGATION_LIMITS.maxTasks, items: TASK_SCHEMA },
    dependencies: { anyOf: [{ type: 'array', maxItems: DELEGATION_LIMITS.maxDependencies, items: DEPENDENCY_SCHEMA }, { type: 'null' }] },
  },
});

export const DELEGATION_SCHEMA = DELEGATION_PROPOSAL_SCHEMA;
export const DELEGATION_OUTPUT_SCHEMA = DELEGATION_PROPOSAL_SCHEMA;
