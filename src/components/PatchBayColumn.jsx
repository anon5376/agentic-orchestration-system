import React from 'react';

export function PatchBayColumn({ title, items = [], activeId, onSelect, className = '' }) {
  return (
    <section className={`patch-bay ${className}`.trim()}>
      <div className="patch-bay__heading">
        <h2>{title}</h2>
        <span className="telemetry">{String(items.length).padStart(2, '0')}</span>
      </div>
      <ol className="patch-bay__list">
        {items.map((item, index) => (
          <li key={item.id || item.name}>
            <button type="button" className={`patch-bay__item ${activeId === item.id ? 'is-active' : ''}`} onClick={() => onSelect?.(item)}>
              <span className="patch-bay__index">{String(index + 1).padStart(2, '0')}</span>
              <span className="patch-bay__name">{item.name}</span>
              {item.state ? <span className="patch-bay__state">{item.state}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
