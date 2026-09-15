import { join } from 'node:path';

export const JOB_VERSION = 'aos-scheduler-proving-job/1';

export const JOB_OBJECTIVE = [
  'Determine whether the AOS scheduler in engine/engine.js preserves dependency correctness and produces useful speedup as run concurrency rises from 1 to 2 to 4.',
  'Evidence comes from repository inspection, a benchmark design, analysis of this run\'s own append-only event log, and adversarial review.',
  'Success criteria: every claim cites a file line or an event id and carries a confidence; the synthesis separates measured facts from predictions.',
  'Scope: this repository and this run\'s event log only. Out of scope: changing any file, other repositories, network sources.',
].join(' ');

export const REVIEW_OBJECTIVE = [
  'Using the measured benchmark evidence for concurrency 1, 2 and 4, decide whether the AOS scheduler preserves dependency correctness and gives useful speedup,',
  'recommend a default concurrency for live Luna workers, and propose improvements.',
  'Success criteria: each conclusion cites a benchmark file and a number; the strongest objection is stated.',
  'Scope: the evidence files listed in each task. Out of scope: changing any file.',
].join(' ');

export const INJECTED_FAULT_HOLD_MS = 5_000;

const fault = (taskKey) => ({
  attempt: 1,
  holdMs: INJECTED_FAULT_HOLD_MS,
  error: `Injected retryable failure on ${taskKey} attempt 1: simulated worker crash before first output`,
});

// 28 tasks: a root framing task, four branches of six (lead, four leaves, branch
// summary), then synthesis, retrospective and one approval gate that stays pending.
export function buildSchedulerJob({ repoRoot, jobSpecPath }) {
  const repo = (path) => join(repoRoot, path);
  const tasks = [];
  const dependencies = [];
  const add = (task, after = []) => {
    tasks.push({
      id: task.key,
      worker: 'codex',
      maxRetries: 1,
      dependencyPolicy: 'all_succeeded',
      ...task,
    });
    for (const dependsOn of after) dependencies.push({ taskId: task.key, dependsOnTaskId: dependsOn });
  };

  add({
    key: 'J0',
    title: 'Frame the scheduler question',
    kind: 'intake',
    branch: 'root',
    readPaths: [repo('engine/engine.js'), repo('docs/ENGINE.md')],
    brief: 'State two falsifiable hypotheses. H1 dependency correctness: no task starts before its dependencies reach the state its dependency policy requires, and an approval gate never dispatches without approval. H2 useful speedup: makespan falls materially from concurrency 1 to 2 to 4 for this job. For each, name the event types in events.jsonl whose order would falsify it. Read advanceRun, #drive, #freeSlots, #refreshReady and #depsSatisfied in engine/engine.js.',
  });

  // Branch R: repository inspection
  add({ key: 'R0', parentId: 'J0', branch: 'repository', kind: 'plan', title: 'Scope repository inspection',
    readPaths: [repo('engine/engine.js'), repo('engine/workers.js'), repo('engine/codex.js'), repo('engine/intake.js')],
    brief: 'Split repository inspection into four narrow questions for R1 (dispatch loop and slots), R2 (readiness and dependency policies), R3 (isolation boundary) and R4 (retry, cancellation and approval state machine). Name the exact functions and files each should read. Do not answer the questions yourself.' }, ['J0']);
  add({ key: 'R1', parentId: 'R0', branch: 'repository', kind: 'research', title: 'Inspect dispatch loop and slot accounting',
    readPaths: [repo('engine/engine.js')],
    brief: 'In engine/engine.js inspect advanceRun, #drive, #freeSlots and #executeTask. Determine how free slots are computed, whether a finished task frees its slot immediately, whether two drivers on one run can exceed the cap, and what happens to a worker result that arrives after cancellation. Cite lines.' }, ['R0']);
  add({ key: 'R2', parentId: 'R0', branch: 'repository', kind: 'research', title: 'Inspect readiness and dependency policies',
    readPaths: [repo('engine/engine.js'), repo('engine/intake.js')],
    injectFault: fault('R2'),
    brief: 'In engine/engine.js inspect #refreshReady and #depsSatisfied, and validatePlan in engine/intake.js. Determine exactly when a task becomes ready under all_succeeded and under all_terminal, how approval gates interact with readiness, and whether a cycle or unknown reference can reach the scheduler. Cite lines.' }, ['R0']);
  add({ key: 'R3', parentId: 'R0', branch: 'repository', kind: 'research', title: 'Inspect the isolation boundary',
    readPaths: [repo('engine/workers.js'), repo('engine/codex.js')],
    brief: 'Inspect claimWorkspace in engine/workers.js and CodexCliWorker, buildCodexArgs and sanitizedChildEnv in engine/codex.js. Determine what a worker can write and read, which environment variables it receives, and whether one task can overwrite another task\'s artifacts. Cite lines.' }, ['R0']);
  add({ key: 'R4', parentId: 'R0', branch: 'repository', kind: 'research', title: 'Inspect retry, cancellation and approval transitions',
    readPaths: [repo('engine/engine.js')],
    brief: 'In engine/engine.js inspect #failTask, #injectFault, #abortRun, cancelRun, cancelTask, approveTask, approveProposal and #settleRun. Map task and run state transitions, including injected faults and fatal provider errors, and identify any transition that could lose or duplicate work. Cite lines.' }, ['R0']);
  add({ key: 'R5', parentId: 'R0', branch: 'repository', kind: 'summary', title: 'Summarize repository inspection', dependencyPolicy: 'all_terminal',
    brief: 'Merge R1 to R4 into the strongest claims about dependency correctness and concurrency behaviour that the code supports, and list what the code alone cannot establish.' }, ['R1', 'R2', 'R3', 'R4']);

  // Branch B: benchmark design
  add({ key: 'B0', parentId: 'J0', branch: 'benchmark', kind: 'plan', title: 'Scope benchmark design',
    brief: 'Using the hypotheses from J0 and the inspection scope from R0, assign B1 to B4 their design questions: metrics, blocked-time decomposition, violation detectors, and isolation and provider-evidence checks. Do not answer them yourself.' }, ['J0', 'R0']);
  add({ key: 'B1', parentId: 'B0', branch: 'benchmark', kind: 'research', title: 'Define makespan and speedup metrics',
    readPaths: [repo('engine/metrics.js')],
    brief: 'Define makespan, speedup and efficiency for runs at concurrency 1, 2 and 4 from events.jsonl alone (worker.dispatched, task.completed, task.retried, task.failed). Specify the start and end events, how retries and injected-fault hold time count, and how to separate scheduler effect from model latency variance, for example with trace-driven replay.' }, ['B0', 'R1']);
  add({ key: 'B2', parentId: 'B0', branch: 'benchmark', kind: 'research', title: 'Define blocked-time decomposition',
    brief: 'Define blocked time per task as dependency wait, slot wait, retry wait and approval wait, each as the difference between two named events. State how to aggregate across tasks and what the approval-gated task contributes.' }, ['B0', 'R2', 'R4']);
  add({ key: 'B3', parentId: 'B0', branch: 'benchmark', kind: 'research', title: 'Design race and dependency-violation detectors',
    brief: 'Specify detectors computable from event order in events.jsonl: dispatch before a dependency completed, dispatch of an unapproved gate, running count above the cap, overlapping attempts of one task, attempts without exactly one terminal event, and state that disagrees with events. Explain why event file order is safer than timestamps.' }, ['B0', 'R1', 'R2']);
  add({ key: 'B4', parentId: 'B0', branch: 'benchmark', kind: 'research', title: 'Design isolation and provider-evidence checks',
    readPaths: [repo('engine/codex.js')],
    brief: 'Specify checks proving each live worker ran as gpt-5.6-luna at effort max through the ChatGPT login and could not write outside its workspace: which fields of attempt-N/runtime.json and the Codex session record to compare, the workspace file allowlist, nonce echo, thread-id uniqueness, a repository fingerprint before and after, and a secret scan.' }, ['B0', 'R3']);
  add({ key: 'B5', parentId: 'B0', branch: 'benchmark', kind: 'summary', title: 'Summarize benchmark design', dependencyPolicy: 'all_terminal',
    brief: 'Consolidate B1 to B4 into one measurement protocol with an explicit pass or fail rule for H1 and for H2.' }, ['B1', 'B2', 'B3', 'B4']);

  // Branch E: execution analysis of this live run
  add({ key: 'E0', parentId: 'J0', branch: 'execution', kind: 'plan', title: 'Scope execution analysis',
    readPaths: [jobSpecPath],
    brief: 'Plan how E1 to E4 will analyse this run from its event log while the run is still in progress. State what a partial log can and cannot show. Do not answer the questions yourself.' }, ['J0', 'B0']);
  add({ key: 'E1', parentId: 'E0', branch: 'execution', kind: 'analysis', title: 'Check dispatch order so far',
    readPaths: [jobSpecPath],
    brief: 'Read this run\'s events.jsonl. List worker.dispatched events so far, in order, with task keys (payload.key) and attempts, and check each against the dependencies in the job spec. Report any dispatch that preceded a dependency\'s task.completed event, citing event ids.' }, ['E0', 'B3']);
  add({ key: 'E2', parentId: 'E0', branch: 'execution', kind: 'analysis', title: 'Compute theoretical makespan bounds',
    readPaths: [jobSpecPath],
    brief: 'From the job spec, compute the longest dependency chain and the unit-duration makespan at concurrency 1, 2, 4 and unbounded, assuming each task takes one unit, injected faults take no time, and the approval-gated task never runs. Show the level structure you used.' }, ['E0', 'B1']);
  add({ key: 'E3', parentId: 'E0', branch: 'execution', kind: 'analysis', title: 'Analyse observed retries and injected failures',
    brief: 'From events.jsonl, find fault.injected and task.retried events so far. For each, report the task key, attempt, hold time, when the retry was dispatched and the slot wait it incurred. Confirm that no non-retryable error was retried.' }, ['E0', 'R2', 'B2']);
  add({ key: 'E4', parentId: 'E0', branch: 'execution', kind: 'analysis', title: 'Reconstruct slot utilisation so far',
    brief: 'From events.jsonl, reconstruct how many workers were running after each worker.dispatched and each terminal task event so far, the peak, and periods below the cap while tasks were ready. Compare the peak with maxConcurrency in the run.started payload.' }, ['E0', 'B1']);
  add({ key: 'E5', parentId: 'E0', branch: 'execution', kind: 'summary', title: 'Summarize execution analysis', dependencyPolicy: 'all_terminal',
    injectFault: fault('E5'),
    brief: 'Consolidate E1 to E4 into what this run\'s execution shows so far about H1 and H2, separating measured facts from predictions.' }, ['E1', 'E2', 'E3', 'E4']);

  // Branch A: adversarial review
  add({ key: 'A0', parentId: 'J0', branch: 'adversarial', kind: 'plan', title: 'Scope adversarial review',
    brief: 'List the four claims most likely to be wrong or overstated in this benchmark (dependency correctness, isolation, speedup measurement, provider substitution) and the concrete test that would falsify each. Do not run the tests yourself.' }, ['J0']);
  add({ key: 'A1', parentId: 'A0', branch: 'adversarial', kind: 'critique', title: 'Attack dependency-correctness claims',
    readPaths: [repo('engine/engine.js')],
    brief: 'Try to break R5: construct concrete event sequences or code paths (cancel mid-run, retry of a dependency, all_terminal with a failed parent, two drivers on one run) in which a task could start too early. Say whether the code prevents each, citing lines.' }, ['A0', 'R5']);
  add({ key: 'A2', parentId: 'A0', branch: 'adversarial', kind: 'critique', title: 'Attack the speedup measurement',
    brief: 'Try to break B5: model latency variance between runs, prompt caching across runs, run order, preflight time inside makespan, injected-fault hold time, one sample per concurrency level. For each, estimate how much it could bias speedup and how to control it.' }, ['A0', 'B5']);
  add({ key: 'A3', parentId: 'A0', branch: 'adversarial', kind: 'critique', title: 'Attack the execution-analysis conclusions',
    brief: 'Challenge E5: which conclusions rest on a partial event log, which could be artefacts of when the analysis ran, and what the complete log would need to show to confirm them.' }, ['A0', 'E5']);
  add({ key: 'A4', parentId: 'A0', branch: 'adversarial', kind: 'critique', title: 'Attack isolation and substitution guarantees',
    readPaths: [repo('engine/codex.js'), repo('engine/workers.js')],
    brief: 'Look for any way a worker could write outside its workspace, run a different model or effort, use an API key instead of the ChatGPT login, or leak a secret into captured output, given engine/codex.js and engine/workers.js. Cite lines and rate each residual risk.' }, ['A0', 'R3', 'B4']);
  add({ key: 'A5', parentId: 'A0', branch: 'adversarial', kind: 'summary', title: 'Summarize adversarial review', dependencyPolicy: 'all_terminal',
    brief: 'Consolidate A1 to A4 into the objections that survive, ranked by how much each should reduce confidence.' }, ['A1', 'A2', 'A3', 'A4']);

  add({ key: 'S', parentId: 'J0', branch: 'root', kind: 'synthesis', title: 'Synthesize the scheduler decision', dependencyPolicy: 'all_terminal',
    brief: 'From the four branch summaries, decide whether the scheduler preserves dependency correctness and is expected to give useful speedup at concurrency 2 and 4. Give a recommendation, the strongest surviving objection and a calibrated confidence. Separate evidence from this run from predictions the cross-run benchmark must confirm.' }, ['R5', 'B5', 'E5', 'A5']);
  add({ key: 'T', parentId: 'J0', branch: 'root', kind: 'retrospective', title: 'Write the run retrospective', dependencyPolicy: 'all_terminal',
    brief: 'Review this run\'s events.jsonl and the synthesis. Record what failed (including the two injected faults), why, what should improve, and two to four concrete improvement proposals for the scheduler or the worker provider. Proposals are for human approval only.' }, ['S']);
  add({ key: 'G', parentId: 'T', branch: 'root', kind: 'adopt', worker: 'engine', requiresApproval: true, title: 'Apply improvement proposals',
    brief: 'Human approval gate. Nothing is applied unless an operator approves.' }, ['T']);

  return {
    title: 'AOS scheduler proving job',
    version: JOB_VERSION,
    branches: [
      { key: 'repository', title: 'Repository inspection' },
      { key: 'benchmark', title: 'Benchmark design' },
      { key: 'execution', title: 'Execution analysis' },
      { key: 'adversarial', title: 'Adversarial review' },
    ],
    tasks,
    dependencies,
  };
}

// The concurrency comparison comes from replaying one live trace, and every brief says so,
// so review workers cannot mistake replayed rows for separate live runs.
export function buildReviewJob({ outDir, liveLevel }) {
  const file = (path) => join(outDir, path);
  const live = (path) => file(`c${liveLevel}/${path}`);
  const tasks = [];
  const dependencies = [];
  const add = (task, after = []) => {
    tasks.push({ id: task.key, worker: 'codex', maxRetries: 1, dependencyPolicy: 'all_succeeded', branch: 'review', ...task });
    for (const dependsOn of after) dependencies.push({ taskId: task.key, dependsOnTaskId: dependsOn });
  };
  add({ key: 'X1', kind: 'analysis', title: 'Compare replayed concurrency levels',
    readPaths: [file('benchmark.json'), file('benchmark.md'), file('replay.json')],
    brief: `There was one live run at concurrency ${liveLevel}. The concurrency 1, 2 and 4 rows are deterministic replays of its measured attempt durations, not separate live runs. Compare the replayed rows on makespan, speedup, efficiency, dispatch order, retries, slot, dependency and retry wait, and artifact completeness. Explain where the time went, how close the replay at the live cap came to the observed run (fidelity section), and what the batch-dispatch counterfactual shows.` });
  add({ key: 'X2', kind: 'analysis', title: 'Audit correctness, isolation and provider evidence',
    readPaths: [file('violations.json'), file('workers.json'), live('manifest.json'), live('metrics.json')],
    brief: 'For the live run, confirm or refute: zero dependency, race and isolation violations; every spawned worker verified as gpt-5.6-luna at effort max through the ChatGPT login; exactly two injected retryable failures; one approval gate still pending; all proposals pending. Also report the violation checks on the replayed schedules. Cite file paths, task keys and counts.' });
  add({ key: 'X3', kind: 'critique', title: 'Attack the benchmark conclusions',
    readPaths: [file('benchmark.json'), file('replay.json')],
    brief: 'Attack X1 and X2. Consider: replay treats durations as independent of concurrency although they were measured with four workers running; one live sample; the injected-fault hold time; execution-analysis tasks reading a growing log; plan-order dispatch; and anything the detectors cannot see. State which conclusions survive and how much confidence each objection removes.' }, ['X1', 'X2']);
  add({ key: 'X4', kind: 'synthesis', title: 'Recommend a scheduler decision', dependencyPolicy: 'all_terminal',
    readPaths: [live('artifacts/S.md'), file('benchmark.md')],
    brief: 'Give a concise, evidence-backed recommendation: does the AOS scheduler preserve dependency correctness, does it give useful speedup at concurrency 2 and 4 on this job, and what default concurrency should live Luna workers use. Label speedup figures as replayed from one live trace. Compare with the in-run synthesis listed. State the strongest surviving objection and a calibrated confidence.' }, ['X1', 'X2', 'X3']);
  add({ key: 'X5', kind: 'retrospective', title: 'Write the proving-run retrospective', dependencyPolicy: 'all_terminal',
    readPaths: [live('artifacts/T.md'), file('violations.json')],
    brief: 'Write the retrospective for the whole proving run: what failed, why, what should improve, and three to five concrete improvement proposals drawn from the evidence and the in-run retrospective listed. Proposals stay pending for human approval and must not be applied.' }, ['X4']);
  return { title: 'AOS scheduler benchmark review', version: `${JOB_VERSION}-review`, branches: [{ key: 'review', title: 'Benchmark review' }], tasks, dependencies };
}
