import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { BLUEPRINT_EXPORT_FORMAT, BUILTIN_BLUEPRINTS } from '../engine/blueprints.js';
import { executeCommand } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';

const PROMPT = 'Determine whether delayed feedback destabilises coupling. Success is a bounded claim. Scope excludes clinical work.';

function engine(dataDir = mkdtempSync(join(tmpdir(), 'aos-blueprints-'))) {
  const aos = new AosEngine({ dataDir, concurrency: 2 });
  aos.load();
  return aos;
}

const baseConfig = () => ({ lead: { templateId: 'default-lead' }, childTemplates: ['default-worker', 'default-critic'], kindTemplates: { research: 'default-worker', critique: 'default-critic' } });

test('built-in blueprints validate and resolve to their templates', () => {
  const aos = engine();
  assert.equal(aos.blueprints.list().length, BUILTIN_BLUEPRINTS.length);
  for (const item of aos.blueprints.list()) {
    const record = aos.blueprints.get(item.id);
    assert.deepEqual(aos.blueprints.validate({ id: record.id, name: record.name, config: record.config }).errors, [], `${item.id} valid`);
    const view = aos.blueprints.effective(item.id);
    assert.equal(view.lead.id, record.config.lead.templateId);
    assert.equal(view.childTemplates.length, record.config.childTemplates.length);
  }
  assert.equal(aos.blueprints.effective('default-research-swarm').limits.depth, 3);
  assert.equal(aos.blueprints.effective('unbounded-research-swarm').limits.depth, 'unlimited');
  assert.equal(aos.blueprints.list().find((item) => item.id === 'unbounded-research-swarm').unlimited, true);
});

test('validation rejects unknown templates, missing limits, and impossible policies', () => {
  const aos = engine();
  const codes = (config) => { const verdict = aos.blueprints.validate({ id: 'x', name: 'x', config }); return verdict.ok ? [] : verdict.errors.map((item) => item.code).sort(); };
  assert.deepEqual(codes({ lead: { templateId: 'ghost' }, childTemplates: [] }), ['not_found']);
  assert.deepEqual(codes({ ...baseConfig(), childTemplates: ['default-worker', 'default-critic', 'ghost'] }), ['unknown_template']);
  assert.deepEqual(codes({ ...baseConfig(), depth: { max: null } }), ['limit_required']);
  assert.deepEqual(codes({ ...baseConfig(), concurrency: { global: null, perBranch: 2 } }), ['limit_required']);
  assert.deepEqual(codes({ ...baseConfig(), ceilings: { tasks: null, tokens: null, usd: null, timeMs: null } }), ['limit_required']);
  assert.deepEqual(codes({ ...baseConfig(), concurrency: { global: 2, perBranch: 5 } }), ['impossible']);
  assert.deepEqual(codes({ ...baseConfig(), depth: { max: 0 } }), ['impossible']);
  assert.deepEqual(codes({ lead: { templateId: 'default-worker' }, childTemplates: ['default-critic'] }), ['impossible']);
  assert.deepEqual(codes({ ...baseConfig(), kindTemplates: { research: 'default-analyst' } }), ['not_permitted']);
  assert.deepEqual(codes({ ...baseConfig(), gates: { verification: [{ afterKind: 'research', verifierTemplateId: 'ghost' }] } }), ['unknown_template']);
  assert.deepEqual(codes({ ...baseConfig(), routing: { rules: [{ match: { kind: 'research' }, harness: 'quantum' }] } }), ['enum']);
  assert.deepEqual(codes({ ...baseConfig(), depth: { max: null, unlimited: true }, concurrency: { global: null, unlimited: true }, ceilings: { unlimited: true } }), [], 'explicit unlimited is accepted');
});

test('create, edit, fork, archive, restore, export and import work and persist', () => {
  const aos = engine();
  const created = aos.blueprints.create({ id: 'my-swarm', name: 'My swarm', config: baseConfig() });
  assert.equal(created.version, 1);
  assert.equal(created.config.concurrency.global, 4, 'defaults filled');
  const v2 = aos.blueprints.edit('my-swarm', { config: { concurrency: { global: 8 } } });
  assert.equal(v2.config.concurrency.global, 8);
  assert.equal(v2.config.concurrency.perBranch, 2);
  const forked = aos.blueprints.fork({ fromId: 'my-swarm', id: 'my-swarm-2' });
  assert.deepEqual(forked.forkedFrom, { id: 'my-swarm', version: 2 });
  aos.blueprints.archive('my-swarm', 2);
  assert.equal(aos.blueprints.get('my-swarm').version, 1);
  assert.throws(() => aos.blueprints.archive('default-research-swarm'), (error) => error.code === 'blueprint_builtin');
  aos.blueprints.edit('default-research-swarm', { config: { depth: { max: 5 } } });
  assert.equal(aos.blueprints.get('default-research-swarm').config.depth.max, 5);
  assert.equal(aos.blueprints.restoreDefault('default-research-swarm').config.depth.max, 3);
  const payload = aos.blueprints.exportBlueprints();
  assert.equal(payload.format, BLUEPRINT_EXPORT_FORMAT);
  assert.deepEqual(payload.blueprints.map((item) => item.id), ['my-swarm', 'my-swarm-2']);
  const target = engine();
  assert.deepEqual(target.blueprints.importBlueprints(payload).imported.map((item) => item.id), ['my-swarm', 'my-swarm-2']);
  const reloaded = engine(target.store.dataDir);
  assert.equal(reloaded.blueprints.get('my-swarm-2').config.concurrency.global, 8);
});

test('dry-run estimation expands the hierarchy and flags unbounded blueprints without a fixed cap', () => {
  const aos = engine();
  const estimate = aos.blueprints.estimate('default-research-swarm');
  assert.equal(estimate.depthEstimated, 3);
  assert.deepEqual(estimate.levels.map((level) => level.maxAgents), [1, 12, 72]);
  assert.equal(estimate.totalAgents, 85);
  assert.equal(estimate.unbounded, false);
  assert.ok(estimate.totalTokens > 0);

  const unbounded = aos.blueprints.estimate('unbounded-research-swarm');
  assert.equal(unbounded.unbounded, true);
  assert.ok(unbounded.warnings.some((item) => item.includes('depth is unlimited')));
  const deeper = aos.blueprints.estimate('unbounded-research-swarm', { depth: 6 });
  assert.equal(deeper.depthEstimated, 6);

  // No product-level cap: a finite but enormous fan-out is estimated exactly.
  aos.templates.create({ id: 'fanout', name: 'Fanout', config: { preset: { id: 'branch-manager' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 10_000, maxDepth: 500, childTemplates: ['fanout'] }, variables: { branch_question: 'q' } } });
  aos.blueprints.create({ id: 'huge', name: 'Huge', config: { lead: { templateId: 'fanout' }, childTemplates: ['fanout'], depth: { max: 'unlimited' }, concurrency: { global: 'unlimited' }, ceilings: { unlimited: true } } });
  const huge = aos.blueprints.estimate('huge', { depth: 5 });
  assert.equal(huge.unbounded, true);
  assert.equal(huge.indeterminate, false);
  assert.deepEqual(huge.levels.map((level) => level.maxAgents), [1, 1e4, 1e8, 1e12, 1e16, 1e20]);
  assert.equal(aos.blueprints.get('huge').config.depth.max, null);
  assert.equal(aos.blueprints.get('huge').config.concurrency.global, null);
  // Unlimited fan-out: the topology is indeterminate and no count is invented.
  aos.templates.create({ id: 'open-fanout', name: 'Open fanout', config: { preset: { id: 'branch-manager' }, harness: { id: 'local' }, delegation: { mayDelegate: true, maxChildren: 'unlimited', maxDepth: 'unlimited', childTemplates: ['open-fanout'] }, variables: { branch_question: 'q' } } });
  assert.equal(aos.templates.get('open-fanout').config.delegation.maxChildren, null);
  assert.equal(aos.templates.get('open-fanout').config.delegation.unlimited, true);
  aos.blueprints.create({ id: 'open', name: 'Open', config: { lead: { templateId: 'open-fanout' }, childTemplates: ['open-fanout'], depth: { max: 'unlimited' }, concurrency: { global: 'unlimited' }, ceilings: { unlimited: true } } });
  const open = aos.blueprints.estimate('open', { depth: 4 });
  assert.equal(open.indeterminate, true);
  assert.equal(open.unbounded, true);
  assert.equal(open.totalAgents, null);
  assert.deepEqual(open.levels.map((level) => level.maxAgents), [1, null, null, null, null]);
  assert.ok(open.warnings.some((item) => item.includes('indeterminate')));
});

test('a run started from a blueprint applies its lead and per-kind templates and records ceilings and policies', async () => {
  const aos = engine();
  const goal = aos.createGoal({ prompt: PROMPT });
  const run = aos.startRun({ goalId: goal.id, blueprintId: 'default-research-swarm' });
  assert.deepEqual(run.blueprint, { id: 'default-research-swarm', version: 1 });
  assert.equal(run.maxConcurrency, 4, 'blueprint concurrency applied');
  assert.equal(run.ceilings.tokens, 2_000_000);
  assert.deepEqual(run.policies.gates.human, ['before_adopt', 'on_budget_exhausted']);
  const tasks = aos.state.tasks.filter((item) => item.runId === run.id);
  const byKind = Object.fromEntries(tasks.map((item) => [item.kind, item]));
  assert.equal(byKind.intake.config.templateId, 'default-lead');
  assert.equal(byKind.intake.presetId, 'lead-investigator');
  assert.equal(byKind.intake.mayDelegate, true);
  assert.equal(byKind.research.config.templateId, 'default-researcher');
  assert.equal(byKind.critique.presetId, 'adversarial-critic');
  assert.equal(byKind.synthesis.presetId, 'synthesizer');
  assert.equal(byKind.retrospective.presetId, 'retrospective-analyst');
  assert.equal(byKind.adopt.config, undefined, 'the approval gate task is never templated');

  const seen = [];
  const original = aos.workers.get('local');
  aos.workers.set('local', { id: 'local', async execute(task, ctx) { seen.push({ kind: task.kind, prompt: ctx.systemPrompt }); return original.execute(task, ctx); } });
  await aos.advanceRun(run.id, { untilIdle: true });
  const critique = seen.find((item) => item.kind === 'critique');
  assert.ok(critique.prompt.includes('Your target:'), 'critic target derived from dependency results');
  assert.ok(critique.prompt.includes('Primary analysis'), 'dependency findings reached the derived target');
  const synthesis = seen.find((item) => item.kind === 'synthesis');
  assert.ok(synthesis.prompt.includes('You synthesize run ' + run.id));
  const retro = seen.find((item) => item.kind === 'retrospective');
  assert.ok(retro.prompt.includes('Run ' + run.id + ': status'), 'run record derived from telemetry');
  assert.equal(aos.getRun(run.id).status, 'awaiting_approval');
  assert.equal(aos.store.readEventLog().some((event) => event.type === 'prompt.render_failed'), false);
});

test('a blueprint ceiling on tasks and an unlimited blueprint both apply at run start', () => {
  const aos = engine();
  aos.blueprints.create({ id: 'tiny', name: 'Tiny', config: { ...baseConfig(), ceilings: { tasks: 3 } } });
  const goal = aos.createGoal({ prompt: PROMPT });
  assert.throws(() => aos.startRun({ goalId: goal.id, blueprintId: 'tiny' }), (error) => error.code === 'blueprint_ceiling' && error.details.ceiling === 3);
  assert.equal(aos.state.runs.length, 0);
  const run = aos.startRun({ goalId: goal.id, blueprintId: 'unbounded-research-swarm' });
  assert.equal(run.maxConcurrency, null, 'unlimited concurrency means no engine cap');
  assert.deepEqual(run.ceilings, { unlimited: true });
  assert.throws(() => aos.startRun({ goalId: goal.id, blueprintId: 'ghost' }), (error) => error.code === 'not_found');
});

test('CLI and HTTP accept a blueprint when starting a run', async () => {
  const aos = engine();
  const created = await executeCommand(aos, `goal create "${PROMPT}"`);
  const goalId = created.lines[0].split(' ')[1];
  const started = await executeCommand(aos, `run start ${goalId} --blueprint small-audit-swarm`);
  assert.equal(started.ok, true);
  assert.match(started.lines[0], /blueprint small-audit-swarm@1/);
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1' });
  await listen();
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goalId, blueprintId: 'default-research-swarm' }) });
  assert.equal(response.status, 201);
  const run = await response.json();
  assert.deepEqual(run.blueprint, { id: 'default-research-swarm', version: 1 });
  const bad = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goalId, blueprintId: 'ghost' }) });
  assert.equal(bad.status, 404);
  assert.equal((await bad.json()).code, 'not_found');
  await close();
});
