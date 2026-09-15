import React, { useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import '../styles/pages/synthesis.css';

const checks = [
  {
    id: 'mechanistic',
    number: '01',
    title: 'MECHANISTIC CHECK',
    question: 'DOES IT WORK?',
    asset: '/assets/specimens/synthesis-cell.png',
    verdict: 'SUPPORT',
    note: 'Mechanism consistent with observed data. Reproducible in simulation. No critical conflicts.',
    signal: '0.81',
  },
  {
    id: 'adversarial',
    number: '02',
    title: 'ADVERSARIAL CHECK',
    question: 'CAN IT FAIL?',
    asset: '/assets/specimens/synthesis/split-dual-head-organism-v1.png',
    verdict: 'SUPPORT',
    note: 'Stress-tested over diverse conditions. Plausible alternatives considered. Failure modes bounded.',
    signal: '0.68',
  },
  {
    id: 'source',
    number: '03',
    title: 'SOURCE CHECK',
    question: 'IS IT GROUNDED?',
    asset: null,
    verdict: 'SUPPORT',
    note: 'Multiple independent sources converge. Data lineage traceable. No evidence of manipulation.',
    signal: '0.76',
  },
];

function SignalBars({ value = 0.7, tone = 'chalk' }) {
  const active = Math.round(value * 18);
  return (
    <span className={`synthesis-signal synthesis-signal--${tone}`} aria-label={`${Math.round(value * 100)} percent signal`}>
      {Array.from({ length: 18 }, (_, index) => (
        <i key={index} className={index < active ? 'is-active' : ''} style={{ height: `${4 + ((index * 7) % 13)}px` }} />
      ))}
    </span>
  );
}

function SourceTexture() {
  return (
    <div className="synthesis-source-texture" aria-label="Source convergence trace">
      {Array.from({ length: 18 }, (_, row) => (
        <span key={row} style={{ '--trace-width': `${38 + ((row * 23) % 58)}%`, '--trace-offset': `${(row * 11) % 22}%` }} />
      ))}
      <b>TRACE / INDEPENDENT SOURCE LINES</b>
    </div>
  );
}

function CheckPanel({ item, active, onSelect }) {
  return (
    <button type="button" className={`synthesis-check ${active ? 'is-active' : ''}`} onClick={onSelect} aria-pressed={active}>
      <span className="synthesis-check__heading">
        <span className="synthesis-check__number">{item.number}</span>
        <span>
          <strong>{item.title}</strong>
          <small>{item.question}</small>
        </span>
      </span>
      <span className="synthesis-check__image">
        {item.asset ? <img src={item.asset} alt="Abstract research specimen" /> : <SourceTexture />}
      </span>
      <span className="synthesis-check__criteria">
        {item.note.split('. ').filter(Boolean).map((criterion) => (
          <span key={criterion}><i aria-hidden="true" />{criterion.replace(/[.]$/, '')}</span>
        ))}
      </span>
      <span className="synthesis-check__verdict">
        <small>VERDICT</small>
        <strong>{item.verdict}</strong>
        <SignalBars value={Number(item.signal)} />
      </span>
    </button>
  );
}

function ConclusionPanel({ decision, onDecision }) {
  return (
    <article className="synthesis-conclusion">
      <div className="synthesis-conclusion__seam" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => <span key={index} style={{ '--seam-height': `${28 + ((index * 13) % 64)}%`, '--seam-offset': `${(index * 17) % 92}%` }} />)}
      </div>
      <header className="synthesis-conclusion__header">
        <span className="synthesis-conclusion__label"><i /> PROPOSED CONCLUSION</span>
        <span className="telemetry">ID AT-4271-B</span>
      </header>
      <div className="synthesis-conclusion__copy">
        <h2>ADAPTIVE NERVE<br />INTERFACES ENABLE<br />STABLE CROSS-SPECIES<br />SIGNAL TRANSFER.</h2>
        <p>Biological and synthetic nervous systems can co-adapt through closed-loop interfaces without loss of functional integrity.</p>
      </div>
      <div className="synthesis-conclusion__objection">
        <span className="synthesis-conclusion__objection-count">1 OBJECTION</span>
        <strong>MISSING EXPERIMENT</strong>
        <p>Long-term stability in vivo remains untested.</p>
        <small>Extended duration study required before claim can be considered robust.</small>
      </div>
      <div className="synthesis-conclusion__footer">
        <span className="telemetry">CONSENSUS / PROVISIONAL</span>
        <button type="button" className={decision === 'hold' ? 'is-selected' : ''} onClick={() => onDecision('hold')}>HOLD AT GATE</button>
      </div>
    </article>
  );
}

export default function SynthesisPage() {
  const { state, setDecision } = useDemoState();
  const [activeCheck, setActiveCheck] = useState('mechanistic');
  const [notice, setNotice] = useState('SYNTHESIS AWAITS A RESEARCH DECISION');

  const choose = (value, label) => {
    setDecision(value);
    setNotice(label);
  };

  return (
    <div className="synthesis-page" data-decision={state.decision}>
      <header className="synthesis-hero">
        <div className="synthesis-hero__title-wrap">
          <p className="synthesis-kicker">AOS / DECISION SURFACE / {state.run.id}</p>
          <h1>SYNTHESIS GATE</h1>
        </div>
        <p className="synthesis-hero__thesis">EVIDENCE.<br />DISSENT.<br />CONVERGENCE.<br /><span>A CLEARER TOMORROW.</span></p>
        <div className="synthesis-hero__context">
          <p>MULTI-PERSPECTIVE REVIEW<br />BEFORE KNOWLEDGE ADVANCES.</p>
          <span className="synthesis-rule" />
          <p>THE BLACK ATLAS<br />AOS v0.1.0</p>
        </div>
        <div className="synthesis-hero__decision">
          <span>RESEARCH DECISION <b>[−]</b></span>
          <p>SAME QUESTION.<br />DIFFERENT MINDS.<br />A STRONGER ANSWER.</p>
        </div>
      </header>

      <main className="synthesis-workfield">
        <div className="synthesis-check-column">
          <CheckPanel item={checks[0]} active={activeCheck === checks[0].id} onSelect={() => setActiveCheck(checks[0].id)} />
        </div>
        <div className="synthesis-check-column">
          <CheckPanel item={checks[1]} active={activeCheck === checks[1].id} onSelect={() => setActiveCheck(checks[1].id)} />
        </div>
        <ConclusionPanel decision={state.decision} onDecision={(value) => choose(value, 'GATE HELD / PROVISIONAL CONCLUSION')} />
        <div className="synthesis-check-column">
          <CheckPanel item={checks[2]} active={activeCheck === checks[2].id} onSelect={() => setActiveCheck(checks[2].id)} />
        </div>
        <aside className="synthesis-perspective">
          <div className="synthesis-perspective__copy">
            <p>SYNTHESIS<br />INTEGRATE.<br />EXTEND.<br />GENERALIZE.</p>
            <p>DISSENT<br />QUESTION.<br />CHALLENGE.<br />REFINE.</p>
          </div>
          <div className="synthesis-perspective__image">
            <img src="/assets/specimens/synthesis-dual.png" alt="Two-sided abstract research organism" />
            <span className="synthesis-perspective__axis" aria-hidden="true" />
          </div>
          <p className="synthesis-perspective__caption">TWO PERSPECTIVES.<br />A STRONGER TRUTH.</p>
        </aside>
      </main>

      <section className="synthesis-decision-bar" aria-label="Research decision options">
        <div className="synthesis-decision-bar__intro">
          <p>DECISION OPTIONS</p>
          <strong>{notice}</strong>
          <small>SELECT A PATH BASED ON THE CURRENT EVIDENCE.</small>
        </div>
        <button type="button" className={state.decision === 'continue' ? 'is-selected' : ''} onClick={() => choose('continue', 'CONTINUE RESEARCH / MISSING EXPERIMENT QUEUED')}>
          <b>→</b><span>CONTINUE RESEARCH<small>RUN MISSING EXPERIMENT<br />AND RE-EVALUATE.</small></span>
        </button>
        <button type="button" className={state.decision === 'restructure' ? 'is-selected' : ''} onClick={() => choose('restructure', 'RESTRUCTURE SWARM / NEW BRANCH REQUIRED')}>
          <b>→</b><span>RESTRUCTURE SWARM<small>CHANGE APPROACH, HYPOTHESES,<br />OR AGENT COMPOSITION.</small></span>
        </button>
        <button type="button" className={state.decision === 'complete' ? 'is-selected' : ''} onClick={() => choose('complete', 'COMPLETE AS INCONCLUSIVE / ARCHIVE FINDINGS')}>
          <b>→</b><span>COMPLETE AS INCONCLUSIVE<small>CLOSE INVESTIGATION.<br />ARCHIVE FINDINGS.</small></span>
        </button>
      </section>
    </div>
  );
}
