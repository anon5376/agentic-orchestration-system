import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { buildWorkerPrompt } from '../engine/codex.js';
import { BUILTIN_TEMPLATES, TEMPLATE_EXPORT_FORMAT, applyTemplateToTask } from '../engine/templates.js';

const PROMPT = 'Template objective with success criteria and a bounded scope.';

function engine(dataDir = mkdtempSync(join(tmpdir(), 'aos-templates-'))) {
  const aos = new AosEngine({ dataDir, concurrency: 3 });
  aos.load();
  return aos;
}

function captureWorker(aos, seen) {
  aos.workers.set('local', {
    id: 'local',
    async execute(task, ctx) {
      seen.push({ key: task.key, systemPrompt: ctx.systemPrompt, task: structuredClone(task) });
      return { status: 'succeeded', summary: `${task.key} done` };
    },
  });
}

const criticConfig = () => ({ preset: { id: 'adversarial-critic' }, harness: { id: 'local' }, retry: { maxRetries: 2 }, timeoutMs: 120_000, budget: { tokens: 50_000, usd: 1.5 }, variables: { target: 'the branch finding' } });

test('built-in templates exist, resolve their presets, and validate', () => {
  const aos = engine();
  const list = aos.templates.list();
  assert.equal(list.length, BUILTIN_TEMPLATES.length);
  assert.ok(list.every((item) => item.builtin && item.headVersion === 1));
  for (const item of list) {
    const record = aos.templates.get(item.id);
    const verdict = aos.templates.validate({ id: record.id, name: record.name, config: record.config });
    assert.deepEqual(verdict.errors, [], `${item.id} valid`);
    assert.ok(aos.presets.effective(record.config.preset.id));
  }
  assert.equal(aos.templates.get('default-lead').config.delegation.maxChildren, 12);
  assert.equal(aos.templates.get('default-worker').config.filesystem.sandbox, 'read_only');
});

test('create, edit, fork, archive, restore, history, export and import behave like versioned records', () => {
  const aos = engine();
  const created = aos.templates.create({ id: 'strict-critic', name: 'Strict critic', config: criticConfig() });
  assert.equal(created.version, 1);
  assert.equal(created.config.delegation.mayDelegate, false, 'defaults filled in');
  const v2 = aos.templates.edit('strict-critic', { config: { budget: { tokens: 20_000 } }, note: 'cheaper' });
  assert.equal(v2.version, 2);
  assert.equal(v2.config.budget.tokens, 20_000);
  assert.equal(v2.config.budget.usd, 1.5, 'deep merge keeps untouched fields');
  assert.equal(v2.config.variables.target, 'the branch finding');
  const forked = aos.templates.fork({ fromId: 'strict-critic', id: 'strict-critic-2' });
  assert.deepEqual(forked.forkedFrom, { id: 'strict-critic', version: 2 });
  aos.templates.archive('strict-critic', 2);
  assert.equal(aos.templates.get('strict-critic').version, 1);
  assert.deepEqual(aos.templates.history('strict-critic').map((item) => [item.version, item.archived]), [[1, false], [2, true]]);
  const edited = aos.templates.edit('default-worker', { config: { budget: { tokens: 1 } } });
  assert.equal(edited.version, 2);
  assert.equal(aos.templates.get('default-worker').builtin, false);
  assert.throws(() => aos.templates.archive('default-worker', 1), (error) => error.code === 'template_builtin');
  assert.equal(aos.templates.restoreDefault('default-worker').builtin, true);

  const payload = aos.templates.exportTemplates();
  assert.equal(payload.format, TEMPLATE_EXPORT_FORMAT);
  assert.deepEqual(payload.templates.map((item) => `${item.id}@${item.version}`), ['strict-critic@1', 'strict-critic-2@1']);
  const target = engine();
  const report = target.templates.importTemplates(payload);
  assert.deepEqual(report.imported, [{ id: 'strict-critic', version: 1 }, { id: 'strict-critic-2', version: 1 }]);
  assert.deepEqual(target.templates.get('strict-critic').config, aos.templates.get('strict-critic').config);
  const reloaded = engine(target.store.dataDir);
  assert.equal(reloaded.templates.get('strict-critic-2').forkedFrom, null, 'imports carry no fork provenance');
  assert.equal(reloaded.templates.get('strict-critic').version, 1);
});

test('validation rejects unknown presets, incoherent delegation, sandbox and network combinations, and bad values', () => {
  const aos = engine();
  const base = { id: 'bad', name: 'Bad' };
  const codeOf = (config) => { const verdict = aos.templates.validate({ ...base, config }); return verdict.ok ? null : verdict.errors.map((item) => item.code); };
  assert.deepEqual(codeOf({ preset: { id: 'no-such-preset' }, harness: { id: 'local' } }), ['not_found']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'quantum' } }), ['enum']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: false, maxChildren: 3 } }), ['inconsistent']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 0 } }), ['inconsistent']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, filesystem: { sandbox: 'read_only', writePaths: ['out'] } }), ['inconsistent']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, network: { allowed: true } }), ['inconsistent']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, budget: { usd: -1 } }), ['min']);
  assert.equal(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 1e9, maxDepth: 1e6 } }), null, 'no product-level cap on fan-out or depth');
  assert.equal(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 'unlimited', maxDepth: 'unlimited' } }), null, 'explicit unlimited accepted');
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: false, maxChildren: 'unlimited' } }), ['inconsistent']);
  assert.deepEqual(codeOf({ preset: { id: 'general-worker' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 2, childTemplates: ['ghost'] } }), ['unknown_template']);
  assert.throws(() => aos.templates.create({ ...base, config: { preset: { id: 'general-worker' }, harness: { id: 'local' }, extra: true } }), (error) => error.code === 'invalid_input');
  assert.throws(() => aos.templates.create({ id: 'default-lead', name: 'dup', config: { preset: { id: 'general-worker' }, harness: { id: 'local' } } }), (error) => error.code === 'template_exists');
});

test('a plan task that names a template is instantiated with the template applied and overrides recorded', async () => {
  const aos = engine();
  const seen = [];
  captureWorker(aos, seen);
  aos.templates.create({ id: 'strict-critic', name: 'Strict critic', config: criticConfig() });
  const goal = aos.createGoal({
    prompt: PROMPT,
    plan: {
      tasks: [
        { id: 'C', key: 'C', title: 'Critique', kind: 'critique', templateId: 'strict-critic', timeoutMs: 5_000, brief: 'Attack the finding about coupling.' },
        { id: 'W', key: 'W', title: 'Plain', kind: 'research', worker: 'local' },
      ],
      dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  const critic = aos.state.tasks.find((item) => item.runId === run.id && item.key === 'C');
  assert.equal(critic.presetId, 'adversarial-critic');
  assert.equal(critic.worker, 'local');
  assert.equal(critic.maxRetries, 2);
  assert.equal(critic.timeoutMs, 5_000, 'plan value wins');
  assert.deepEqual(critic.config.overrides, ['timeoutMs']);
  assert.equal(critic.config.templateId, 'strict-critic');
  assert.equal(critic.budget.tokens, 50_000);
  assert.equal(critic.sandbox, 'read_only');
  assert.equal(critic.variables.target, 'the branch finding');
  const plain = aos.state.tasks.find((item) => item.runId === run.id && item.key === 'W');
  assert.equal(plain.presetId, undefined);
  assert.equal(plain.config, undefined);

  await aos.advanceRun(run.id, { untilIdle: true });
  const criticCall = seen.find((item) => item.key === 'C');
  assert.ok(criticCall.systemPrompt.startsWith('## Mission'), 'rendered preset is the system prompt');
  assert.ok(criticCall.systemPrompt.includes('You are the adversarial critic for run ' + run.id));
  assert.ok(criticCall.systemPrompt.includes('Your target: the branch finding'));
  assert.ok(criticCall.systemPrompt.includes('Attack the finding about coupling.'));
  assert.ok(criticCall.systemPrompt.includes(critic.nonce));
  assert.ok(criticCall.systemPrompt.includes('At most 50000 tokens, 1.5 USD for this task.'));
  assert.equal(/\{\{/.test(criticCall.systemPrompt), false);
  assert.equal(seen.find((item) => item.key === 'W').systemPrompt, null, 'a task without a preset gets no system prompt');
  assert.ok(aos.store.readEventLog().some((event) => event.type === 'prompt.rendered' && event.taskId === critic.id));
  assert.equal(aos.getRun(run.id).status, 'completed');
});

test('run start fails before any mutation when a preset requires variables the task does not supply', () => {
  const aos = engine();
  // A user preset with a required variable the engine cannot derive.
  aos.presets.create({ id: 'subject-worker', name: 'Subject worker', role: 'worker', extends: { id: 'general-worker' }, variables: { subject: { type: 'string', required: true } }, sections: { Mission: 'Study {{subject}} only.' } });
  aos.templates.create({ id: 'subject-template', name: 'Subject template', config: { preset: { id: 'subject-worker' }, harness: { id: 'local' } } });
  const goal = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'B', key: 'B', title: 'Subject', kind: 'research', templateId: 'subject-template' }], dependencies: [] } });
  const runsBefore = aos.state.runs.length;
  assert.throws(() => aos.startRun({ goalId: goal.id }), (error) => error.code === 'invalid_input' && error.details.missing.includes('subject'));
  assert.equal(aos.state.runs.length, runsBefore);
  assert.equal(aos.state.tasks.filter((item) => item.goalId === goal.id).length, 0);
  const derived = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'B', key: 'B', title: 'Branch', kind: 'research', templateId: 'default-branch-manager' }], dependencies: [] } });
  assert.ok(aos.startRun({ goalId: derived.id }).id, 'branch_question is derived from the brief, so no variable is required');
  const ok = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'B', key: 'B', title: 'Subject', kind: 'research', templateId: 'subject-template', variables: { subject: 'coupling' } }], dependencies: [] } });
  assert.ok(aos.startRun({ goalId: ok.id }).id);
  const missingTemplate = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'T', key: 'T', title: 'T', kind: 'research', templateId: 'ghost' }], dependencies: [] } });
  assert.throws(() => aos.startRun({ goalId: missingTemplate.id }), (error) => error.code === 'not_found');
});

test('a task with a preset but no template renders too, and the Codex prompt carries the system prompt first', () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'P', key: 'P', title: 'Plain preset', kind: 'research', presetId: 'general-worker', worker: 'local' }], dependencies: [] } });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  assert.equal(task.presetId, 'general-worker');
  const prompt = buildWorkerPrompt({ ...task, attempts: 1 }, { run, goal, systemPrompt: '## Mission\n\nBe the worker.', dependencies: [], repoRoot: null, eventsPath: null });
  assert.ok(prompt.startsWith('## Mission\n\nBe the worker.\n\n---\n\n# AOS worker assignment'));
  const plain = buildWorkerPrompt({ ...task, attempts: 1 }, { run, goal, dependencies: [], repoRoot: null, eventsPath: null });
  assert.ok(plain.startsWith('# AOS worker assignment'));
});

test('a live task can be saved as a template that reproduces its configuration', async () => {
  const aos = engine();
  const seen = [];
  captureWorker(aos, seen);
  aos.templates.create({ id: 'strict-critic', name: 'Strict critic', config: criticConfig() });
  const goal = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'C', key: 'C', title: 'Critique', kind: 'critique', templateId: 'strict-critic', timeoutMs: 7_000 }], dependencies: [] } });
  const run = aos.startRun({ goalId: goal.id });
  await aos.advanceRun(run.id, { untilIdle: true });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  const saved = aos.templates.saveFromAgent({ taskId: task.id, id: 'critic-as-run', name: 'Critic as run' });
  assert.equal(saved.provenance.via, 'save_from_agent');
  assert.equal(saved.provenance.taskId, task.id);
  assert.equal(saved.provenance.templateId, 'strict-critic');
  assert.equal(saved.config.timeoutMs, 7_000, 'the applied override is what gets saved');
  assert.equal(saved.config.budget.tokens, 50_000);
  assert.equal(saved.config.preset.id, 'adversarial-critic');

  const legacy = aos.createGoal({ prompt: PROMPT });
  const legacyRun = aos.startRun({ goalId: legacy.id });
  const legacyTask = aos.state.tasks.find((item) => item.runId === legacyRun.id && item.kind === 'critique');
  const fromLegacy = aos.templates.saveFromAgent({ taskId: legacyTask.id, id: 'legacy-critique' });
  assert.equal(fromLegacy.config.preset.id, 'adversarial-critic', 'kind maps to a preset for untemplated tasks');
  assert.equal(fromLegacy.config.harness.id, 'local');

  const replay = aos.createGoal({ prompt: PROMPT, plan: { tasks: [{ id: 'C2', key: 'C2', title: 'Critique again', kind: 'critique', templateId: 'critic-as-run' }], dependencies: [] } });
  const replayRun = aos.startRun({ goalId: replay.id });
  const replayed = aos.state.tasks.find((item) => item.runId === replayRun.id);
  assert.equal(replayed.timeoutMs, 7_000);
  assert.deepEqual(replayed.config.overrides, []);
  const events = readFileSync(aos.store.eventsPath, 'utf8');
  assert.ok(events.includes('"type":"template.saved_from_agent"'));
});

test('applyTemplateToTask records every plan override and leaves untouched fields to the template', () => {
  const template = BUILTIN_TEMPLATES.find((item) => item.id === 'default-worker');
  const task = applyTemplateToTask({}, { budget: { usd: 2 }, sandbox: 'workspace_write', variables: { language: 'terse' } }, template);
  assert.deepEqual(task.config.overrides, ['budget', 'sandbox', 'variables']);
  assert.equal(task.budget.tokens, 60_000, 'template value kept where the plan is silent');
  assert.equal(task.budget.usd, 2);
  assert.equal(task.sandbox, 'workspace_write');
  assert.equal(task.maxRetries, 1);
  assert.equal(task.presetId, 'general-worker');
});
