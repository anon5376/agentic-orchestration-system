import React, { useEffect, useMemo, useRef, useState } from 'react';
import { routeDefinitions } from '../data/demoState';

export function CommandPalette({ open, currentPath, onClose, onNavigate, onToggleCli }) {
  const inputRef = useRef(null);
  const previousFocusRef = useRef(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const items = useMemo(() => {
    const search = query.trim().toLowerCase();
    const routes = routeDefinitions.map((route) => ({
      id: `route-${route.key}`,
      kind: 'route',
      label: `Go to ${route.label}`,
      detail: route.path,
      path: route.path,
      route,
    }));
    const actions = [
      { id: 'action-cli', kind: 'action', label: 'Toggle console', detail: 'open the local prototype console', action: onToggleCli },
      { id: 'action-missions', kind: 'action', label: 'Return to research', detail: 'open the research list', path: '/missions' },
    ];
    return [...routes, ...actions].filter((item) => {
      if (!search) return true;
      return `${item.label} ${item.detail}`.toLowerCase().includes(search);
    });
  }, [onToggleCli, query]);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      previousFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(Math.max(0, items.length - 1));
  }, [activeIndex, items.length]);

  if (!open) return null;

  const execute = (item) => {
    if (!item) return;
    if (item.path) onNavigate(item.path);
    else item.action?.();
    onClose();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % Math.max(items.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      execute(items[activeIndex]);
    }
  };

  return (
    <div className="command-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <div className="command-palette__topline">
          <span id="command-palette-title">Go to</span>
          <span className="telemetry">Esc to close</span>
        </div>
        <label className="command-palette__search">
          <span className="sr-only">Search routes and actions</span>
          <span className="command-palette__prompt" aria-hidden="true">/</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search routes or actions"
            autoComplete="off"
            spellCheck="false"
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="command-palette__list" role="listbox" aria-label="Command results">
          {items.length ? (
            items.map((item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                key={item.id}
                className={`command-item ${index === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(item)}
              >
                <span className="command-item__label">{item.label}</span>
                <span className="command-item__detail">{item.detail}</span>
                {item.kind === 'route' && item.path === currentPath ? <span className="command-item__current">CURRENT</span> : null}
              </button>
            ))
          ) : (
            <p className="command-palette__empty">No route or action matches “{query}”.</p>
          )}
        </div>
        <div className="command-palette__hint">↑↓ navigate <span>·</span> ENTER select <span>·</span> ⌘K toggle</div>
      </section>
    </div>
  );
}
