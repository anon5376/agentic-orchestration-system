const DEFAULT_BLUEPRINT = 'default-research-swarm';
const AUDIT_BLUEPRINT = 'small-audit-swarm';
const UNBOUNDED_BLUEPRINT = 'unbounded-research-swarm';

const includesAny = (value, terms) => terms.some((term) => value.includes(term));

export function initialSetupDraft(blueprints = [], selectedBlueprintId = null) {
  const fallback = blueprints.find((item) => item.id === selectedBlueprintId)
    || blueprints.find((item) => item.id === DEFAULT_BLUEPRINT)
    || blueprints[0]
    || null;
  return {
    blueprintId: fallback?.id || null,
    objective: '',
    priority: 'balanced',
    requestedWorkers: null,
    requestedHarness: 'inherit current runtime',
    memory: 'inherit current policy',
    rationale: 'No requirements described yet.',
  };
}

export function interpretSetupMessage(message, blueprints = [], previous = initialSetupDraft(blueprints)) {
  const input = String(message || '').trim();
  const normalized = input.toLowerCase();
  const next = { ...previous };
  const findBlueprint = (id) => blueprints.find((item) => item.id === id);

  if (input) next.objective = input;

  if (includesAny(normalized, ['audit', 'review', 'verify', 'verification', 'check existing', 'critic'])) {
    next.blueprintId = findBlueprint(AUDIT_BLUEPRINT)?.id || next.blueprintId;
    next.priority = 'verification';
    next.rationale = 'A smaller audit swarm keeps critique and verification central.';
  } else if (includesAny(normalized, ['unlimited', 'unbounded', 'exhaustive', 'massive', 'as many', 'wide search'])) {
    next.blueprintId = findBlueprint(UNBOUNDED_BLUEPRINT)?.id || next.blueprintId;
    next.priority = 'breadth';
    next.rationale = 'The request favors breadth and does not set a product-level agent ceiling.';
  } else {
    next.blueprintId = findBlueprint(DEFAULT_BLUEPRINT)?.id || next.blueprintId;
    next.rationale = 'The bounded research swarm is the safest useful starting point.';
  }

  if (includesAny(normalized, ['fast', 'quick', 'speed', 'cheap', 'low cost'])) next.priority = 'speed and cost';
  if (includesAny(normalized, ['rigorous', 'evidence', 'source', 'validate', 'high confidence'])) next.priority = 'evidence quality';
  if (includesAny(normalized, ['broad', 'breadth', 'many angles'])) next.priority = 'breadth';

  const workerMatch = normalized.match(/\b(\d{1,5})\s*(?:agents?|workers?)\b/);
  if (workerMatch) next.requestedWorkers = Number(workerMatch[1]);

  if (includesAny(normalized, ['codex', 'openai', 'gpt'])) next.requestedHarness = 'Codex / OpenAI requested';
  else if (includesAny(normalized, ['claude', 'anthropic'])) next.requestedHarness = 'Claude requested';
  else if (includesAny(normalized, ['ollama', 'local model', 'local llm'])) next.requestedHarness = 'local model requested';
  else if (includesAny(normalized, ['deepseek', 'dsh'])) next.requestedHarness = 'DeepSeek harness requested';

  if (includesAny(normalized, ['no memory', 'forget everything', 'ephemeral'])) next.memory = 'disabled requested';
  else if (includesAny(normalized, ['remember', 'persistent memory', 'long-term memory'])) next.memory = 'persistent requested';

  const blueprint = findBlueprint(next.blueprintId);
  const shortObjective = input.length > 180 ? `${input.slice(0, 177)}…` : input;
  const unresolved = [];
  if (next.requestedHarness !== 'inherit current runtime') unresolved.push('The requested provider must be configured in Workers before launch.');
  if (next.memory !== 'inherit current policy') unresolved.push('Memory is staged only; review its policy before applying it.');
  if (next.requestedWorkers) unresolved.push(`The ${next.requestedWorkers}-worker request is recorded, but the selected blueprint still controls actual fan-out.`);

  return {
    draft: next,
    reply: {
      title: blueprint ? `I recommend ${blueprint.name}.` : 'I have a workable starting point.',
      body: shortObjective
        ? `I read the goal as: ${shortObjective}`
        : 'Describe the outcome, the evidence standard, and any hard limits.',
      reason: next.rationale,
      unresolved,
      question: next.priority === 'balanced'
        ? 'What matters most here: speed, breadth, or evidence quality?'
        : 'Review the draft at right. Nothing changes until you apply the recommendation.',
    },
  };
}
