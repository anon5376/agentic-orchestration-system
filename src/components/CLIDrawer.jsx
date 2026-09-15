import React, { useEffect, useRef, useState } from 'react';

export function CLIDrawer({ open, expanded, lines, onClose, onOpen, onToggleExpanded, onCommand, live = false, route, run, connection }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, open]);

  const submit = (event) => {
    event.preventDefault();
    const command = value.trim();
    if (!command) return;
    onCommand(command);
    setValue('');
  };

  const firstLiveCommand = lines.findIndex((line) => line.kind === 'command');
  const visibleLines = live
    ? [
        { kind: 'system', text: 'AOS console — live local engine' },
        ...(firstLiveCommand === -1
          ? [{ kind: 'prompt', text: 'Commands execute against the same local store as this dashboard.' }]
          : lines.slice(firstLiveCommand)),
      ]
    : lines;

  return (
    <aside
      id="aos-cli-drawer"
      className={`cli-drawer ${open ? 'is-open' : ''} ${expanded ? 'is-expanded' : ''}`}
      aria-label={live ? 'AOS command line' : 'Simulated AOS command line'}
    >
      <div className="cli-drawer__rail">
        <button type="button" className="cli-drawer__opener" onClick={open ? onClose : onOpen} aria-expanded={open} aria-controls="aos-cli-body">
          <span aria-hidden="true">{open ? '−' : '›'}</span>
          AOS CONSOLE
        </button>
        <span className="cli-drawer__context">{route?.label || 'Workspace'} / {run?.id || 'NO-RUN'}</span>
        <span className={`cli-drawer__mode ${live ? 'is-live' : ''}`}>
          {live ? (connection === 'ready' ? 'EXECUTES LOCALLY' : `LIVE / ${connection || 'unknown'}`) : 'SIMULATED / NO EXECUTION'}
        </span>
        <kbd>CTRL `</kbd>
      </div>
      <div id="aos-cli-body" className="cli-drawer__body" hidden={!open}>
      <div className="cli-drawer__header">
        <div>
          <span className="cli-drawer__title">Universal command surface</span>
          <span className="cli-drawer__subtitle">{live ? 'Commands execute against the active local engine and .aos store.' : 'Navigation and deterministic demo commands only. No provider, file, or network execution.'}</span>
        </div>
        <div className="cli-drawer__actions">
          <button type="button" className="cli-drawer__button" onClick={onToggleExpanded} disabled={!open} aria-expanded={expanded}>
            {expanded ? 'Reduce' : 'Expand'}
          </button>
          <button type="button" className="cli-drawer__button" onClick={onClose} disabled={!open} aria-label="Close CLI drawer">
            Close
          </button>
        </div>
      </div>
      <div ref={logRef} className="cli-drawer__log" role="log" aria-live="polite" aria-relevant="additions">
        {visibleLines.map((line, index) => (
          <div key={`${line.kind}-${index}`} className={`cli-line cli-line--${line.kind}`}>
            {line.kind === 'command' ? <span className="cli-line__prompt">$</span> : null}
            <span>{line.text}</span>
          </div>
        ))}
      </div>
      <form className="cli-drawer__form" onSubmit={submit}>
        <label className="sr-only" htmlFor="cli-command-input">{live ? 'Enter an AOS command' : 'Enter a simulated AOS command'}</label>
        <span className="cli-line__prompt" aria-hidden="true">$</span>
        <input
          ref={inputRef}
          id="cli-command-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={live ? 'status' : 'help'}
          disabled={!open}
          autoComplete="off"
          spellCheck="false"
        />
        <span className="telemetry">Enter</span>
      </form>
      </div>
    </aside>
  );
}
