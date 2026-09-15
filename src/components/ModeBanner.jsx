import React from 'react';
import { useWorkspace } from '../app/WorkspaceContext';

export function ModeBanner() {
  const { mode, setMode, connection, error, empty } = useWorkspace();
  const live = mode === 'live';

  return (
    <div className={`aos-mode-banner ${live ? 'aos-mode-banner--live' : 'aos-mode-banner--illustrative'}`} role="status">
      <p className="aos-mode-banner__state">
        <span className={`mode-signal mode-signal--${live ? connection : 'illustrative'}`} />
        {live
          ? connection === 'error'
            ? `Live local engine unreachable. ${error || 'Start it with npm run engine.'}`
            : connection === 'loading'
              ? 'Connecting to the local AOS engine…'
              : empty
                ? 'Live local engine · no goals or runs yet. Create one from New question or the CLI.'
                : 'Live local engine · dashboard and console share .aos'
          : 'Illustrative chamber · deterministic demo state · nothing executes'}
      </p>
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
