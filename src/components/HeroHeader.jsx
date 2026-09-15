import React from 'react';

export function HeroHeader({ kicker, title, summary, meta, actions, className = '' }) {
  return (
    <header className={`hero-header ${className}`.trim()}>
      <div className="hero-header__copy">
        {kicker ? <p className="hero-header__kicker">{kicker}</p> : null}
        <h1>{title}</h1>
        {summary ? <p className="hero-header__summary">{summary}</p> : null}
      </div>
      {(meta || actions) && (
        <div className="hero-header__aside">
          {meta ? <div className="hero-header__meta">{meta}</div> : null}
          {actions ? <div className="hero-header__actions">{actions}</div> : null}
        </div>
      )}
    </header>
  );
}
