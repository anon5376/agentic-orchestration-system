import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../app/WorkspaceContext';
import { normalizePlanResponse } from '../lib/liveRecords';

const INITIAL_DRAFT = {
  reason: '',
  title: '',
  kind: 'research',
  summary: '',
  parentId: '',
  prerequisites: [],
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function display(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function timestamp(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function shortTimestamp(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46);
}

function errorMessage(error) {
  const code = error?.data?.code || error?.code;
  const details = error?.data?.details || error?.details || {};
  const expected = details.expected ?? details.currentVersion ?? details.current_version;
  if (code === 'plan_version_conflict' || (error?.status === 409 && expected != null)) {
    return `Plan advanced to v${expected ?? '?'}. Review current plan before retrying.`;
  }
  const message = error?.data?.error || error?.message || 'The plan request failed.';
  if (String(code || '').startsWith('plan_policy') || String(code || '').includes('live_codex')) {
    return `Backend policy: ${message}`;
  }
  return message;
}

function isPlanConflict(error) {
  const code = error?.data?.code || error?.code;
  return code === 'plan_version_conflict' || (error?.status === 409 && (error?.data?.details?.expected != null || error?.data?.details?.currentVersion != null));
}

function taskIdForAppend(title) {
  return `operator-${slug(title) || 'research'}-${Date.now()}`.slice(0, 120);
}

function patchIdForAppend() {
  return `operator-plan-patch-${Date.now()}`;
}

function runtimeHarness(run) {
  const explicit = run?.execution?.provider || run?.execution?.harness;
  if (explicit) return String(explicit);
  if (run?.execution?.mode === 'codex') return 'codex';
  if (run?.execution?.mode === 'local') return 'local';
  return null;
}

function immutablePlanTasks(snapshot) {
  const result = [];
  const seen = new Set();
  const visit = (items) => {
    asArray(items).forEach((task) => {
      if (!task || typeof task !== 'object' || !task.id || seen.has(task.id)) return;
      seen.add(task.id);
      result.push(task);
      visit(task.children);
    });
  };
  visit(snapshot?.tasks);
  return result;
}

function planTaskLabel(task) {
  return `${display(task?.title, 'Untitled task')} · ${task.id}`;
}

function historyLabel(item) {
  const version = asNumber(item?.version);
  const tasks = item?.taskCount == null ? '' : ` · ${item.taskCount} tasks`;
  const date = item?.createdAt ? ` · ${shortTimestamp(item.createdAt)}` : '';
  return `v${version ?? '?'}${tasks}${date}`;
}

export function RunPlanPanel({ run }) {
  const ws = useWorkspace();
  const runId = run?.id || ws.snapshot?.run?.id || null;
  const requestSequence = useRef(0);
  const [plan, setPlan] = useState(null);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionConflict, setActionConflict] = useState(false);
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState(INITIAL_DRAFT);

  const loadPlan = useCallback(async (version = null) => {
    if (!runId || ws.mode !== 'live') return null;
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setPlanLoading(true);
    setPlanError('');
    try {
      const next = normalizePlanResponse(await ws.runPlan(runId, version));
      if (requestId !== requestSequence.current) return null;
      setPlan(next);
      const nextVersion = asNumber(version) ?? next.currentVersion ?? asNumber(next.snapshot?.version);
      if (nextVersion != null) setSelectedVersion(String(nextVersion));
      return next;
    } catch (error) {
      if (requestId === requestSequence.current) setPlanError(errorMessage(error));
      return null;
    } finally {
      if (requestId === requestSequence.current) setPlanLoading(false);
    }
  }, [runId, ws.mode, ws.runPlan]);

  useEffect(() => {
    setPlan(null);
    setSelectedVersion('');
    setPlanError('');
    setActionError('');
    setActionConflict(false);
    setSuccess('');
    if (runId && ws.mode === 'live') loadPlan();
  }, [runId, ws.mode, loadPlan]);

  const pointerVersion = asNumber(run?.plan?.version);
  useEffect(() => {
    if (pointerVersion != null && plan && plan.currentVersion !== pointerVersion) loadPlan();
  }, [pointerVersion, plan, loadPlan]);

  const currentVersion = plan?.currentVersion ?? pointerVersion;
  const selectedVersionNumber = asNumber(selectedVersion) ?? currentVersion;
  const historical = currentVersion != null && selectedVersionNumber != null && selectedVersionNumber !== currentVersion;
  const selectedSnapshot = plan?.snapshot || null;
  const currentHistory = asArray(plan?.history).find((item) => asNumber(item.version) === currentVersion) || null;
  const selectedHistory = asArray(plan?.history).find((item) => asNumber(item.version) === selectedVersionNumber) || null;
  const currentTasksCount = currentHistory?.taskCount ?? (!historical ? asArray(selectedSnapshot?.tasks).length : null);
  const currentDependenciesCount = currentHistory?.dependencyCount ?? (!historical ? asArray(selectedSnapshot?.dependencies).length : null);
  const selectedTasks = asArray(selectedSnapshot?.tasks);
  const selectedDependencies = asArray(selectedSnapshot?.dependencies);
  const currentSnapshotLoaded = Boolean(
    !historical
      && selectedSnapshot
      && currentVersion != null
      && asNumber(selectedSnapshot.version) === currentVersion,
  );
  const availableTasks = useMemo(() => (currentSnapshotLoaded ? immutablePlanTasks(selectedSnapshot) : []), [currentSnapshotLoaded, selectedSnapshot]);
  const availableTaskIds = useMemo(() => new Set(availableTasks.map((task) => task.id)), [availableTasks]);
  const lastPatch = asArray(plan?.patches).at(-1) || null;
  const selectedPatch = asArray(plan?.patches).find((item) => asNumber(item.version) === selectedVersionNumber) || null;
  const lastAppendReason = plan?.lastAppendReason || lastPatch?.reason || 'No append recorded';
  const history = useMemo(() => {
    const items = asArray(plan?.history).filter((item) => asNumber(item.version) != null);
    if (currentVersion != null && !items.some((item) => asNumber(item.version) === currentVersion)) {
      return [{ version: currentVersion, taskCount: currentTasksCount, dependencyCount: currentDependenciesCount }, ...items];
    }
    return items;
  }, [plan?.history, currentVersion, currentTasksCount, currentDependenciesCount]);
  const transportStatus = ws.transport?.status || 'idle';
  const transportSettled = transportStatus === 'streaming' || transportStatus === 'polling';
  const runPatchable = ['running', 'paused'].includes(run?.status);
  const appendHarness = runtimeHarness(run);
  const resyncReadOnly = transportStatus === 'resyncing';
  const transportReadOnly = transportStatus === 'error';
  const readOnly = historical || resyncReadOnly || transportReadOnly;
  const canAppend = Boolean(
    ws.mode === 'live'
      && runId
      && currentVersion != null
      && currentSnapshotLoaded
      && appendHarness
      && runPatchable
      && transportSettled
      && !readOnly
      && !planLoading
      && !submitting
      && !ws.busy,
  );

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setActionError('');
    setActionConflict(false);
    setSuccess('');
  };

  const togglePrerequisite = (taskId, checked) => {
    setDraft((current) => {
      const selected = new Set(asArray(current.prerequisites));
      if (checked) selected.add(taskId);
      else selected.delete(taskId);
      return { ...current, prerequisites: [...selected] };
    });
    setActionError('');
    setActionConflict(false);
    setSuccess('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!canAppend) return;
    const reason = draft.reason.trim();
    const title = draft.title.trim();
    const kind = draft.kind.trim();
    const summary = draft.summary.trim();
    const parentId = availableTaskIds.has(draft.parentId) ? draft.parentId : null;
    const prerequisites = asArray(draft.prerequisites).filter((taskId) => availableTaskIds.has(taskId));
    if (!currentSnapshotLoaded) {
      setActionError('The current immutable plan snapshot is still loading. Review it before appending.');
      return;
    }
    if (!reason || !title || !kind || !summary) {
      setActionError('Reason, title, role / kind, and summary are required.');
      return;
    }
    const id = taskIdForAppend(title);
    const additions = {
      tasks: [{
        id,
        key: id,
        title,
        kind,
        summary,
        parentId,
        worker: appendHarness,
      }],
      dependencies: prerequisites.map((dependsOnTaskId, index) => ({
        id: `${id}-dependency-${index + 1}`,
        taskId: id,
        dependsOnTaskId,
      })),
    };
    setSubmitting(true);
    setActionError('');
    setSuccess('');
    try {
      await ws.appendPlan(runId, {
        id: patchIdForAppend(),
        baseVersion: currentVersion,
        reason,
        additions,
      });
      const refreshed = await loadPlan();
      const version = refreshed?.currentVersion;
      setDraft(INITIAL_DRAFT);
      setSuccess(version == null ? 'Research task appended after backend confirmation.' : `Research task appended to plan v${version}.`);
    } catch (error) {
      setActionError(errorMessage(error));
      setActionConflict(isPlanConflict(error));
    } finally {
      setSubmitting(false);
    }
  };

  const chooseVersion = (event) => {
    const value = event.target.value;
    setActionError('');
    setSuccess('');
    setSelectedVersion(value);
    loadPlan(Number(value));
  };

  if (ws.mode !== 'live') return null;

  return (
    <section className="run-plan-panel" aria-labelledby="run-plan-title" data-testid="run-plan-panel">
      <header className="run-plan-panel__header">
        <div>
          <p className="docket-context">Versioned runtime plan</p>
          <h2 id="run-plan-title">Current work plan</h2>
          <p>Immutable run snapshots keep operator additions reviewable and auditable. Runtime tasks are never rewritten in place.</p>
        </div>
        <div className="run-plan-panel__connection" aria-label="Plan transport status">
          <span className={`run-plan-panel__signal run-plan-panel__signal--${transportStatus}`} aria-hidden="true" />
          <strong>{transportStatus}</strong>
          <small>cursor {display(ws.transport?.cursor ?? ws.snapshot?.eventCursor, '—')}</small>
          <small>updated {timestamp(ws.transport?.lastUpdated || ws.snapshot?.generatedAt)}</small>
        </div>
      </header>

      <dl className="run-plan-panel__summary" aria-label="Current plan summary">
        <div><dt>Current version</dt><dd>{currentVersion == null ? '—' : `v${currentVersion}`}</dd></div>
        <div><dt>Tasks</dt><dd>{currentTasksCount == null ? '—' : currentTasksCount}</dd></div>
        <div><dt>Dependencies</dt><dd>{currentDependenciesCount == null ? '—' : currentDependenciesCount}</dd></div>
        <div><dt>Last append reason</dt><dd>{lastAppendReason}</dd></div>
      </dl>

      {!runId ? (
        <p className="run-plan-panel__empty">No active run has an immutable plan snapshot yet.</p>
      ) : (
        <div className="run-plan-panel__body">
          <section className="run-plan-panel__history" aria-labelledby="run-plan-history-title">
            <div className="run-plan-panel__section-heading">
              <div>
                <p className="docket-context">Record</p>
                <h3 id="run-plan-history-title">Immutable history</h3>
              </div>
              {historical ? <span className="run-plan-panel__badge">HISTORICAL · READ ONLY</span> : null}
            </div>
            <label htmlFor="run-plan-version">Inspect version</label>
            <select id="run-plan-version" value={selectedVersion} onChange={chooseVersion} disabled={planLoading || !history.length}>
              {!history.length ? <option value="">No history returned</option> : null}
              {history.map((item) => <option value={item.version} key={item.version}>{historyLabel(item)}</option>)}
            </select>
            {planLoading ? <p className="run-plan-panel__muted" role="status">Reading authoritative snapshot…</p> : null}
            {planError ? (
              <div className="run-plan-panel__error" role="alert">
                <p>{planError}</p>
                {planError.startsWith('Plan advanced to') ? <button type="button" className="docket-link" onClick={() => loadPlan()}>Review current plan</button> : null}
              </div>
            ) : null}
            {selectedSnapshot ? (
              <dl className="run-plan-panel__metadata">
                <div><dt>Snapshot</dt><dd>{display(selectedSnapshot.id)} · v{display(selectedSnapshot.version, '?')}</dd></div>
                <div><dt>Source</dt><dd>{display(selectedSnapshot.source)}</dd></div>
                <div><dt>Created</dt><dd>{timestamp(selectedSnapshot.createdAt)}</dd></div>
                <div><dt>Actor</dt><dd>{display(selectedSnapshot.createdBy)}</dd></div>
                <div><dt>Snapshot tasks</dt><dd>{selectedTasks.length}</dd></div>
                <div><dt>Snapshot dependencies</dt><dd>{selectedDependencies.length}</dd></div>
              </dl>
            ) : (
              <p className="run-plan-panel__muted">The engine has not returned a selected immutable snapshot.</p>
            )}
            {selectedPatch ? (
              <div className="run-plan-panel__patch-meta">
                <p className="docket-context">Selected patch receipt</p>
                <dl className="run-plan-panel__metadata">
                  <div><dt>Patch</dt><dd>{display(selectedPatch.id)}</dd></div>
                  <div><dt>Reason</dt><dd>{display(selectedPatch.reason)}</dd></div>
                  <div><dt>Actor</dt><dd>{display(selectedPatch.actor)}</dd></div>
                  <div><dt>Base</dt><dd>{selectedPatch.baseVersion == null ? '—' : `v${selectedPatch.baseVersion}`}</dd></div>
                  <div><dt>Recorded</dt><dd>{timestamp(selectedPatch.at || selectedPatch.createdAt)}</dd></div>
                </dl>
              </div>
            ) : null}
            <div className="run-plan-panel__receipts">
              <p className="docket-context">Append receipts</p>
              {asArray(plan?.patches).length ? (
                <ul>
                  {asArray(plan.patches).slice(-5).reverse().map((patch) => (
                    <li key={patch.id || `${patch.version}-${patch.reason}`}>
                      <strong>v{display(patch.version, '?')}</strong>
                      <span>{display(patch.reason)}</span>
                      <small>{display(patch.actor, 'unknown actor')} · {timestamp(patch.at || patch.createdAt)}</small>
                    </li>
                  ))}
                </ul>
              ) : <p className="run-plan-panel__muted">No operator append receipts.</p>}
            </div>
          </section>

          <section className="run-plan-panel__action" aria-labelledby="run-plan-action-title">
            <div className="run-plan-panel__section-heading">
              <div>
                <p className="docket-context">Disclosed append</p>
                <h3 id="run-plan-action-title">Add research task</h3>
              </div>
              {currentVersion != null ? <span className="run-plan-panel__version-chip">base v{currentVersion}</span> : null}
            </div>
            {runPatchable && transportSettled && !readOnly && currentSnapshotLoaded ? (
              <form className="run-plan-panel__form" onSubmit={submit}>
                <p className="run-plan-panel__form-note">Draft fields are <strong>UNVALIDATED / PENDING REVIEW</strong> until the backend accepts this exact append. Harness follows this run: <strong>{appendHarness}</strong>.</p>
                <label htmlFor="run-plan-reason">Reason <span>required</span></label>
                <input id="run-plan-reason" value={draft.reason} onChange={(event) => updateDraft('reason', event.target.value)} required placeholder="Why should this task enter the run?" />
                <label htmlFor="run-plan-title-input">Task title <span>required</span></label>
                <input id="run-plan-title-input" value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} required placeholder="Name the research task" />
                <label htmlFor="run-plan-kind">Role / kind <span>required</span></label>
                <input id="run-plan-kind" value={draft.kind} onChange={(event) => updateDraft('kind', event.target.value)} required placeholder="research" />
                <label htmlFor="run-plan-summary">Summary <span>required</span></label>
                <textarea id="run-plan-summary" value={draft.summary} onChange={(event) => updateDraft('summary', event.target.value)} required rows="4" placeholder="Bounded question, evidence path, and done condition." />
                <label htmlFor="run-plan-parent">Parent task <span>optional; immutable plan task ID</span></label>
                <select id="run-plan-parent" value={draft.parentId} onChange={(event) => updateDraft('parentId', event.target.value)} disabled={!currentSnapshotLoaded}>
                  <option value="">Root task (no parent)</option>
                  {availableTasks.map((task) => <option value={task.id} key={task.id}>{planTaskLabel(task)}</option>)}
                </select>
                <fieldset className="run-plan-panel__choices">
                  <legend>Prerequisites <span>required; select immutable plan task IDs or none</span></legend>
                  <div className="run-plan-panel__choice-list">
                    <label className="run-plan-panel__choice">
                      <input type="checkbox" checked={!draft.prerequisites.length} onChange={() => updateDraft('prerequisites', [])} />
                      <span>None — no dependency</span>
                    </label>
                    {availableTasks.map((task) => (
                      <label className="run-plan-panel__choice" key={task.id}>
                        <input type="checkbox" checked={draft.prerequisites.includes(task.id)} onChange={(event) => togglePrerequisite(task.id, event.target.checked)} />
                        <span>{planTaskLabel(task)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button type="submit" className="docket-button docket-button--primary" disabled={!canAppend || !draft.reason.trim() || !draft.title.trim() || !draft.kind.trim() || !draft.summary.trim()}>
                  {submitting ? 'Submitting append…' : 'Review and append task'}
                </button>
              </form>
            ) : (
              <div className="run-plan-panel__read-only" role="status">
                {historical
                  ? 'Historical versions are immutable. Select the current version to prepare an append.'
                  : resyncReadOnly
                    ? 'Live transport is resyncing. Plan append is read-only until the authoritative snapshot and cursor settle.'
                    : transportReadOnly
                      ? `Transport error: ${display(ws.transport?.error, 'live updates are unavailable')}. Plan append is read-only.`
                      : !transportSettled
                        ? `Waiting for settled live transport (${transportStatus}).`
                        : !currentSnapshotLoaded
                          ? 'Waiting for the current immutable plan snapshot. Append remains disabled until its task IDs are loaded.'
                        : !runPatchable
                          ? `Plan append is unavailable while the run is ${display(run?.status, 'not active')}.`
                        : !appendHarness
                          ? 'This run does not disclose a supported harness; append is read-only until the backend reports one.'
                          : 'An authoritative plan version is required before this append can be reviewed.'}
              </div>
            )}
            {actionError ? (
              <div className="run-plan-panel__error" role="alert">
                <p>{actionError}</p>
                {actionConflict ? (
                  <button type="button" className="docket-link" onClick={() => { setActionError(''); setActionConflict(false); loadPlan(); }}>
                    Review current plan
                  </button>
                ) : null}
              </div>
            ) : null}
            {success ? <p className="run-plan-panel__success" role="status" aria-live="polite">{success}</p> : null}
            {historical ? <p className="run-plan-panel__muted">No edit, delete, reorder, or stale retry is available for history.</p> : null}
          </section>
        </div>
      )}
    </section>
  );
}
