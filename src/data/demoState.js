export const routeDefinitions = [
  { key: 'missions', path: '/missions', label: 'Missions', shortLabel: 'M', group: 'research' },
  { key: 'intake', path: '/intake', label: 'Goal intake', shortLabel: 'G', group: 'research' },
  { key: 'swarm', path: '/swarm', label: 'Swarm', shortLabel: 'S', group: 'run' },
  { key: 'evidence', path: '/evidence', label: 'Evidence', shortLabel: 'E', group: 'run' },
  { key: 'synthesis', path: '/synthesis', label: 'Synthesis', shortLabel: 'Y', group: 'decision' },
  { key: 'evolution', path: '/evolution', label: 'Evolution', shortLabel: 'V', group: 'decision' },
  { key: 'capabilities', path: '/capabilities', label: 'Capabilities', shortLabel: 'C', group: 'system' },
  { key: 'memory', path: '/memory', label: 'Memory', shortLabel: 'M', group: 'system' },
  { key: 'system', path: '/system', label: 'System studio', shortLabel: 'S', group: 'system' },
];

export const defaultRoute = routeDefinitions[0].path;

export function normalizeRoutePath(value) {
  const candidate = String(value || '').trim().replace(/^#/, '').split('?')[0] || defaultRoute;
  const withSlash = candidate.startsWith('/') ? candidate : `/${candidate}`;
  return routeDefinitions.some((route) => route.path === withSlash) ? withSlash : defaultRoute;
}

export function routeForPath(path) {
  const normalized = normalizeRoutePath(path);
  return routeDefinitions.find((route) => route.path === normalized) || routeDefinitions[0];
}

const initialAgents = [
  {
    id: 'agent-lead',
    name: 'Lead',
    role: 'Synthesis lead',
    branch: 'root',
    status: 'active',
    provider: 'Codex / illustrative',
    task: 'Reconcile independent findings before the gate.',
    progress: 0.74,
  },
  {
    id: 'agent-01',
    name: 'Source review',
    role: 'Source reviewer',
    branch: 'evidence',
    status: 'active',
    provider: 'Claude Code / illustrative',
    task: 'Index the primary source chain.',
    progress: 0.62,
  },
  {
    id: 'agent-02',
    name: 'Adversarial review',
    role: 'Critical reviewer',
    branch: 'evidence',
    status: 'blocked',
    provider: 'Codex / illustrative',
    task: 'Test the highest-leverage objection.',
    progress: 0.41,
  },
  {
    id: 'agent-03',
    name: 'Mechanism analysis',
    role: 'Mechanism reviewer',
    branch: 'mechanism',
    status: 'complete',
    provider: 'Local model / illustrative',
    task: 'Compare the candidate explanations.',
    progress: 1,
  },
  {
    id: 'agent-04',
    name: 'Independent check',
    role: 'Verification reviewer',
    branch: 'mechanism',
    status: 'queued',
    provider: 'Codex / illustrative',
    task: 'Await the lead’s narrowed question.',
    progress: 0,
  },
];

const initialFindings = [
  {
    id: 'finding-01',
    type: 'supported',
    claim: 'The primary mechanism is consistent across the strongest sources.',
    confidence: 0.78,
    sourceCount: 4,
    owner: 'TRACE-01',
  },
  {
    id: 'finding-02',
    type: 'conflict',
    claim: 'A late source introduces a boundary condition the current synthesis omits.',
    confidence: 0.54,
    sourceCount: 2,
    owner: 'TRACE-02',
  },
  {
    id: 'finding-03',
    type: 'open',
    claim: 'The proposed intervention has not yet been independently checked.',
    confidence: 0.31,
    sourceCount: 1,
    owner: 'MODEL-02',
  },
];

const initialCapabilities = [
  { id: 'cap-codex', name: 'CODEX WORKER', kind: 'provider', state: 'connected', capacity: '04 / 08', latency: '620 ms' },
  { id: 'cap-claude', name: 'CLAUDE CODE', kind: 'provider', state: 'connected', capacity: '02 / 04', latency: '910 ms' },
  { id: 'cap-mcp', name: 'MCP / SOURCE INDEX', kind: 'tool', state: 'degraded', capacity: '01 / 02', latency: '1.8 s' },
  { id: 'cap-local', name: 'LOCAL MODEL', kind: 'provider', state: 'standby', capacity: '00 / 01', latency: '—' },
];

const initialPolicies = [
  { id: 'policy-01', name: 'Evidence before synthesis', scope: 'run', state: 'enforced', detail: 'The gate waits for source provenance and an independent check.' },
  { id: 'policy-02', name: 'No automatic adoption', scope: 'project', state: 'enforced', detail: 'Evolution proposals require an explicit decision.' },
  { id: 'policy-03', name: 'Illustrative state', scope: 'global', state: 'visible', detail: 'All values on this prototype are deterministic demo data.' },
];

export function createInitialDemoState() {
  return {
    project: {
      id: 'PROJECT-01',
      name: 'Adaptive interfaces',
      mode: 'illustrative',
    },
    run: {
      id: 'RUN-024',
      status: 'awaiting decision',
      startedAt: '2026-09-12 04:18:09 UTC',
      elapsed: '00:42:18',
      objective: 'Identify the mechanism, its limits, and the next useful experiment.',
    },
    agents: initialAgents.map((agent) => ({ ...agent })),
    findings: initialFindings.map((finding) => ({ ...finding })),
    capabilities: initialCapabilities.map((capability) => ({ ...capability })),
    policies: initialPolicies.map((policy) => ({ ...policy })),
    memory: {
      global: 18,
      project: 64,
      agent: 31,
      retention: '30 days / illustrative',
      inheritance: 'project → branch → worker',
    },
    selectedAgentId: 'agent-lead',
    focusedBranch: 'root',
    activeFilter: 'all',
    decision: 'hold',
    lastAction: 'Prototype state loaded',
    cliOpen: false,
    cliExpanded: false,
    cliHistory: [],
    cliLines: [
      { kind: 'system', text: 'AOS console — simulated command surface' },
      { kind: 'system', text: 'Run RUN-024 is illustrative. No provider is connected.' },
      { kind: 'prompt', text: 'type “help” for available local demo commands' },
    ],
  };
}
