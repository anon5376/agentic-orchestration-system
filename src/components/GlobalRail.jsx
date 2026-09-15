import React, { useEffect, useRef } from 'react';
import { routeDefinitions } from '../data/demoState';
import { displayStatus } from '../lib/liveRecords';
import { ApertureSigil } from './ApertureSigil';

export function GlobalRail({ route, onNavigate, onOpenPalette, onToggleCli, cliOpen, run }) {
  const activeRouteRef = useRef(null);
  const primaryRoutes = routeDefinitions.slice(0, 5);
  const systemRoutes = routeDefinitions.slice(5);
  const systemValue = systemRoutes.some((item) => item.key === route.key) ? route.path : '';

  useEffect(() => {
    const activeRoute = activeRouteRef.current;
    const nav = activeRoute?.parentElement;
    if (!activeRoute || !nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: activeRoute.offsetLeft - (nav.clientWidth - activeRoute.offsetWidth) / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [route.key]);

  return (
    <header className="global-rail">
      <div className="global-rail__identity">
        <a className="brand-lockup" href="#/missions" aria-label="AOS — Research runs">
          <ApertureSigil size={26} />
          <span className="brand-lockup__wordmark">AOS</span>
          <span className="brand-lockup__descriptor">Acceleration Chamber</span>
        </a>
      </div>

      <nav className="route-nav" aria-label="AOS routes">
        {primaryRoutes.map((item) => (
          <a
            key={item.key}
            href={`#${item.path}`}
            ref={item.key === route.key ? activeRouteRef : null}
            className={`route-nav__link ${item.key === route.key ? 'is-active' : ''}`}
            aria-current={item.key === route.key ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(item.path);
            }}
          >
            <span className="route-nav__label">{item.label}</span>
          </a>
        ))}
        <label ref={systemValue ? activeRouteRef : null} className={`route-more ${systemValue ? 'is-active' : ''}`}>
          <span className="sr-only">System pages</span>
          <select
            value={systemValue}
            onChange={(event) => onNavigate(event.target.value)}
            aria-label="Open a system page"
          >
            <option value="" disabled>System</option>
            {systemRoutes.map((item) => <option value={item.path} key={item.key}>{item.label}</option>)}
          </select>
        </label>
      </nav>

      <div className="global-rail__actions">
        <span className="global-rail__run" aria-label={`Current run: ${run?.id || 'none'}, ${run?.status || 'idle'}`}>
          <i className={`rail-signal rail-signal--${String(run?.status || 'idle').toLowerCase()}`} />
          {String(run?.id || 'NO-RUN').replace('RUN-', '')} / {displayStatus(run?.status, 'idle')}
        </span>
        <button type="button" className="rail-command" onClick={onOpenPalette} aria-label="Open command palette">
          <span>Command</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className={`rail-cli ${cliOpen ? 'is-active' : ''}`}
          onClick={onToggleCli}
          aria-expanded={cliOpen}
          aria-controls="aos-cli-drawer"
        >
          CLI
        </button>
      </div>
    </header>
  );
}
