import React from 'react';

export function ApertureSigil({ size = 32, labelled = false, className = '' }) {
  return (
    <svg
      className={`aperture-sigil ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? 'AOS aperture sigil' : undefined}
      aria-hidden={labelled ? undefined : true}
    >
      <path d="M32 5v10M32 49v10M5 32h10M49 32h10" />
      <path d="M18.2 10.7a25 25 0 0 0-7.5 7.5M45.8 10.7a25 25 0 0 1 7.5 7.5M10.7 45.8a25 25 0 0 0 7.5 7.5M53.3 45.8a25 25 0 0 1-7.5 7.5" />
      <circle cx="32" cy="32" r="18" />
      <circle cx="32" cy="32" r="5" className="aperture-sigil__core" />
    </svg>
  );
}
