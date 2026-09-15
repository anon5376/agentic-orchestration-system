import React from 'react';

export function StatusSignal({ status = 'neutral', label, compact = false }) {
  const readable = label || status;
  return (
    <span className={`status-signal status-signal--${status} ${compact ? 'status-signal--compact' : ''}`}>
      <span className="status-signal__dot" aria-hidden="true" />
      <span>{readable}</span>
    </span>
  );
}
