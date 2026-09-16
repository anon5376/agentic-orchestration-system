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

function asNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstRecord(...values) {
  return values.find((value) => isPlainRecord(value)) || null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== null) return number;
  }
  return null;
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
    plan: normalizePlanSummary(value.plan),
  };
}

function normalizePlanSummary(value) {
  if (!isPlainRecord(value)) return value ?? null;
  return {
    ...value,
    version: firstNumber(value.version, value.currentVersion, value.current_version),
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    dependencies: Array.isArray(value.dependencies) ? value.dependencies : [],
    lastAppendReason: value.lastAppendReason ?? value.last_append_reason ?? value.reason ?? null,
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
    planVersion: value.planVersion ?? value.plan_version ?? null,
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
  if (!isPlainRecord(snapshot)) return { runs: [], goals: [], taskTree: [], tasks: [], agents: [], evidence: [], proposals: [], policies: [], providers: [], telemetry: null, eventCursor: null };
  const runs = asArray(snapshot.runs).map(normalizeRun).filter(Boolean);
  const run = normalizeRun(snapshot.run) || runs[0] || null;
  return {
    ...snapshot,
    eventCursor: firstNumber(snapshot.eventCursor, snapshot.event_cursor, snapshot.cursor),
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
        workers: asArray(snapshot.telemetry.workers).filter(isPlainRecord).map((item) => ({
          ...item,
          planVersion: item.planVersion ?? item.plan_version ?? null,
        })),
        tokens: isPlainRecord(snapshot.telemetry.tokens) ? snapshot.telemetry.tokens : {},
        counts: isPlainRecord(snapshot.telemetry.counts) ? snapshot.telemetry.counts : {},
      }
      : null,
    decision: isPlainRecord(snapshot.decision) ? snapshot.decision : null,
    retrospective: isPlainRecord(snapshot.retrospective) ? snapshot.retrospective : null,
    memory: isPlainRecord(snapshot.memory) ? snapshot.memory : null,
  };
}

function normalizePlanHistoryItem(value) {
  if (!isPlainRecord(value)) return null;
  const nested = firstRecord(value.snapshot, value.plan, value.selectedSnapshot);
  return {
    ...value,
    version: firstNumber(value.version, value.planVersion, value.plan_version, nested?.version),
    snapshot: nested,
    reason: value.reason ?? value.appendReason ?? value.append_reason ?? null,
    createdAt: value.createdAt ?? value.created_at ?? value.at ?? value.ts ?? null,
  };
}

function planSnapshotCandidate(source) {
  const candidates = [
    source.selectedSnapshot,
    source.selected?.snapshot,
    source.selected?.plan,
    source.snapshot,
    source.current?.snapshot,
    source.current?.plan,
    source.currentPlan,
    source.current_plan,
    source.current,
    source.plan?.snapshot,
    source.plan,
  ];
  return candidates.find((value) => isPlainRecord(value) && (Array.isArray(value.tasks) || Array.isArray(value.dependencies))) || null;
}

export function normalizePlanResponse(value) {
  const source = isPlainRecord(value) ? value : {};
  const pointer = firstRecord(source.pointer, source.currentPointer, source.current_pointer, source.current, source.planPointer, source.plan_pointer);
  const snapshot = planSnapshotCandidate(source);
  const selected = firstRecord(source.selected, source.selectedVersion, source.selectedPlan) || (snapshot ? { snapshot } : null);
  const historySource = source.history ?? source.versions ?? source.planHistory ?? source.plan_history ?? source.timeline;
  const patchesSource = source.patches ?? source.patchHistory ?? source.patch_history ?? source.appendPatches ?? source.append_patches;
  const receiptsSource = source.receipts ?? source.patchReceipts ?? source.patch_receipts ?? patchesSource;
  const currentVersion = firstNumber(
    source.currentVersion,
    source.current_version,
    pointer?.version,
    pointer?.currentVersion,
    pointer?.current_version,
    source.version,
    snapshot?.version,
  );
  return {
    ...source,
    pointer,
    currentVersion,
    history: asArray(historySource).map(normalizePlanHistoryItem).filter(Boolean),
    selected,
    snapshot,
    patches: asArray(patchesSource).filter(isPlainRecord),
    receipts: asArray(receiptsSource).filter(isPlainRecord),
    lastAppendReason: source.lastAppendReason
      ?? source.last_append_reason
      ?? pointer?.lastAppendReason
      ?? pointer?.last_append_reason
      ?? pointer?.reason
      ?? asArray(patchesSource).at(-1)?.reason
      ?? null,
  };
}

export function normalizeReplayResponse(value) {
  const source = isPlainRecord(value) ? value : {};
  const events = source.events ?? source.items ?? source.records;
  return {
    ...source,
    events: asArray(events).filter(isPlainRecord),
    nextCursor: firstNumber(source.nextCursor, source.next_cursor, source.cursor, source.latest),
    earliest: firstNumber(source.earliest, source.earliestCursor, source.earliest_cursor),
    latest: firstNumber(source.latest, source.latestCursor, source.latest_cursor),
    resyncRequired: Boolean(source.resyncRequired ?? source.resync_required ?? false),
  };
}
