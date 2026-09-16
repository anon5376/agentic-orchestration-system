import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePlannerRequest, leadPlannerState } from '../src/lib/leadPlanner.js';

test('lead planner request identity is reused for identical input and replaced when input changes', () => {
  const first = ensurePlannerRequest(null, {
    kind: 'create',
    prompt: '  Compare two assays. ',
    contextPaths: ['notes.md'],
  }, 'lead-create');
  const retry = ensurePlannerRequest(first, {
    kind: 'create',
    prompt: 'Compare two assays.',
    contextPaths: ['notes.md'],
  }, 'lead-create');
  const changed = ensurePlannerRequest(retry, {
    kind: 'create',
    prompt: 'Compare two assays.',
    contextPaths: ['sources.md'],
  }, 'lead-create');

  assert.equal(retry.requestId, first.requestId);
  assert.notEqual(changed.requestId, first.requestId);
  assert.notEqual(changed.inputKey, first.inputKey);
});

test('lead planner state preserves the review gates', () => {
  assert.equal(leadPlannerState({ status: 'planning' }, { status: 'generating' }), 'generating');
  assert.equal(leadPlannerState({ status: 'awaiting_user' }, { status: 'needs_clarification' }), 'awaiting_user');
  assert.equal(leadPlannerState({ status: 'lead_revision_ready' }, { status: 'needs_clarification' }), 'lead_revision_ready');
  assert.equal(leadPlannerState({ status: 'awaiting_approval' }, { status: 'proposed' }), 'awaiting_approval');
  assert.equal(leadPlannerState({ status: 'planned' }, { status: 'accepted' }), 'planned');
  assert.equal(leadPlannerState({ status: 'planning' }, { status: 'rejected' }), 'rejected');
  assert.equal(leadPlannerState({ status: 'planning' }, { status: 'failed' }), 'failed');
});
