import test from 'node:test';
import assert from 'node:assert/strict';
import { DETERMINISTIC_SCHEDULER_BENCHMARK, runDeterministicSchedulerBenchmark } from '../engine/evaluation-runner.js';

test('the deterministic scheduler runner fingerprints a frozen suite and measures only scheduler replay', () => {
  const result = runDeterministicSchedulerBenchmark({ baselineMaxConcurrency: 1, candidateMaxConcurrency: 2 });
  assert.equal(result.input.benchmark.id, DETERMINISTIC_SCHEDULER_BENCHMARK.id);
  assert.equal(result.input.benchmark.version, DETERMINISTIC_SCHEDULER_BENCHMARK.version);
  assert.equal(result.input.benchmark.sampleSize, 2);
  assert.equal(result.input.baseline.quality, 1);
  assert.equal(result.input.candidate.quality, 1);
  assert.equal(result.input.baseline.costUsd, 0);
  assert.equal(result.input.candidate.verifiedRuntimeRate, 0);
  assert.ok(result.input.candidate.latencyMs < result.input.baseline.latencyMs);
  assert.match(result.input.artifactRefs[0], /^aos:deterministic-scheduler:[a-f0-9]{16}$/);
  assert.equal(result.evidence.source, 'engine_owned_deterministic_replay');
  assert.deepEqual(result.evidence.exclusions, [...DETERMINISTIC_SCHEDULER_BENCHMARK.exclusions]);
  assert.ok(result.evidence.baseline.cases.every((item) => item.violations.length === 0 && item.stuck.length === 0));
});

test('the deterministic scheduler runner fails closed on an invalid cap', () => {
  assert.throws(
    () => runDeterministicSchedulerBenchmark({ baselineMaxConcurrency: 1, candidateMaxConcurrency: 0 }),
    (error) => error.code === 'deterministic_benchmark_policy_invalid',
  );
});
