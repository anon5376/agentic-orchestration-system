function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  if (typeof value === 'string' && value.length) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function displayStatus(status, fallback = 'unknown') {
  return asString(status, fallback).replaceAll('_', ' ');
}

function normalizeRun(value, index = 0) {
  if (!isPlainRecord(value)) return null;
  return {
    ...value,
    id: asString(value.id, `unknown-run-${index}`),
    status: asString(value.status, 'unknown'),
    objective: asString(value.objective, asString(value.prompt, 'Untitled run')),
    goalId: asString(value.goalId, ''),
  };
}

function normalizeTask(value, index = 0) {
  if (!isPlainRecord(value)) return null;
  return {
    ...value,
    id: asString(value.id, `unknown-task-${index}`),
    status: asString(value.status, 'unknown'),
    title: asString(value.title, 'Untitled task'),
    kind: asString(value.kind, 'unknown'),
    worker: asString(value.worker, 'local'),
    children: asArray(value.children).map(normalizeTask).filter(Boolean),
  };
}

function normalizeGoal(value, index = 0) {
  if (!isPlainRecord(value)) return null;
  const plan = isPlainRecord(value.plan) ? value.plan : {};
  return {
    ...value,
    id: asString(value.id, `unknown-goal-${index}`),
    prompt: asString(value.prompt, ''),
    ambiguities: asArray(value.ambiguities),
    questions: asArray(value.questions).filter(isPlainRecord),
    plan: {
      ...plan,
      tasks: asArray(plan.tasks).filter(isPlainRecord),
    },
  };
}

function normalizeNamed(value, index, fallbackId) {
  if (!isPlainRecord(value)) return null;
  return {
    ...value,
    id: asString(value.id, `${fallbackId}-${index}`),
  };
}

export function selectCurrentProposal(proposals, { retrospective, run } = {}) {
  const list = Array.isArray(proposals) ? proposals.filter(isPlainRecord) : [];
  const proposalId = isPlainRecord(retrospective) ? asString(retrospective.proposalId) : '';
  if (proposalId) {
    const matched = list.find((item) => item.id === proposalId);
    if (matched) return matched;
  }
  const runId = isPlainRecord(run) ? asString(run.id) : '';
  if (runId) {
    return list.find((item) => item.runId === runId) || null;
  }
  return list[0] || null;
}

export function normalizeSnapshot(snapshot) {
  if (!isPlainRecord(snapshot)) return { runs: [], goals: [], taskTree: [], tasks: [], agents: [], evidence: [], proposals: [], policies: [], providers: [], telemetry: null };
  const runs = asArray(snapshot.runs).map(normalizeRun).filter(Boolean);
  const run = normalizeRun(snapshot.run) || runs[0] || null;
  return {
    ...snapshot,
    run,
    runs,
    goals: asArray(snapshot.goals).map(normalizeGoal).filter(Boolean),
    tasks: asArray(snapshot.tasks).map(normalizeTask).filter(Boolean),
    taskTree: asArray(snapshot.taskTree).map(normalizeTask).filter(Boolean),
    agents: asArray(snapshot.agents).map((item, index) => normalizeNamed(item, index, 'unknown-agent')).filter(Boolean),
    evidence: asArray(snapshot.evidence).map((item, index) => normalizeNamed(item, index, 'unknown-evidence')).filter(Boolean),
    proposals: asArray(snapshot.proposals).map((item, index) => normalizeNamed(item, index, 'unknown-proposal')).filter(Boolean),
    policies: asArray(snapshot.policies).map((item, index) => normalizeNamed(item, index, 'unknown-policy')).filter(Boolean),
    providers: asArray(snapshot.providers).map((item, index) => normalizeNamed(item, index, 'unknown-provider')).filter(Boolean),
    decisions: asArray(snapshot.decisions).filter(isPlainRecord),
    retrospectives: asArray(snapshot.retrospectives).filter(isPlainRecord),
    events: asArray(snapshot.events).filter(isPlainRecord),
    telemetry: isPlainRecord(snapshot.telemetry)
      ? {
        ...snapshot.telemetry,
        workers: asArray(snapshot.telemetry.workers).filter(isPlainRecord),
        tokens: isPlainRecord(snapshot.telemetry.tokens) ? snapshot.telemetry.tokens : {},
        counts: isPlainRecord(snapshot.telemetry.counts) ? snapshot.telemetry.counts : {},
      }
      : null,
    decision: isPlainRecord(snapshot.decision) ? snapshot.decision : null,
    retrospective: isPlainRecord(snapshot.retrospective) ? snapshot.retrospective : null,
    memory: isPlainRecord(snapshot.memory) ? snapshot.memory : null,
  };
}
