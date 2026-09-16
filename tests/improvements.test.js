import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';
import { dispatch } from '../engine/cli.js';

const PROMPT = 'Evaluate one bounded local claim. Success is one conclusion and one retrospective. Scope excludes network access.';

function engine() {
  const aos = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-improvements-')) });
  aos.load();
  return aos;
}

async function pendingImprovement(aos) {
  const goal = aos.createGoal({ prompt: PROMPT });
  if (goal.questions.some((item) => item.required)) {
    aos.answerQuestions(goal.id, goal.questions.map((item) => ({ id: item.id, answer: 'Use only deterministic local evidence.' })));
  }
  const run = aos.startRun({ goalId: goal.id, maxConcurrency: 1 });
  await aos.advanceRun(run.id, { untilIdle: true });
  return { run, proposal: aos.getProposal(aos.getRetrospective(run.id).proposalId) };
}

function evaluation(requestId, { pass = true } = {}) {
  return {
    requestId,
    benchmark: { id: 'reasoning-gate', version: '1.0', datasetFingerprint: 'abcdef0123456789', sampleSize: 100 },
    baseline: { quality: 0.72, costUsd: 1, latencyMs: 1000, verifiedRuntimeRate: 1, operatorInterventions: 2 },
    candidate: pass
      ? { quality: 0.78, costUsd: 0.9, latencyMs: 900, verifiedRuntimeRate: 1, operatorInterventions: 1 }
      : { quality: 0.6, costUsd: 2, latencyMs: 2000, verifiedRuntimeRate: 0.8, operatorInterventions: 4 },
    artifactRefs: [`bench/${requestId}.json`],
  };
}

test('an improvement cannot be approved before a passing comparable evaluation', async () => {
  const aos = engine();
  const { proposal } = await pendingImprovement(aos);
  assert.equal(proposal.evaluationRequired, true);
  assert.throws(() => aos.approveProposal(proposal.id), (error) => error.code === 'improvement_evaluation_required');

  const failed = aos.improvements.evaluate(proposal.id, evaluation('failed-eval', { pass: false }));
  assert.equal(failed.status, 'failed');
  assert.throws(() => aos.approveProposal(proposal.id), (error) => error.code === 'improvement_evaluation_required');

  const passed = aos.improvements.evaluate(proposal.id, evaluation('passed-eval'));
  assert.equal(passed.status, 'passed');
  assert.equal(passed.evidence.source, 'operator_attested');
  assert.ok(passed.checks.every((item) => item.passed));
  assert.equal(passed.rollbackTarget.value, 2);
  aos.transact(() => { aos.defaultProject().maxRetries = 3; });
  assert.throws(() => aos.approveProposal(proposal.id), (error) => error.code === 'improvement_baseline_changed');
});

test('the engine-owned deterministic runner records a replay receipt for a maxConcurrency proposal', async () => {
  const aos = engine();
  aos.transact(() => { aos.defaultProject().maxConcurrency = 1; });
  const { proposal } = await pendingImprovement(aos);
  assert.equal(proposal.payload.key, 'maxConcurrency');
  aos.transact(() => { proposal.payload.value = 2; });

  const receipt = aos.improvements.runDeterministic(proposal.id, { requestId: 'deterministic-policy-eval' });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.evidence.source, 'engine_owned_deterministic_replay');
  assert.equal(receipt.evidence.baseline.maxConcurrency, 1);
  assert.equal(receipt.evidence.candidate.maxConcurrency, 2);
  assert.equal(receipt.baseline.verifiedRuntimeRate, 0);
  assert.ok(receipt.candidate.latencyMs < receipt.baseline.latencyMs);
  assert.match(receipt.artifactRefs[0], /^aos:deterministic-scheduler:[a-f0-9]{16}$/);
  assert.deepEqual(aos.improvements.runDeterministic(proposal.id, { requestId: 'deterministic-policy-eval' }), receipt, 'request id is idempotent');
  aos.approveProposal(proposal.id);
  assert.equal(aos.getProposal(proposal.id).status, 'approved');
});

test('the deterministic runner refuses policy surfaces it does not measure', async () => {
  const aos = engine();
  const { proposal } = await pendingImprovement(aos);
  aos.transact(() => { proposal.payload = { key: 'maxRetries', value: 2 }; });
  assert.throws(
    () => aos.improvements.runDeterministic(proposal.id, { requestId: 'unsupported-policy-eval' }),
    (error) => error.code === 'deterministic_benchmark_unsupported',
  );
});

test('a deterministic replay blocks a maxConcurrency regression', async () => {
  const aos = engine();
  aos.transact(() => { aos.defaultProject().maxConcurrency = 2; });
  const { proposal } = await pendingImprovement(aos);
  aos.transact(() => { proposal.payload.value = 1; });

  const receipt = aos.improvements.runDeterministic(proposal.id, { requestId: 'regressing-policy-eval' });
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.checks.some((check) => check.metric === 'latencyMs' && !check.passed));
  assert.throws(() => aos.approveProposal(proposal.id), (error) => error.code === 'improvement_evaluation_required');
});

test('promotion versions the policy genome and rollback appends a restoring version', async () => {
  const aos = engine();
  aos.transact(() => { aos.defaultProject().maxConcurrency = null; });
  const { run, proposal } = await pendingImprovement(aos);
  aos.improvements.evaluate(proposal.id, evaluation('promotion-eval'));
  aos.approveProposal(proposal.id);
  await aos.advanceRun(run.id, { untilIdle: true });

  assert.equal(aos.defaultProject().maxConcurrency, 1);
  const genome = aos.improvements.listGenome({ projectId: aos.defaultProject().id });
  assert.deepEqual(genome.map((item) => item.action), ['baseline', 'promotion']);
  assert.equal(genome[0].values.maxConcurrency, null);
  assert.equal(genome[1].values.maxConcurrency, 1);
  assert.equal(aos.getProposal(proposal.id).genomeVersion, 2);

  const rollback = aos.improvements.rollback(genome[1].id, { reason: 'candidate regressed on held-out work' });
  assert.equal(rollback.action, 'rollback');
  assert.equal(rollback.rollbackOf, 2);
  assert.equal(aos.defaultProject().maxConcurrency, null);
  assert.deepEqual(aos.improvements.listGenome({ projectId: aos.defaultProject().id }).map((item) => item.version), [1, 2, 3]);
  assert.throws(() => aos.improvements.rollback(genome[1].id), (error) => error.code === 'improvement_rollback_stale');
});

test('HTTP evaluation and CLI genome reads share the same immutable receipts', async () => {
  const aos = engine();
  const { proposal } = await pendingImprovement(aos);
  const { listen, close, server } = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await listen();
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const response = await fetch(`${base}/proposals/${proposal.id}/evaluations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: evaluation('http-eval') }),
    });
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.status, 'passed');
    assert.deepEqual(aos.improvements.evaluate(proposal.id, evaluation('http-eval')), receipt, 'request id is idempotent');

    const second = await pendingImprovement(aos);
    aos.transact(() => {
      aos.defaultProject().maxConcurrency = 1;
      second.proposal.payload.value = 2;
    });
    const deterministic = await fetch(`${base}/proposals/${second.proposal.id}/evaluations/run-deterministic`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { requestId: 'http-deterministic-eval' } }),
    });
    assert.equal(deterministic.status, 201);
    assert.equal((await deterministic.json()).evidence.source, 'engine_owned_deterministic_replay');

    const third = await pendingImprovement(aos);
    aos.transact(() => {
      aos.defaultProject().maxConcurrency = 1;
      third.proposal.payload.value = 2;
    });
    const cliDeterministic = JSON.parse((await dispatch(aos, [
      'improvement', 'run-deterministic', third.proposal.id, '--json', '{"requestId":"cli-deterministic-eval"}',
    ])).join('\n'));
    assert.equal(cliDeterministic.evidence.source, 'engine_owned_deterministic_replay');

    const listed = JSON.parse((await dispatch(aos, ['improvement', 'evaluations', '--proposal', proposal.id])).join('\n'));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, receipt.id);
  } finally {
    await close();
  }
});
