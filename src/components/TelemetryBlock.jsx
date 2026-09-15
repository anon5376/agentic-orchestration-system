import React from 'react';

export function TelemetryBlock({ title, rows = [], children, className = '' }) {
  return (
    <section className={`telemetry-block ${className}`.trim()}>
      {title ? <h2 className="telemetry-block__title">{title}</h2> : null}
      {rows.length ? (
        <dl className="telemetry-block__rows">
          {rows.map((row) => (
            <div className="telemetry-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.tone ? `is-${row.tone}` : ''}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </section>
  );
}
