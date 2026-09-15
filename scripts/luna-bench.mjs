#!/usr/bin/env node
// Live proving benchmark. One run of the AOS scheduler job executes on real Codex CLI
// workers (gpt-5.6-luna, effort max, ChatGPT login) at the live cap. Concurrency 1, 2
// and 4 are then compared by replaying that run's measured attempt durations, and a
// small Luna review run reads the result. Everything is written under --out.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AosEngine } from '../engine/engine.js';
import { preflightCodex, resolveCodexConfig } from '../engine/codex.js';
import { analyzeRun, replayMetrics } from '../engine/metrics.js';
import { validatePlan } from '../engine/intake.js';
import { buildReviewJob, buildSchedulerJob, JOB_OBJECTIVE, REVIEW_OBJECTIVE } from '../bench/scheduler-job.js';

const repoRoot = resolve(import.meta.dirname, '..');
const flags = parseFlags(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const smoke = Boolean(flags.smoke);
const liveCap = Number(flags.live || (smoke ? 2 : 4));
const replayCaps = String(flags.replay || '1,2,4').split(',').map(Number);
const outDir = resolve(flags.out || join(repoRoot, 'evidence', 'luna-max-e2e', `${smoke ? 'smoke' : 'bench'}-${stamp}`));
const timeoutMs = Number(flags['timeout-ms'] || 15 * 60_000);
const usageStop = Number(flags['usage-stop'] || 90);
const EXCLUDED = new Set(['node_modules', 'dist', '.aos', '.backups', 'evidence']);

mkdirSync(outDir, { recursive: true });
const logPath = join(outDir, 'bench.log');
const active = new Set();
let stopping = null;
let live = null;
let review = null;

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));

log(`command  node scripts/luna-bench.mjs ${process.argv.slice(2).join(' ')}`);
log(`out      ${outDir}`);
log(`pid      ${process.pid}`);
writeJson('commands.json', {
  bench: `node scripts/luna-bench.mjs ${process.argv.slice(2).join(' ')}`.trim(),
  cwd: repoRoot,
  pid: process.pid,
  node: process.version,
  startedAt: new Date().toISOString(),
  note: 'Each worker attempt records its exact codex argv in attempt-N/runtime.json. The prompt is sent on stdin and saved as attempt-N/prompt.md.',
});

const codexConfig = resolveCodexConfig({ timeoutMs, repoRoot });
let preflight;
try {
  preflight = await preflightCodex(codexConfig);
} catch (error) {
  writeJson('preflight-failed.json', { message: error.message, details: error.details || null, at: new Date().toISOString() });
  log(`STOP preflight failed: ${error.message}`);
  log(`     ${JSON.stringify(error.details || {})}`);
  process.exit(2);
}
writeJson('preflight.json', preflight);
log(`preflight ${preflight.cliVersion} · ${preflight.login} · ${preflight.requested.model}/${preflight.requested.effort} · catalog efforts ${preflight.model.efforts.join(',')}`);

const jobSpecPath = join(outDir, 'job-spec.json');
const plan = smoke ? smokePlan() : buildSchedulerJob({ repoRoot, jobSpecPath });
const validated = validatePlan(plan);
const planDeps = plan.dependencies.map((dep) => ({ task: dep.taskId, dependsOn: dep.dependsOnTaskId }));
const dependencyPolicies = Object.fromEntries(plan.tasks.map((task) => [task.key, task.dependencyPolicy || 'all_succeeded']));
const unitBounds = Object.fromEntries([1, 2, 4, 0].map((cap) => [cap || 'unbounded', replayMetrics({
  tasks: plan.tasks.map((task) => ({ key: task.key, attempts: task.requiresApproval ? [] : [1] })),
  dependencies: planDeps,
  cap,
}).makespanMs]));
writeJson('job-spec.json', {
  version: plan.version || 'smoke',
  objective: smoke ? 'Smoke test' : JOB_OBJECTIVE,
  taskCount: validated.tasks.length,
  dependencyCount: validated.dependencies.length,
  injectedFaults: plan.tasks.filter((task) => task.injectFault).map((task) => ({ key: task.key, ...task.injectFault })),
  approvalGates: plan.tasks.filter((task) => task.requiresApproval).map((task) => task.key),
  unitMakespan: unitBounds,
  plan,
});
log(`job      ${validated.tasks.length} tasks, ${validated.dependencies.length} dependencies, unit makespan ${JSON.stringify(unitBounds)}`);

live = await runLevel({
  label: `c${liveCap}`,
  dataDir: join(outDir, `c${liveCap}`),
  plan,
  objective: smoke ? 'Smoke test of the live AOS Codex worker path. Success is one cited claim per task. Scope is engine/ids.js only.' : JOB_OBJECTIVE,
  cap: liveCap,
});
if (stopping) finish(130, `stopped by ${stopping} during the live run`);
if (live.aborted) finish(3, `live run aborted: ${live.aborted.reason}`);

const benchmark = buildBenchmark(live);
writeJson('benchmark.json', benchmark);
writeJson('replay.json', { liveTrace: benchmark.liveTrace.runId, schedules: benchmark.schedules });
writeJson('violations.json', {
  live: { runId: live.runId, violations: live.violations, repo: live.repo },
  replayed: Object.fromEntries(benchmark.rows.map((row) => [`c${row.concurrency}`, row.simulatedScheduleViolations])),
});
writeJson('workers.json', live.workers.map((worker) => ({ runId: live.runId, ...worker })));
writeFileSync(join(outDir, 'benchmark.md'), renderBenchmark(benchmark));
writeFileSync(join(outDir, 'workers.md'), renderWorkers(live));
log('benchmark written: benchmark.json, benchmark.md, replay.json, violations.json, workers.json, workers.md');
if (live.metrics.workers.maxUsedPercent >= usageStop) finish(4, `ChatGPT usage window at ${live.metrics.workers.maxUsedPercent}% (stop threshold ${usageStop}%); review run skipped`);

if (!smoke && !flags['skip-review']) {
  review = await runLevel({ label: 'review', dataDir: join(outDir, 'review'), plan: buildReviewJob({ outDir, liveLevel: liveCap }), objective: REVIEW_OBJECTIVE, cap: 4 });
  if (stopping) finish(130, `stopped by ${stopping} during the review run`);
  if (review.aborted) finish(3, `review run aborted: ${review.aborted.reason}`);
}

writeJson('approvals.json', {
  note: 'Nothing was approved or applied. The gate and every proposal below are pending a human decision.',
  runs: [live, ...(review ? [review] : [])].map((item) => ({
    label: item.label,
    runId: item.runId,
    runStatus: item.metrics.status,
    approvalGate: item.metrics.approvalGate,
    pendingProposals: item.metrics.pendingProposals,
  })),
});
finish(0, 'complete');

async function runLevel({ label, dataDir, plan: jobPlan, objective, cap }) {
  const repoBefore = fingerprintRepo();
  const engine = new AosEngine({ dataDir, execution: { mode: 'codex', codex: { timeoutMs, repoRoot } } });
  engine.load();
  const goal = engine.createGoal({ prompt: objective, plan: jobPlan });
  const run = engine.startRun({ goalId: goal.id, maxConcurrency: cap });
  const handle = { engine, runId: run.id };
  active.add(handle);
  const startedAt = Date.now();
  const keys = new Map(engine.state.tasks.filter((task) => task.runId === run.id).map((task) => [task.id, task.key]));
  const appendEvent = engine.store.appendEvent.bind(engine.store);
  engine.store.appendEvent = (event) => {
    const record = appendEvent(event);
    progress(label, startedAt, record, keys, engine, run.id);
    return record;
  };
  log(`${label} run ${run.id} started · cap ${run.maxConcurrency} · data ${relative(outDir, dataDir)}`);
  await engine.advanceRun(run.id, { untilIdle: true });
  engine.store.appendEvent = appendEvent;
  active.delete(handle);
  const repoAfter = fingerprintRepo();
  const analysis = analyzeRun({ dataDir, runId: run.id });
  const repo = compareFingerprints(repoBefore, repoAfter);
  if (repo.changed.length) analysis.violations.push({ type: 'repo_mutation', files: repo.changed.slice(0, 50) });
  analysis.metrics.violations = analysis.violations.length;

  const rel = relative(outDir, dataDir);
  writeJson(`${rel}/metrics.json`, analysis.metrics);
  writeJson(`${rel}/manifest.json`, analysis.manifest);
  writeJson(`${rel}/workers.json`, analysis.workers);
  writeJson(`${rel}/violations.json`, { violations: analysis.violations, repo });
  writeFileSync(join(dataDir, 'tree.txt'), `${analysis.tree}\n`);
  const artifactDir = join(dataDir, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  for (const entry of analysis.manifest.entries) {
    const source = join(dataDir, entry.workspace, 'artifact.md');
    if (existsSync(source)) copyFileSync(source, join(artifactDir, `${entry.key}.md`));
  }
  const m = analysis.metrics;
  log(`${label} done · status ${m.status} · makespan ${seconds(m.makespanMs)} · peak ${m.peakConcurrency} · retries ${m.retries.injected} injected/${m.retries.organic} organic · artifacts ${m.artifacts.complete}/${m.artifacts.expected} · workers verified ${m.workers.verified}/${m.workers.spawned} · violations ${analysis.violations.length} · usage ${m.workers.maxUsedPercent}%`);
  return {
    label,
    cap,
    runId: run.id,
    dataDir,
    metrics: m,
    workers: analysis.workers,
    violations: analysis.violations,
    repo,
    aborted: engine.getRun(run.id).error || null,
  };
}

function progress(label, startedAt, record, keys, engine, runId) {
  const interesting = new Set(['worker.dispatched', 'task.completed', 'task.retried', 'task.failed', 'task.cancelled', 'fault.injected', 'worker.substitution_detected', 'worker.unverified', 'run.aborted', 'task.approval_required', 'isolation.violation']);
  if (record.runId !== runId || !interesting.has(record.type)) return;
  const running = engine.state.tasks.filter((task) => task.runId === runId && task.status === 'running').length;
  const done = engine.state.tasks.filter((task) => task.runId === runId && ['succeeded', 'failed', 'cancelled'].includes(task.status)).length;
  const detail = record.payload?.error || record.payload?.reason || '';
  log(`${label} +${seconds(Date.now() - startedAt).padStart(7)} ${record.type.padEnd(24)} ${String(keys.get(record.taskId) || '').padEnd(3)}${record.payload?.attempt ? `#${record.payload.attempt}` : '  '} running=${running} done=${done}${detail ? `  ${String(detail).slice(0, 120)}` : ''}`);
}

function buildBenchmark(liveResult) {
  const m = liveResult.metrics;
  const durations = new Map(m.attemptDurations.map((entry) => [entry.key, entry.durations]));
  const traceTasks = plan.tasks.map((task) => ({ key: task.key, attempts: durations.get(task.key) || [] }));
  const replay = (cap, policy) => replayMetrics({ tasks: traceTasks, dependencies: planDeps, cap, policy, dependencyPolicies });
  const label = `replayed schedule from live trace ${liveResult.runId} (live cap ${liveResult.cap})`;
  const pool = Object.fromEntries(replayCaps.map((cap) => [cap, replay(cap, 'pool')]));
  const batch = Object.fromEntries(replayCaps.map((cap) => [cap, replay(cap, 'batch')]));
  const own = pool[liveResult.cap] || replay(liveResult.cap, 'pool');
  const baseline = pool[1];
  const firstDivergence = m.dispatchOrder.findIndex((item, index) => own.dispatchOrder[index] !== item);

  return {
    generatedAt: new Date().toISOString(),
    kind: 'one live trace, concurrency levels replayed',
    note: 'Rows are deterministic replays of the measured attempt durations from one live run. They are not separate live runs.',
    liveTrace: {
      runId: liveResult.runId,
      cap: liveResult.cap,
      status: m.status,
      makespanMs: m.makespanMs,
      preflightMs: m.preflightMs,
      workerBusyMs: m.workerBusyMs,
      utilization: m.utilization,
      peakConcurrency: m.peakConcurrency,
      dispatches: m.dispatches,
      dispatchOrder: m.dispatchOrder,
      retries: m.retries,
      blockedMs: m.blockedMs,
      artifacts: m.artifacts,
      workers: m.workers,
      approvalGate: m.approvalGate,
      pendingProposals: m.pendingProposals,
      violations: liveResult.violations.length,
    },
    fidelity: {
      cap: liveResult.cap,
      observedMakespanMs: m.makespanMs,
      replayedMakespanMs: own.makespanMs,
      differenceMs: m.makespanMs - own.makespanMs,
      differencePct: m.makespanMs ? (m.makespanMs - own.makespanMs) / m.makespanMs : null,
      dispatchOrderMatches: firstDivergence === -1 && own.dispatchOrder.length === m.dispatchOrder.length,
      firstDivergence: firstDivergence === -1 ? null : { index: firstDivergence, observed: m.dispatchOrder[firstDivergence], replayed: own.dispatchOrder[firstDivergence] },
    },
    rows: replayCaps.map((cap) => ({
      concurrency: cap,
      label,
      policy: 'pool',
      makespanMs: pool[cap].makespanMs,
      speedupVsC1: baseline ? baseline.makespanMs / pool[cap].makespanMs : null,
      efficiency: baseline ? baseline.makespanMs / pool[cap].makespanMs / cap : null,
      peakConcurrency: pool[cap].peakConcurrency,
      dispatches: pool[cap].dispatches,
      dispatchOrder: pool[cap].dispatchOrder,
      retries: { injected: m.retries.injected, organic: m.retries.organic, note: 'retries are fixed by the trace' },
      blockedMs: pool[cap].blockedMs,
      approvalGate: m.approvalGate,
      artifacts: { ...m.artifacts, note: 'artifacts come from the live run; replay produces none' },
      simulatedScheduleViolations: pool[cap].violations,
      batchCounterfactualMakespanMs: batch[cap].makespanMs,
      batchPenalty: (batch[cap].makespanMs - pool[cap].makespanMs) / pool[cap].makespanMs,
    })),
    unitMakespan: unitBounds,
    schedules: { pool, batch },
    assumptions: [
      'Each attempt keeps the duration measured in the live run, including the 5 s hold of each injected fault.',
      `Durations were measured with up to ${liveResult.cap} workers running at once. If concurrent Codex sessions slowed each other, lower-concurrency replays overstate their makespan and so overstate speedup.`,
      'Dispatch follows plan order among ready tasks, as the engine does. Batch rows model the engine before live execution, which waited for a whole batch before refilling slots.',
      'Model output, and therefore duration, would differ in a fresh run at another concurrency. The replay isolates the scheduler, not the model.',
    ],
  };
}

function renderBenchmark(benchmark) {
  const live = benchmark.liveTrace;
  const lines = [
    '# Scheduler benchmark: one live trace, replayed at concurrency 1, 2 and 4',
    '',
    `Every row below is a deterministic replay of the attempt durations measured in live run ${live.runId}, which ran ${live.dispatches} worker attempts at concurrency ${live.cap}. The rows are not separate live runs.`,
    '',
    '| Concurrency | Makespan (replayed) | Speedup vs c=1 | Efficiency | Peak running | Slot wait | Dependency wait | Retry wait | Retries (injected / organic) | Approval gate | Artifacts (live run) | Schedule violations | Batch-dispatch makespan |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of benchmark.rows) {
    lines.push(`| ${row.concurrency} | ${seconds(row.makespanMs)} | ${fixed(row.speedupVsC1)} | ${fixed(row.efficiency)} | ${row.peakConcurrency} | ${seconds(row.blockedMs.slotWait)} | ${seconds(row.blockedMs.dependencyWait)} | ${seconds(row.blockedMs.retryWait)} | ${row.retries.injected} / ${row.retries.organic} | ${gateText(row.approvalGate)} | ${row.artifacts.complete}/${row.artifacts.expected} | ${row.simulatedScheduleViolations.length} | ${seconds(row.batchCounterfactualMakespanMs)} (+${(row.batchPenalty * 100).toFixed(0)}%) |`);
  }
  const f = benchmark.fidelity;
  lines.push(
    '',
    'Wait columns are sums across tasks. Batch-dispatch makespan is the same trace scheduled the way the engine worked before live execution: dispatch a batch and wait for all of it.',
    '',
    '## Live trace (observed)',
    '',
    `- Run ${live.runId}, status ${live.status}, concurrency cap ${live.cap}, peak running ${live.peakConcurrency}.`,
    `- Makespan ${seconds(live.makespanMs)}; worker time ${seconds(live.workerBusyMs)}; utilisation ${fixed(live.utilization)}.`,
    `- Retries ${live.retries.injected} injected / ${live.retries.organic} organic; artifacts ${live.artifacts.complete}/${live.artifacts.expected}; violations ${live.violations}.`,
    `- Workers ${live.workers.verified}/${live.workers.spawned} verified as ${live.workers.models.join(', ')}; plan ${live.workers.planTypes.join(', ')}.`,
    `- Approval gate ${gateText(live.approvalGate)}; ${live.pendingProposals.length} proposals pending.`,
    '',
    '## Replay fidelity',
    '',
    `Replaying the trace at the live cap gives ${seconds(f.replayedMakespanMs)} against ${seconds(f.observedMakespanMs)} observed (difference ${seconds(f.differenceMs)}, ${f.differencePct == null ? '—' : `${(f.differencePct * 100).toFixed(1)}%`}). Dispatch order ${f.dispatchOrderMatches ? 'matches exactly' : `first differs at position ${f.firstDivergence.index} (observed ${f.firstDivergence.observed}, replayed ${f.firstDivergence.replayed})`}.`,
    '',
    `Unit-duration bound (every task one step, no faults): ${JSON.stringify(benchmark.unitMakespan)}`,
    '',
    '## Assumptions',
    '',
    ...benchmark.assumptions.map((item) => `- ${item}`),
    '',
    '## Dispatch order',
    '',
    `- live c=${live.cap}: ${live.dispatchOrder.join(' ')}`,
    ...benchmark.rows.map((row) => `- replayed c=${row.concurrency}: ${row.dispatchOrder.join(' ')}`),
  );
  return `${lines.join('\n')}\n`;
}

function renderWorkers(result) {
  const lines = [
    `# Worker runtime evidence — live run ${result.runId}`,
    '',
    '| Task | Spawned | Requested | Effective (session record) | Plan | Verified | Thread | Started | Ended | Duration | Exit | Artifact |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const worker of result.workers) {
    lines.push(`| ${worker.key}#${worker.attempt} | ${worker.injected ? 'no (injected fault)' : worker.spawned} | ${worker.requestedModel}/${worker.requestedEffort} | ${worker.effectiveModel ?? '—'}/${worker.effectiveEffort ?? '—'} | ${worker.planType ?? '—'} | ${worker.verified} | ${worker.threadId ?? '—'} | ${worker.startedAt} | ${worker.endedAt ?? '—'} | ${seconds(worker.durationMs)} | ${worker.exitCode ?? '—'} | ${worker.artifact ?? '—'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function gateText(gate) {
  if (!gate) return 'none';
  if (gate.pendingSince) return `${gate.key} pending since ${gate.pendingSince}`;
  return `${gate.key} ${gate.status}`;
}

function smokePlan() {
  const ids = join(repoRoot, 'engine/ids.js');
  return {
    title: 'Live smoke',
    tasks: [
      { id: 'S1', key: 'S1', title: 'Explain newId', kind: 'research', worker: 'codex', readPaths: [ids], brief: 'Read engine/ids.js and state in one sentence what newId returns, citing the line.' },
      { id: 'S2', key: 'S2', title: 'Explain fingerprint', kind: 'research', worker: 'codex', readPaths: [ids], brief: 'Read engine/ids.js and state in one sentence what fingerprint returns, citing the line.' },
      { id: 'S3', key: 'S3', title: 'Combine', kind: 'synthesis', worker: 'codex', dependencyPolicy: 'all_terminal', brief: 'Combine S1 and S2 into one recommendation about whether these ids are safe as task nonces.' },
    ],
    dependencies: [{ taskId: 'S3', dependsOnTaskId: 'S1' }, { taskId: 'S3', dependsOnTaskId: 'S2' }],
  };
}

function fingerprintRepo() {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (EXCLUDED.has(name) && dir === repoRoot) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else files.set(relative(repoRoot, path), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(repoRoot);
  return files;
}

function compareFingerprints(before, after) {
  const changed = [];
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  const digest = (files) => createHash('sha256').update([...files.entries()].sort().map(([path, hash]) => `${path}:${hash}`).join('\n')).digest('hex');
  return { files: after.size, before: digest(before), after: digest(after), changed };
}

// A signal cancels the active run (which kills its Codex process groups) and stops
// the script from starting anything else.
function stopAll(signal) {
  if (stopping) return;
  stopping = signal;
  log(`${signal} received: cancelling active runs; no further runs will start`);
  for (const { engine, runId } of active) engine.cancelRun(runId);
  setTimeout(() => process.exit(130), 15_000).unref();
}

function finish(code, message) {
  writeJson('summary.json', {
    exitCode: code,
    message,
    finishedAt: new Date().toISOString(),
    outDir,
    liveRun: live && { runId: live.runId, cap: live.cap, status: live.metrics.status, makespanMs: live.metrics.makespanMs, violations: live.violations.length },
    reviewRun: review && { runId: review.runId, status: review.metrics.status, violations: review.violations.length },
  });
  log(`${code === 0 ? 'DONE' : 'STOP'} ${message}`);
  process.exit(code);
}

function writeJson(path, value) {
  const target = join(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(logPath, `${text}\n`);
}

function seconds(ms) {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

function fixed(value) {
  return value == null ? '—' : value.toFixed(2);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[token.slice(2)] = next;
      i += 1;
    } else {
      out[token.slice(2)] = true;
    }
  }
  return out;
}
