import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { aosApi } from '../lib/aosApi';
import { normalizeReplayResponse, normalizeSnapshot } from '../lib/liveRecords';
import { shouldRefreshAfterTaskAnswerError } from '../lib/taskQuestions';
import { createTransportRecovery } from '../lib/transportRecovery';

const WorkspaceContext = createContext(null);
const MODE_KEY = 'aos-workspace-mode';

function readMode() {
  try {
    const value = window.localStorage.getItem(MODE_KEY);
    return value === 'live' ? 'live' : 'illustrative';
  } catch {
    return 'illustrative';
  }
}

function numberCursor(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventCursor(event) {
  const id = numberCursor(event?.lastEventId);
  if (id !== null) return id;
  try {
    const data = JSON.parse(event?.data || '{}');
    return numberCursor(data?.id ?? data?.eventId ?? data?.event_id ?? data?.cursor);
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }) {
  const [mode, setModeState] = useState(readMode);
  const [connection, setConnection] = useState(mode === 'live' ? 'loading' : 'idle');
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [transport, setTransport] = useState(() => ({
    status: mode === 'live' ? 'replaying' : 'idle',
    cursor: null,
    lastUpdated: null,
    error: null,
  }));
  const transportCursor = useRef(null);
  const taskAnswerInFlight = useRef(null);

  const setMode = useCallback((next) => {
    const value = next === 'live' ? 'live' : 'illustrative';
    setModeState(value);
    try {
      window.localStorage.setItem(MODE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

  const refresh = useCallback(async () => {
    if (mode !== 'live') return null;
    try {
      const next = normalizeSnapshot(await aosApi.snapshot());
      setSnapshot(next);
      setError(null);
      setConnection('ready');
      setTransport((current) => ({ ...current, lastUpdated: new Date().toISOString() }));
      return next;
    } catch (err) {
      setSnapshot(null);
      setError(err.message || 'Local engine unreachable');
      setConnection('error');
      return null;
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live') {
      setConnection('idle');
      setError(null);
      transportCursor.current = null;
      setTransport({ status: 'idle', cursor: null, lastUpdated: null, error: null });
      return undefined;
    }

    let disposed = false;
    let source = null;
    let pollingTimer = null;
    let reconnectTimer = null;
    let stableTimer = null;
    let snapshotTimer = null;
    let replayInFlight = false;
    let refreshInFlight = false;
    let latestRunStatus = null;

    const updateTransport = (next) => {
      if (!disposed) setTransport((current) => ({ ...current, ...next }));
    };

    const closeSource = () => {
      if (source) {
        source.close();
        source = null;
      }
    };

    const updateCursor = (value) => {
      const next = numberCursor(value);
      if (next === null) return;
      const current = numberCursor(transportCursor.current);
      if (current !== null && next < current) return;
      transportCursor.current = next;
      updateTransport({ cursor: next });
    };

    const resetCursor = (value) => {
      const next = numberCursor(value);
      transportCursor.current = next;
      updateTransport({ cursor: next });
    };

    const refreshAuthoritativeSnapshot = async () => {
      if (refreshInFlight || disposed) return null;
      refreshInFlight = true;
      try {
        const next = await refresh();
        if (next) {
          latestRunStatus = next.run?.status || null;
          updateCursor(next.eventCursor);
        }
        return next;
      } finally {
        refreshInFlight = false;
      }
    };

    const startPolling = () => {
      if (disposed) return;
      closeSource();
      if (pollingTimer) return;
      updateTransport({ status: 'polling', error: null });
      const poll = async () => {
        const next = await refreshAuthoritativeSnapshot();
        if (next && latestRunStatus !== (next.run?.status || null)) {
          latestRunStatus = next.run?.status || null;
          window.clearInterval(pollingTimer);
          pollingTimer = null;
          startPolling();
        }
      };
      const delay = latestRunStatus === 'running' ? 1000 : 4000;
      pollingTimer = window.setInterval(poll, delay);
    };

    const scheduleSnapshotRefresh = () => {
      if (snapshotTimer || disposed) return;
      snapshotTimer = window.setTimeout(async () => {
        snapshotTimer = null;
        await refreshAuthoritativeSnapshot();
      }, 80);
    };

    const replay = async (status = 'replaying') => {
      if (replayInFlight || disposed) return false;
      replayInFlight = true;
      updateTransport({ status, error: null });
      try {
        const result = normalizeReplayResponse(await aosApi.eventsReplay({ after: transportCursor.current, limit: 200 }));
        if (result.resyncRequired) {
          updateTransport({ status: 'resyncing', error: null });
          const next = await refreshAuthoritativeSnapshot();
          if (!next) throw new Error('Snapshot refresh required before the live stream can resume.');
          resetCursor(next.eventCursor);
          return true;
        }
        result.events.forEach((event) => updateCursor(event.id ?? event.eventId ?? event.event_id ?? event.cursor));
        updateCursor(result.nextCursor ?? result.latest);
        await refreshAuthoritativeSnapshot();
        return true;
      } catch (err) {
        updateTransport({ status: 'error', error: err.message || 'Event replay failed' });
        return false;
      } finally {
        replayInFlight = false;
      }
    };

    const recovery = createTransportRecovery({
      replay,
      isActive: () => !disposed,
      scheduleReconnect: (delay) => {
        if (disposed) return;
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (!disposed) connect();
        }, delay);
      },
      startPolling: () => {
        if (!disposed) startPolling();
      },
    });
    const recover = (status) => recovery.recover(status);

    const connect = () => {
      if (disposed || pollingTimer || typeof window.EventSource !== 'function') {
        if (typeof window.EventSource !== 'function') startPolling();
        return;
      }
      try {
        source = new window.EventSource(aosApi.eventsStreamUrl(transportCursor.current));
        source.onopen = () => {
          if (stableTimer) window.clearTimeout(stableTimer);
          stableTimer = window.setTimeout(() => { recovery.resetAttempts(); }, 5000);
          updateTransport({ status: 'streaming', error: null, cursor: transportCursor.current });
        };
        const handleStreamEvent = (event) => {
          updateCursor(eventCursor(event));
          scheduleSnapshotRefresh();
        };
        source.onmessage = handleStreamEvent;
        source.addEventListener('aos.event', handleStreamEvent);
        source.addEventListener('aos.resync', async () => {
          closeSource();
          await recover('resyncing');
        });
        source.onerror = async () => {
          closeSource();
          await recover('replaying');
        };
      } catch (err) {
        updateTransport({ status: 'error', error: err.message || 'Live stream unavailable' });
        startPolling();
      }
    };

    const start = async () => {
      setConnection((current) => (current === 'ready' ? current : 'loading'));
      updateTransport({ status: 'replaying', error: null });
      const first = await refreshAuthoritativeSnapshot();
      if (disposed) return;
      if (!first) {
        updateTransport({ status: 'error', error: 'Snapshot refresh failed' });
        startPolling();
        return;
      }
      const recovered = await replay('replaying');
      if (disposed) return;
      if (recovered) connect();
      else startPolling();
    };

    start();
    return () => {
      disposed = true;
      closeSource();
      if (pollingTimer) window.clearInterval(pollingTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (stableTimer) window.clearTimeout(stableTimer);
      if (snapshotTimer) window.clearTimeout(snapshotTimer);
    };
  }, [mode, refresh]);

  const runAction = useCallback(async (label, fn) => {
    setBusy(true);
    setNotice(label);
    try {
      const result = await fn();
      await refresh();
      setNotice(`${label} · recorded`);
      return result;
    } catch (err) {
      setNotice(`${label} failed: ${err.message}`);
      throw err;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const leadAction = useCallback(async (fn) => {
    setBusy(true);
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (err) {
      await refresh();
      throw err;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const answerTaskQuestions = useCallback((taskId, answers) => {
    if (taskAnswerInFlight.current) return taskAnswerInFlight.current;
    let pending;
    pending = (async () => {
      setBusy(true);
      try {
        const result = await aosApi.answerTaskQuestions(taskId, answers);
        await refresh();
        return result;
      } catch (err) {
        if (shouldRefreshAfterTaskAnswerError(err)) await refresh();
        throw err;
      } finally {
        setBusy(false);
        if (taskAnswerInFlight.current === pending) taskAnswerInFlight.current = null;
      }
    })();
    taskAnswerInFlight.current = pending;
    return pending;
  }, [refresh]);

  const empty = connection === 'ready' && snapshot && !snapshot.runs?.length && !snapshot.goals?.length;
  const runPlan = useCallback((runId, version = null) => aosApi.runPlan(runId, version), []);
  const appendPlan = useCallback((runId, input) => runAction('Append research task', () => aosApi.patchRunPlan(runId, input)), [runAction]);

  const value = useMemo(
    () => ({
      mode,
      setMode,
      connection,
      snapshot,
      error,
      busy,
      notice,
      empty,
      transport,
      refresh,
      runPlan,
      appendPlan,
      answerTaskQuestions,
      createGoal: (prompt, contextPaths) => runAction('Create goal', () => aosApi.createGoal(prompt, contextPaths)),
      answerQuestions: (goalId, answers) => runAction('Record answers', () => aosApi.answerQuestions(goalId, answers)),
      createLeadGoal: (prompt, contextPaths, requestId) => leadAction(() => aosApi.createLeadGoal(prompt, contextPaths, requestId)),
      answerLeadQuestions: (goalId, answers) => leadAction(() => aosApi.answerQuestions(goalId, answers)),
      listLeadPlans: (goalId, status = null) => aosApi.listLeadPlans(goalId, status),
      getLeadPlan: (id) => aosApi.getLeadPlan(id),
      reviseLeadPlan: (goalId, requestId, derivedFromProposalId) => leadAction(() => aosApi.reviseLeadPlan(goalId, { requestId, derivedFromProposalId })),
      acceptLeadPlan: (id) => leadAction(() => aosApi.acceptLeadPlan(id)),
      rejectLeadPlan: (id, reason) => leadAction(() => aosApi.rejectLeadPlan(id, reason)),
      startRun: (goalId, options = {}) => runAction('Start run', () => aosApi.startRun(goalId, options)),
      advance: (runId) => runAction('Advance', () => aosApi.advance(runId)),
      cancel: (runId) => runAction('Cancel', () => aosApi.cancel(runId)),
      pause: (runId) => runAction('Pause', () => aosApi.pause(runId)),
      resume: (runId) => runAction('Resume', () => aosApi.resume(runId)),
      approveProposal: (id) => runAction('Approve proposal', () => aosApi.approveProposal(id)),
      rejectProposal: (id) => runAction('Reject proposal', () => aosApi.rejectProposal(id)),
      runCli: (command) => aosApi.cli(command),
    }),
    [mode, setMode, connection, snapshot, error, busy, notice, empty, transport, refresh, runAction, leadAction, runPlan, appendPlan, answerTaskQuestions],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
