import React from 'react';

export function SpecimenPlate({ label, caption, children, tone = 'void', className = '' }) {
  return (
    <figure className={`specimen-plate specimen-plate--${tone} ${className}`.trim()}>
      <div className="specimen-plate__registration" aria-hidden="true" />
      <div className="specimen-plate__body">{children}</div>
      {(label || caption) && (
        <figcaption className="specimen-plate__caption">
          {label ? <span className="specimen-plate__label">{label}</span> : null}
          {caption ? <span>{caption}</span> : null}
        </figcaption>
      )}
    </figure>
  );
}
