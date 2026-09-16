// Engine-owned, deterministic evaluation for one narrow policy surface. It replays
// fixed-duration scheduler fixtures; it does not invoke a model or provider.
import { fingerprint } from './ids.js';
import { AosError } from './schema.js';
import { replayMetrics } from './metrics.js';

export const DETERMINISTIC_SCHEDULER_BENCHMARK = Object.freeze({
  id: 'aos.scheduler-cap-replay',
  version: '1',
  claimBoundary: 'Measures only the AOS scheduler replay under a changed maxConcurrency policy.',
  exclusions: Object.freeze([
    'model quality',
    'provider cost or latency',
    'live provider attestation',
    'cross-product superiority',
  ]),
});

// The fixtures are deliberately small, static and dependency-only. Keeping them in
// code makes their inputs, version and content fingerprint part of each receipt.
const SCHEDULER_SUITE = Object.freeze([
  {
    id: 'fanout-join',
    tasks: [
      { key: 'A', attempts: [7] },
      { key: 'B', attempts: [4] },
      { key: 'C', attempts: [6] },
      { key: 'D', attempts: [3] },
      { key: 'E', attempts: [5] },
      { key: 'F', attempts: [8] },
    ],
    dependencies: [
      { task: 'E', dependsOn: 'A' },
      { task: 'E', dependsOn: 'B' },
      { task: 'E', dependsOn: 'C' },
      { task: 'E', dependsOn: 'D' },
      { task: 'F', dependsOn: 'E' },
    ],
  },
  {
    id: 'staged-branches',
    tasks: [
      { key: 'P', attempts: [2] },
      { key: 'Q', attempts: [9] },
      { key: 'R', attempts: [5] },
      { key: 'S', attempts: [4] },
      { key: 'T', attempts: [6] },
      { key: 'U', attempts: [3] },
      { key: 'V', attempts: [7] },
    ],
    dependencies: [
      { task: 'Q', dependsOn: 'P' },
      { task: 'R', dependsOn: 'P' },
      { task: 'S', dependsOn: 'P' },
      { task: 'T', dependsOn: 'Q' },
      { task: 'U', dependsOn: 'R' },
      { task: 'V', dependsOn: 'T' },
      { task: 'V', dependsOn: 'U' },
      { task: 'V', dependsOn: 'S' },
    ],
  },
]);

const DATASET_FINGERPRINT = fingerprint(JSON.stringify(SCHEDULER_SUITE));

function assertMaxConcurrency(value, label) {
  if (value === null) return value;
  if (!Number.isInteger(value) || value < 1) {
    throw new AosError('deterministic_benchmark_policy_invalid', `${label} maxConcurrency must be a positive integer or null`, {
      statusCode: 409,
      details: { label, value },
    });
  }
  return value;
}

function runSuite(maxConcurrency) {
  return SCHEDULER_SUITE.map((fixture) => {
    const replay = replayMetrics({
      tasks: fixture.tasks,
      dependencies: fixture.dependencies,
      cap: maxConcurrency,
    });
    return {
      id: fixture.id,
      makespanMs: replay.makespanMs,
      peakConcurrency: replay.peakConcurrency,
      dispatches: replay.dispatches,
      stuck: replay.stuck,
      violations: replay.violations,
      outputFingerprint: fingerprint(JSON.stringify({
        id: fixture.id,
        makespanMs: replay.makespanMs,
        peakConcurrency: replay.peakConcurrency,
        dispatchOrder: replay.dispatchOrder,
        stuck: replay.stuck,
        violations: replay.violations,
      })),
    };
  });
}

function metricsFor(results) {
  const passed = results.filter((result) => result.stuck.length === 0 && result.violations.length === 0).length;
  return {
    // In this bounded runner, quality means scheduler-fixture correctness only.
    quality: results.length ? passed / results.length : 0,
    // No provider or model is invoked, so these values must not imply live evidence.
    costUsd: 0,
    latencyMs: results.reduce((total, result) => total + result.makespanMs, 0),
    verifiedRuntimeRate: 0,
    operatorInterventions: 0,
  };
}

// Produce one immutable input bundle for the existing promotion gate. The caller
// persists it atomically with the project-policy snapshot that generated it.
export function runDeterministicSchedulerBenchmark({ baselineMaxConcurrency, candidateMaxConcurrency }) {
  const baselineCap = assertMaxConcurrency(baselineMaxConcurrency, 'baseline');
  const candidateCap = assertMaxConcurrency(candidateMaxConcurrency, 'candidate');
  const baselineCases = runSuite(baselineCap);
  const candidateCases = runSuite(candidateCap);
  const baseline = metricsFor(baselineCases);
  const candidate = metricsFor(candidateCases);
  const outputFingerprint = fingerprint(JSON.stringify({
    benchmark: DETERMINISTIC_SCHEDULER_BENCHMARK,
    datasetFingerprint: DATASET_FINGERPRINT,
    baselineMaxConcurrency: baselineCap,
    candidateMaxConcurrency: candidateCap,
    baselineCases,
    candidateCases,
  }));
  const artifactRef = `aos:deterministic-scheduler:${outputFingerprint}`;

  return {
    input: {
      benchmark: {
        id: DETERMINISTIC_SCHEDULER_BENCHMARK.id,
        version: DETERMINISTIC_SCHEDULER_BENCHMARK.version,
        datasetFingerprint: DATASET_FINGERPRINT,
        sampleSize: SCHEDULER_SUITE.length,
      },
      baseline,
      candidate,
      artifactRefs: [artifactRef],
    },
    evidence: {
      source: 'engine_owned_deterministic_replay',
      runner: {
        id: DETERMINISTIC_SCHEDULER_BENCHMARK.id,
        version: DETERMINISTIC_SCHEDULER_BENCHMARK.version,
      },
      claimBoundary: DETERMINISTIC_SCHEDULER_BENCHMARK.claimBoundary,
      exclusions: [...DETERMINISTIC_SCHEDULER_BENCHMARK.exclusions],
      datasetFingerprint: DATASET_FINGERPRINT,
      outputFingerprint,
      baseline: { maxConcurrency: baselineCap, cases: baselineCases },
      candidate: { maxConcurrency: candidateCap, cases: candidateCases },
      metricDefinitions: {
        quality: 'Fraction of frozen scheduler fixtures with no replay violation and no stuck task.',
        costUsd: 'Always zero because this runner invokes no provider.',
        latencyMs: 'Sum of simulated scheduler makespans across the frozen fixtures.',
        verifiedRuntimeRate: 'Always zero because this runner produces no provider-runtime evidence.',
        operatorInterventions: 'Always zero because this runner accepts no human intervention during execution.',
      },
    },
  };
}
