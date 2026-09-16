import { validatePlan } from './intake.js';
import { AosError } from './schema.js';

export const LEAD_PLANNING_SCHEMA_VERSION = 1;

// Lead planning is deliberately smaller than the general worker plan surface. These
// are wire bounds; the engine still applies project policy before accepting a plan.
export const LEAD_PLANNING_LIMITS = Object.freeze({
  maxTasks: 24,
  maxDependencies: 48,
  maxHierarchyDepth: 4,
  maxQuestions: 3,
  maxPromptChars: 1500,
  maxPromptLength: 500,
  maxReasonLength: 300,
  maxTitleLength: 200,
  maxSummaryLength: 1000,
  maxBriefLength: 4000,
  maxRationaleLength: 2000,
  maxAcceptanceItems: 12,
  maxAcceptanceLength: 500,
});

const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const PLAN_KEYS = new Set(['title', 'ambiguities', 'branches', 'tasks', 'dependencies']);
const TASK_KEYS = new Set([
  'id', 'key', 'parentId', 'parentKey', 'title', 'kind', 'role', 'roleId', 'summary', 'brief', 'branch',
  'worker', 'harness', 'model', 'effort', 'sandbox', 'sandboxTier', 'budget',
  'dependencyPolicy', 'requiresApproval', 'optional', 'maxRetries', 'timeoutMs',
  'templateId', 'templateVersion', 'presetId', 'presetVersion', 'acceptance',
]);
const DEPENDENCY_KEYS = new Set(['id', 'taskId', 'dependsOnTaskId', 'policy']);
const QUESTION_KEYS = new Set(['prompt', 'reason', 'required']);
const OUTPUT_KEYS = new Set(['task_nonce', 'status', 'questions', 'plan', 'rationale', 'summary']);
const BUDGET_KEYS = new Set(['tokens', 'usd', 'timeMs']);

function fail(message, details = null, code = 'lead_plan_invalid', statusCode = 409) {
  throw new AosError(code, message, { statusCode, details });
}

function ensureObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, { field });
}

function ensureKeys(value, allowed, field) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) fail(`${field} contains unsupported fields`, { field, extraKeys: extra });
}

function text(value, field, { min = 0, max = null, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`, { field });
    return value;
  }
  if (typeof value !== 'string') fail(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${field} must be nonblank`, { field });
  if (trimmed.length < min || (max != null && trimmed.length > max)) {
    fail(`${field} must contain ${min} to ${max ?? 'unbounded'} characters`, { field, min, max });
  }
  return trimmed;
}

function boolean(value, field, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') fail(`${field} must be boolean`, { field });
  return value;
}

function nonnegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) fail(`${field} must be a nonnegative integer`, { field });
  return value;
}

function normalizeQuestion(question, index) {
  ensureObject(question, `questions[${index}]`);
  ensureKeys(question, QUESTION_KEYS, `questions[${index}]`);
  const prompt = text(question.prompt, `questions[${index}].prompt`, { min: 1, max: LEAD_PLANNING_LIMITS.maxPromptLength, required: true });
  const reason = question.reason === undefined
    ? undefined
    : text(question.reason, `questions[${index}].reason`, { max: LEAD_PLANNING_LIMITS.maxReasonLength });
  return {
    prompt,
    ...(reason ? { reason } : {}),
    required: boolean(question.required, `questions[${index}].required`, true),
  };
}

export function validateLeadQuestions(questions) {
  if (!Array.isArray(questions) || questions.length > LEAD_PLANNING_LIMITS.maxQuestions) {
    fail(`Lead planner questions must contain at most ${LEAD_PLANNING_LIMITS.maxQuestions} items`, { field: 'questions', maxItems: LEAD_PLANNING_LIMITS.maxQuestions });
  }
  let total = 0;
  const normalized = questions.map((question, index) => {
    const item = normalizeQuestion(question, index);
    total += item.prompt.length;
    return item;
  });
  if (total > LEAD_PLANNING_LIMITS.maxPromptChars) {
    fail(`Lead planner question prompts must total at most ${LEAD_PLANNING_LIMITS.maxPromptChars} characters`, {
      field: 'questions', totalPromptChars: total, maxPromptChars: LEAD_PLANNING_LIMITS.maxPromptChars,
    });
  }
  return normalized;
}

function normalizeBudget(budget, field) {
  ensureObject(budget, field);
  ensureKeys(budget, BUDGET_KEYS, field);
  const normalized = {};
  for (const key of BUDGET_KEYS) {
    if (budget[key] === undefined) continue;
    if (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] < 0) {
      fail(`${field}.${key} must be a finite nonnegative number`, { field: `${field}.${key}` }, 'lead_plan_budget_invalid');
    }
    normalized[key] = budget[key];
  }
  return normalized;
}

function normalizeTask(task, index) {
  ensureObject(task, `plan.tasks[${index}]`);
  ensureKeys(task, TASK_KEYS, `plan.tasks[${index}]`);
  const id = text(task.id ?? task.key, `plan.tasks[${index}].id`, { min: 1, max: 128, required: true });
  if (!ID.test(id)) fail(`plan.tasks[${index}].id is not a valid identifier`, { field: `plan.tasks[${index}].id` });
  const key = text(task.key ?? id, `plan.tasks[${index}].key`, { min: 1, max: 128, required: true });
  if (!ID.test(key)) fail(`plan.tasks[${index}].key is not a valid identifier`, { field: `plan.tasks[${index}].key` });
  const title = text(task.title, `plan.tasks[${index}].title`, { min: 1, max: LEAD_PLANNING_LIMITS.maxTitleLength, required: true });
  const kind = text(task.kind ?? task.role, `plan.tasks[${index}].kind`, { min: 1, max: 80, required: true });
  const worker = task.worker ?? task.harness ?? 'codex';
  if (typeof worker !== 'string' || !worker.trim()) fail(`plan.tasks[${index}].worker must be a nonblank string`, { field: `plan.tasks[${index}].worker` });
  if (task.worker !== undefined && task.harness !== undefined && task.worker !== task.harness) {
    fail(`plan.tasks[${index}] worker and harness disagree`, { field: `plan.tasks[${index}]` });
  }
  const parent = task.parentId ?? task.parentKey ?? null;
  if (parent !== null && (typeof parent !== 'string' || !ID.test(parent))) fail(`plan.tasks[${index}].parentId is invalid`, { field: `plan.tasks[${index}].parentId` });
  if (task.parentId !== undefined && task.parentKey !== undefined && task.parentId !== task.parentKey) {
    fail(`plan.tasks[${index}] parentId and parentKey disagree`, { field: `plan.tasks[${index}]` });
  }
  const sandbox = task.sandbox ?? task.sandboxTier ?? 'read-only';
  if (typeof sandbox !== 'string' || !sandbox.trim()) fail(`plan.tasks[${index}].sandbox must be a nonblank string`, { field: `plan.tasks[${index}].sandbox` });
  if (task.sandbox !== undefined && task.sandboxTier !== undefined && task.sandbox !== task.sandboxTier) {
    fail(`plan.tasks[${index}] sandbox and sandboxTier disagree`, { field: `plan.tasks[${index}]` });
  }

  const normalized = {
    id,
    key,
    parentId: parent,
    title,
    kind,
    summary: text(task.summary ?? '', `plan.tasks[${index}].summary`, { max: LEAD_PLANNING_LIMITS.maxSummaryLength }),
    branch: text(task.branch ?? 'root', `plan.tasks[${index}].branch`, { min: 1, max: 80, required: true }),
    worker: worker.trim(),
    harness: worker.trim(),
    sandbox: sandbox.trim(),
    sandboxTier: sandbox.trim(),
    requiresApproval: boolean(task.requiresApproval, `plan.tasks[${index}].requiresApproval`),
    dependencyPolicy: task.dependencyPolicy ?? 'all_succeeded',
    optional: boolean(task.optional, `plan.tasks[${index}].optional`),
  };
  if (!['all_succeeded', 'all_terminal'].includes(normalized.dependencyPolicy)) {
    fail(`plan.tasks[${index}].dependencyPolicy is unsupported`, { field: `plan.tasks[${index}].dependencyPolicy` });
  }
  if (task.brief !== undefined) normalized.brief = text(task.brief, `plan.tasks[${index}].brief`, { min: 1, max: LEAD_PLANNING_LIMITS.maxBriefLength, required: true });
  for (const field of ['role', 'roleId', 'model', 'effort', 'templateId', 'presetId']) {
    if (task[field] !== undefined) normalized[field] = text(task[field], `plan.tasks[${index}].${field}`, { min: 1, max: 200, required: true });
  }
  for (const field of ['templateVersion', 'presetVersion', 'timeoutMs', 'maxRetries']) {
    if (task[field] !== undefined) normalized[field] = nonnegativeInteger(task[field], `plan.tasks[${index}].${field}`);
  }
  if (task.acceptance !== undefined) {
    if (!Array.isArray(task.acceptance) || task.acceptance.length > LEAD_PLANNING_LIMITS.maxAcceptanceItems || task.acceptance.some((item) => typeof item !== 'string')) {
      fail(`plan.tasks[${index}].acceptance must be a bounded array of strings`, { field: `plan.tasks[${index}].acceptance` });
    }
    normalized.acceptance = task.acceptance.map((item, itemIndex) => text(item, `plan.tasks[${index}].acceptance[${itemIndex}]`, { min: 1, max: LEAD_PLANNING_LIMITS.maxAcceptanceLength, required: true }));
  }
  if (task.budget !== undefined) normalized.budget = normalizeBudget(task.budget, `plan.tasks[${index}].budget`);
  return normalized;
}

function normalizeDependency(dependency, index) {
  ensureObject(dependency, `plan.dependencies[${index}]`);
  ensureKeys(dependency, DEPENDENCY_KEYS, `plan.dependencies[${index}]`);
  const taskId = text(dependency.taskId, `plan.dependencies[${index}].taskId`, { min: 1, max: 128, required: true });
  const dependsOnTaskId = text(dependency.dependsOnTaskId, `plan.dependencies[${index}].dependsOnTaskId`, { min: 1, max: 128, required: true });
  if (dependency.policy !== undefined && !['all_succeeded', 'all_terminal'].includes(dependency.policy)) {
    fail(`plan.dependencies[${index}].policy is unsupported`, { field: `plan.dependencies[${index}].policy` });
  }
  return {
    ...(dependency.id !== undefined ? { id: text(dependency.id, `plan.dependencies[${index}].id`, { min: 1, max: 128, required: true }) } : {}),
    taskId,
    dependsOnTaskId,
    ...(dependency.policy !== undefined ? { policy: dependency.policy } : {}),
  };
}

function boundedMetadata(value, field, maxItems = LEAD_PLANNING_LIMITS.maxTasks) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) fail(`${field} must be a bounded array`, { field, maxItems });
  return structuredClone(value);
}

function validateHierarchy(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map();
  const visiting = new Set();
  const depthOf = (task) => {
    if (depths.has(task.id)) return depths.get(task.id);
    if (visiting.has(task.id)) fail(`Plan hierarchy contains a cycle at ${task.id}`, { taskId: task.id }, 'lead_plan_depth');
    visiting.add(task.id);
    let depth = 1;
    if (task.parentId) {
      const parent = byId.get(task.parentId);
      if (!parent) fail(`Plan task ${task.id} has unknown parent ${task.parentId}`, { taskId: task.id, parentId: task.parentId });
      depth = depthOf(parent) + 1;
    }
    visiting.delete(task.id);
    depths.set(task.id, depth);
    if (depth > LEAD_PLANNING_LIMITS.maxHierarchyDepth) {
      fail(`Plan task ${task.id} exceeds hierarchy depth ${LEAD_PLANNING_LIMITS.maxHierarchyDepth}`, { taskId: task.id, depth, maxDepth: LEAD_PLANNING_LIMITS.maxHierarchyDepth }, 'lead_plan_depth');
    }
    return depth;
  };
  for (const task of tasks) depthOf(task);
}

export function normalizeLeadPlan(plan) {
  ensureObject(plan, 'plan');
  ensureKeys(plan, PLAN_KEYS, 'plan');
  if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > LEAD_PLANNING_LIMITS.maxTasks) {
    fail(`plan.tasks must contain 1 to ${LEAD_PLANNING_LIMITS.maxTasks} tasks`, { field: 'plan.tasks', maxTasks: LEAD_PLANNING_LIMITS.maxTasks });
  }
  if (!Array.isArray(plan.dependencies) || plan.dependencies.length > LEAD_PLANNING_LIMITS.maxDependencies) {
    fail(`plan.dependencies must contain at most ${LEAD_PLANNING_LIMITS.maxDependencies} items`, { field: 'plan.dependencies', maxDependencies: LEAD_PLANNING_LIMITS.maxDependencies });
  }
  const tasks = plan.tasks.map(normalizeTask);
  const byKey = new Map(tasks.map((task) => [task.key, task.id]));
  const byId = new Map(tasks.map((task) => [task.id, task.id]));
  for (const task of tasks) {
    if (task.parentId && !byId.has(task.parentId)) task.parentId = byKey.get(task.parentId) || task.parentId;
  }
  const dependencies = plan.dependencies.map(normalizeDependency);
  const resolvedDependencies = dependencies.map((dependency) => ({
    ...dependency,
    taskId: byKey.get(dependency.taskId) || dependency.taskId,
    dependsOnTaskId: byKey.get(dependency.dependsOnTaskId) || dependency.dependsOnTaskId,
  }));
  for (const dependency of resolvedDependencies) {
    if (!dependency.policy) continue;
    const target = tasks.find((task) => task.id === dependency.taskId);
    if (target && target.dependencyPolicy !== 'all_succeeded' && target.dependencyPolicy !== dependency.policy) {
      fail(`plan task ${dependency.taskId} has conflicting dependency policies`, { taskId: dependency.taskId });
    }
    if (target) target.dependencyPolicy = dependency.policy;
  }
  validateHierarchy(tasks);
  const title = text(plan.title ?? tasks[0].title, 'plan.title', { min: 1, max: LEAD_PLANNING_LIMITS.maxTitleLength, required: true });
  let validated;
  try {
    validated = validatePlan({
      title,
      ambiguities: boundedMetadata(plan.ambiguities, 'plan.ambiguities'),
      branches: boundedMetadata(plan.branches, 'plan.branches'),
      tasks,
      dependencies: resolvedDependencies,
    });
  } catch (error) {
    fail(error.message, { reason: error.message });
  }
  // validatePlan intentionally projects to the engine task shape. Restore the
  // planner-facing assignment and bounded fields after graph validation.
  const sourceById = new Map(tasks.map((task) => [task.id, task]));
  validated.tasks = validated.tasks.map((task) => {
    const source = sourceById.get(task.id) || {};
    return {
      ...task,
      harness: source.harness || task.worker,
      sandbox: source.sandbox || 'read-only',
      sandboxTier: source.sandboxTier || source.sandbox || 'read-only',
      ...(source.role ? { role: source.role } : {}),
      ...(source.roleId ? { roleId: source.roleId } : {}),
      ...(source.model ? { model: source.model } : {}),
      ...(source.effort ? { effort: source.effort } : {}),
      ...(source.brief !== undefined ? { brief: source.brief } : {}),
      ...(source.budget ? { budget: structuredClone(source.budget) } : {}),
      ...(source.acceptance ? { acceptance: [...source.acceptance] } : {}),
      ...(source.templateId ? { templateId: source.templateId } : {}),
      ...(source.templateVersion !== undefined ? { templateVersion: source.templateVersion } : {}),
      ...(source.presetId ? { presetId: source.presetId } : {}),
      ...(source.presetVersion !== undefined ? { presetVersion: source.presetVersion } : {}),
      ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
      ...(source.maxRetries !== undefined ? { maxRetries: source.maxRetries } : {}),
    };
  });
  validated.dependencies = validated.dependencies.map((dependency, index) => ({
    ...dependency,
    ...(resolvedDependencies[index]?.policy ? { policy: resolvedDependencies[index].policy } : {}),
  }));
  return validated;
}

export function normalizeLeadPlanOutput(output, { expectedNonce = null } = {}) {
  ensureObject(output, 'lead planner output');
  ensureKeys(output, OUTPUT_KEYS, 'lead planner output');
  const nonce = output.task_nonce;
  if (typeof nonce !== 'string' || !nonce.trim()) fail('lead planner task_nonce must be a nonblank string', { field: 'task_nonce' });
  if (expectedNonce && nonce !== expectedNonce) fail('Lead planner output carried another task nonce', { field: 'task_nonce' });
  const status = output.status;
  if (!['succeeded', 'needs_clarification', 'awaiting_user'].includes(status)) {
    fail(`Lead planner status must be succeeded, needs_clarification, or awaiting_user; got ${String(status)}`, { field: 'status' });
  }
  const questions = validateLeadQuestions(output.questions);
  if (status === 'succeeded' && questions.length) fail('Lead planner succeeded with questions', { field: 'questions' });
  if (status !== 'succeeded' && !questions.length) fail(`Lead planner ${status} output needs at least one question`, { field: 'questions' });
  if (status !== 'succeeded' && (!Object.prototype.hasOwnProperty.call(output, 'plan') || output.plan !== null)) {
    fail(`Lead planner ${status} output must set plan to null`, { field: 'plan', expected: null });
  }
  const rationale = text(output.rationale, 'rationale', { max: LEAD_PLANNING_LIMITS.maxRationaleLength });
  const summary = text(output.summary, 'summary', { max: LEAD_PLANNING_LIMITS.maxSummaryLength });
  const plan = output.plan == null ? null : normalizeLeadPlan(output.plan);
  if (status === 'succeeded' && !plan) fail('Lead planner succeeded without a plan', { field: 'plan' });
  return { task_nonce: nonce, status, questions, plan, rationale: rationale || '', summary: summary || '' };
}

// Keep this wire contract deliberately smaller than the engine's internal plan
// shape. The Codex structured-output validator is strict: every object must
// reject unknown keys and every declared property must be required. Runtime
// normalization remains the second line of validation for graph and policy
// invariants which JSON Schema cannot express here.
const leadPlanTaskWireSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'kind', 'brief', 'parentId', 'worker', 'model', 'effort', 'sandbox', 'requiresApproval'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    title: { type: 'string', minLength: 1, maxLength: LEAD_PLANNING_LIMITS.maxTitleLength },
    kind: { type: 'string', minLength: 1, maxLength: 80 },
    brief: { type: 'string', minLength: 1, maxLength: LEAD_PLANNING_LIMITS.maxBriefLength },
    parentId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'null' }] },
    worker: { type: 'string', enum: ['codex', 'engine'] },
    model: { type: 'string', minLength: 1, maxLength: 80 },
    effort: { type: 'string', minLength: 1, maxLength: 40 },
    sandbox: { type: 'string', minLength: 1, maxLength: 40 },
    requiresApproval: { type: 'boolean' },
  },
};

const leadPlanDependencyWireSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'dependsOnTaskId', 'policy'],
  properties: {
    taskId: { type: 'string', minLength: 1, maxLength: 128 },
    dependsOnTaskId: { type: 'string', minLength: 1, maxLength: 128 },
    policy: { type: 'string', enum: ['all_succeeded', 'all_terminal'] },
  },
};

const leadPlanWireSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'tasks', 'dependencies'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: LEAD_PLANNING_LIMITS.maxTitleLength },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: LEAD_PLANNING_LIMITS.maxTasks,
      items: leadPlanTaskWireSchema,
    },
    dependencies: {
      type: 'array',
      maxItems: LEAD_PLANNING_LIMITS.maxDependencies,
      items: leadPlanDependencyWireSchema,
    },
  },
};

export const LEAD_PLANNING_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['task_nonce', 'status', 'questions', 'plan', 'rationale', 'summary'],
  properties: {
    task_nonce: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['succeeded', 'needs_clarification', 'awaiting_user'] },
    questions: {
      type: 'array',
      maxItems: LEAD_PLANNING_LIMITS.maxQuestions,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'reason', 'required'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: LEAD_PLANNING_LIMITS.maxPromptLength },
          reason: { anyOf: [{ type: 'string', maxLength: LEAD_PLANNING_LIMITS.maxReasonLength }, { type: 'null' }] },
          required: { type: 'boolean' },
        },
      },
    },
    plan: { anyOf: [leadPlanWireSchema, { type: 'null' }] },
    rationale: { type: 'string', maxLength: LEAD_PLANNING_LIMITS.maxRationaleLength },
    summary: { type: 'string', maxLength: LEAD_PLANNING_LIMITS.maxSummaryLength },
  },
});

export function buildLeadPlanningPrompt(task, ctx = {}) {
  const goal = ctx.goal || {};
  const policy = ctx.policy || {};
  const answers = (ctx.answers || []).filter((question) => typeof question.answer === 'string' && question.answer.trim());
  const lines = [
    '# AOS lead planning assignment',
    '',
    'You are the lead planner. Propose a bounded plan for operator review; do not dispatch work, modify files, or apply your proposal.',
    '',
    `AOS task nonce: ${task.nonce}`,
    `Planning task: ${task.key || task.id} (attempt ${task.attempts || 1})`,
    `Planning goal: ${goal.id || 'unknown'}`,
    '',
    '## Objective',
    String(goal.prompt || ''),
    '',
    '## Context',
    ...(goal.contextPaths?.length ? goal.contextPaths.map((path) => `- ${path}`) : ['- no context paths supplied']),
    ...(answers.length ? ['', '## Operator clarifications', ...answers.map((question) => `- ${question.id}: ${question.answer}`)] : []),
    '',
    '## Fixed runtime',
    `Harness: ${policy.harness || 'codex'}`,
    `Model: ${policy.model || 'gpt-5.6-luna'}`,
    `Effort: ${policy.effort || 'max'}`,
    `Sandbox: ${policy.sandbox || 'read-only'}`,
    '',
    '## Rules',
    '- Return a proposal only. The operator must accept it before the goal plan changes.',
    `- Use 1–${LEAD_PLANNING_LIMITS.maxTasks} tasks and at most ${LEAD_PLANNING_LIMITS.maxDependencies} dependencies. Hierarchy depth is at most ${LEAD_PLANNING_LIMITS.maxHierarchyDepth}.`,
    '- Every task needs a unique id, title, kind, bounded brief, nullable parentId, worker, model, effort, sandbox, and requiresApproval. Use codex with gpt-5.6-luna, max, and read-only sandbox; engine adopt tasks must set requiresApproval true.',
    '- Every dependency needs taskId, dependsOnTaskId, and policy (all_succeeded or all_terminal).',
    '- Do not include capabilities, read paths, delegation, variables, credentials, environment values, or unsupported fields.',
    '- If a material ambiguity prevents a safe bounded plan, return needs_clarification with 1–3 questions and no guessed scope.',
    '',
    '## Output',
    'Reply with JSON only, matching the provided lead-planning output schema. Echo the planning task nonce exactly.',
  ];
  return `${lines.join('\n')}\n`;
}
