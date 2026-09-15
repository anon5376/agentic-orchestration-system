import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { aosApi } from '../lib/aosApi';
import { normalizeSnapshot } from '../lib/liveRecords';

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

export function WorkspaceProvider({ children }) {
  const [mode, setModeState] = useState(readMode);
  const [connection, setConnection] = useState(mode === 'live' ? 'loading' : 'idle');
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

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
      return undefined;
    }
    setConnection((current) => (current === 'ready' ? current : 'loading'));
    refresh();
    const active = snapshot?.run?.status === 'running';
    const timer = window.setInterval(refresh, active ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [mode, refresh, snapshot?.run?.status]);

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

  const empty = connection === 'ready' && snapshot && !snapshot.runs?.length && !snapshot.goals?.length;

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
      refresh,
      createGoal: (prompt, contextPaths) => runAction('Create goal', () => aosApi.createGoal(prompt, contextPaths)),
      answerQuestions: (goalId, answers) => runAction('Record answers', () => aosApi.answerQuestions(goalId, answers)),
      startRun: (goalId, options = {}) => runAction('Start run', () => aosApi.startRun(goalId, options)),
      advance: (runId) => runAction('Advance', () => aosApi.advance(runId)),
      cancel: (runId) => runAction('Cancel', () => aosApi.cancel(runId)),
      pause: (runId) => runAction('Pause', () => aosApi.pause(runId)),
      resume: (runId) => runAction('Resume', () => aosApi.resume(runId)),
      approveProposal: (id) => runAction('Approve proposal', () => aosApi.approveProposal(id)),
      rejectProposal: (id) => runAction('Reject proposal', () => aosApi.rejectProposal(id)),
      runCli: (command) => aosApi.cli(command),
    }),
    [mode, setMode, connection, snapshot, error, busy, notice, empty, refresh, runAction],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
