import { fingerprint, newId, nowIso } from './ids.js';
import { AosError, check, identifier, invalid, notFound, t } from './schema.js';
import { runDeterministicSchedulerBenchmark } from './evaluation-runner.js';

export const IMPROVEMENT_SCHEMA_VERSION = 1;
export const IMPROVABLE_POLICY_KEYS = Object.freeze(['maxConcurrency', 'maxRetries', 'retentionDays']);

const METRICS_SCHEMA = t.object({
  quality: t.number({ min: 0, max: 1 }),
  costUsd: t.number({ min: 0 }),
  latencyMs: t.number({ min: 0 }),
  verifiedRuntimeRate: t.number({ min: 0, max: 1 }),
  operatorInterventions: t.integer({ min: 0 }),
});

export const IMPROVEMENT_EVALUATION_INPUT_SCHEMA = t.object({
  requestId: identifier(),
  benchmark: t.object({
    id: t.string({ minLength: 1, maxLength: 120 }),
    version: t.string({ minLength: 1, maxLength: 80 }),
    datasetFingerprint: t.string({ minLength: 8, maxLength: 128, pattern: /^[a-f0-9]+$/i, patternName: 'a hexadecimal fingerprint' }),
    sampleSize: t.integer({ min: 1, max: 1_000_000 }),
  }),
  baseline: METRICS_SCHEMA,
  candidate: METRICS_SCHEMA,
  artifactRefs: t.array(t.string({ minLength: 1, maxLength: 300, pattern: /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/, patternName: 'a credential-free artifact reference' }), { unique: true, minItems: 1, maxItems: 50 }),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
});

export const DETERMINISTIC_IMPROVEMENT_EVALUATION_INPUT_SCHEMA = t.object({
  requestId: identifier(),
  actor: t.optional(t.string({ minLength: 1, maxLength: 120 })),
});

function clone(value) {
  return structuredClone(value);
}

function validate(schema, value, label) {
  const errors = check(schema, value);
  if (errors.length) throw invalid(`${label} failed validation: ${errors[0].path} ${errors[0].message}`, { errors });
  return value;
}

function material(proposal) {
  return {
    id: proposal.id,
    projectId: proposal.projectId,
    runId: proposal.runId || null,
    type: proposal.type,
    title: proposal.title,
    change: proposal.change,
    payload: proposal.payload || null,
  };
}

export function proposalFingerprint(proposal) {
  return fingerprint(JSON.stringify(material(proposal)));
}

function ratioPass(candidate, baseline, ratio) {
  return baseline === 0 ? candidate === 0 : candidate <= baseline * ratio;
}

function evaluateMetrics(baseline, candidate) {
  const checks = [
    { metric: 'quality', passed: candidate.quality >= baseline.quality, baseline: baseline.quality, candidate: candidate.quality, delta: candidate.quality - baseline.quality },
    { metric: 'costUsd', passed: ratioPass(candidate.costUsd, baseline.costUsd, 1.1), baseline: baseline.costUsd, candidate: candidate.costUsd, delta: candidate.costUsd - baseline.costUsd },
    { metric: 'latencyMs', passed: ratioPass(candidate.latencyMs, baseline.latencyMs, 1.1), baseline: baseline.latencyMs, candidate: candidate.latencyMs, delta: candidate.latencyMs - baseline.latencyMs },
    { metric: 'verifiedRuntimeRate', passed: candidate.verifiedRuntimeRate >= baseline.verifiedRuntimeRate, baseline: baseline.verifiedRuntimeRate, candidate: candidate.verifiedRuntimeRate, delta: candidate.verifiedRuntimeRate - baseline.verifiedRuntimeRate },
    { metric: 'operatorInterventions', passed: candidate.operatorInterventions <= baseline.operatorInterventions, baseline: baseline.operatorInterventions, candidate: candidate.operatorInterventions, delta: candidate.operatorInterventions - baseline.operatorInterventions },
  ];
  return { status: checks.every((item) => item.passed) ? 'passed' : 'failed', checks };
}

function policyValues(project) {
  return Object.fromEntries(IMPROVABLE_POLICY_KEYS.map((key) => [key, project[key] ?? null]));
}

function baselineFingerprint(genomeVersion, values) {
  return fingerprint(JSON.stringify({ genomeVersion, values }));
}

export class ImprovementService {
  constructor({ engine, clock = () => Date.now() }) {
    this.engine = engine;
    this.clock = clock;
  }

  listEvaluations({ proposalId = null, projectId = null } = {}) {
    return this.engine.state.improvementEvaluations
      .filter((item) => !proposalId || item.proposalId === proposalId)
      .filter((item) => !projectId || item.projectId === projectId)
      .map(clone);
  }

  evaluate(proposalId, input) {
    validate(IMPROVEMENT_EVALUATION_INPUT_SCHEMA, input, 'improvement evaluation');
    return this.engine.transact(() => this.#recordEvaluation(proposalId, input, {
      source: 'operator_attested',
      claimBoundary: 'AOS stored operator-supplied metrics and artifact references; it did not execute or verify this benchmark.',
    }));
  }

  runDeterministic(proposalId, input) {
    validate(DETERMINISTIC_IMPROVEMENT_EVALUATION_INPUT_SCHEMA, input, 'deterministic improvement evaluation');
    return this.engine.transact(() => {
      const proposal = this.#pendingProposal(proposalId);
      if (proposal.type !== 'policy' || proposal.payload?.key !== 'maxConcurrency') {
        throw new AosError('deterministic_benchmark_unsupported', 'The deterministic scheduler benchmark supports only a pending maxConcurrency policy proposal', {
          statusCode: 409,
          details: { proposalId, type: proposal.type, key: proposal.payload?.key ?? null },
        });
      }
      const project = this.engine.state.projects.find((item) => item.id === proposal.projectId);
      if (!project) throw notFound('project', proposal.projectId);
      const generated = runDeterministicSchedulerBenchmark({
        baselineMaxConcurrency: project.maxConcurrency ?? null,
        candidateMaxConcurrency: proposal.payload.value,
      });
      return this.#recordEvaluation(proposalId, { ...generated.input, requestId: input.requestId, actor: input.actor }, generated.evidence);
    });
  }

  #pendingProposal(proposalId) {
    const proposal = this.engine.state.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw notFound('proposal', proposalId);
    if (proposal.evaluationRequired !== true) throw new AosError('improvement_evaluation_not_required', `Proposal ${proposalId} is not an improvement candidate`, { statusCode: 409 });
    if (proposal.status !== 'proposed') throw new AosError('improvement_not_pending', `Proposal ${proposalId} is not pending`, { statusCode: 409 });
    return proposal;
  }

  #recordEvaluation(proposalId, input, evidence) {
    const proposal = this.#pendingProposal(proposalId);
    const existing = this.engine.state.improvementEvaluations.find((item) => item.requestId === input.requestId);
    const inputFingerprint = fingerprint(JSON.stringify({ proposalId, ...input, actor: undefined }));
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) throw new AosError('improvement_evaluation_request_conflict', `Evaluation request ${input.requestId} was already used`, { statusCode: 409 });
      return clone(existing);
    }

    const verdict = evaluateMetrics(input.baseline, input.candidate);
    const project = this.engine.state.projects.find((item) => item.id === proposal.projectId);
    if (!project) throw notFound('project', proposal.projectId);
    const head = this.listGenome({ projectId: proposal.projectId }).at(-1) || null;
    const baselinePolicy = policyValues(project);
    const baselineGenomeVersion = head?.version || 0;
    const record = {
      id: newId('improvementEvaluation'),
      schemaVersion: IMPROVEMENT_SCHEMA_VERSION,
      requestId: input.requestId,
      inputFingerprint,
      proposalId,
      proposalFingerprint: proposalFingerprint(proposal),
      projectId: proposal.projectId,
      runId: proposal.runId || null,
      benchmark: clone(input.benchmark),
      baseline: clone(input.baseline),
      candidate: clone(input.candidate),
      artifactRefs: [...input.artifactRefs],
      evidence: clone(evidence),
      status: verdict.status,
      checks: verdict.checks,
      baselinePolicy,
      baselineGenomeVersion,
      baselinePolicyFingerprint: baselineFingerprint(baselineGenomeVersion, baselinePolicy),
      rollbackTarget: proposal.type === 'policy' && IMPROVABLE_POLICY_KEYS.includes(proposal.payload?.key)
        ? { key: proposal.payload.key, value: project[proposal.payload.key] ?? null, genomeVersion: head?.version || 0 }
        : null,
      evaluatedAt: nowIso(this.clock),
      actor: input.actor || 'operator',
    };
    this.engine.state.improvementEvaluations.push(record);
    proposal.evaluationId = record.id;
    proposal.evaluationStatus = record.status;
    this.engine.recordEvent('improvement.evaluated', {
      projectId: proposal.projectId,
      runId: proposal.runId,
      payload: { proposalId, evaluationId: record.id, status: record.status, benchmarkId: record.benchmark.id, evidenceSource: record.evidence.source },
    });
    return clone(record);
  }

  assertPromotionReady(proposal, { project = null } = {}) {
    if (proposal.evaluationRequired !== true) return null;
    const evaluation = this.engine.state.improvementEvaluations.find((item) => item.id === proposal.evaluationId);
    if (!evaluation || evaluation.status !== 'passed') {
      throw new AosError('improvement_evaluation_required', `Proposal ${proposal.id} needs a passing benchmark evaluation before approval`, { statusCode: 409 });
    }
    if (evaluation.proposalFingerprint !== proposalFingerprint(proposal)) {
      throw new AosError('improvement_candidate_changed', `Proposal ${proposal.id} changed after evaluation`, { statusCode: 409 });
    }
    if (project) {
      const head = this.listGenome({ projectId: project.id }).at(-1) || null;
      const currentValues = policyValues(project);
      const currentFingerprint = baselineFingerprint(head?.version || 0, currentValues);
      if (currentFingerprint !== evaluation.baselinePolicyFingerprint) {
        throw new AosError('improvement_baseline_changed', `Project policy changed after proposal ${proposal.id} was evaluated`, {
          statusCode: 409,
          details: { evaluatedGenomeVersion: evaluation.baselineGenomeVersion, currentGenomeVersion: head?.version || 0 },
        });
      }
    }
    return evaluation;
  }

  listGenome({ projectId }) {
    return this.engine.state.genomeVersions
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  preparePromotion(proposal, project) {
    const evaluation = this.assertPromotionReady(proposal, { project });
    const versions = this.listGenome({ projectId: project.id });
    return { evaluation, head: versions.at(-1) || null, baselineValues: policyValues(project) };
  }

  recordPromotion(proposal, project, prepared) {
    const { evaluation, baselineValues } = prepared;
    let { head } = prepared;
    if (!head) {
      head = {
        id: newId('genomeVersion'), schemaVersion: IMPROVEMENT_SCHEMA_VERSION, projectId: project.id, version: 1,
        parentVersion: null, action: 'baseline', proposalId: null, evaluationId: null, values: clone(baselineValues),
        createdAt: nowIso(this.clock), actor: 'engine',
      };
      this.engine.state.genomeVersions.push(head);
    }
    const version = {
      id: newId('genomeVersion'), schemaVersion: IMPROVEMENT_SCHEMA_VERSION, projectId: project.id, version: head.version + 1,
      parentVersion: head.version, action: 'promotion', proposalId: proposal.id, evaluationId: evaluation.id,
      values: policyValues(project), createdAt: nowIso(this.clock), actor: 'operator',
    };
    this.engine.state.genomeVersions.push(version);
    proposal.genomeVersion = version.version;
    proposal.rollbackTargetVersion = head.version;
    this.engine.recordEvent('improvement.promoted', {
      projectId: project.id,
      runId: proposal.runId,
      payload: { proposalId: proposal.id, evaluationId: evaluation.id, genomeVersion: version.version, rollbackTargetVersion: head.version },
    });
    return clone(version);
  }

  rollback(versionId, { actor = 'operator', reason = 'operator rollback' } = {}) {
    return this.engine.transact(() => {
      const target = this.engine.state.genomeVersions.find((item) => item.id === versionId);
      if (!target) throw notFound('genome version', versionId);
      if (target.action !== 'promotion') throw new AosError('improvement_not_promotion', `Genome version ${versionId} is not a promotion`, { statusCode: 409 });
      const versions = this.listGenome({ projectId: target.projectId });
      const head = versions.at(-1);
      if (head.id !== target.id) throw new AosError('improvement_rollback_stale', `Genome version ${versionId} is not the current head`, { statusCode: 409 });
      const parent = versions.find((item) => item.version === target.parentVersion);
      if (!parent) throw new AosError('improvement_rollback_target_missing', `Rollback target for ${versionId} is missing`, { statusCode: 409 });
      const project = this.engine.state.projects.find((item) => item.id === target.projectId);
      if (!project) throw notFound('project', target.projectId);
      for (const key of IMPROVABLE_POLICY_KEYS) {
        if (Object.hasOwn(parent.values, key)) project[key] = parent.values[key];
      }
      const rollback = {
        id: newId('genomeVersion'), schemaVersion: IMPROVEMENT_SCHEMA_VERSION, projectId: target.projectId, version: head.version + 1,
        parentVersion: head.version, action: 'rollback', proposalId: target.proposalId, evaluationId: target.evaluationId,
        rollbackOf: target.version, values: policyValues(project), createdAt: nowIso(this.clock), actor: actor || 'operator', reason: String(reason || 'operator rollback').slice(0, 500),
      };
      this.engine.state.genomeVersions.push(rollback);
      this.engine.recordEvent('improvement.rolled_back', {
        projectId: project.id,
        payload: { genomeVersion: rollback.version, rollbackOf: target.version, proposalId: target.proposalId, reason: rollback.reason },
      });
      return clone(rollback);
    });
  }
}
