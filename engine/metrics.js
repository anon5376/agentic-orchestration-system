import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Files the engine itself writes into a task workspace. Anything else is a violation.
const WORKSPACE_FILES = [
  /^OWNER$/,
  /^artifact\.(json|md)$/,
  /^adoption\.json$/,
  /^attempt-\d+\/(prompt\.md|output-schema\.json|stdout\.jsonl|stderr\.txt|last-message\.json|runtime\.json)$/,
  /^(interpretation|finding|critique|decision|retrospective|output|command)\.json$/,
];

const SECRET_PATTERNS = [
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ['oauth_field', /"(?:access_token|refresh_token|id_token)"\s*:\s*"[^"]{10,}"/],
];

const END_EVENTS = new Set(['task.completed', 'task.retried', 'task.failed', 'task.cancelled']);

export function readEvents(dataDir) {
  const path = join(dataDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => ({ ...JSON.parse(line), index }));
}

export function analyzeRun({ dataDir, runId }) {
  const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`Unknown run ${runId} in ${dataDir}`);
  const tasks = state.tasks.filter((item) => item.runId === runId);
  const deps = state.dependencies.filter((item) => item.runId === runId);
  const allEvents = readEvents(dataDir);
  const events = allEvents.filter((item) => item.runId === runId);
  const timeline = buildTimeline({ run, tasks, events });
  const manifest = buildManifest({ dataDir, run, tasks });
  const workers = collectWorkerEvidence({ dataDir, run, tasks, timeline });
  const secrets = scanSecrets([join(dataDir, 'workspaces', run.id), join(dataDir, 'events.jsonl'), join(dataDir, 'state.json')]);
  const violations = detectViolations({ run, tasks, deps, events, allEvents, timeline, manifest, workers, secrets });
  const metrics = summarizeMetrics({ run, state, tasks, deps, events, timeline, manifest, workers, violations });
  return { run, tasks, deps, events, timeline, manifest, workers, violations, metrics, tree: renderTree(tasks, deps) };
}

export function buildTimeline({ run, tasks, events }) {
  const records = new Map(tasks.map((task) => [task.id, {
    key: task.key || task.id,
    taskId: task.id,
    readyAt: null,
    approvalRequiredAt: null,
    approvedIndex: null,
    completedIndex: null,
    terminalIndex: null,
    refused: 0,
    attempts: [],
  }]));
  const open = new Map();
  const cap = run.maxConcurrency == null || run.maxConcurrency <= 0 ? null : run.maxConcurrency;
  const dispatchOrder = [];
  const overCap = [];
  const doubleDispatch = [];
  const endsWithoutDispatch = [];
  let running = 0;
  let peak = 0;

  for (const event of events) {
    const record = event.taskId ? records.get(event.taskId) : null;
    const at = Date.parse(event.ts);
    if (!record) continue;
    if (event.type === 'task.ready' && record.readyAt == null) record.readyAt = at;
    else if (event.type === 'task.approval_required') record.approvalRequiredAt = at;
    else if (event.type === 'task.approved') record.approvedIndex = event.index;
    else if (event.type === 'worker.refused' || event.type === 'isolation.denied') record.refused += 1;
    else if (event.type === 'worker.dispatched') {
      if (open.has(event.taskId)) doubleDispatch.push({ key: record.key, index: event.index });
      const previous = record.attempts.at(-1);
      const attempt = {
        attempt: event.payload?.attempt ?? record.attempts.length + 1,
        queuedAt: previous ? previous.endAt : record.readyAt,
        dispatchAt: at,
        dispatchIndex: event.index,
        runningAtDispatch: event.payload?.running ?? null,
        endAt: null,
        endIndex: null,
        outcome: null,
        injected: false,
        threadId: null,
      };
      record.attempts.push(attempt);
      open.set(event.taskId, attempt);
      running += 1;
      peak = Math.max(peak, running);
      if (cap && running > cap) overCap.push({ key: record.key, index: event.index, running });
      dispatchOrder.push(`${record.key}#${attempt.attempt}`);
    } else if (event.type === 'fault.injected') {
      const attempt = open.get(event.taskId);
      if (attempt) attempt.injected = true;
    } else if (event.type === 'worker.thread') {
      const attempt = open.get(event.taskId);
      if (attempt) attempt.threadId = event.payload?.sessionId || event.payload?.threadId || null;
    } else if (END_EVENTS.has(event.type)) {
      if (event.type === 'task.completed') record.completedIndex = event.index;
      if (event.type !== 'task.retried') record.terminalIndex = event.index;
      const attempt = open.get(event.taskId);
      if (!attempt) {
        if (event.type !== 'task.cancelled' && !record.refused) endsWithoutDispatch.push({ key: record.key, type: event.type, index: event.index });
        continue;
      }
      attempt.endAt = at;
      attempt.endIndex = event.index;
      attempt.outcome = event.type.slice('task.'.length);
      if (event.type === 'task.retried' || event.type === 'task.failed') {
        attempt.retryable = event.payload?.retryable ?? null;
        attempt.injected = attempt.injected || Boolean(event.payload?.injected);
        attempt.error = event.payload?.error || null;
      }
      open.delete(event.taskId);
      running -= 1;
    }
  }

  return {
    records,
    dispatchOrder,
    peakConcurrency: peak,
    cap,
    overCap,
    doubleDispatch,
    endsWithoutDispatch,
    openAttempts: [...open.entries()].map(([taskId, attempt]) => ({ key: records.get(taskId).key, attempt: attempt.attempt })),
  };
}

export function buildManifest({ dataDir, run, tasks }) {
  const root = join(dataDir, 'workspaces', run.id);
  const live = run.execution?.mode === 'codex';
  const known = new Set(tasks.map((task) => task.id));
  const strayWorkspaces = existsSync(root) ? readdirSync(root).filter((name) => !known.has(name)) : [];
  const entries = tasks.map((task) => {
    const dir = join(root, task.id);
    const files = existsSync(dir)
      ? walk(dir).map((path) => {
        const body = readFileSync(path);
        return { path: relative(dir, path), bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
      })
      : [];
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(join(dir, 'OWNER'), 'utf8'));
    } catch {
      owner = null;
    }
    let artifact = null;
    if (files.some((file) => file.path === 'artifact.json')) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8'));
        artifact = {
          nonceMatch: parsed.nonce === task.nonce,
          attempt: parsed.attempt ?? null,
          threadId: parsed.threadId ?? null,
          summaryChars: String(parsed.output?.summary || '').length,
          findings: parsed.output?.findings?.length ?? 0,
          hasDecision: Boolean(parsed.output?.decision),
          hasRetrospective: Boolean(parsed.output?.retrospective),
        };
      } catch (error) {
        artifact = { invalid: error.message };
      }
    }
    const expectsArtifact = live && task.worker === 'codex';
    const complete = expectsArtifact
      ? Boolean(
        artifact && !artifact.invalid && artifact.nonceMatch && artifact.summaryChars > 0 && task.status === 'succeeded'
        && (task.kind !== 'synthesis' || artifact.hasDecision)
        && (task.kind !== 'retrospective' || artifact.hasRetrospective),
      )
      : null;
    return {
      key: task.key || task.id,
      taskId: task.id,
      kind: task.kind,
      worker: task.worker,
      status: task.status,
      attempts: task.attempts,
      workspace: relative(dataDir, dir),
      ownerOk: owner ? owner.taskId === task.id && owner.runId === run.id && owner.agentId === task.agentId : !files.length,
      files,
      unexpectedFiles: files.map((file) => file.path).filter((path) => !WORKSPACE_FILES.some((pattern) => pattern.test(path))),
      artifact,
      artifactPath: artifact ? relative(dataDir, join(dir, 'artifact.md')) : null,
      expectsArtifact,
      complete,
    };
  });
  const expected = entries.filter((entry) => entry.expectsArtifact);
  return {
    runId: run.id,
    root: relative(dataDir, root),
    strayWorkspaces,
    completeness: { expected: expected.length, complete: expected.filter((entry) => entry.complete).length },
    entries,
  };
}

export function collectWorkerEvidence({ dataDir, run, tasks, timeline }) {
  const attempts = [];
  for (const task of tasks) {
    const record = timeline.records.get(task.id);
    for (const attempt of record.attempts) {
      const path = join(dataDir, 'workspaces', run.id, task.id, `attempt-${attempt.attempt}`, 'runtime.json');
      let runtime = null;
      try {
        runtime = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        runtime = null;
      }
      attempts.push({
        key: record.key,
        taskId: task.id,
        attempt: attempt.attempt,
        outcome: attempt.outcome,
        runtimePath: runtime ? relative(dataDir, path) : null,
        spawned: runtime?.spawned ?? null,
        injected: runtime?.injected ?? attempt.injected,
        provider: runtime?.provider ?? task.worker,
        authPath: runtime?.authPath ?? null,
        login: runtime?.login ?? null,
        codexBin: runtime?.codexBin ?? null,
        cliVersion: runtime?.cliVersion ?? null,
        requestedModel: runtime?.requested?.model ?? null,
        requestedEffort: runtime?.requested?.effort ?? null,
        effectiveModel: runtime?.effective?.model ?? null,
        effectiveEffort: runtime?.effective?.effort ?? null,
        modelProvider: runtime?.effective?.modelProvider ?? null,
        sandbox: runtime?.effective?.sandbox ?? null,
        planType: runtime?.effective?.planType ?? null,
        usedPercent: runtime?.effective?.usedPercent ?? null,
        verified: runtime?.verified ?? false,
        threadId: runtime?.threadId ?? attempt.threadId,
        startedAt: runtime?.startedAt ?? new Date(attempt.dispatchAt).toISOString(),
        endedAt: runtime?.endedAt ?? (attempt.endAt ? new Date(attempt.endAt).toISOString() : null),
        durationMs: runtime?.durationMs ?? (attempt.endAt ? attempt.endAt - attempt.dispatchAt : null),
        exitCode: runtime?.exitCode ?? null,
        signal: runtime?.signal ?? null,
        timedOut: runtime?.timedOut ?? false,
        artifact: runtime?.artifact ? relative(dataDir, join(dataDir, 'workspaces', run.id, task.id, runtime.artifact)) : null,
        usage: runtime?.usage ?? null,
        command: runtime?.command ?? null,
        error: runtime?.error ?? attempt.error ?? null,
      });
    }
  }
  return attempts.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export function scanSecrets(paths) {
  const hits = [];
  for (const root of paths) {
    if (!existsSync(root)) continue;
    const files = statSync(root).isDirectory() ? walk(root) : [root];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) hits.push({ file, pattern: name });
      }
    }
  }
  return hits;
}

export function detectViolations({ run, tasks, deps, events, allEvents, timeline, manifest, workers, secrets = [] }) {
  const violations = [];
  const add = (type, detail) => violations.push({ type, ...detail });
  const { records } = timeline;
  const live = run.execution?.mode === 'codex';

  for (const task of tasks) {
    const record = records.get(task.id);
    const parents = deps.filter((dep) => dep.taskId === task.id).map((dep) => records.get(dep.dependsOnTaskId)).filter(Boolean);
    for (const attempt of record.attempts) {
      for (const parent of parents) {
        const needed = task.dependencyPolicy === 'all_terminal' ? parent.terminalIndex : parent.completedIndex;
        if (needed == null || needed > attempt.dispatchIndex) {
          add('dependency_order', { task: record.key, attempt: attempt.attempt, dependsOn: parent.key, policy: task.dependencyPolicy, dispatchEvent: attempt.dispatchIndex, dependencyEvent: needed });
        }
      }
      if (task.requiresApproval && (record.approvedIndex == null || record.approvedIndex > attempt.dispatchIndex)) {
        add('approval_gate', { task: record.key, attempt: attempt.attempt, dispatchEvent: attempt.dispatchIndex });
      }
    }
    record.attempts.forEach((attempt, index) => {
      if (attempt.attempt !== index + 1) add('attempt_numbering', { task: record.key, expected: index + 1, got: attempt.attempt });
    });
    if (task.attempts !== record.attempts.length + record.refused) {
      add('attempt_accounting', { task: record.key, stateAttempts: task.attempts, dispatchedAttempts: record.attempts.length });
    }
    const last = [...events].reverse().find((event) => event.taskId === task.id && END_EVENTS.has(event.type) && event.type !== 'task.retried');
    const expectedStatus = { 'task.completed': 'succeeded', 'task.failed': 'failed', 'task.cancelled': 'cancelled' }[last?.type];
    if (expectedStatus && expectedStatus !== task.status) add('state_event_mismatch', { task: record.key, state: task.status, lastEvent: last.type });
    if (!last && TERMINAL_STATUS.has(task.status)) add('state_event_mismatch', { task: record.key, state: task.status, lastEvent: null });
  }

  for (const item of timeline.overCap) add('concurrency_cap', item);
  for (const item of timeline.doubleDispatch) add('double_dispatch', item);
  for (const item of timeline.endsWithoutDispatch) add('end_without_dispatch', item);
  if (!['running', 'paused'].includes(run.status)) {
    for (const item of timeline.openAttempts) add('unterminated_attempt', item);
  }

  const threads = new Map();
  for (const worker of workers) {
    if (!worker.threadId) continue;
    if (threads.has(worker.threadId)) add('thread_reuse', { threadId: worker.threadId, tasks: [threads.get(worker.threadId), `${worker.key}#${worker.attempt}`] });
    threads.set(worker.threadId, `${worker.key}#${worker.attempt}`);
  }

  if (live) {
    for (const worker of workers) {
      const label = `${worker.key}#${worker.attempt}`;
      if (!worker.runtimePath) {
        add('missing_runtime_evidence', { attempt: label });
        continue;
      }
      if (worker.injected) {
        if (worker.spawned) add('injected_fault_spawned_worker', { attempt: label });
        continue;
      }
      if (worker.requestedModel !== 'gpt-5.6-luna' || worker.requestedEffort !== 'max') {
        add('requested_model', { attempt: label, model: worker.requestedModel, effort: worker.requestedEffort });
      }
      if (worker.effectiveModel && worker.effectiveModel !== worker.requestedModel) add('model_substitution', { attempt: label, requested: worker.requestedModel, effective: worker.effectiveModel });
      if (worker.effectiveEffort && worker.effectiveEffort !== worker.requestedEffort) add('effort_substitution', { attempt: label, requested: worker.requestedEffort, effective: worker.effectiveEffort });
      if (worker.sandbox && worker.sandbox !== 'read-only') add('sandbox', { attempt: label, sandbox: worker.sandbox });
      if (worker.outcome === 'completed' && !worker.verified) add('unverified_worker', { attempt: label });
      if (worker.outcome === 'completed' && !worker.planType) add('chatgpt_plan_missing', { attempt: label });
      if (!worker.command?.includes('--sandbox') || !worker.command?.includes('read-only')) add('sandbox_flag_missing', { attempt: label });
    }
  }

  for (const entry of manifest.entries) {
    if (!entry.ownerOk) add('workspace_owner', { task: entry.key });
    for (const path of entry.unexpectedFiles) add('unexpected_workspace_file', { task: entry.key, path });
    if (entry.artifact && !entry.artifact.invalid && !entry.artifact.nonceMatch) add('nonce_mismatch', { task: entry.key });
  }
  for (const name of manifest.strayWorkspaces) add('stray_workspace', { name });

  for (const event of events) {
    if (event.type === 'isolation.violation' || event.type === 'worker.substitution_detected' || event.type === 'run.aborted') {
      add(event.type.replace('.', '_'), { event: event.index, payload: event.payload });
    }
  }
  const ids = new Set();
  let previous = 0;
  for (const event of allEvents) {
    if (ids.has(event.id)) add('event_log_duplicate_id', { id: event.id, index: event.index });
    ids.add(event.id);
    const at = Date.parse(event.ts);
    if (at < previous) add('event_log_time_regression', { index: event.index });
    previous = Math.max(previous, at);
  }
  for (const hit of secrets) add('secret_pattern', hit);
  return violations;
}

const TERMINAL_STATUS = new Set(['succeeded', 'failed', 'cancelled']);

export function summarizeMetrics({ run, state, tasks, deps, events, timeline, manifest, workers, violations }) {
  const records = [...timeline.records.values()];
  const attempts = records.flatMap((record) => record.attempts.map((attempt) => ({ ...attempt, key: record.key })));
  const dispatched = attempts.filter((attempt) => attempt.dispatchAt != null);
  const firstDispatchAt = Math.min(...dispatched.map((attempt) => attempt.dispatchAt));
  const lastEndAt = Math.max(...dispatched.map((attempt) => attempt.endAt ?? attempt.dispatchAt));
  const runStarted = events.find((event) => event.type === 'run.started');
  const runStartedAt = runStarted ? Date.parse(runStarted.ts) : Date.parse(run.startedAt);
  const retried = events.filter((event) => event.type === 'task.retried');

  const blocked = records.map((record) => {
    const task = tasks.find((item) => item.id === record.taskId);
    const [first, ...retries] = record.attempts;
    // Waits are measured from the first dispatch so live preflight time is not counted as blocking.
    const readyAt = record.readyAt != null && Number.isFinite(firstDispatchAt) ? Math.max(record.readyAt, firstDispatchAt) : null;
    return {
      key: record.key,
      dependencyWaitMs: readyAt != null ? readyAt - firstDispatchAt : null,
      slotWaitMs: first && readyAt != null ? Math.max(0, first.dispatchAt - readyAt) : null,
      retryWaitMs: retries.reduce((sum, attempt) => sum + Math.max(0, attempt.dispatchAt - (attempt.queuedAt ?? attempt.dispatchAt)), 0),
      // A gate still awaiting approval has an open-ended wait, reported as pendingSince instead.
      approvalWaitMs: task.requiresApproval && record.approvalRequiredAt != null && first ? Math.max(0, first.dispatchAt - record.approvalRequiredAt) : null,
    };
  });
  const sum = (field) => blocked.reduce((total, item) => total + (item[field] || 0), 0);
  const busyMs = dispatched.reduce((total, attempt) => total + Math.max(0, (attempt.endAt ?? attempt.dispatchAt) - attempt.dispatchAt), 0);
  const makespanMs = Number.isFinite(firstDispatchAt) ? lastEndAt - firstDispatchAt : null;
  const gate = tasks.find((task) => task.requiresApproval);
  const spawned = workers.filter((worker) => worker.spawned);

  return {
    runId: run.id,
    status: run.status,
    cap: timeline.cap,
    execution: run.execution,
    taskCount: tasks.length,
    dependencyCount: deps.length,
    branches: [...new Set(tasks.map((task) => task.branch).filter((branch) => branch && branch !== 'root'))],
    runStartedAt: new Date(runStartedAt).toISOString(),
    firstDispatchAt: Number.isFinite(firstDispatchAt) ? new Date(firstDispatchAt).toISOString() : null,
    lastWorkerEndAt: Number.isFinite(lastEndAt) ? new Date(lastEndAt).toISOString() : null,
    preflightMs: Number.isFinite(firstDispatchAt) ? firstDispatchAt - runStartedAt : null,
    makespanMs,
    workerBusyMs: busyMs,
    utilization: makespanMs && timeline.cap ? busyMs / (makespanMs * timeline.cap) : null,
    peakConcurrency: timeline.peakConcurrency,
    dispatches: dispatched.length,
    dispatchOrder: timeline.dispatchOrder,
    retries: {
      total: retried.length,
      injected: retried.filter((event) => event.payload?.injected).length,
      organic: retried.filter((event) => !event.payload?.injected).length,
      faultsInjected: events.filter((event) => event.type === 'fault.injected').length,
    },
    blockedMs: {
      dependencyWait: sum('dependencyWaitMs'),
      slotWait: sum('slotWaitMs'),
      retryWait: sum('retryWaitMs'),
      approvalWait: sum('approvalWaitMs'),
    },
    blockedByTask: blocked,
    artifacts: {
      ...manifest.completeness,
      ratio: manifest.completeness.expected ? manifest.completeness.complete / manifest.completeness.expected : null,
    },
    workers: {
      spawned: spawned.length,
      verified: spawned.filter((worker) => worker.verified).length,
      models: [...new Set(spawned.map((worker) => `${worker.effectiveModel}/${worker.effectiveEffort}`))],
      planTypes: [...new Set(spawned.map((worker) => worker.planType))],
      maxUsedPercent: Math.max(0, ...spawned.map((worker) => worker.usedPercent ?? 0)),
      tokens: spawned.reduce((total, worker) => ({
        input: total.input + (worker.usage?.input_tokens || 0),
        cachedInput: total.cachedInput + (worker.usage?.cached_input_tokens || 0),
        output: total.output + (worker.usage?.output_tokens || 0),
        reasoning: total.reasoning + (worker.usage?.reasoning_output_tokens || 0),
      }), { input: 0, cachedInput: 0, output: 0, reasoning: 0 }),
    },
    approvalGate: gate
      ? {
        key: gate.key || gate.id,
        status: gate.status,
        dispatched: timeline.records.get(gate.id).attempts.length > 0,
        approvalRequiredAt: timeline.records.get(gate.id).approvalRequiredAt ? new Date(timeline.records.get(gate.id).approvalRequiredAt).toISOString() : null,
        pendingSince: gate.status === 'awaiting_approval' && timeline.records.get(gate.id).approvalRequiredAt
          ? new Date(timeline.records.get(gate.id).approvalRequiredAt).toISOString()
          : null,
      }
      : null,
    pendingProposals: state.proposals.filter((item) => item.runId === run.id && item.status === 'proposed').map((item) => ({ id: item.id, title: item.title, type: item.type })),
    violations: violations.length,
    attemptDurations: records.map((record) => ({
      key: record.key,
      durations: record.attempts.map((attempt) => (attempt.endAt ?? attempt.dispatchAt) - attempt.dispatchAt),
    })),
  };
}

// Trace-driven replay: re-schedules measured attempt durations under a cap, either
// refilling a slot as soon as it frees (pool, what the engine does) or waiting for a
// whole batch to finish (batch, what the engine did before live execution).
// Durations are taken as fixed, so any contention effect in the trace is replayed too.
export function replaySchedule({ tasks, dependencies, cap, policy = 'pool' }) {
  const limit = cap == null || cap <= 0 ? Infinity : cap;
  const parents = new Map(tasks.map((task) => [task.key, []]));
  for (const dep of dependencies) parents.get(dep.task)?.push(dep.dependsOn);
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = new Map(tasks.map((task) => [task.key, { next: 0, done: task.attempts.length === 0, running: false, readyAt: null, queuedAt: null }]));
  const attempts = [];
  let running = [];
  let time = 0;
  let peak = 0;
  for (;;) {
    for (const task of tasks) {
      const entry = state.get(task.key);
      if (entry.done || entry.running || entry.queuedAt != null) continue;
      if (parents.get(task.key).every((parent) => state.get(parent)?.done ?? true)) {
        entry.queuedAt = time;
        if (entry.readyAt == null) entry.readyAt = time;
      }
    }
    if (policy === 'pool' || running.length === 0) {
      for (const task of tasks) {
        if (running.length >= limit) break;
        const entry = state.get(task.key);
        if (entry.done || entry.running || entry.queuedAt == null) continue;
        const attempt = { key: task.key, attempt: entry.next + 1, queuedAt: entry.queuedAt, at: time, end: time + task.attempts[entry.next] };
        entry.running = true;
        entry.queuedAt = null;
        attempts.push(attempt);
        running.push(attempt);
      }
      peak = Math.max(peak, running.length);
    }
    if (!running.length) break;
    const next = policy === 'batch' ? Math.max(...running.map((item) => item.end)) : Math.min(...running.map((item) => item.end));
    const finished = policy === 'batch' ? running : running.filter((item) => item.end === next);
    time = next;
    running = running.filter((item) => !finished.includes(item));
    for (const item of finished) {
      const entry = state.get(item.key);
      entry.running = false;
      entry.next += 1;
      if (entry.next >= byKey.get(item.key).attempts.length) entry.done = true;
    }
  }
  const stuck = [...state.entries()].filter(([, entry]) => !entry.done).map(([key]) => key);
  const readyAt = Object.fromEntries([...state.entries()].map(([key, entry]) => [key, entry.readyAt]));
  return { makespan: time, peak, attempts, dispatches: attempts, readyAt, stuck };
}

// Summarises a replayed schedule with the same measures as a live run, and runs the
// live-run detectors over a synthetic event log built from it.
export function replayMetrics({ tasks, dependencies, cap, policy = 'pool', dependencyPolicies = {} }) {
  const schedule = replaySchedule({ tasks, dependencies, cap, policy });
  const byTask = new Map(tasks.map((task) => [task.key, schedule.attempts.filter((attempt) => attempt.key === task.key)]));
  const blocked = tasks.filter((task) => task.attempts.length).map((task) => {
    const [first, ...retries] = byTask.get(task.key);
    return {
      key: task.key,
      dependencyWaitMs: schedule.readyAt[task.key],
      slotWaitMs: first ? first.at - first.queuedAt : null,
      retryWaitMs: retries.reduce((sum, attempt) => sum + (attempt.at - attempt.queuedAt), 0),
    };
  });
  const sum = (field) => blocked.reduce((total, item) => total + (item[field] || 0), 0);

  const synthetic = [];
  for (const attempt of schedule.attempts) {
    const last = attempt.attempt === tasks.find((task) => task.key === attempt.key).attempts.length;
    synthetic.push({ at: attempt.end, order: 0, type: last ? 'task.completed' : 'task.retried', taskId: attempt.key, payload: { attempt: attempt.attempt, retryable: true } });
    synthetic.push({ at: attempt.at, order: 1, type: 'worker.dispatched', taskId: attempt.key, payload: { attempt: attempt.attempt } });
  }
  synthetic.sort((a, b) => a.at - b.at || a.order - b.order);
  const events = synthetic.map((event, index) => ({ id: `sim_${index}`, index, ts: new Date(event.at).toISOString(), runId: 'replay', type: event.type, taskId: event.taskId, payload: event.payload }));
  const run = { id: 'replay', maxConcurrency: cap, status: 'awaiting_approval', execution: { mode: 'replay' } };
  const simTasks = tasks.map((task) => ({
    id: task.key,
    key: task.key,
    status: task.attempts.length ? 'succeeded' : 'awaiting_approval',
    attempts: task.attempts.length,
    dependencyPolicy: dependencyPolicies[task.key] || 'all_succeeded',
    requiresApproval: !task.attempts.length,
  }));
  const simDeps = dependencies.map((dep) => ({ taskId: dep.task, dependsOnTaskId: dep.dependsOn }));
  const timeline = buildTimeline({ run, tasks: simTasks, events });
  const violations = detectViolations({ run, tasks: simTasks, deps: simDeps, events, allEvents: events, timeline, manifest: { entries: [], strayWorkspaces: [] }, workers: [] });

  return {
    cap,
    policy,
    makespanMs: schedule.makespan,
    peakConcurrency: schedule.peak,
    dispatches: schedule.attempts.length,
    dispatchOrder: [...schedule.attempts].sort((a, b) => a.at - b.at).map((attempt) => `${attempt.key}#${attempt.attempt}`),
    blockedMs: { dependencyWait: sum('dependencyWaitMs'), slotWait: sum('slotWaitMs'), retryWait: sum('retryWaitMs') },
    blockedByTask: blocked,
    stuck: schedule.stuck,
    violations,
    schedule: schedule.attempts,
  };
}

export function renderTree(tasks, deps) {
  const byParent = new Map();
  for (const task of tasks) {
    const key = task.parentId || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  const keyOf = new Map(tasks.map((task) => [task.id, task.key || task.id]));
  const lines = [];
  const visit = (task, depth) => {
    const after = deps.filter((dep) => dep.taskId === task.id).map((dep) => keyOf.get(dep.dependsOnTaskId));
    lines.push(`${'  '.repeat(depth)}${String(task.key || task.id).padEnd(4)} ${task.status.padEnd(18)} ${task.kind.padEnd(13)} attempts=${task.attempts} ${task.title}${after.length ? `  ← ${after.join(', ')}` : ''}`);
    for (const child of byParent.get(task.id) || []) visit(child, depth + 1);
  };
  for (const root of byParent.get('root') || []) visit(root, 0);
  return lines.join('\n');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}
