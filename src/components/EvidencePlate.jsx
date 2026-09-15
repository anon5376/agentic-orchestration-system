import React from 'react';

export function EvidencePlate({ id, type = 'open', claim, sourceCount, confidence, owner, children }) {
  return (
    <article className={`evidence-plate evidence-plate--${type}`}>
      <div className="evidence-plate__topline">
        <span className="telemetry">{id}</span>
        <span className="evidence-plate__type">{type}</span>
      </div>
      <p className="evidence-plate__claim">{claim}</p>
      <div className="evidence-plate__meta">
        {sourceCount !== undefined ? <span>{String(sourceCount).padStart(2, '0')} SOURCES</span> : null}
        {confidence !== undefined ? <span>{Math.round(confidence * 100)}% CONFIDENCE</span> : null}
        {owner ? <span>{owner}</span> : null}
      </div>
      {children}
    </article>
  );
}
