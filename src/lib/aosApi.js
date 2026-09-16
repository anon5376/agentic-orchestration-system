const BASE = '/api/v1';

function encode(value) {
  return encodeURIComponent(String(value));
}

function queryString(values = {}) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  });
  const rendered = query.toString();
  return rendered ? `?${rendered}` : '';
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Engine request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const aosApi = {
  health: () => fetch('/health').then((res) => {
    if (!res.ok) throw new Error('Engine health check failed');
    return res.json();
  }),
  snapshot: () => request('/snapshot'),
  createGoal: (prompt, contextPaths = []) => request('/goals', { method: 'POST', body: { prompt, contextPaths } }),
  createLeadGoal: (prompt, contextPaths = [], requestId) => request('/goals', {
    method: 'POST',
    body: { prompt, contextPaths, planningMode: 'lead', requestId },
  }),
  answerQuestions: (goalId, answers) => request(`/goals/${goalId}/answers`, { method: 'POST', body: { answers } }),
  listLeadPlans: (goalId, status = null) => request(`/goals/${encode(goalId)}/lead-plans${queryString({ status })}`),
  reviseLeadPlan: (goalId, { requestId, derivedFromProposalId } = {}) => request(`/goals/${encode(goalId)}/lead-plans`, {
    method: 'POST',
    body: { requestId, derivedFromProposalId },
  }),
  getLeadPlan: (id) => request(`/lead-plans/${encode(id)}`),
  acceptLeadPlan: (id, actor = 'operator') => request(`/lead-plans/${encode(id)}/accept`, {
    method: 'POST',
    body: { actor },
  }),
  rejectLeadPlan: (id, reason = 'Rejected from dashboard', actor = 'operator') => request(`/lead-plans/${encode(id)}/reject`, {
    method: 'POST',
    body: { actor, reason },
  }),
  answerTaskQuestions: (taskId, answers) => request(`/tasks/${encode(taskId)}/answers`, { method: 'POST', body: { answers } }),
  startRun: (goalId, { blueprintId = null, blueprintVersion = null, maxConcurrency = null } = {}) => request('/runs', {
    method: 'POST',
    body: { goalId, blueprintId, blueprintVersion, maxConcurrency },
  }),
  advance: (runId) => request(`/runs/${runId}/advance`, { method: 'POST', body: { untilIdle: true } }),
  cancel: (runId) => request(`/runs/${runId}/cancel`, { method: 'POST', body: {} }),
  pause: (runId) => request(`/runs/${runId}/pause`, { method: 'POST', body: {} }),
  resume: (runId) => request(`/runs/${runId}/resume`, { method: 'POST', body: {} }),
  approveProposal: (id) => request(`/proposals/${id}/approve`, { method: 'POST', body: {} }),
  rejectProposal: (id) => request(`/proposals/${id}/reject`, { method: 'POST', body: { reason: 'Rejected from dashboard' } }),
  providers: () => request('/providers').then((data) => data.providers || []),
  modelControl: (projectId = null) => request(`/models${queryString({ projectId })}`),
  assignModel: (input) => request('/models/assign', { method: 'POST', body: input }),
  runPlan: (runId, version = null) => request(`/runs/${encode(runId)}/plan${queryString({ version })}`),
  patchRunPlan: (runId, input) => request(`/runs/${encode(runId)}/plan/patches`, { method: 'POST', body: input }),
  eventsReplay: ({ after = null, limit = 200 } = {}) => request(`/events/replay${queryString({ after, limit })}`),
  eventsStreamUrl: (after = null) => `/api/v1/events/stream${queryString({ after })}`,
  cli: (command) => request('/cli', { method: 'POST', body: { command } }),

  systemManifest: () => request('/settings/manifest'),
  systemDiagnostics: () => request('/settings/diagnostics'),

  presets: (filters = {}) => request(`/presets${queryString(filters)}`),
  preset: (id, version) => request(`/presets/${encode(id)}/effective${queryString({ version })}`),
  editPreset: (id, input) => request(`/presets/${encode(id)}/versions`, { method: 'POST', body: { input } }),
  forkPreset: (id, input) => request(`/presets/${encode(id)}/fork`, { method: 'POST', body: input }),

  templates: (filters = {}) => request(`/templates${queryString(filters)}`),
  template: (id, version) => request(`/templates/${encode(id)}${queryString({ version })}`),
  createTemplate: (input) => request('/templates', { method: 'POST', body: { input } }),
  editTemplate: (id, input) => request(`/templates/${encode(id)}/versions`, { method: 'POST', body: { input } }),
  forkTemplate: (id, input) => request(`/templates/${encode(id)}/fork`, { method: 'POST', body: input }),

  blueprints: (filters = {}) => request(`/blueprints${queryString(filters)}`),
  blueprint: (id, version) => request(`/blueprints/${encode(id)}/effective${queryString({ version })}`),
  blueprintEstimate: (id, depth) => request(`/blueprints/${encode(id)}/estimate${queryString({ depth })}`),
  createBlueprint: (input) => request('/blueprints', { method: 'POST', body: { input } }),
  editBlueprint: (id, input) => request(`/blueprints/${encode(id)}/versions`, { method: 'POST', body: { input } }),
  forkBlueprint: (id, input) => request(`/blueprints/${encode(id)}/fork`, { method: 'POST', body: input }),

  memoryPolicy: (scope = 'global', scopeId = null) => request(`/memory/policy${queryString({ scope, scopeId })}`),
  memoryStats: () => request('/memory/stats'),
  setMemoryPolicy: (value, scope = 'global', scopeId = null) => request('/memory/policy', { method: 'PUT', body: { value, scope, scopeId } }),
  searchMemory: (filters = {}) => request(`/memory/search${queryString(filters)}`),

  settings: (filters = {}) => request(`/settings${queryString(filters)}`),
  effectiveSetting: (key, context = {}) => request(`/settings/${encode(key)}/effective${queryString(context)}`),
  setSetting: (key, value, scope = 'global', scopeId = null) => request(`/settings/${encode(key)}`, { method: 'PUT', body: { value, scope, scopeId } }),
  unsetSetting: (key, scope = 'global', scopeId = null) => request(`/settings/${encode(key)}${queryString({ scope, scopeId })}`, { method: 'DELETE' }),
  patchRun: (runId, key, value, reason = null) => request(`/runs/${encode(runId)}/patch`, { method: 'POST', body: { key, value, reason } }),
};
