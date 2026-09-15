import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { MEMORY_EXPORT_FORMAT } from '../engine/memory/index.js';
import { resolveMemoryPolicy } from '../engine/memory/policy.js';

const PROMPT = 'Memory objective with success criteria and a bounded scope.';

function engine(dataDir = mkdtempSync(join(tmpdir(), 'aos-memory-')), globalDir = mkdtempSync(join(tmpdir(), 'aos-memory-global-'))) {
  const aos = new AosEngine({ dataDir, concurrency: 2, memory: { globalDir } });
  aos.load();
  return aos;
}

function enable(aos, extra = {}) {
  aos.memory.setPolicy('global', null, { enabled: true });
  aos.memory.setPolicy('project', aos.defaultProject().id, { enabled: true, ...extra });
}

// A worker that captures the system prompt and can propose memory writes per task key.
function memoryWorker(aos, { writes = {}, seen = [] } = {}) {
  aos.workers.set('local', {
    id: 'local',
    async execute(task, ctx) {
      seen.push({ key: task.key, prompt: ctx.systemPrompt });
      return { status: 'succeeded', summary: `${task.key} done`, result: { findings: [], memory_writes: writes[task.key] || [] } };
    },
  });
  return seen;
}

function plan(keys, deps = []) {
  return { tasks: keys.map((key) => ({ id: key, key, title: `Task ${key}`, kind: 'research', worker: 'local', presetId: 'general-worker', brief: `Investigate ${key} coupling stability` })), dependencies: deps.map(([taskId, dependsOnTaskId]) => ({ taskId, dependsOnTaskId })) };
}

const write = (scope, title, content, extra = {}) => ({ scope, type: 'fact', title, content, tags: ['coupling'], confidence: 0.8, sensitivity: 'normal', ...extra });

test('memory is off by default: no retrieval, no writes, no files, and the prompt says so', async () => {
  const aos = engine();
  const seen = memoryWorker(aos, { writes: { A: [write('run', 'Coupling fact', 'Delayed feedback destabilises coupling above 40 ms.')] } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A', 'B'], [['B', 'A']]) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.ok(seen.find((item) => item.key === 'A').prompt.includes('Memory is disabled for this task'));
  assert.ok(seen.find((item) => item.key === 'B').prompt.includes('Memory is disabled for this task'));
  assert.equal(existsSync(join(aos.store.dataDir, 'memory')), false, 'no memory directory was created');
  assert.equal(readdirSync(aos.memory.globalDir).length, 0, 'global directory untouched');
  const events = aos.store.readEventLog();
  assert.ok(events.some((event) => event.type === 'memory.write_skipped' && event.payload.reason === 'memory disabled'));
  assert.equal(events.some((event) => event.type === 'memory.retrieved'), false);
  assert.deepEqual(aos.state.memoryIndex, []);
  assert.equal(resolveMemoryPolicy({}).enabled, false);
});

test('when enabled, worker writes land by scope policy and later tasks retrieve them into their prompts', async () => {
  const aos = engine();
  enable(aos);
  const seen = memoryWorker(aos, { writes: {
    A: [write('run', 'Coupling threshold', 'Delayed feedback destabilises coupling above 40 ms of delay.'), write('project', 'Project lesson', 'Always check the timing constraint first.', { type: 'failure_lesson' })],
  } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A', 'B'], [['B', 'A']]) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const promptB = seen.find((item) => item.key === 'B').prompt;
  assert.ok(promptB.includes('Coupling threshold'), 'the run-scope item reached the next task');
  assert.ok(promptB.includes('[mem_'), 'items carry their ids');
  assert.equal(promptB.includes('Project lesson'), false, 'a proposed project item is not retrieved until committed');
  assert.ok(existsSync(join(aos.store.dataDir, 'memory', 'runs', run.id, 'items.jsonl')));
  assert.ok(existsSync(join(aos.store.dataDir, 'memory', 'project', run.projectId, 'items.jsonl')));
  const index = aos.state.memoryIndex;
  assert.equal(index.filter((item) => item.scope === 'run' && item.status === 'committed').length >= 1, true);
  assert.equal(index.filter((item) => item.scope === 'project' && item.status === 'proposed').length, 1);
  const events = readFileSync(aos.store.eventsPath, 'utf8');
  assert.ok(events.includes('"type":"memory.written"'));
  assert.ok(events.includes('"type":"memory.proposed"'));
  assert.ok(events.includes('"type":"memory.retrieved"'));
  assert.equal(events.includes('destabilises coupling above 40 ms'), false, 'events never carry content');

  const proposed = index.find((item) => item.scope === 'project');
  aos.memory.commit(proposed.id, { actor: 'curator' });
  const seen2 = memoryWorker(aos);
  const goal2 = aos.createGoal({ prompt: PROMPT, plan: plan(['C']) });
  const run2 = aos.startRun({ goalId: goal2.id });
  await aos.advanceRun(run2.id, { untilIdle: true });
  const promptC = seen2.find((item) => item.key === 'C').prompt;
  assert.ok(promptC.includes('Project lesson'), 'committed project memory reaches a later run');
  assert.equal(promptC.includes('Coupling threshold'), false, 'run-scope memory of another run is not visible');
  const reloaded = engine(aos.store.dataDir, aos.memory.globalDir);
  assert.equal(reloaded.memory.inspect(proposed.id).title, 'Project lesson');
});

test('namespaces isolate projects and a template can turn memory off for one task', async () => {
  const aos = engine();
  enable(aos);
  const other = aos.createProject({ name: 'Other' });
  aos.memory.setPolicy('project', other.id, { enabled: true });
  aos.memory.add('project', aos.defaultProject().id, write('project', 'Only in the first project', 'Coupling stability fact for project one.'));
  const seen = memoryWorker(aos);
  const goal = aos.createGoal({ projectId: other.id, prompt: PROMPT, plan: plan(['X']) });
  const run = aos.startRun({ goalId: goal.id, projectId: other.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(seen[0].prompt.includes('Only in the first project'), false);
  assert.ok(seen[0].prompt.includes('Memory is enabled but nothing relevant was found'));

  aos.templates.create({ id: 'no-memory', name: 'No memory', config: { preset: { id: 'general-worker' }, harness: { id: 'local' }, memory: { read: false, write: false } } });
  const seen2 = memoryWorker(aos, { writes: { Y: [write('run', 'Should be skipped', 'Nothing here.')] } });
  const goal2 = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'Y', key: 'Y', title: 'Y', kind: 'research', templateId: 'no-memory', brief: 'coupling' }], dependencies: [] } });
  const run2 = aos.startRun({ goalId: goal2.id });
  await aos.advanceRun(run2.id, { untilIdle: true });
  assert.ok(seen2[0].prompt.includes('Memory is disabled for this task'));
  assert.equal(aos.state.memoryIndex.some((item) => item.title === 'Should be skipped'), false);
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'memory.write_skipped' && event.payload.reason === 'writes disabled'));
});

test('a role memory policy narrows every agent using that role', () => {
  const aos = engine();
  enable(aos);
  aos.memory.setPolicy('role', 'general-worker', { read: false, scopes: ['agent', 'run'] });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A']) });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  const policy = aos.memory.policyFor({ run, task });
  assert.equal(policy.enabled, true, 'the enabled global and project layers remain active');
  assert.equal(policy.read, false, 'the role layer narrows retrieval for agents using the preset');
  assert.deepEqual(policy.scopes, ['agent', 'run']);
});

test('retrieval ranks by tags, title and recency and respects per-query limits', () => {
  const aos = engine();
  enable(aos, { maxItemsPerQuery: 2 });
  const project = aos.defaultProject().id;
  aos.memory.add('project', project, { scope: 'project', type: 'fact', title: 'Unrelated note', content: 'The cafeteria opens at nine.', tags: ['office'], confidence: 0.9 });
  aos.memory.add('project', project, { scope: 'project', type: 'decision', title: 'Coupling timing decision', content: 'Delay above 40 ms is the failure boundary for coupling.', tags: ['coupling', 'timing'], confidence: 0.9 });
  aos.memory.add('project', project, { scope: 'project', type: 'fact', title: 'Coupling instrument', content: 'The nerve interface samples coupling every 2 ms.', tags: ['coupling'], confidence: 0.6 });
  const goal = aos.createGoal({ prompt: 'Coupling timing failure boundary. Success is a bounded claim. Scope excludes clinical work.', plan: plan(['A']) });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  const result = aos.memory.retrieveForTask(run, task, { query: 'coupling timing failure boundary' });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, 'Coupling timing decision');
  assert.equal(result.items.some((item) => item.title === 'Unrelated note'), false);
  const search = aos.memory.search({ query: 'cafeteria', limit: 5 });
  assert.equal(search.items[0].title, 'Unrelated note');
});

test('secret-like content is refused without failing the task, control characters are stripped, and sensitive items never promote', async () => {
  const aos = engine();
  enable(aos);
  const seen = memoryWorker(aos, { writes: { A: [
    write('run', 'Leaked key', 'The key is sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    write('run', `Noisy${String.fromCharCode(7)} title`, 'Clean content.'),
    write('run', 'Private observation', 'Founder prefers terse reports.', { type: 'preference', sensitivity: 'sensitive' }),
  ] } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A']) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(aos.getRun(run.id).status, 'completed', 'the task succeeded despite the refused write');
  const events = aos.store.readEventLog();
  assert.ok(events.some((event) => event.type === 'memory.write_failed' && event.payload.code === 'memory_secret_like'));
  const index = aos.state.memoryIndex;
  assert.equal(index.some((item) => item.title === 'Leaked key'), false);
  assert.ok(index.some((item) => item.title === 'Noisy title'));
  const sensitive = index.find((item) => item.title === 'Private observation');
  assert.throws(() => aos.memory.promote(sensitive.id, 'project'), (error) => error.code === 'memory_sensitive');
  assert.equal(aos.memory.diagnostics.writeFailures, 1);
});

test('correct supersedes, pin protects, forget tombstones, and search hides inactive items', () => {
  const aos = engine();
  enable(aos);
  const project = aos.defaultProject().id;
  const original = aos.memory.add('project', project, write('project', 'Threshold', 'Failure above 40 ms.'));
  const corrected = aos.memory.correct(original.id, { content: 'Failure above 45 ms after recalibration.' });
  assert.equal(corrected.supersedes, original.id);
  assert.equal(aos.memory.inspect(original.id).supersededBy, corrected.id);
  assert.equal(aos.memory.search({ query: 'threshold' }).items.map((item) => item.id).includes(original.id), false);
  assert.ok(aos.memory.search({ query: 'threshold' }).items.some((item) => item.id === corrected.id));
  const sameTitle = aos.memory.add('project', project, write('project', 'Threshold', 'A third value, 50 ms.'));
  assert.equal(aos.memory.inspect(corrected.id).supersededBy, sameTitle.id, 'a committed item with the same title is superseded');
  aos.memory.pin(sameTitle.id);
  assert.throws(() => aos.memory.forget(sameTitle.id, 'test', { actor: 'curator' }), (error) => error.code === 'memory_pinned');
  aos.memory.forget(sameTitle.id, 'no longer true');
  assert.equal(aos.memory.inspect(sameTitle.id).tombstoned, true);
  assert.equal(aos.memory.search({ query: 'threshold' }).items.length, 0);
  assert.equal(aos.memory.search({ query: 'threshold', includeInactive: true }).items.length, 3);
  const duplicate = aos.memory.add('project', project, write('project', 'Fresh', 'Same content twice.'));
  const again = aos.memory.add('project', project, write('project', 'Fresh', 'Same content twice.'));
  assert.equal(again.id, duplicate.id, 'exact duplicates are not stored twice');
});

test('promotion follows policy: auto, curator, or the approval gate, and workers cannot self-promote', async () => {
  const aos = engine();
  enable(aos);
  const seen = memoryWorker(aos, { writes: { A: [write('agent', 'Agent note', 'Coupling observation from one agent.'), write('run', 'Run fact', 'Coupling fact for the run.')] } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A']) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const agentItem = aos.state.memoryIndex.find((item) => item.title === 'Agent note');
  const runItem = aos.state.memoryIndex.find((item) => item.title === 'Run fact');
  const promotedToRun = aos.memory.promote(agentItem.id, 'run', { actor: 'worker' });
  assert.equal(promotedToRun.scope, 'run', 'agent to run is automatic');
  const asWorker = aos.memory.promote(runItem.id, 'project', { actor: 'worker' });
  assert.equal(asWorker.proposed, true, 'a worker gets a proposal instead of a promotion');
  const asOperator = aos.memory.promote(runItem.id, 'project', { actor: 'operator' });
  assert.equal(asOperator.scope, 'project');
  assert.equal(asOperator.provenance.promotedFrom, runItem.id);
  const toGlobal = aos.memory.promote(asOperator.id, 'global', { actor: 'operator' });
  assert.equal(toGlobal.proposed, true, 'global promotion always needs the approval gate');
  assert.equal(readdirSync(aos.memory.globalDir).length, 0);
  aos.approveProposal(toGlobal.proposalId);
  assert.ok(existsSync(join(aos.memory.globalDir, 'items.jsonl')), 'approval applied the promotion into the global store');
  assert.ok(aos.state.memoryIndex.some((item) => item.scope === 'global' && item.title === 'Run fact'));
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'memory.promoted' && event.payload.fromScope === 'project'));
  assert.equal(aos.getProposal(toGlobal.proposalId).applied, true);
});

test('retention expires and evicts, clear-scope needs confirmation or approval, and reflection summarises a finished run', async () => {
  const aos = engine();
  enable(aos, { maxItemsPerScope: { project: 3 } });
  const project = aos.defaultProject().id;
  aos.memory.add('project', project, write('project', 'Expired', 'Old.', { expiresAt: new Date(Date.now() - 1000).toISOString() }));
  for (let index = 0; index < 4; index += 1) aos.memory.add('project', project, write('project', `Item ${index}`, `Content ${index}.`, { confidence: 0.1 * (index + 1) }));
  const report = aos.memory.runRetention();
  assert.deepEqual(report, [{ scope: 'project', namespace: project, expired: 1, evicted: 1 }]);
  assert.equal(aos.state.memoryIndex.filter((item) => item.scope === 'project' && !item.tombstoned).length, 3);
  assert.equal(aos.state.memoryIndex.find((item) => item.title === 'Item 0').tombstoned, true, 'the lowest-confidence item was evicted');

  const pending = aos.memory.clearScope('project', project);
  assert.equal(pending.proposed, true);
  assert.equal(aos.state.memoryIndex.filter((item) => item.scope === 'project' && !item.tombstoned).length, 3, 'nothing cleared before approval');
  aos.approveProposal(pending.proposalId);
  assert.equal(aos.state.memoryIndex.filter((item) => item.scope === 'project').length, 0, 'approval cleared the scope');
  aos.memory.add('project', project, write('project', 'Again', 'Back.'));
  assert.deepEqual(aos.memory.clearScope('project', project, { confirm: true }), { cleared: 1 });

  memoryWorker(aos);
  const goal = aos.createGoal({ prompt: PROMPT, plan: plan(['A']) });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const summary = aos.state.memoryIndex.find((item) => item.scope === 'run' && item.type === 'summary');
  assert.ok(summary, 'run reflection wrote a summary');
  assert.ok(aos.memory.inspect(summary.id).content.includes(`Run ${run.id} ended completed`));
});

test('export and import round-trip a scope and importing skips inactive items', () => {
  const aos = engine();
  enable(aos);
  const project = aos.defaultProject().id;
  const kept = aos.memory.add('project', project, write('project', 'Keep me', 'Portable fact.'));
  const gone = aos.memory.add('project', project, write('project', 'Drop me', 'Old fact.'));
  aos.memory.forget(gone.id);
  const payload = aos.memory.exportScope('project', project);
  assert.equal(payload.format, MEMORY_EXPORT_FORMAT);
  assert.deepEqual(payload.items.map((item) => item.id), [kept.id]);
  const target = engine();
  enable(target);
  const report = target.memory.importScope(payload, { scope: 'project', namespace: target.defaultProject().id });
  assert.equal(report.imported.length, 1);
  assert.equal(target.memory.search({ query: 'portable' }).items[0].title, 'Keep me');
  assert.equal(target.memory.search({ query: 'portable' }).items[0].provenance.importedFrom, kept.id);
  assert.throws(() => target.memory.importScope({ format: 'nope' }), (error) => error.code === 'invalid_input');
  assert.equal(engine(target.store.dataDir, target.memory.globalDir).memory.stats().scopes.project.committed, 1);
});
