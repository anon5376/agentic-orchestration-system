import React from 'react';
import { useWorkspace } from '../app/WorkspaceContext';

export function ModeBanner() {
  const { mode, setMode, connection, error, empty, transport } = useWorkspace();
  const live = mode === 'live';
  const transportState = transport?.status || 'idle';
  const transportError = transport?.error;
  const isError = live && (connection === 'error' || transportState === 'error');

  return (
    <div
      className={`aos-mode-banner ${live ? 'aos-mode-banner--live' : 'aos-mode-banner--illustrative'}`}
    >
      <p className="aos-mode-banner__state" role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
        <span className={`mode-signal mode-signal--${live ? connection : 'illustrative'}`} />
        {live
          ? isError
            ? `Live local engine unavailable. ${error || transportError || 'Start it with npm run engine.'}`
            : connection === 'loading'
              ? 'Connecting to the local AOS engine…'
              : empty
                ? 'Live local engine · no goals or runs yet. Create one from New question or the CLI.'
                : 'Live local engine · dashboard and console share .aos'
          : 'Illustrative chamber · deterministic demo state · nothing executes'}
      </p>
      {live ? (
        <div className="aos-mode-banner__transport-group">
          <span className="aos-mode-banner__transport" role="status" aria-live="polite">Transport: {transportState}</span>
          <span className="aos-mode-banner__transport-meta" aria-live="off">
            {transport?.cursor == null ? 'cursor —' : `cursor ${transport.cursor}`}
            {transport?.lastUpdated ? ` · updated ${new Date(transport.lastUpdated).toLocaleTimeString()}` : ''}
          </span>
        </div>
      ) : null}
      <div className="aos-mode-banner__actions">
        <button
          type="button"
          className={!live ? 'is-active' : ''}
          aria-pressed={!live}
          onClick={() => setMode('illustrative')}
        >
          Simulated
        </button>
        <button
          type="button"
          className={live ? 'is-active' : ''}
          aria-pressed={live}
          onClick={() => setMode('live')}
        >
          Live / local
        </button>
      </div>
    </div>
  );
}

export function EngineStatePanel({ title, body, action, onAction }) {
  return (
    <div className="aos-state-panel" role="status">
      <p className="docket-context">Local engine</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? (
        <button type="button" className="docket-button docket-button--primary" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}
