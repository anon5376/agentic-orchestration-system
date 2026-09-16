import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../app/WorkspaceContext';
import { DocketFigure } from '../components/DocketFigure';
import { EngineStatePanel } from '../components/ModeBanner';
import { RunPlanPanel } from '../components/RunPlanPanel';
import { aosApi } from '../lib/aosApi';
import { ensurePlannerRequest, leadPlannerState } from '../lib/leadPlanner';
import { displayStatus, selectCurrentProposal } from '../lib/liveRecords';
import { buildTaskAnswers, describeTaskAnswerError, getOpenTaskQuestions } from '../lib/taskQuestions';

const SELECTED_BLUEPRINT_KEY = 'aos-selected-blueprint';
const ATTENTION_WORKER_STATUSES = new Set(['running', 'awaiting_user', 'awaiting_approval']);

function PageHeader({ title, description, action, onAction, context = 'Current research', figure, disabled }) {
  return (
    <header className={`docket-header docket-header--${figure}`}>
      <div>
        <p className="docket-context">{context}</p>
        <h1>{title}</h1>
      </div>
      <div className="docket-header__aside">
        <p>{description}</p>
        {action ? (
          <button type="button" className="docket-button docket-button--primary" onClick={onAction} disabled={disabled}>
            {action}
          </button>
        ) : null}
      </div>
      <DocketFigure variant={figure} />
    </header>
  );
}

function State({ children, tone = 'neutral' }) {
  return <span className={`docket-state docket-state--${tone}`}>{children}</span>;
}

function SectionHeading({ title, note }) {
  return (
    <div className="docket-section-heading">
      <h2>{title}</h2>
      {note ? <p>{note}</p> : null}
    </div>
  );
}

function DefinitionList({ items }) {
  return (
    <dl className="docket-definitions">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExecutionTelemetry({ worker, compact = false }) {
  const execution = normalizeExecutionTelemetry(worker);
  if (!execution) return null;
  const pool = isPoolExecution(execution.kind);
  const expired = execution.leaseState === 'expired';
  const heartbeatAge = formatTelemetryAge(execution.heartbeatAt);
  const heartbeatTimestamp = formatTelemetryTimestamp(execution.heartbeatAt);
  const leaseTimestamp = formatTelemetryTimestamp(execution.leaseUntil);

  if (compact) {
    return (
      <span className={`worker-record__execution ${pool ? 'is-pool' : ''}`}>
        <b>{executionKindLabel(execution.kind)}</b>
        {execution.protocol ? ` · ${execution.protocol}` : null}
      </span>
    );
  }

  const items = [
    ['Executor', executionKindLabel(execution.kind)],
    ...(execution.leaseState ? [['Claim state', displayStatus(execution.leaseState)]] : []),
    ...(execution.ownerId ? [['Pool owner', execution.ownerId]] : []),
    ...(execution.claimId ? [['Pool claim', execution.claimId]] : []),
    ...(execution.protocol ? [['Pool protocol', execution.protocol]] : []),
    ...(execution.heartbeatAt ? [['Heartbeat freshness', heartbeatAge || heartbeatTimestamp || 'reported']] : []),
    ...(execution.leaseUntil ? [['Lease deadline', leaseTimestamp || execution.leaseUntil]] : []),
    ...(execution.workerPid ? [['Worker PID', execution.workerPid]] : []),
    ...(execution.workerPgid ? [['Worker PGID', execution.workerPgid]] : []),
  ];

  return (
    <section className={`execution-telemetry ${pool ? 'is-pool' : ''} ${expired ? 'is-expired' : ''}`} aria-label="Execution authority telemetry">
      <div className="execution-telemetry__heading">
        <span>Execution authority</span>
        <strong>{executionKindLabel(execution.kind)}</strong>
      </div>
      <DefinitionList items={items} />
    </section>
  );
}

function Gate({ children, allowEmpty = false, emptyTitle, emptyBody, emptyAction, onEmptyAction }) {
  const ws = useWorkspace();
  if (ws.connection === 'loading') {
    return <EngineStatePanel title="Loading local engine" body="Reading the shared .aos store." />;
  }
  if (ws.connection === 'error') {
    return (
      <EngineStatePanel
        title="Local engine unreachable"
        body={`${ws.error || 'Nothing is listening on the API proxy.'} Start it with npm run engine, then stay on Live local.`}
      />
    );
  }
  if (!allowEmpty && ws.empty) {
    return (
      <EngineStatePanel
        title={emptyTitle || 'No live research yet'}
        body={emptyBody || 'Create a goal from New question, or run aos goal create from the CLI.'}
        action={emptyAction}
        onAction={onEmptyAction}
      />
    );
  }
  return children;
}

function statusTone(status) {
  if (['running', 'ready', 'active'].includes(status)) return 'active';
  if (['awaiting_user', 'awaiting_approval', 'paused', 'proposed'].includes(status)) return 'review';
  if (['succeeded', 'completed', 'approved', 'pass', 'enforced'].includes(status)) return 'complete';
  if (['failed', 'error', 'rejected', 'conflict'].includes(status)) return 'warning';
  return 'quiet';
}

function flattenTasks(nodes, depth = 0, acc = []) {
  for (const node of nodes || []) {
    acc.push({ ...node, depth });
    flattenTasks(node.children, depth + 1, acc);
  }
  return acc;
}

function formatTokens(value) {
  if (value === null || value === undefined || value === '') return '—';
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return '—';
  if (count < 1000) return count.toLocaleString('en-US');
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '—';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 1) return `${remainder}s`;
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function workerHasTokenReceipt(worker, field = null) {
  return (worker?.runtime || []).some((attempt) => {
    const usage = attempt?.usage;
    if (!usage || typeof usage !== 'object') return false;
    const fields = field ? [field] : ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
    return fields.some((name) => Number.isFinite(Number(usage[name])) && Number(usage[name]) >= 0);
  });
}

function aggregateHasTokenReceipt(workers, field) {
  return workers.some((worker) => workerHasTokenReceipt(worker, field));
}

function reportedWorkerToken(worker, field) {
  return workerHasTokenReceipt(worker, field) ? formatTokens(worker?.usage?.[field]) : '—';
}

function shortWorkspace(path) {
  if (!path) return 'unclaimed';
  const parts = String(path).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function telemetryText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function executionField(source, pool, ...keys) {
  for (const key of keys) {
    const value = telemetryText(source?.[key]) || telemetryText(pool?.[key]);
    if (value) return value;
  }
  return null;
}

function normalizeExecutionTelemetry(worker) {
  const source = worker?.execution;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const pool = [source.pool, source.lease, source.poolLease, source.pool_lease]
    .find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
  const execution = {
    kind: executionField(source, pool, 'executorKind', 'executor_kind', 'kind', 'executor'),
    ownerId: executionField(source, pool, 'ownerId', 'owner_id', 'poolOwnerId', 'pool_owner_id', 'poolOwner', 'pool_owner', 'owner'),
    claimId: executionField(source, pool, 'claimId', 'claim_id', 'poolClaimId', 'pool_claim_id', 'poolClaim', 'pool_claim', 'claim'),
    protocol: executionField(source, pool, 'poolProtocol', 'pool_protocol', 'protocol'),
    leaseState: executionField(source, pool, 'leaseState', 'lease_state', 'state'),
    heartbeatAt: executionField(source, pool, 'heartbeatAt', 'heartbeat_at'),
    leaseUntil: executionField(source, pool, 'leaseUntil', 'lease_until', 'leaseDeadline', 'lease_deadline'),
    workerPid: executionField(source, pool, 'workerPid', 'worker_pid', 'processId', 'process_id', 'pid'),
    workerPgid: executionField(source, pool, 'workerPgid', 'worker_pgid', 'processGroupId', 'process_group_id', 'pgid'),
  };
  return Object.values(execution).some(Boolean) ? execution : null;
}

function isPoolExecution(kind) {
  return ['pool', 'external_pool', 'worker_pool'].includes(String(kind || '').toLowerCase());
}

function executionKindLabel(kind) {
  if (!kind) return 'unknown executor';
  if (isPoolExecution(kind)) return 'external pool';
  return displayStatus(kind);
}

function formatTelemetryTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : telemetryText(value);
}

function formatTelemetryAge(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return null;
  const delta = Date.now() - timestamp;
  if (delta < 1000 && delta > -1000) return 'just now';
  if (delta < 0) return `in ${formatDuration(Math.abs(delta))}`;
  return `${formatDuration(delta)} ago`;
}

function leadStateTone(state) {
  if (state === 'planned') return 'complete';
  if (['awaiting_user', 'lead_revision_ready', 'awaiting_approval'].includes(state)) return 'review';
  if (['failed', 'rejected', 'interrupted'].includes(state)) return 'warning';
  if (state === 'generating') return 'active';
  return 'quiet';
}

function describeLeadPlannerError(error, fallback) {
  const code = String(error?.data?.code || error?.code || '').trim();
  const messages = {
    lead_plan_input_invalid: 'Check the objective and context before trying the lead planner again.',
    lead_plan_creation_mismatch: 'That planning request was already used for different input. Keep the objective and context unchanged when retrying.',
    lead_plan_request_mismatch: 'That revision request was already used for different input. Review the current proposal before retrying.',
    lead_plan_request_active: 'A lead proposal is still being prepared. Wait for its state to settle before trying again.',
    lead_plan_questions_unavailable: 'The clarification set changed. Review the current goal before answering again.',
    lead_plan_question_not_found: 'A clarification is no longer available. Review the current goal before continuing.',
    lead_plan_answer_conflict: 'A clarification answer changed. Review the current goal before continuing.',
    lead_plan_revision_not_ready: 'Answer every required clarification before revising the plan.',
    lead_plan_derived_invalid: 'This proposal cannot be revised from the current clarification state.',
    lead_plan_already_accepted: 'A lead plan has already been accepted for this goal.',
    lead_plan_goal_not_lead: 'This goal is not using the lead planner.',
  };
  return messages[code] || error?.message || fallback;
}

function LeadPlanProposal({ proposal, phase, onAccept, onReject, disabled }) {
  const tasks = Array.isArray(proposal?.plan?.tasks) ? proposal.plan.tasks : [];
  const reviewable = phase === 'awaiting_approval';
  return (
    <section className="lead-plan" aria-labelledby="lead-plan-title">
      <div className="lead-plan__header">
        <div>
          <p className="docket-context">Lead plan proposal</p>
          <h3 id="lead-plan-title">{reviewable ? 'Review before launch' : 'Accepted plan'}</h3>
        </div>
        <State tone={leadStateTone(phase)}>{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</State>
      </div>
      <p className="form-note">{proposal?.summary || 'The lead planner returned an immutable proposal for operator review.'}</p>
      {tasks.length ? (
        <ol className="lead-plan__tasks">
          {tasks.map((task, index) => (
            <li key={task.id || `${task.title || 'task'}-${index}`}>
              <span>{task.title || 'Untitled task'}</span>
              <small>{task.kind || task.role || 'unspecified kind'}</small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="form-note">No task details were returned with this proposal.</p>
      )}
      {reviewable ? (
        <div className="lead-plan__actions">
          <button type="button" className="docket-button docket-button--primary" onClick={onAccept} disabled={disabled}>
            Accept plan
          </button>
          <button type="button" className="docket-button docket-button--quiet" onClick={onReject} disabled={disabled}>
            Reject plan
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TaskTree({ nodes, selectedId, selectedPath, telemetryByTask, onSelect, level = 1 }) {
  return (
    <ol className={level === 1 ? 'task-tree' : 'task-tree__group'} data-testid={level === 1 ? 'task-tree' : undefined}>
      {(nodes || []).map((task) => {
        const worker = telemetryByTask.get(task.id);
        const children = task.children || [];
        const selected = task.id === selectedId;
        return (
          <li
            className={`${selected ? 'is-selected' : ''} ${selectedPath.has(task.id) ? 'is-path' : ''}`}
            key={task.id}
          >
            <button type="button" onClick={() => onSelect(task.id)} aria-current={selected ? 'true' : undefined}>
              <i className={`task-tree__signal task-tree__signal--${task.status}`} aria-hidden="true" />
              <span className="task-tree__copy">
                <small>{worker?.taskCode || task.kind}{(task.planVersion ?? task.plan?.version) != null ? ` · plan v${task.planVersion ?? task.plan.version}` : ''}</small>
                <strong>{task.title}</strong>
              </span>
              <span className="task-tree__state">{displayStatus(task.status)}</span>
              {worker?.status === 'running' ? <span className="task-tree__model">{worker.model}</span> : null}
            </button>
            {children.length ? (
              <TaskTree
                nodes={children}
                selectedId={selectedId}
                selectedPath={selectedPath}
                telemetryByTask={telemetryByTask}
                onSelect={onSelect}
                level={level + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function TaskIntervention({ task, run, onAnswer, disabled, focusToken }) {
  const questions = getOpenTaskQuestions(task);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const firstAnswerRef = useRef(null);
  const headingId = task?.id ? `task-intervention-${task.id}` : 'task-intervention';

  useEffect(() => {
    setDrafts({});
    setError(null);
    setFieldErrors({});
    setSuccess('');
  }, [task?.id, task?.updatedAt]);

  useEffect(() => {
    if (focusToken && questions.length) firstAnswerRef.current?.focus();
  }, [focusToken, task?.id, questions.length]);

  if (!task || task.status !== 'awaiting_user') return null;

  const submit = async (event) => {
    event.preventDefault();
    if (submittingRef.current || disabled) return;
    let answers;
    try {
      answers = buildTaskAnswers(task, drafts);
    } catch (answerError) {
      setSuccess('');
      const described = describeTaskAnswerError(answerError);
      setFieldErrors(Object.fromEntries((described.fieldErrors || []).map((item) => [item.questionId || String(item.questionIndex), item])));
      setError(described);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    setSuccess('');
    try {
      await onAnswer(task.id, answers);
      setDrafts({});
      setSuccess('Answers recorded.');
    } catch (answerError) {
      setError(describeTaskAnswerError(answerError));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <section className="task-intervention" data-testid="task-intervention" aria-labelledby={headingId}>
      <div className="task-intervention__header">
        <div>
          <p className="docket-context">Operator intervention</p>
          <h3 id={headingId}>Answer required</h3>
        </div>
        <State tone="review">Awaiting user</State>
      </div>
      <p className="task-intervention__note">
        {run?.status === 'paused' ? 'Run paused. Answering this task will not resume scheduling.' : 'Every open required answer is required before this task can continue.'}
      </p>
      <p className="task-intervention__audit-note">Activity records retain question IDs and counts only.</p>
      {questions.length ? (
        <form className="task-intervention__form" onSubmit={submit} noValidate>
          <fieldset className="task-intervention__fieldset task-intervention__questions" disabled={disabled || submitting}>
            <legend className="sr-only">Required operator answers</legend>
            {questions.map((question, index) => {
              const inputId = `${headingId}-question-${question.id || index}`;
              const errorId = `${inputId}-error`;
              const fieldKey = question.id || String(index);
              const fieldError = fieldErrors[fieldKey];
              const value = drafts[question.id] || '';
              const askedBy = question.askedBy && typeof question.askedBy === 'object' ? question.askedBy : {};
              return (
                <label className="task-intervention__question" htmlFor={inputId} key={question.id || `question-${index}`}>
                  <span>{question.prompt}</span>
                  {question.reason ? <small>{question.reason}</small> : null}
                  <small className="task-intervention__provenance">
                    worker={askedBy.worker || '—'} · agent={askedBy.agentId || '—'} · attempt={question.attempt ?? '—'}
                  </small>
                  <textarea
                    id={inputId}
                    ref={index === 0 ? firstAnswerRef : undefined}
                    value={value}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [question.id]: event.target.value }));
                      setFieldErrors((current) => {
                        if (!current[fieldKey]) return current;
                        const next = { ...current };
                        delete next[fieldKey];
                        return next;
                      });
                    }}
                    minLength={1}
                    maxLength={2000}
                    required
                    aria-invalid={fieldError ? 'true' : undefined}
                    aria-describedby={[`${inputId}-count`, fieldError ? errorId : null].filter(Boolean).join(' ')}
                    placeholder="Write the operator answer"
                  />
                  <small id={`${inputId}-count`} className="task-intervention__counter">{value.trim().length}/2000 characters</small>
                  {fieldError ? <small id={errorId} className="task-intervention__field-error">{fieldError.message}</small> : null}
                </label>
              );
            })}
          </fieldset>
          <div className="task-intervention__footer">
            <span className="form-note">Required · 1–2000 nonblank characters</span>
            <button type="submit" className="docket-button docket-button--primary" disabled={disabled || submitting || !questions.length}>
              {submitting ? 'Recording…' : 'Record answers'}
            </button>
          </div>
          {error ? <p className="task-intervention__error" role="alert">{error.message}</p> : null}
          {success ? <p className="task-intervention__success" role="status">{success}</p> : null}
        </form>
      ) : (
        <p className="task-intervention__empty">No open required answers are present. Refresh the run before answering.</p>
      )}
    </section>
  );
}

export function LiveMissionsPage({ onNavigate }) {
  const ws = useWorkspace();
  const runs = ws.snapshot?.runs || [];
  const [selectedId, setSelectedId] = useState(runs[0]?.id || null);
  const selected = runs.find((run) => run.id === selectedId) || runs[0];

  return (
    <Gate emptyAction="New research" onEmptyAction={() => onNavigate('/intake')}>
      <div className="docket-page docket-page--missions">
        <PageHeader
          title="Research runs"
          description="Live goals and runs from the local engine. Same identifiers as the CLI."
          action="New research"
          onAction={() => onNavigate('/intake')}
          figure="missions"
        />
        <div className="docket-split docket-split--wide">
          <section>
            <SectionHeading title="Open work" note="Live local state" />
            <div className="run-list">
              {runs.map((run) => (
                <button
                  type="button"
                  className={`run-row ${selected?.id === run.id ? 'is-selected' : ''}`}
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  aria-pressed={selected?.id === run.id}
                >
                  <span className="run-row__main">
                    <strong>{run.id}</strong>
                    <span>{run.objective}</span>
                  </span>
                  <span className="run-row__facts">
                    <State tone={statusTone(run.status)}>{displayStatus(run.status)}</State>
                    <small>{run.updatedAt || run.createdAt}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <aside className="docket-note">
            {selected ? (
              <>
                <p className="docket-context">Selected run</p>
                <h2>{selected.id}</h2>
                <p className="docket-note__question">{selected.objective}</p>
                <DefinitionList
                  items={[
                    ['Status', selected.status],
                    ['Goal', selected.goalId],
                    ['Concurrency', selected.maxConcurrency == null ? 'uncapped' : String(selected.maxConcurrency)],
                  ]}
                />
                <button type="button" className="docket-link" onClick={() => onNavigate('/swarm')}>
                  Open run →
                </button>
              </>
            ) : (
              <p>Select a run.</p>
            )}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveIntakePage({ onNavigate }) {
  const ws = useWorkspace();
  const [objective, setObjective] = useState('');
  const [contextText, setContextText] = useState('');
  const [plannerMode, setPlannerMode] = useState(() => (
    ws.mode === 'live' && ws.snapshot?.execution?.mode === 'codex' ? 'lead' : 'deterministic'
  ));
  const plannerModeTouched = useRef(false);
  const [blueprints, setBlueprints] = useState([]);
  const [blueprintId, setBlueprintId] = useState(() => {
    try { return window.localStorage.getItem(SELECTED_BLUEPRINT_KEY) || ''; }
    catch { return ''; }
  });
  const [createdGoal, setCreatedGoal] = useState(null);
  const [leadProposal, setLeadProposal] = useState(null);
  const [leadCreateRequest, setLeadCreateRequest] = useState(null);
  const [leadRevisionRequest, setLeadRevisionRequest] = useState(null);
  const [leadGenerating, setLeadGenerating] = useState(false);
  const [leadReset, setLeadReset] = useState(false);
  const [answers, setAnswers] = useState({});
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    aosApi.blueprints().then((records) => {
      if (cancelled) return;
      const items = Array.isArray(records) ? records : records?.items || [];
      setBlueprints(items);
      setBlueprintId((current) => {
        const next = items.some((item) => item.id === current)
          ? current
          : items.find((item) => item.id === 'default-research-swarm')?.id || items[0]?.id || '';
        try { if (next) window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, next); } catch { /* ignore */ }
        return next;
      });
    }).catch((error) => {
      if (!cancelled) setActionError(error.message || 'Could not load saved swarms.');
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (plannerModeTouched.current || createdGoal || !ws.snapshot?.execution) return;
    setPlannerMode(ws.snapshot.execution.mode === 'codex' ? 'lead' : 'deterministic');
  }, [createdGoal, ws.snapshot?.execution, ws.snapshot?.execution?.mode]);

  // Prefer the engine's copy so a refreshed snapshot clears the awaiting_user gate.
  const latestGoal = useMemo(() => {
    const goals = ws.snapshot?.goals || [];
    const id = createdGoal?.id;
    if (id) return goals.find((item) => item.id === id) || createdGoal;
    const compatible = goals.filter((item) => (
      plannerMode === 'lead' ? item.planningMode === 'lead' : item.planningMode !== 'lead'
    ));
    if (plannerMode === 'lead' && leadReset) return null;
    if (plannerMode === 'lead' && leadCreateRequest) {
      return compatible.find((item) => item.leadPlan?.requestId === leadCreateRequest.requestId) || null;
    }
    return compatible[compatible.length - 1] || null;
  }, [ws.snapshot, createdGoal, leadCreateRequest, leadReset, plannerMode]);

  const proposalPointerId = latestGoal?.leadPlan?.id || '';
  const getLeadPlan = ws.getLeadPlan;
  useEffect(() => {
    if (plannerMode !== 'lead' || !proposalPointerId || leadProposal?.id === proposalPointerId || typeof getLeadPlan !== 'function') return undefined;
    let cancelled = false;
    getLeadPlan(proposalPointerId)
      .then((record) => {
        if (!cancelled) setLeadProposal(record?.proposal || record || null);
      })
      .catch((error) => {
        if (!cancelled) setActionError(describeLeadPlannerError(error, 'Could not load the lead plan details.'));
      });
    return () => { cancelled = true; };
  }, [getLeadPlan, leadProposal?.id, plannerMode, proposalPointerId]);

  const questions = latestGoal?.questions || [];
  const unanswered = questions.filter((question) => question.required && !String(question.answer || '').trim());
  const leadPhase = plannerMode === 'lead' ? leadPlannerState(latestGoal, leadProposal) : 'idle';
  const awaitingUser = plannerMode === 'lead'
    ? leadPhase === 'awaiting_user' && unanswered.length > 0
    : latestGoal?.status === 'awaiting_user' && unanswered.length > 0;
  const leadRevisionReady = plannerMode === 'lead' && leadPhase === 'lead_revision_ready' && unanswered.length === 0;
  const leadPlanReady = plannerMode === 'lead'
    && latestGoal?.status === 'planned'
    && leadProposal?.status === 'accepted';
  const showGoal = Boolean(latestGoal && !leadGenerating);
  const selectedBlueprint = blueprints.find((item) => item.id === blueprintId) || null;

  const selectBlueprint = (id) => {
    setBlueprintId(id);
    try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, id); } catch { /* ignore */ }
  };

  const selectPlannerMode = (next) => {
    if (next === plannerMode || ws.busy || createdGoal) return;
    plannerModeTouched.current = true;
    setPlannerMode(next);
    setLeadProposal(null);
    setLeadCreateRequest(null);
    setLeadRevisionRequest(null);
    setLeadReset(false);
    setAnswers({});
    setActionError('');
  };

  const submit = async () => {
    try {
      setActionError('');
      const contextPaths = contextText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (plannerMode === 'lead') {
        const request = ensurePlannerRequest(leadCreateRequest, {
          kind: 'create',
          prompt: objective,
          contextPaths,
        }, 'lead-create');
        setLeadCreateRequest(request);
        setLeadReset(false);
        setLeadGenerating(true);
        try {
          const result = await ws.createLeadGoal(objective, contextPaths, request.requestId);
          if (!result?.goal || !result?.proposal) throw new Error('The lead planner returned an incomplete proposal.');
          setCreatedGoal(result.goal);
          setLeadProposal(result.proposal);
          setLeadRevisionRequest(null);
          setAnswers({});
        } finally {
          setLeadGenerating(false);
        }
      } else {
        const created = await ws.createGoal(objective, contextPaths);
        setCreatedGoal(created);
        setLeadProposal(null);
        setLeadReset(false);
        setAnswers({});
      }
    } catch (error) {
      setActionError(plannerMode === 'lead'
        ? describeLeadPlannerError(error, 'Could not prepare the lead plan.')
        : (error.message || 'Could not store the objective.'));
    }
  };

  const recordAnswers = async () => {
    if (!latestGoal?.id) return;
    const payload = unanswered
      .map((question) => ({ id: question.id, answer: String(answers[question.id] || '').trim() }))
      .filter((answer) => answer.answer);
    if (!payload.length) {
      setActionError('Answer at least one required question before continuing.');
      return;
    }
    if (payload.some((answer) => answer.answer.length > 2000)) {
      setActionError('Each clarification must be between 1 and 2000 characters.');
      return;
    }
    try {
      setActionError('');
      const updated = plannerMode === 'lead'
        ? await ws.answerLeadQuestions(latestGoal.id, payload)
        : await ws.answerQuestions(latestGoal.id, payload);
      if (updated) setCreatedGoal(updated);
      setAnswers({});
    } catch (error) {
      setActionError(plannerMode === 'lead'
        ? describeLeadPlannerError(error, 'Could not record the clarifications.')
        : (error.message || 'Could not record the answers.'));
    }
  };

  const revisePlan = async () => {
    if (!latestGoal?.id || !leadProposal?.id || !leadRevisionReady) return;
    const request = ensurePlannerRequest(leadRevisionRequest, {
      kind: 'revise',
      goalId: latestGoal.id,
      derivedFromProposalId: leadProposal.id,
    }, 'lead-revise');
    setLeadRevisionRequest(request);
    try {
      setActionError('');
      const result = await ws.reviseLeadPlan(latestGoal.id, request.requestId, leadProposal.id);
      if (!result?.goal || !result?.proposal) throw new Error('The lead planner returned an incomplete revised proposal.');
      setCreatedGoal(result.goal);
      setLeadProposal(result.proposal);
      setAnswers({});
    } catch (error) {
      setActionError(describeLeadPlannerError(error, 'Could not revise the lead plan.'));
    }
  };

  const acceptPlan = async () => {
    if (!leadProposal?.id) return;
    try {
      setActionError('');
      const result = await ws.acceptLeadPlan(leadProposal.id);
      if (!result?.goal || !result?.proposal) throw new Error('The lead planner returned an incomplete acceptance response.');
      setCreatedGoal(result.goal);
      setLeadProposal(result.proposal);
    } catch (error) {
      setActionError(describeLeadPlannerError(error, 'Could not accept the lead plan.'));
    }
  };

  const rejectPlan = async () => {
    if (!leadProposal?.id) return;
    try {
      setActionError('');
      const result = await ws.rejectLeadPlan(leadProposal.id, 'Rejected from live intake');
      if (!result?.goal || !result?.proposal) throw new Error('The lead planner returned an incomplete rejection response.');
      setCreatedGoal(result.goal);
      setLeadProposal(result.proposal);
    } catch (error) {
      setActionError(describeLeadPlannerError(error, 'Could not reject the lead plan.'));
    }
  };

  const startOver = () => {
    setCreatedGoal(null);
    setLeadProposal(null);
    setLeadCreateRequest(null);
    setLeadRevisionRequest(null);
    setLeadGenerating(false);
    setAnswers({});
    setActionError('');
    setLeadReset(true);
  };

  const start = async () => {
    if (!latestGoal?.id) return;
    if (plannerMode === 'lead' && !leadPlanReady) {
      setActionError('Accept the lead plan before launching the selected swarm.');
      return;
    }
    try {
      setActionError('');
      const run = await ws.startRun(latestGoal.id, { blueprintId });
      if (run?.id) await ws.advance(run.id);
      onNavigate('/swarm');
    } catch (error) {
      setActionError(error.message || 'Could not start the run.');
    }
  };

  return (
    <Gate allowEmpty>
      <div className="docket-page docket-page--intake">
        <PageHeader
          title="Start with a question"
          description={plannerMode === 'lead'
            ? 'The lead planner drafts a proposal for operator review before any workers can launch.'
            : 'The engine stores the prompt, names material ambiguities, and builds a reviewable plan.'}
          context="New research"
          figure="intake"
        />
        <div className="docket-split">
          <section className="docket-form">
            <fieldset className="planner-mode" disabled={Boolean(createdGoal) || ws.busy}>
              <legend>Planner mode</legend>
              <label className={plannerMode === 'lead' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="planner-mode"
                  value="lead"
                  checked={plannerMode === 'lead'}
                  onChange={() => selectPlannerMode('lead')}
                />
                <span>
                  <strong>Lead planner · Luna</strong>
                  <small>Reviewable proposal with clarifications.</small>
                </span>
              </label>
              <label className={plannerMode === 'deterministic' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="planner-mode"
                  value="deterministic"
                  checked={plannerMode === 'deterministic'}
                  onChange={() => selectPlannerMode('deterministic')}
                />
                <span>
                  <strong>Deterministic</strong>
                  <small>Existing local plan and review flow.</small>
                </span>
              </label>
            </fieldset>
            <p className="form-note">
              {plannerMode === 'lead'
                ? 'Lead mode uses verified ChatGPT-login Codex · gpt-5.6-luna / max / read-only.'
                : 'Deterministic mode uses the local planner and keeps the existing review gate.'}
            </p>
            <label htmlFor="live-swarm">Swarm</label>
            <select id="live-swarm" value={blueprintId} onChange={(event) => selectBlueprint(event.target.value)} disabled={!blueprints.length || ws.busy}>
              {blueprints.length ? blueprints.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No saved swarms</option>}
            </select>
            <p className="form-note">This exact swarm version and its worker, hierarchy, memory, approval and budget settings are resolved when the run starts.</p>
            <label htmlFor="live-research-question">Research objective</label>
            <textarea
              id="live-research-question"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="State the question, success criteria, and scope."
            />
            <label htmlFor="live-context">Context paths (one per line, optional)</label>
            <textarea
              id="live-context"
              value={contextText}
              onChange={(event) => setContextText(event.target.value)}
              placeholder="notes.md"
            />
            <button type="button" className="docket-button docket-button--primary" onClick={submit} disabled={!objective.trim() || ws.busy}>
              {leadGenerating ? 'Generating…' : 'Prepare research plan'}
            </button>
            {plannerMode === 'lead' && actionError && !showGoal ? <p className="form-note action-notice" role="alert">{actionError}</p> : null}
            <p className="form-note">Stores the objective, records ambiguities, and keeps worker launch behind an explicit review gate.</p>
            {plannerMode === 'deterministic' && ws.notice ? <p className="form-note action-notice">{ws.notice}</p> : null}
          </section>
          <aside className={`interpretation ${latestGoal ? 'is-ready' : ''}`}>
            <SectionHeading
              title="Working interpretation"
              note={leadGenerating ? 'generating' : showGoal ? (plannerMode === 'lead' ? leadPhase : 'Goal prepared') : 'Waiting for a prompt'}
            />
            {leadGenerating ? (
              <div className="lead-planner-status">
                <State tone="active">generating</State>
                <p>The verified lead planner is preparing a proposal for review.</p>
              </div>
            ) : showGoal ? (
              <>
                {plannerMode === 'lead' ? (
                  <p className="lead-planner-status">
                    <State tone={leadStateTone(leadPhase)}>{leadPhase}</State>
                    <span>
                      {leadPhase === 'awaiting_user'
                        ? 'Clarifications are required before the plan can be revised.'
                        : leadPhase === 'lead_revision_ready'
                          ? 'All required clarifications are recorded. Review the next proposal step.'
                          : leadPhase === 'awaiting_approval'
                            ? 'Review the proposed tasks, then accept or reject the plan.'
                            : leadPhase === 'planned'
                              ? 'The accepted plan is ready for an explicit worker launch.'
                              : leadPhase === 'rejected'
                                ? 'The proposal was rejected and cannot be launched.'
                                : 'The lead planner returned a reviewable result.'}
                    </span>
                  </p>
                ) : null}
                <DefinitionList
                  items={[
                    ['Ambiguities', String(latestGoal.ambiguities?.length || 0)],
                    ['Plan tasks', String(plannerMode === 'lead' ? (leadProposal?.plan?.tasks?.length || 0) : (latestGoal.plan?.tasks?.length || 0))],
                    ['Swarm', selectedBlueprint?.name || blueprintId || 'None selected'],
                    ['Questions', questions.length ? `${questions.length} recorded` : 'None'],
                  ]}
                />
                <div className="question-list">
                  <h3>Questions recorded</h3>
                  <ol>
                    {questions.map((item, index) => (
                      <li key={item.id || `question-${index}`}>
                        <span>{item.prompt}</span>
                        {item.answer ? (
                          <small className="question-list__answer">{item.answer}</small>
                        ) : item.required ? (
                          <small className="question-list__required">Required before workers start</small>
                        ) : null}
                        {awaitingUser && item.required && !String(item.answer || '').trim() ? (
                          <label className="question-answer">
                            <span className="sr-only">Answer: {item.prompt}</span>
                            <input
                              type="text"
                              value={answers[item.id] || ''}
                              onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                              placeholder="Your answer"
                              aria-label={`Answer: ${item.prompt}`}
                              maxLength={2000}
                            />
                          </label>
                        ) : null}
                      </li>
                    ))}
                    {questions.length ? null : <li>No questions were recorded.</li>}
                  </ol>
                </div>
                {awaitingUser ? (
                  <>
                    <p className="form-note">
                      The engine will not dispatch workers until {unanswered.length} required {unanswered.length === 1 ? 'question is' : 'questions are'} answered.
                    </p>
                    <button type="button" className="docket-button docket-button--primary" onClick={recordAnswers} disabled={ws.busy}>
                      Record answers
                    </button>
                  </>
                ) : leadRevisionReady ? (
                  <>
                    <p className="form-note">Every required clarification is recorded. Ask the lead planner for a revised proposal.</p>
                    <button type="button" className="docket-button docket-button--primary" onClick={revisePlan} disabled={ws.busy || !leadProposal?.id}>
                      Revise plan
                    </button>
                  </>
                ) : plannerMode === 'lead' && (leadPhase === 'awaiting_approval' || leadPhase === 'planned' || leadPhase === 'rejected') ? (
                  leadProposal ? (
                    <LeadPlanProposal
                      proposal={leadProposal}
                      phase={leadPhase}
                      onAccept={acceptPlan}
                      onReject={rejectPlan}
                      disabled={ws.busy}
                    />
                  ) : (
                    <p className="form-note">Loading the immutable lead plan details for review.</p>
                  )
                ) : plannerMode === 'lead' && (leadPhase === 'failed' || leadPhase === 'interrupted') ? (
                  <p className="form-note">The lead planner did not produce a proposal. Review the error and try the objective again.</p>
                ) : (
                  plannerMode === 'lead' ? (
                    <p className="form-note">The lead planner must return a proposal before worker launch is available.</p>
                  ) : (
                    <button type="button" className="docket-button docket-button--primary" onClick={start} disabled={ws.busy || !blueprintId}>
                      Launch {selectedBlueprint?.name || 'selected swarm'}
                    </button>
                  )
                )}
                {plannerMode === 'lead' && leadPlanReady ? (
                  <button type="button" className="docket-button docket-button--primary" onClick={start} disabled={ws.busy || !blueprintId}>
                    Launch {selectedBlueprint?.name || 'selected swarm'}
                  </button>
                ) : null}
                {plannerMode === 'lead' && ['rejected', 'failed', 'interrupted'].includes(leadPhase) ? (
                  <div className="lead-plan__reset">
                    <p className="form-note">This lead attempt cannot be retried with the same proposal.</p>
                    <button type="button" className="docket-link" onClick={startOver} disabled={ws.busy}>Start over</button>
                  </div>
                ) : null}
                {actionError ? <p className="form-note action-notice" role="alert">{actionError}</p> : null}
              </>
            ) : (
              <p>Submit an objective to store it and review the plan before workers start.</p>
            )}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveSwarmPage() {
  const ws = useWorkspace();
  const run = ws.snapshot?.run;
  const roots = ws.snapshot?.taskTree || [];
  const tasks = flattenTasks(roots);
  const telemetry = ws.snapshot?.telemetry;
  const workers = telemetry?.workers || [];
  const firstWaitingTask = tasks.find((task) => task.status === 'awaiting_user');
  const [selectedId, setSelectedId] = useState(firstWaitingTask?.id || tasks.find((task) => task.status === 'running')?.id || tasks[0]?.id || null);
  const [focusAnswerRequest, setFocusAnswerRequest] = useState(0);
  const [workerView, setWorkerView] = useState('all');
  const selected = tasks.find((task) => task.id === selectedId) || tasks[0];
  const telemetryByTask = useMemo(() => new Map(workers.map((worker) => [worker.taskId, worker])), [workers]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const agentByTask = useMemo(() => new Map((ws.snapshot?.agents || []).map((agent) => [agent.taskId, agent])), [ws.snapshot?.agents]);
  const selectedWorker = selected ? telemetryByTask.get(selected.id) : null;
  const selectedRuntime = selectedWorker?.runtime?.at(-1) || null;
  const selectedAgent = selected ? agentByTask.get(selected.id) : null;
  const selectedParent = selected?.parentId ? taskById.get(selected.parentId) : null;
  const selectedPath = useMemo(() => {
    const path = new Set();
    let cursor = selected;
    while (cursor) {
      path.add(cursor.id);
      cursor = cursor.parentId ? taskById.get(cursor.parentId) : null;
    }
    return path;
  }, [selected, taskById]);
  const rankedWorkers = useMemo(() => {
    const rank = { running: 0, awaiting_user: 1, ready: 2, awaiting_approval: 3, pending: 4, failed: 5, succeeded: 6, cancelled: 7 };
    return [...workers].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }, [workers]);
  const attentionCount = rankedWorkers.filter((worker) => ATTENTION_WORKER_STATUSES.has(worker.status)).length;
  const visibleWorkers = workerView === 'active'
    ? rankedWorkers.filter((worker) => worker.status === 'running')
    : workerView === 'attention'
      ? rankedWorkers.filter((worker) => ATTENTION_WORKER_STATUSES.has(worker.status))
      : rankedWorkers;
  const activeCount = telemetry?.active || 0;
  const poolCount = workers.filter((worker) => isPoolExecution(normalizeExecutionTelemetry(worker)?.kind)).length;
  const model = run?.execution?.model || ws.snapshot?.execution?.model || workers.find((worker) => worker.model)?.model || 'local deterministic';
  const effort = run?.execution?.effort || ws.snapshot?.execution?.effort || workers.find((worker) => worker.effort)?.effort;
  const latestTask = telemetry?.latestEvent?.taskId ? taskById.get(telemetry.latestEvent.taskId) : null;
  const latestWorker = telemetry?.latestEvent?.taskId ? telemetryByTask.get(telemetry.latestEvent.taskId) : null;
  const tokens = telemetry?.tokens || {};
  const inputReported = aggregateHasTokenReceipt(workers, 'input_tokens');
  const cachedReported = aggregateHasTokenReceipt(workers, 'cached_input_tokens');
  const outputReported = aggregateHasTokenReceipt(workers, 'output_tokens');
  const reasoningReported = aggregateHasTokenReceipt(workers, 'reasoning_output_tokens');
  const canAdvance = run && !['awaiting_approval', 'completed', 'failed', 'cancelled'].includes(run.status);
  const focusWaitingTask = () => {
    if (!firstWaitingTask) return;
    setSelectedId(firstWaitingTask.id);
    setFocusAnswerRequest((current) => current + 1);
  };
  const headerAction = firstWaitingTask
    ? 'Answer worker'
    : canAdvance
      ? (run?.status === 'paused' ? 'Resume' : 'Advance work')
      : null;
  const handleHeaderAction = firstWaitingTask
    ? focusWaitingTask
    : () => (run?.status === 'paused' ? ws.resume(run.id) : ws.advance(run.id));
  const selectedAwaiting = selected?.status === 'awaiting_user';

  return (
    <Gate>
      <div className="docket-page docket-page--swarm">
        <PageHeader
          title={run?.status === 'running' ? 'Work in progress' : 'Research trace'}
          description="A live view of delegated work, model sessions, dependencies, and measured consumption."
          action={headerAction}
          onAction={handleHeaderAction}
          disabled={!run || ws.busy}
          figure="swarm"
        />
        <section className="run-ledger" data-testid="swarm-run-ledger" aria-label="Live run telemetry">
          <div className="run-ledger__identity">
            <span className={`presence presence--${activeCount ? 'active' : run?.status === 'failed' ? 'blocked' : 'complete'}`} />
            <p><small>Run</small><strong>{run?.id || '—'}</strong><span>{displayStatus(run?.status)}</span></p>
          </div>
          <dl>
            <div><dt>Model</dt><dd>{model}<small>{effort ? `${effort} reasoning` : run?.execution?.mode || 'local'}</small></dd></div>
            <div><dt>Workers</dt><dd>{activeCount} active / {telemetry?.cap ?? '∞'} cap<small>{poolCount} pool · {telemetry?.verified || 0}/{telemetry?.spawned || 0} sessions verified</small></dd></div>
            <div><dt>Input</dt><dd>{inputReported ? formatTokens(tokens.input_tokens) : '—'}<small>{cachedReported ? `${formatTokens(tokens.cached_input_tokens)} cached · included` : 'No usage reported'}</small></dd></div>
            <div><dt>Output</dt><dd>{outputReported ? formatTokens(tokens.output_tokens) : '—'}<small>{reasoningReported ? `${formatTokens(tokens.reasoning_output_tokens)} reasoning` : 'No usage reported'}</small></dd></div>
            <div><dt>Runtime</dt><dd>{formatDuration(telemetry?.durationMs)}<small>peak {telemetry?.peakConcurrency || 0} · {telemetry?.retries?.total || 0} retries</small></dd></div>
          </dl>
          <p className="run-ledger__latest"><small>Latest event</small><strong>{telemetry?.latestEvent?.type ? displayStatus(telemetry.latestEvent.type) : 'No events'}</strong><span>{latestWorker?.taskCode || latestTask?.title || telemetry?.latestEvent?.id || '—'}</span></p>
        </section>
        <RunPlanPanel run={run} />
        <div className={`swarm-layout ${selectedAwaiting ? 'is-awaiting' : ''}`}>
          <section className="branch-outline">
            <SectionHeading title="Agent hierarchy" note={`${tasks.length} tasks · ${telemetry?.counts?.succeeded || 0} complete`} />
            <TaskTree nodes={roots} selectedId={selected?.id} selectedPath={selectedPath} telemetryByTask={telemetryByTask} onSelect={setSelectedId} />
          </section>
          <section className={`branch-detail ${selected?.status === 'running' ? 'is-running' : ''}`}>
            {selected ? (
              <>
                <p className="docket-context">Selected task · {selectedWorker?.taskCode || selected.kind}</p>
                <h2>{selected.title}</h2>
                <p>{selected.summary || selected.output?.summary || 'No output yet.'}</p>
                <TaskIntervention
                  task={selected}
                  run={run}
                  onAnswer={ws.answerTaskQuestions}
                  disabled={ws.busy}
                  focusToken={focusAnswerRequest}
                />
                <div className="execution-signature">
                  <span className={`presence presence--${selected.status === 'running' ? 'active' : selected.status === 'failed' ? 'blocked' : 'complete'}`} />
                  <strong>{selectedWorker?.model || selected.worker}</strong>
                  <span>{selectedWorker?.effort ? `${selectedWorker.effort} reasoning` : displayStatus(selected.status)}</span>
                  {selectedWorker?.verified ? <b>session verified</b> : null}
                </div>
                <ExecutionTelemetry worker={selectedWorker} />
                <DefinitionList
                  items={[
                    ['State', displayStatus(selected.status)],
                    ['Role', selected.kind],
                    ['Agent', selectedAgent ? `${selectedAgent.id} · ${selectedAgent.role || selectedAgent.provider || 'worker'}` : 'not assigned'],
                    ['Parent task', selectedParent?.title || 'root'],
                    ['Plan version', selected.planVersion ?? selected.plan?.version ?? '—'],
                    ['Attempts', String(selected.attempts || 0)],
                    ['Runtime', formatDuration(selectedWorker?.durationMs)],
                    ['Depends on', selectedWorker?.dependsOn?.map((id) => telemetryByTask.get(id)?.taskCode || taskById.get(id)?.title || id).join(', ') || 'none'],
                    ['Workspace', shortWorkspace(selected.workspace)],
                  ]}
                />
                <div className="task-token-ledger" aria-label="Selected task token consumption">
                  <span><small>Input</small><strong>{reportedWorkerToken(selectedWorker, 'input_tokens')}</strong></span>
                  <span><small>Cached</small><strong>{reportedWorkerToken(selectedWorker, 'cached_input_tokens')}</strong></span>
                  <span><small>Output</small><strong>{reportedWorkerToken(selectedWorker, 'output_tokens')}</strong></span>
                  <span><small>Reasoning</small><strong>{reportedWorkerToken(selectedWorker, 'reasoning_output_tokens')}</strong></span>
                </div>
                <div className="branch-next">
                  <span>Execution record</span>
                  <p>{selectedWorker?.verified ? 'Provider-owned execution evidence verified by the engine.' : selectedRuntime?.spawned ? 'Model process started; verified evidence is not recorded yet.' : 'No model session was dispatched for this task.'}</p>
                  <small>{selectedWorker?.latestEvent?.type ? `${displayStatus(selectedWorker.latestEvent.type)} · ${selectedWorker.latestEvent.ts}` : 'Waiting for the first event.'}</small>
                </div>
              </>
            ) : null}
          </section>
          <aside className="worker-list">
            <SectionHeading title="Model sessions" note={`${activeCount} active · ${telemetry?.spawned || 0} spawned`} />
            <div className="worker-list__filters" role="group" aria-label="Worker list filter">
              <button type="button" className={workerView === 'active' ? 'is-active' : ''} onClick={() => setWorkerView('active')} aria-pressed={workerView === 'active'}>Active {activeCount}</button>
              <button type="button" className={workerView === 'attention' ? 'is-active' : ''} onClick={() => setWorkerView('attention')} aria-pressed={workerView === 'attention'}>Attention {attentionCount}</button>
              <button type="button" className={workerView === 'all' ? 'is-active' : ''} onClick={() => setWorkerView('all')} aria-pressed={workerView === 'all'}>All {workers.length}</button>
            </div>
            <div className="worker-list__records">
              {visibleWorkers.length ? visibleWorkers.map((worker) => (
                <button type="button" className={selected?.id === worker.taskId ? 'is-selected' : ''} key={worker.taskId} onClick={() => setSelectedId(worker.taskId)}>
                  <span className="worker-record__title">
                    <i className={`presence presence--${worker.status === 'running' ? 'active' : worker.status === 'awaiting_user' ? 'waiting' : worker.status === 'failed' ? 'blocked' : worker.status === 'succeeded' ? 'complete' : 'queued'}`} />
                    <strong>{worker.taskCode || worker.title}</strong>
                    <small>{displayStatus(worker.status)}</small>
                  </span>
                  <span className="worker-record__model">{worker.model}{worker.effort ? ` / ${worker.effort}` : ''}</span>
                  <ExecutionTelemetry worker={worker} compact />
                  <span className="worker-record__plan">Plan v{worker.planVersion ?? taskById.get(worker.taskId)?.planVersion ?? taskById.get(worker.taskId)?.plan?.version ?? '—'}</span>
                  <span className="worker-record__usage">{workerHasTokenReceipt(worker) ? `${reportedWorkerToken(worker, 'input_tokens')} in · ${reportedWorkerToken(worker, 'output_tokens')} out` : 'usage not reported'} · {formatDuration(worker.durationMs)}</span>
                </button>
              )) : <p className="worker-list__empty">No model is running. Switch to All to inspect completed sessions.</p>}
            </div>
            {run && ['running', 'paused'].includes(run.status) ? (
              <div className="live-run-actions">
                <button type="button" className="docket-link" onClick={() => ws.pause(run.id)} disabled={ws.busy}>
                  Pause scheduling
                </button>
                <button type="button" className="docket-link" onClick={() => ws.cancel(run.id)} disabled={ws.busy}>
                  Cancel run
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveEvidencePage() {
  const ws = useWorkspace();
  const evidence = ws.snapshot?.evidence || [];
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(evidence[0]?.id || null);
  const filters = ['all', 'supported', 'conflict', 'open'];
  const visible = evidence.filter((item) => filter === 'all' || item.type === filter);
  const selected = evidence.find((item) => item.id === selectedId) || visible[0];

  return (
    <Gate emptyTitle="No evidence yet" emptyBody="Advance a live run so workers can write provenance-backed findings.">
      <div className="docket-page docket-page--evidence">
        <PageHeader title="Evidence" description="Claims recorded by workers, with workspace provenance." figure="evidence" />
        <div className="filter-row" role="group" aria-label="Evidence type">
          {filters.map((item) => (
            <button type="button" className={filter === item ? 'is-active' : ''} key={item} onClick={() => setFilter(item)} aria-pressed={filter === item}>
              {item}
            </button>
          ))}
        </div>
        <div className="docket-split docket-split--wide">
          <section>
            <SectionHeading title="Source record" note={`${visible.length} visible`} />
            <div className="evidence-list">
              {visible.map((item) => (
                <button
                  type="button"
                  className={selected?.id === item.id ? 'is-selected' : ''}
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  aria-pressed={selected?.id === item.id}
                >
                  <span className="evidence-list__id">{item.id}</span>
                  <span>
                    <strong>{item.claim}</strong>
                    <small>
                      {item.type} · {item.provenance?.worker}
                    </small>
                  </span>
                  <State tone={statusTone(item.type)}>{item.type}</State>
                </button>
              ))}
            </div>
          </section>
          <aside className="docket-note">
            {selected ? (
              <>
                <p className="docket-context">Selected evidence</p>
                <h2>{selected.claim}</h2>
                <DefinitionList
                  items={[
                    ['Record', selected.id],
                    ['Task', selected.taskId],
                    ['Confidence', selected.confidence == null ? '—' : String(selected.confidence)],
                    ['Workspace', selected.provenance?.workspace || '—'],
                    ['Artifact', selected.provenance?.artifact || '—'],
                  ]}
                />
              </>
            ) : (
              <p>No evidence in this filter.</p>
            )}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveSynthesisPage() {
  const ws = useWorkspace();
  const decision = ws.snapshot?.decision;
  const run = ws.snapshot?.run;

  return (
    <Gate emptyTitle="No decision yet" emptyBody="The synthesis task writes a decision after research branches are terminal.">
      <div className="docket-page docket-page--decision">
        <PageHeader
          title="Decision"
          description="The current conclusion, the objection that limits it, and the evidence checks."
          context={run?.id || 'Live run'}
          figure="synthesis"
        />
        {decision ? (
          <>
            <main className="decision-layout">
              <section className="decision-main">
                <p className="docket-context">Provisional conclusion</p>
                <h2>{decision.conclusion}</h2>
                <div className="decision-confidence">
                  <span>Confidence</span>
                  <strong>{Number(decision.confidence).toFixed(2)}</strong>
                  <div>
                    <i style={{ width: `${Math.round(Number(decision.confidence) * 100)}%` }} />
                  </div>
                </div>
              </section>
              <aside className="decision-objection">
                <p className="docket-context">What prevents closure</p>
                <h2>{decision.objection}</h2>
                <DefinitionList items={[['Evidence records', String(decision.evidenceIds?.length || 0)], ['Decision id', decision.id]]} />
              </aside>
            </main>
            <section className="check-list">
              <SectionHeading title="Review checks" note="From the synthesis worker" />
              {(decision.checks || []).map((check) => (
                <div key={check.name}>
                  <span>
                    <strong>{check.name}</strong>
                  </span>
                  <State tone={statusTone(check.status)}>{check.status}</State>
                </div>
              ))}
            </section>
          </>
        ) : (
          <EngineStatePanel title="Synthesis has not run" body="Advance the live run until the synthesis task completes." />
        )}
      </div>
    </Gate>
  );
}

export function LiveEvolutionPage() {
  const ws = useWorkspace();
  const retro = ws.snapshot?.retrospective;
  const proposals = ws.snapshot?.proposals || [];
  const proposal = selectCurrentProposal(proposals, { retrospective: retro, run: ws.snapshot?.run });

  return (
    <Gate emptyTitle="No retrospective yet" emptyBody="The engine writes a retrospective at the end of a run. Proposals are not applied until you approve them.">
      <div className="docket-page docket-page--review">
        <PageHeader
          title="Run review"
          description="What failed, why, and a proposed change. Default is proposal-only."
          context={ws.snapshot?.run?.id}
          figure="evolution"
        />
        <div className="review-statement">
          <p className="docket-context">Observed problem</p>
          <h2>{retro?.whatFailed || 'No retrospective recorded'}</h2>
        </div>
        <div className="review-grid">
          <section>
            <SectionHeading title="Proposed change" />
            <p>{proposal?.change || retro?.shouldImprove}</p>
            {retro?.why ? <pre>{retro.why}</pre> : null}
          </section>
          <section>
            <SectionHeading title="Evaluation" />
            <DefinitionList
              items={[
                ['Proposal', proposal?.id || '—'],
                ['Status', proposal?.status || '—'],
                ['Self-modification', proposal?.selfModification ? 'yes' : 'no'],
                ['Retries observed', String(retro?.retries ?? 0)],
              ]}
            />
          </section>
          <aside>
            <SectionHeading title="Recommendation" note={proposal?.status || 'None'} />
            <p>Approving records consent. Only allowlisted policy keys may change runtime state. Engine code is never rewritten.</p>
            {proposal?.status === 'proposed' ? (
              <>
                <button type="button" className="docket-button docket-button--primary" onClick={() => ws.approveProposal(proposal.id)} disabled={ws.busy}>
                  Approve proposal
                </button>
                <button type="button" className="docket-link" onClick={() => ws.rejectProposal(proposal.id)} disabled={ws.busy}>
                  Reject
                </button>
              </>
            ) : (
              <p className="form-note">{proposal ? `Proposal ${proposal.status}` : 'No proposal'}</p>
            )}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveCapabilitiesPage() {
  const ws = useWorkspace();
  const providers = ws.snapshot?.providers || [];
  const [selectedId, setSelectedId] = useState(providers[0]?.id || 'local');
  const selected = providers.find((item) => item.id === selectedId) || providers[0];

  return (
    <Gate allowEmpty>
      <div className="docket-page docket-page--connections">
        <PageHeader title="Connections" description="Typed worker boundaries. Live provider execution is not claimed unless reproduced." figure="capabilities" />
        <div className="docket-split docket-split--wide">
          <section>
            <SectionHeading title="Available to this project" note="Live configuration" />
            <div className="connection-list">
              {providers.map((item) => {
                const readiness = item.readiness?.status;
                const executionLabel = item.liveExecutionEnabled
                  ? 'Execution verified'
                  : readiness === 'unverified' || readiness === 'unavailable'
                    ? 'Preflight required'
                    : readiness === 'disabled'
                      ? 'Disabled by mode'
                      : 'Boundary only';
                return (
                  <button
                    type="button"
                    className={selected?.id === item.id ? 'is-selected' : ''}
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    aria-pressed={selected?.id === item.id}
                  >
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.authType}</small>
                    </span>
                    <span>{executionLabel}</span>
                    <State tone={item.liveExecutionEnabled ? 'complete' : item.configured || item.liveAuthSupported ? 'review' : 'warning'}>
                      {item.secretPresent ? 'secret present' : readiness?.replaceAll('_', ' ') || (item.configured ? 'configured' : 'not live')}
                    </State>
                  </button>
                );
              })}
            </div>
          </section>
          <aside className="docket-note">
            {selected ? (
              <>
                <p className="docket-context">Selected connection</p>
                <h2>{selected.name}</h2>
                <DefinitionList
                  items={[
                    ['Auth', selected.authType],
                    ['Secret env', selected.secretEnv || 'none'],
                    ['Secret present', selected.secretPresent ? 'yes (value hidden)' : 'no'],
                    ['Live auth', selected.liveAuthSupported ? 'supported' : 'unsupported'],
                    ['Live execution', selected.liveExecutionEnabled
                      ? 'verified'
                      : selected.readiness?.status === 'disabled'
                        ? 'disabled by active mode'
                        : selected.configured
                          ? 'preflight required'
                          : 'not invoked'],
                    ['Readiness', selected.readiness?.status?.replaceAll('_', ' ') || 'not reported'],
                    ['Checked', selected.readiness?.checkedAt || 'not checked in this process'],
                  ]}
                />
                <p className="form-note">{selected.note}</p>
              </>
            ) : null}
          </aside>
        </div>
      </div>
    </Gate>
  );
}

export function LiveMemoryPage() {
  const ws = useWorkspace();
  const policies = ws.snapshot?.policies || [];
  const memory = ws.snapshot?.memory;
  const [scope, setScope] = useState('Project');
  const [policy, setPolicy] = useState(policies[0]?.name || '');
  const selected = policies.find((item) => item.name === policy) || policies[0];
  const scopes = [
    { name: 'Global', detail: 'Shared policies and reusable rules', count: memory?.global ?? 0 },
    { name: 'Project', detail: 'Goals, decisions, and accepted findings', count: memory?.project ?? 0 },
    { name: 'Worker', detail: 'Task workspaces and intermediate output', count: memory?.agent ?? 0 },
  ];

  return (
    <Gate allowEmpty>
      <div className="docket-page docket-page--memory">
        <PageHeader title="Memory & policy" description="Retention and improvement rules for the local store." figure="memory" />
        <div className="memory-layout">
          <section>
            <SectionHeading title="Memory scopes" note={memory?.inheritance} />
            <div className="scope-list">
              {scopes.map((item) => (
                <button type="button" className={scope === item.name ? 'is-selected' : ''} key={item.name} onClick={() => setScope(item.name)} aria-pressed={scope === item.name}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <b>{item.count}</b>
                </button>
              ))}
            </div>
            <div className="scope-detail">
              <p className="docket-context">{scope} memory</p>
              <h2>{memory?.retention || 'Local store'}</h2>
              <p>Worker workspaces stay under .aos/workspaces and are not shared across tasks.</p>
            </div>
          </section>
          <aside>
            <SectionHeading title="Project policies" note={selected?.state || 'None'} />
            <div className="policy-list">
              {policies.map((item) => (
                <button type="button" className={policy === item.name ? 'is-selected' : ''} key={item.id} onClick={() => setPolicy(item.name)} aria-pressed={policy === item.name}>
                  <span>{item.name}</span>
                  <State tone={statusTone(item.state)}>{item.state}</State>
                </button>
              ))}
            </div>
            {selected ? <p className="form-note">{selected.detail}</p> : null}
          </aside>
        </div>
      </div>
    </Gate>
  );
}
