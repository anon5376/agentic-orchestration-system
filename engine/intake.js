import { newId } from './ids.js';

const SUCCESS_RE = /\b(success|done when|criteria|measure|evaluate|acceptance|definition of done)\b/i;
const SCOPE_RE = /\b(scope|exclude|not in scope|limit|bounded|out of scope)\b/i;
const SOURCE_RE = /\b(source|paper|dataset|file|document|corpus|citation|evidence)\b/i;
const VAGUE_RE = /\b(better|optimize|improve|fix this|somehow|things|stuff|make it good)\b/i;

export function identifyAmbiguities(prompt, contextPaths = []) {
  const text = String(prompt || '').trim();
  const items = [];
  if (text.length < 48) {
    items.push({
      code: 'brief',
      severity: 'material',
      detail: 'The objective is too brief to bound the work without guessing.',
    });
  }
  if (!SUCCESS_RE.test(text)) {
    items.push({
      code: 'success_criteria',
      severity: 'material',
      detail: 'No success criteria are stated, so completion would be arbitrary.',
    });
  }
  if (!SCOPE_RE.test(text)) {
    items.push({
      code: 'scope',
      severity: 'material',
      detail: 'Scope and exclusions are not stated.',
    });
  }
  if (!contextPaths.length && !SOURCE_RE.test(text)) {
    items.push({
      code: 'sources',
      severity: 'advisory',
      detail: 'No sources or context files were supplied.',
    });
  }
  if (VAGUE_RE.test(text)) {
    items.push({
      code: 'vague',
      severity: 'advisory',
      detail: 'The prompt uses evaluative language without a measurable target.',
    });
  }
  return items;
}

export function questionsFromAmbiguities(ambiguities) {
  const map = {
    brief: 'What is the specific research question, in one sentence?',
    success_criteria: 'What would count as a finished answer, including uncertainty you will accept?',
    scope: 'What is in scope, and what should workers ignore?',
    sources: 'Which documents, datasets, or prior runs should bound the evidence?',
    vague: 'Which metric or qualitative test replaces “better” / “improve”?',
  };
  return ambiguities.map((item) => ({
    id: newId('task').replace('tsk_', 'q_'),
    code: item.code,
    prompt: map[item.code] || item.detail,
    required: item.severity === 'material',
    answer: null,
  }));
}

function inferBranches(prompt) {
  const text = String(prompt || '').toLowerCase();
  const branches = [
    {
      key: 'primary',
      title: 'Primary analysis',
      summary: 'Extract the strongest supported claim and its limits from the stated objective.',
    },
    {
      key: 'independent',
      title: 'Independent check',
      summary: 'Reproduce the claim from a second angle and record disagreements.',
    },
  ];
  if (/\b(mechanism|cause|why|pathway|coupling|interface)\b/.test(text)) {
    branches.push({
      key: 'mechanism',
      title: 'Mechanism review',
      summary: 'Compare candidate mechanisms and name the conditions under which each fails.',
    });
  } else if (text.length > 120 || /\b(experiment|trial|study)\b/.test(text)) {
    branches.push({
      key: 'experiment',
      title: 'Next experiment',
      summary: 'Propose the cheapest test that would change the current conclusion.',
    });
  }
  return branches;
}

function planTask(partial, defaultWorker = 'local') {
  const task = {
    id: partial.id || newId('task'),
    parentId: partial.parentId || null,
    title: partial.title,
    kind: partial.kind,
    summary: partial.summary || '',
    branch: partial.branch || 'root',
    worker: partial.worker || defaultWorker,
    requiresApproval: Boolean(partial.requiresApproval),
    dependencyPolicy: partial.dependencyPolicy || 'all_succeeded',
    optional: Boolean(partial.optional),
  };
  // maxRetries stays absent unless the plan sets it, so a template can supply it; the engine defaults to 1.
  if (partial.maxRetries != null) task.maxRetries = partial.maxRetries;
  for (const field of ['key', 'brief', 'readPaths', 'injectFault', 'timeoutMs', 'templateId', 'templateVersion', 'presetId', 'presetVersion', 'budget', 'sandbox', 'capabilities', 'capabilityExecution', 'mayDelegate', 'delegation', 'model', 'effort', 'variables', 'escalation', 'memory']) {
    if (partial[field] != null) task[field] = partial[field];
  }
  return task;
}

// Validates an operator-authored plan: unique ids, known references, no cycles,
// and injected faults that the retry budget can actually absorb.
export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error('Plan must contain at least one task');
  const ids = new Set();
  const keys = new Set();
  for (const task of plan.tasks) {
    if (!task.id || typeof task.id !== 'string') throw new Error('Every plan task needs a string id');
    if (ids.has(task.id)) throw new Error(`Duplicate plan task id: ${task.id}`);
    ids.add(task.id);
    if (task.key != null) {
      if (keys.has(task.key)) throw new Error(`Duplicate plan task key: ${task.key}`);
      keys.add(task.key);
    }
    if (!task.title || !task.kind) throw new Error(`Plan task ${task.id} needs a title and kind`);
    if (task.dependencyPolicy && !['all_succeeded', 'all_terminal'].includes(task.dependencyPolicy)) {
      throw new Error(`Plan task ${task.id} has unknown dependency policy ${task.dependencyPolicy}`);
    }
    if (task.injectFault) {
      const { attempt, holdMs = 0 } = task.injectFault;
      if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Injected fault on ${task.id} needs an attempt >= 1`);
      if (attempt > (task.maxRetries ?? 1)) throw new Error(`Injected fault on ${task.id} at attempt ${attempt} exceeds maxRetries, so it would not be retryable`);
      if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error(`Injected fault on ${task.id} needs holdMs >= 0`);
    }
  }
  for (const task of plan.tasks) {
    if (task.parentId && !ids.has(task.parentId)) throw new Error(`Plan task ${task.id} has unknown parent ${task.parentId}`);
  }
  const dependencies = plan.dependencies || [];
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, []]));
  for (const dep of dependencies) {
    if (!ids.has(dep.taskId) || !ids.has(dep.dependsOnTaskId)) {
      throw new Error(`Dependency ${dep.taskId} -> ${dep.dependsOnTaskId} references an unknown task`);
    }
    if (dep.taskId === dep.dependsOnTaskId) throw new Error(`Task ${dep.taskId} depends on itself`);
    incoming.set(dep.taskId, incoming.get(dep.taskId) + 1);
    outgoing.get(dep.dependsOnTaskId).push(dep.taskId);
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
  if (visited !== ids.size) throw new Error('Plan dependencies contain a cycle');
  return {
    title: plan.title || firstLine(plan.tasks[0].title),
    ambiguities: plan.ambiguities || [],
    branches: plan.branches || [],
    tasks: plan.tasks.map((task) => planTask(task)),
    dependencies: dependencies.map((dep) => ({ id: dep.id || newId('dep'), taskId: dep.taskId, dependsOnTaskId: dep.dependsOnTaskId })),
  };
}

export function buildHierarchicalPlan(prompt, ambiguities = [], { execution = 'local' } = {}) {
  const branches = inferBranches(prompt);
  const tasks = [];
  const dependencies = [];
  const defaultWorker = ['codex', 'claude', 'openai'].includes(execution) ? execution : 'local';

  const add = (partial) => {
    const worker = partial.kind === 'adopt' ? (defaultWorker === 'codex' ? 'engine' : 'local') : defaultWorker;
    const task = planTask(partial, worker);
    tasks.push(task);
    return task;
  };

  const interpret = add({
    title: 'Interpret objective',
    kind: 'intake',
    summary: 'Store the prompt, ambiguities, and the reviewable work plan.',
    branch: 'root',
  });

  const branchTasks = branches.map((branch) =>
    add({
      parentId: interpret.id,
      title: branch.title,
      kind: 'research',
      summary: branch.summary,
      branch: branch.key,
    }),
  );

  for (const task of branchTasks) {
    dependencies.push({ id: newId('dep'), taskId: task.id, dependsOnTaskId: interpret.id });
  }

  const critique = add({
    parentId: interpret.id,
    title: 'Adversarial check',
    kind: 'critique',
    summary: 'Test the highest-leverage objection against the branch findings.',
    branch: 'critique',
    dependencyPolicy: 'all_terminal',
  });
  for (const task of branchTasks) {
    dependencies.push({ id: newId('dep'), taskId: critique.id, dependsOnTaskId: task.id });
  }

  const synthesis = add({
    parentId: interpret.id,
    title: 'Synthesize decision',
    kind: 'synthesis',
    summary: 'Combine evidence into a decision record with provenance.',
    branch: 'root',
    dependencyPolicy: 'all_terminal',
  });
  dependencies.push({ id: newId('dep'), taskId: synthesis.id, dependsOnTaskId: critique.id });

  const retro = add({
    parentId: interpret.id,
    title: 'Write retrospective',
    kind: 'retrospective',
    summary: 'Record what failed, why, and a proposed improvement. Proposal-only until approved.',
    branch: 'root',
    dependencyPolicy: 'all_terminal',
  });
  dependencies.push({ id: newId('dep'), taskId: retro.id, dependsOnTaskId: synthesis.id });

  const adopt = add({
    parentId: retro.id,
    title: 'Apply improvement proposal',
    kind: 'adopt',
    summary: 'Approval gate. No self-modification until an operator accepts the proposal.',
    branch: 'root',
    requiresApproval: true,
    dependencyPolicy: 'all_succeeded',
  });
  dependencies.push({ id: newId('dep'), taskId: adopt.id, dependsOnTaskId: retro.id });

  return {
    title: firstLine(prompt),
    ambiguities,
    branches,
    tasks,
    dependencies,
  };
}

function firstLine(prompt) {
  const text = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!text) return 'Untitled objective';
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

export function interpretGoal({ prompt, contextPaths = [], execution = 'local' }) {
  const ambiguities = identifyAmbiguities(prompt, contextPaths);
  const questions = questionsFromAmbiguities(ambiguities);
  const plan = buildHierarchicalPlan(prompt, ambiguities, { execution });
  return {
    prompt: String(prompt || '').trim(),
    contextPaths: [...contextPaths],
    ambiguities,
    questions,
    plan,
  };
}
