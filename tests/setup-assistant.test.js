import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSetupDraft, interpretSetupMessage } from '../src/lib/setupAssistant.js';

const blueprints = [
  { id: 'default-research-swarm', name: 'Default research swarm' },
  { id: 'small-audit-swarm', name: 'Small audit swarm' },
  { id: 'unbounded-research-swarm', name: 'Unbounded research swarm' },
];

test('setup assistant starts from the selected or default swarm without mutating it', () => {
  assert.equal(initialSetupDraft(blueprints).blueprintId, 'default-research-swarm');
  assert.equal(initialSetupDraft(blueprints, 'small-audit-swarm').blueprintId, 'small-audit-swarm');
});

test('setup assistant translates audit, scale, provider and memory language into a staged draft', () => {
  const audit = interpretSetupMessage('Use 6 workers to rigorously audit the evidence with Codex and no memory.', blueprints);
  assert.equal(audit.draft.blueprintId, 'small-audit-swarm');
  assert.equal(audit.draft.requestedWorkers, 6);
  assert.equal(audit.draft.requestedHarness, 'Codex / OpenAI requested');
  assert.equal(audit.draft.memory, 'disabled requested');
  assert.equal(audit.draft.priority, 'evidence quality');
  assert.equal(audit.reply.unresolved.length, 3);

  const broad = interpretSetupMessage('Run an exhaustive, unbounded search across many angles.', blueprints);
  assert.equal(broad.draft.blueprintId, 'unbounded-research-swarm');
  assert.equal(broad.draft.priority, 'breadth');
});
