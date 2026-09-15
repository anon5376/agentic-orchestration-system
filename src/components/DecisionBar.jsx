import React from 'react';

export function DecisionBar({ prompt, options = [], value, onChange, detail }) {
  return (
    <section className="decision-bar" aria-label="Decision controls">
      <div className="decision-bar__copy">
        <p className="decision-bar__label">DECISION GATE</p>
        <h2>{prompt}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      <div className="decision-bar__options" role="group" aria-label="Decision options">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`decision-button ${value === option.value ? 'is-selected' : ''} ${option.tone ? `decision-button--${option.tone}` : ''}`}
            onClick={() => onChange?.(option.value)}
          >
            <span>{option.label}</span>
            {option.note ? <small>{option.note}</small> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
