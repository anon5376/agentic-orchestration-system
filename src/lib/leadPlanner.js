function normalizedPaths(paths) {
  return Array.isArray(paths) ? paths.map((path) => String(path)).filter(Boolean) : [];
}

export function plannerInputKey({ kind = 'create', prompt = '', contextPaths = [], goalId = '', derivedFromProposalId = '' } = {}) {
  return JSON.stringify({
    kind,
    prompt: String(prompt).trim(),
    contextPaths: normalizedPaths(contextPaths),
    goalId: String(goalId || ''),
    derivedFromProposalId: String(derivedFromProposalId || ''),
  });
}

export function createPlannerRequestId(prefix = 'lead') {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ensurePlannerRequest(current, input, prefix = 'lead') {
  const inputKey = plannerInputKey(input);
  if (current?.inputKey === inputKey && current?.requestId) return current;
  return { inputKey, requestId: createPlannerRequestId(prefix) };
}

export function leadPlannerState(goal, proposal) {
  const goalStatus = String(goal?.status || '');
  const proposalStatus = String(proposal?.status || '');
  const pointerStatus = String(goal?.leadPlan?.status || '');
  const statuses = [goalStatus, proposalStatus, pointerStatus];
  if (statuses.includes('planned') || statuses.includes('accepted')) return 'planned';
  if (statuses.includes('lead_revision_ready')) return 'lead_revision_ready';
  if (statuses.includes('awaiting_user') || statuses.includes('needs_clarification')) return 'awaiting_user';
  if (statuses.includes('awaiting_approval') || statuses.includes('proposed')) return 'awaiting_approval';
  if (statuses.includes('rejected')) return 'rejected';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('interrupted')) return 'interrupted';
  if (statuses.includes('planning') || statuses.includes('generating')) return 'generating';
  return goalStatus || proposalStatus || pointerStatus || 'idle';
}
