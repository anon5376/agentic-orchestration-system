import React from 'react';
import { routeForPath } from '../data/demoState';

export function RoutePlaceholder({ page }) {
  const route = routeForPath(`/${page}`);
  return (
    <section className="route-placeholder" data-placeholder-route={route.key}>
      <header className="route-placeholder__header">
        <p className="route-placeholder__kicker">AOS / BLACK ATLAS / ILLUSTRATIVE SURFACE</p>
        <h1>{route.label}</h1>
        <p className="route-placeholder__summary">The shared instrument is online. This page’s working field is reserved for its route composition.</p>
      </header>
      <div className="route-placeholder__field" aria-label={`${route.label} page slot`}>
        <span className="route-placeholder__crosshair route-placeholder__crosshair--top" aria-hidden="true" />
        <span className="route-placeholder__crosshair route-placeholder__crosshair--bottom" aria-hidden="true" />
        <span className="telemetry">PAGE SLOT / {route.shortLabel}</span>
        <span className="route-placeholder__line" aria-hidden="true" />
        <span className="route-placeholder__note">PAGE-SPECIFIC COMPOSITION PENDING</span>
      </div>
    </section>
  );
}
