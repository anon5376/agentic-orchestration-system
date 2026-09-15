import React from 'react';

export function InspectionPanel({ eyebrow, title, children, onClose, actions, className = '' }) {
  return (
    <aside className={`inspection-panel ${className}`.trim()} aria-label={title || 'Inspection panel'}>
      <div className="inspection-panel__head">
        <div>
          {eyebrow ? <p className="inspection-panel__eyebrow">{eyebrow}</p> : null}
          {title ? <h2>{title}</h2> : null}
        </div>
        {onClose ? <button type="button" className="text-button" onClick={onClose}>CLOSE</button> : null}
      </div>
      <div className="inspection-panel__body">{children}</div>
      {actions ? <div className="inspection-panel__actions">{actions}</div> : null}
    </aside>
  );
}
