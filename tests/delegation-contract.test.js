import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_OUTPUT_SCHEMA, buildWorkerPrompt } from '../engine/codex.js';
import { normalizeStructuredOutput } from '../engine/claude.js';
import { DELEGATION_LIMITS, DELEGATION_PROPOSAL_SCHEMA, normalizeDelegationProposal } from '../engine/delegation.js';

const authority = {
  mayDelegate: true,
  delegation: {
    maxChildren: 4,
    maxDepth: 2,
    childTemplates: ['default-worker'],
    childTemplateVersions: { 'default-worker': 1 },
  },
  budget: { tokens: 1000 },
};

function child(id, extra = {}) {
  return {
    id,
    key: id,
    title: `Child ${id}`,
    kind: 'research',
    brief: `Bounded standalone brief for ${id}.`,
    templateId: 'default-worker',
    templateVersion: 1,
    budget: { tokens: 100 },
    dependencies: [],
    mayDelegate: false,
    delegation: null,
    ...extra,
  };
}

test('absent delegation is a valid no-op and the shared schema has a strict nullable proposal', () => {
  assert.equal(normalizeDelegationProposal(undefined), null);
  assert.equal(normalizeDelegationProposal(null, { mayDelegate: false }), null);
  assert.deepEqual(CODEX_OUTPUT_SCHEMA.properties.delegation.anyOf.at(-1), { type: 'null' });
  assert.equal(DELEGATION_PROPOSAL_SCHEMA.additionalProperties, false);
  assert.deepEqual([...DELEGATION_PROPOSAL_SCHEMA.required].sort(), ['dependencies', 'tasks']);
  assert.equal(DELEGATION_LIMITS.maxTasks, 32);
});

test('a valid bounded proposal normalizes local sibling dependencies and inherited authority', () => {
  const normalized = normalizeDelegationProposal({
    tasks: [child('a'), child('b', { dependencies: ['a'] })],
    dependencies: null,
  }, authority);
  assert.deepEqual(normalized.tasks.map(({ id, key, dependencies, templateId, templateVersion }) => ({ id, key, dependencies, templateId, templateVersion })), [
    { id: 'a', key: 'a', dependencies: [], templateId: 'default-worker', templateVersion: 1 },
    { id: 'b', key: 'b', dependencies: ['a'], templateId: 'default-worker', templateVersion: 1 },
  ]);
  assert.deepEqual(normalized.dependencies, [{ taskId: 'b', dependsOnTaskId: 'a' }]);
  assert.equal(Object.hasOwn(normalized.tasks[0], 'parentId'), false, 'parent identity is engine-derived');
});

test('unknown fields, invalid strings, and non-positive or non-finite budgets reject', () => {
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { actor: 'worker' })], dependencies: [] }, authority), (error) => error.code === 'delegation_unknown_field');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { title: '   ' })], dependencies: [] }, authority), (error) => error.code === 'delegation_invalid');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { budget: { tokens: 0 } })], dependencies: [] }, authority), (error) => error.code === 'delegation_budget_invalid');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { budget: { tokens: Number.POSITIVE_INFINITY } })], dependencies: [] }, authority), (error) => error.code === 'delegation_budget_invalid');
});

test('children require a positive template version and must match an exact authority pin', () => {
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { templateVersion: undefined })], dependencies: [] }, authority), (error) => error.code === 'delegation_invalid');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { templateVersion: null })], dependencies: [] }, authority), (error) => error.code === 'delegation_invalid');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a', { templateVersion: 2 })], dependencies: [] }, authority), (error) => error.code === 'delegation_authority');
  const versionedRefs = {
    ...authority,
    delegation: { ...authority.delegation, childTemplates: [{ templateId: 'default-worker', templateVersion: 1 }] },
  };
  assert.equal(normalizeDelegationProposal({ tasks: [child('a')], dependencies: [] }, versionedRefs).tasks[0].templateVersion, 1);
});

test('duplicate local ids or keys and cyclic or non-sibling graphs reject', () => {
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a'), child('a', { key: 'b' })], dependencies: [] }, authority), (error) => error.code === 'delegation_duplicate_id');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a'), child('b', { key: 'a' })], dependencies: [] }, authority), (error) => error.code === 'delegation_duplicate_key');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a'), child('b')], dependencies: [{ taskId: 'a', dependsOnTaskId: 'b' }, { taskId: 'b', dependsOnTaskId: 'a' }] }, authority), (error) => error.code === 'delegation_cycle');
  assert.throws(() => normalizeDelegationProposal({ tasks: [child('a')], dependencies: [{ taskId: 'a', dependsOnTaskId: 'outside' }] }, authority), (error) => error.code === 'delegation_reference');
});

test('the dependency limit applies to total canonical sibling edges across both declarations', () => {
  const tasks = Array.from({ length: 9 }, (_, index) => child(`n${index}`, {
    dependencies: index > 0 && index < 8 ? Array.from({ length: index }, (_, dependencyIndex) => `n${dependencyIndex}`) : [],
  }));
  const proposal = {
    tasks,
    dependencies: Array.from({ length: 5 }, (_, index) => ({ taskId: 'n8', dependsOnTaskId: `n${index}` })),
  };
  const wideAuthority = { ...authority, delegation: { ...authority.delegation, maxChildren: 32 } };
  assert.throws(() => normalizeDelegationProposal(proposal, wideAuthority), (error) => error.code === 'delegation_size');
});

test('worker prompt distinguishes authorized proposals from non-delegating work', () => {
  const base = {
    id: 'task_1',
    key: 'A',
    title: 'Research',
    kind: 'research',
    branch: 'root',
    attempts: 1,
    nonce: 'aos-nonce',
    brief: 'Bounded assignment.',
  };
  const ctx = { run: { id: 'run_1' }, goal: { prompt: 'Objective' }, dependencies: [] };
  const nonDelegating = buildWorkerPrompt({ ...base, mayDelegate: false, delegation: { maxChildren: 0, maxDepth: 0 } }, ctx);
  const delegating = buildWorkerPrompt({
    ...base,
    mayDelegate: true,
    delegation: { maxChildren: 2, maxDepth: 1, childTemplateVersions: { 'default-worker': 1, 'default-critic': 2 } },
  }, ctx);
  assert.match(nonDelegating, /Do not spawn sub-agents, delegate, or propose child work/);
  assert.match(nonDelegating, /Set delegation to null/);
  assert.match(delegating, /may propose bounded child work/);
  assert.match(delegating, /A proposal is not a spawn command/);
  assert.match(delegating, /Permitted child templates \(exact\): default-worker@1, default-critic@2/);
  assert.match(delegating, /exact permitted templateId plus its positive pinned templateVersion/);
  assert.match(delegating, /Never use "latest"/);
  assert.doesNotMatch(delegating, /Do not spawn sub-agents, delegate, or propose child work/);
  assert.notEqual(nonDelegating, delegating);
});

test('Claude structured output preserves the same normalized delegation proposal as Codex', () => {
  const task = {
    nonce: 'aos-nonce',
    mayDelegate: authority.mayDelegate,
    delegation: authority.delegation,
    budget: authority.budget,
  };
  const parsed = {
    task_nonce: task.nonce,
    status: 'succeeded',
    summary: 'Claude summary',
    findings: [],
    risks: [],
    confidence: 0.8,
    decision: null,
    retrospective: null,
    memory_writes: [],
    delegation: { tasks: [child('a'), child('b', { dependencies: ['a'] })], dependencies: null },
  };
  const expected = normalizeDelegationProposal(parsed.delegation, task);
  const normalized = normalizeStructuredOutput(parsed, task);
  assert.deepEqual(normalized.output.delegation, expected);
  assert.equal(Object.keys(normalized.output).filter((key) => key === 'delegation').length, 1);
});
