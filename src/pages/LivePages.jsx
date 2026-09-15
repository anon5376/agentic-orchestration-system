import React, { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../app/WorkspaceContext';
import { DocketFigure } from '../components/DocketFigure';
import { EngineStatePanel } from '../components/ModeBanner';
import { aosApi } from '../lib/aosApi';
import { displayStatus, selectCurrentProposal } from '../lib/liveRecords';

const SELECTED_BLUEPRINT_KEY = 'aos-selected-blueprint';

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
  if (['awaiting_approval', 'paused', 'proposed'].includes(status)) return 'review';
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
  const count = Number(value) || 0;
  if (count < 1000) return count.toLocaleString('en-US');
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 1) return `${remainder}s`;
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function shortWorkspace(path) {
  if (!path) return 'unclaimed';
  const parts = String(path).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function TaskTree({ nodes, selectedId, selectedPath, telemetryByTask, onSelect, level = 1 }) {
  return (
    <ol role={level === 1 ? 'tree' : 'group'} className={level === 1 ? 'task-tree' : 'task-tree__group'} data-testid={level === 1 ? 'task-tree' : undefined}>
      {(nodes || []).map((task) => {
        const worker = telemetryByTask.get(task.id);
        const children = task.children || [];
        const selected = task.id === selectedId;
        return (
          <li
            role="treeitem"
            aria-level={level}
            aria-expanded={children.length ? true : undefined}
            className={`${selected ? 'is-selected' : ''} ${selectedPath.has(task.id) ? 'is-path' : ''}`}
            key={task.id}
          >
            <button type="button" onClick={() => onSelect(task.id)} aria-current={selected ? 'true' : undefined}>
              <i className={`task-tree__signal task-tree__signal--${task.status}`} aria-hidden="true" />
              <span className="task-tree__copy">
                <small>{worker?.taskCode || task.kind}</small>
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
  const [blueprints, setBlueprints] = useState([]);
  const [blueprintId, setBlueprintId] = useState(() => {
    try { return window.localStorage.getItem(SELECTED_BLUEPRINT_KEY) || ''; }
    catch { return ''; }
  });
  const [createdGoal, setCreatedGoal] = useState(null);
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

  // Prefer the engine's copy so a refreshed snapshot clears the awaiting_user gate.
  const latestGoal = useMemo(() => {
    const goals = ws.snapshot?.goals || [];
    const id = createdGoal?.id;
    if (id) return goals.find((item) => item.id === id) || createdGoal;
    return goals[goals.length - 1] || null;
  }, [ws.snapshot, createdGoal]);

  const questions = latestGoal?.questions || [];
  const unanswered = questions.filter((question) => question.required && !String(question.answer || '').trim());
  const awaitingUser = latestGoal?.status === 'awaiting_user' && unanswered.length > 0;
  const selectedBlueprint = blueprints.find((item) => item.id === blueprintId) || null;

  const selectBlueprint = (id) => {
    setBlueprintId(id);
    try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, id); } catch { /* ignore */ }
  };

  const submit = async () => {
    try {
      setActionError('');
      const contextPaths = contextText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const created = await ws.createGoal(objective, contextPaths);
      setCreatedGoal(created);
      setAnswers({});
    } catch (error) {
      setActionError(error.message || 'Could not store the objective.');
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
    try {
      setActionError('');
      const updated = await ws.answerQuestions(latestGoal.id, payload);
      if (updated) setCreatedGoal(updated);
      setAnswers({});
    } catch (error) {
      setActionError(error.message || 'Could not record the answers.');
    }
  };

  const start = async () => {
    if (!latestGoal?.id) return;
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
          description="The engine stores the prompt, names material ambiguities, and builds a reviewable plan."
          context="New research"
          figure="intake"
        />
        <div className="docket-split">
          <section className="docket-form">
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
              Prepare research plan
            </button>
            <p className="form-note">Stores the prompt, records ambiguities, and builds a hierarchical plan. Workers start only after you launch the selected swarm. No credentials are used.</p>
            {ws.notice ? <p className="form-note action-notice">{ws.notice}</p> : null}
          </section>
          <aside className={`interpretation ${latestGoal ? 'is-ready' : ''}`}>
            <SectionHeading title="Working interpretation" note={latestGoal ? latestGoal.id : 'Waiting for a prompt'} />
            {latestGoal ? (
              <>
                <p className="interpretation__summary">{latestGoal.prompt}</p>
                <DefinitionList
                  items={[
                    ['Ambiguities', String(latestGoal.ambiguities?.length || 0)],
                    ['Plan tasks', String(latestGoal.plan?.tasks?.length || 0)],
                    ['Swarm', selectedBlueprint?.name || blueprintId || 'None selected'],
                    ['Questions', (latestGoal.questions || []).map((item) => item.prompt).filter(Boolean).join(' / ') || 'None'],
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
                ) : (
                  <button type="button" className="docket-button docket-button--primary" onClick={start} disabled={ws.busy || !blueprintId}>
                    Launch {selectedBlueprint?.name || 'selected swarm'}
                  </button>
                )}
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
  const [selectedId, setSelectedId] = useState(tasks.find((task) => task.status === 'running')?.id || tasks[0]?.id || null);
  const [workerView, setWorkerView] = useState('all');
  const selected = tasks.find((task) => task.id === selectedId) || tasks[0];
  const telemetryByTask = useMemo(() => new Map(workers.map((worker) => [worker.taskId, worker])), [workers]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const selectedWorker = selected ? telemetryByTask.get(selected.id) : null;
  const selectedRuntime = selectedWorker?.runtime?.at(-1) || null;
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
    const rank = { running: 0, ready: 1, awaiting_approval: 2, pending: 3, failed: 4, succeeded: 5, cancelled: 6 };
    return [...workers].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }, [workers]);
  const visibleWorkers = workerView === 'active' ? rankedWorkers.filter((worker) => worker.status === 'running') : rankedWorkers;
  const activeCount = telemetry?.active || 0;
  const model = run?.execution?.model || ws.snapshot?.execution?.model || workers.find((worker) => worker.model)?.model || 'local deterministic';
  const effort = run?.execution?.effort || ws.snapshot?.execution?.effort || workers.find((worker) => worker.effort)?.effort;
  const latestTask = telemetry?.latestEvent?.taskId ? taskById.get(telemetry.latestEvent.taskId) : null;
  const latestWorker = telemetry?.latestEvent?.taskId ? telemetryByTask.get(telemetry.latestEvent.taskId) : null;
  const tokens = telemetry?.tokens || {};
  const canAdvance = run && !['awaiting_approval', 'completed', 'failed', 'cancelled'].includes(run.status);

  return (
    <Gate>
      <div className="docket-page docket-page--swarm">
        <PageHeader
          title={run?.status === 'running' ? 'Work in progress' : 'Research trace'}
          description="A live view of delegated work, model sessions, dependencies, and measured consumption."
          action={canAdvance ? (run?.status === 'paused' ? 'Resume' : 'Advance work') : null}
          onAction={() => (run?.status === 'paused' ? ws.resume(run.id) : ws.advance(run.id))}
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
            <div><dt>Workers</dt><dd>{activeCount} active / {telemetry?.cap ?? '∞'} cap<small>{telemetry?.verified || 0}/{telemetry?.spawned || 0} sessions verified</small></dd></div>
            <div><dt>Input</dt><dd>{formatTokens(tokens.input_tokens)}<small>{formatTokens(tokens.cached_input_tokens)} cached · included</small></dd></div>
            <div><dt>Output</dt><dd>{formatTokens(tokens.output_tokens)}<small>{formatTokens(tokens.reasoning_output_tokens)} reasoning</small></dd></div>
            <div><dt>Runtime</dt><dd>{formatDuration(telemetry?.durationMs)}<small>peak {telemetry?.peakConcurrency || 0} · {telemetry?.retries?.total || 0} retries</small></dd></div>
          </dl>
          <p className="run-ledger__latest"><small>Latest event</small><strong>{telemetry?.latestEvent?.type ? displayStatus(telemetry.latestEvent.type) : 'No events'}</strong><span>{latestWorker?.taskCode || latestTask?.title || telemetry?.latestEvent?.id || '—'}</span></p>
        </section>
        <div className="swarm-layout">
          <section className="branch-outline">
            <SectionHeading title="Research hierarchy" note={`${tasks.length} tasks · ${telemetry?.counts?.succeeded || 0} complete`} />
            <TaskTree nodes={roots} selectedId={selected?.id} selectedPath={selectedPath} telemetryByTask={telemetryByTask} onSelect={setSelectedId} />
          </section>
          <section className={`branch-detail ${selected?.status === 'running' ? 'is-running' : ''}`}>
            {selected ? (
              <>
                <p className="docket-context">Selected task · {selectedWorker?.taskCode || selected.kind}</p>
                <h2>{selected.title}</h2>
                <p>{selected.summary || selected.output?.summary || 'No output yet.'}</p>
                <div className="execution-signature">
                  <span className={`presence presence--${selected.status === 'running' ? 'active' : selected.status === 'failed' ? 'blocked' : 'complete'}`} />
                  <strong>{selectedWorker?.model || selected.worker}</strong>
                  <span>{selectedWorker?.effort ? `${selectedWorker.effort} reasoning` : displayStatus(selected.status)}</span>
                  {selectedWorker?.verified ? <b>session verified</b> : null}
                </div>
                <DefinitionList
                  items={[
                    ['State', displayStatus(selected.status)],
                    ['Role', selected.kind],
                    ['Attempts', String(selected.attempts || 0)],
                    ['Runtime', formatDuration(selectedWorker?.durationMs)],
                    ['Depends on', selectedWorker?.dependsOn?.map((id) => telemetryByTask.get(id)?.taskCode || taskById.get(id)?.title || id).join(', ') || 'none'],
                    ['Workspace', shortWorkspace(selected.workspace)],
                  ]}
                />
                <div className="task-token-ledger" aria-label="Selected task token consumption">
                  <span><small>Input</small><strong>{formatTokens(selectedWorker?.usage?.input_tokens)}</strong></span>
                  <span><small>Cached</small><strong>{formatTokens(selectedWorker?.usage?.cached_input_tokens)}</strong></span>
                  <span><small>Output</small><strong>{formatTokens(selectedWorker?.usage?.output_tokens)}</strong></span>
                  <span><small>Reasoning</small><strong>{formatTokens(selectedWorker?.usage?.reasoning_output_tokens)}</strong></span>
                </div>
                <div className="branch-next">
                  <span>Execution record</span>
                  <p>{selectedRuntime?.threadId ? `Thread ${selectedRuntime.threadId}` : 'No model session was dispatched for this task.'}</p>
                  <small>{selectedWorker?.latestEvent?.type ? `${displayStatus(selectedWorker.latestEvent.type)} · ${selectedWorker.latestEvent.ts}` : 'Waiting for the first event.'}</small>
                </div>
              </>
            ) : null}
          </section>
          <aside className="worker-list">
            <SectionHeading title="Model sessions" note={`${activeCount} active · ${telemetry?.spawned || 0} spawned`} />
            <div className="worker-list__filters" role="group" aria-label="Worker list filter">
              <button type="button" className={workerView === 'active' ? 'is-active' : ''} onClick={() => setWorkerView('active')} aria-pressed={workerView === 'active'}>Active {activeCount}</button>
              <button type="button" className={workerView === 'all' ? 'is-active' : ''} onClick={() => setWorkerView('all')} aria-pressed={workerView === 'all'}>All {workers.length}</button>
            </div>
            <div className="worker-list__records">
              {visibleWorkers.length ? visibleWorkers.map((worker) => (
                <button type="button" className={selected?.id === worker.taskId ? 'is-selected' : ''} key={worker.taskId} onClick={() => setSelectedId(worker.taskId)}>
                  <span className="worker-record__title">
                    <i className={`presence presence--${worker.status === 'running' ? 'active' : worker.status === 'failed' ? 'blocked' : worker.status === 'succeeded' ? 'complete' : 'queued'}`} />
                    <strong>{worker.taskCode || worker.title}</strong>
                    <small>{displayStatus(worker.status)}</small>
                  </span>
                  <span className="worker-record__model">{worker.model}{worker.effort ? ` / ${worker.effort}` : ''}</span>
                  <span className="worker-record__usage">{formatTokens(worker.usage?.input_tokens)} in · {formatTokens(worker.usage?.output_tokens)} out · {formatDuration(worker.durationMs)}</span>
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
