import React, { useMemo, useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import '../styles/pages/intake.css';

const initialContext = [
  { id: 'ctx-n7', name: 'SPECIMEN_N7', detail: 'Neural interface tissue (slice)', type: 'PNG', size: '12 MB', image: '/assets/specimens/missions/nerve-interface-fragment-v1.png' },
  { id: 'ctx-4287', name: 'STUDY_4287', detail: 'Closed-loop adaptation in vivo', type: 'PDF', size: '2.4 MB', image: '/assets/specimens/evidence/faceless-coupled-section-v1.png' },
  { id: 'ctx-312', name: 'DATA_EVID-312', detail: 'Neural response time series', type: 'CSV', size: '18 MB', image: '/assets/specimens/swarm/root-branch-organism-v1.png' },
  { id: 'ctx-bio', name: 'REF_BIO-SYN', detail: 'Synthetic bio-interface review', type: 'PDF', size: '3.1 MB', image: '/assets/specimens/missions/planetary-lattice-fragment-v1.png' },
];

const steps = [
  { id: 'input', label: 'INPUT' },
  { id: 'interpret', label: 'INTERPRET' },
  { id: 'swarm', label: 'FORM SWARM' },
];

function IntakeStepRail({ active, onStep }) {
  return (
    <nav className="intake-page__steps" aria-label="Goal intake steps">
      {steps.map((step, index) => (
        <div className={`intake-page__step ${active === step.id ? 'is-active' : ''} ${index < steps.findIndex((item) => item.id === active) ? 'is-complete' : ''}`} key={step.id}>
          <button type="button" onClick={() => onStep(step.id)} aria-current={active === step.id}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <b>{step.label}</b>
          </button>
          {index < steps.length - 1 ? <span className="intake-page__step-line" aria-hidden="true" /> : null}
        </div>
      ))}
    </nav>
  );
}

function ContextItem({ item, onRemove }) {
  return (
    <li className="intake-context__item">
      <img src={item.image} alt="" />
      <div>
        <strong>{item.name}</strong>
        <span>{item.detail}</span>
        <small>{item.type} · {item.size}</small>
      </div>
      <button type="button" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}>×</button>
    </li>
  );
}

function Interpretation({ objective, active, onFormSwarm }) {
  const questions = [
    ['How do interface materials modulate neural plasticity?', 'ADDRESSED'],
    ['What failure modes emerge at the bio-synthetic boundary?', 'UNRESOLVED'],
    ['Can stable, bidirectional signaling be maintained long-term?', 'UNRESOLVED'],
  ];

  return (
    <section className="intake-interpretation" aria-labelledby="interpretation-title">
      <div className="intake-interpretation__copy">
        <p className="intake-page__kicker">INTERPRETATION</p>
        <h2 id="interpretation-title">LEAD AGENT INTERPRETATION</h2>
        <span className="intake-page__rule" aria-hidden="true" />
        <p className="intake-interpretation__summary">Investigate how biological and synthetic nervous systems adapt at the interface, identifying mechanisms, constraints, and design principles for stable, bidirectional interaction.</p>

        <section className="intake-section">
          <h3>SCOPE BOUNDARIES</h3>
          <dl>
            <div><dt>INCLUDE</dt><dd>Biological and synthetic nerve interfaces</dd></div>
            <div><dt>EXCLUDE</dt><dd>Clinical deployment and human trials</dd></div>
            <div><dt>TIME HORIZON</dt><dd>Current research (≤ 5 years)</dd></div>
            <div><dt>DOMAINS</dt><dd>Neuroscience, bioengineering, computation</dd></div>
            <div><dt>SUCCESS CRITERIA</dt><dd>Mechanistic model with testable predictions</dd></div>
          </dl>
        </section>

        <section className="intake-section intake-section--questions">
          <h3>KEY QUESTIONS</h3>
          <ol>
            {questions.map(([question, status], index) => (
              <li className={status === 'UNRESOLVED' ? 'is-unresolved' : ''} key={question}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{question}</p>
                <b>{status}</b>
              </li>
            ))}
          </ol>
        </section>

        <section className="intake-section">
          <h3>PROPOSED EVIDENCE STANDARD</h3>
          <dl>
            <div><dt>DATA</dt><dd>Peer-reviewed studies, preprints, empirical datasets</dd></div>
            <div><dt>VALIDATION</dt><dd>Cross-method triangulation (in vivo, in vitro, simulation)</dd></div>
            <div><dt>THRESHOLD</dt><dd>Convergent evidence from ≥ 2 independent sources</dd></div>
            <div><dt>OUTPUT</dt><dd>Mechanistic model with uncertainty bounds</dd></div>
          </dl>
        </section>

        <section className="intake-section intake-section--policies">
          <h3>EFFECTIVE POLICIES</h3>
          <dl>
            <div><dt>REASONING</dt><dd>Prioritize mechanistic explanations over correlation</dd></div>
            <div><dt>SOURCES</dt><dd>Diverse and adversarial search</dd></div>
            <div><dt>LIMITS</dt><dd>Flag low-confidence claims and competing hypotheses</dd></div>
            <div><dt>ITERATION</dt><dd>Refine with new evidence from swarm analysis</dd></div>
          </dl>
        </section>
        <p className="intake-interpretation__state" role="status" aria-live="polite">INTERPRETATION STATE / {active === 'interpret' ? 'READY FOR REVIEW' : active === 'swarm' ? 'SWARM FORMATION QUEUED' : 'DRAFT'}</p>
      </div>
      <figure className="intake-interpretation__specimen">
        <img src="/assets/specimens/intake/cranial-nerve-profile-v1.png" alt="Illustrative cranial nerve specimen" />
        <span className="intake-page__crosshair intake-page__crosshair--top" aria-hidden="true" />
        <span className="intake-page__crosshair intake-page__crosshair--mid" aria-hidden="true" />
        <figcaption><span>SPECIMEN N7</span><br />CRANIAL NERVE NETWORK<br />(PARTIAL)</figcaption>
        <span className="intake-interpretation__annotation">SYNTHETIC<br />INTERFACE<br />BOUNDARY<br />(OBSERVATION)</span>
      </figure>
      <button type="button" className="intake-interpretation__form" onClick={onFormSwarm}>
        FORM SWARM <span aria-hidden="true">→</span>
      </button>
      <p className="intake-interpretation__aside-note">TURN QUESTIONS<br />INTO DISCOVERY.<br /><span>—</span></p>
    </section>
  );
}

export default function IntakePage() {
  const demo = useDemoState();
  const [active, setActive] = useState('input');
  const [objective, setObjective] = useState('Map the mechanisms of adaptive nerve interfaces');
  const [context, setContext] = useState(initialContext);
  const [attached, setAttached] = useState(false);
  const wordCount = useMemo(() => objective.trim().split(/\s+/).filter(Boolean).length, [objective]);

  const setStep = (step) => {
    setActive(step);
    if (step !== 'input') demo.setFocusedBranch(step);
  };

  const interpret = () => {
    setActive('interpret');
    demo.setFocusedBranch('intake');
  };

  const formSwarm = () => {
    setActive('swarm');
    demo.setFocusedBranch('swarm');
  };

  return (
    <section className="intake-page" aria-labelledby="intake-title">
      <div className="intake-page__workspace">
        <section className="intake-input" aria-labelledby="intake-title">
          <IntakeStepRail active={active} onStep={setStep} />
          <div className="intake-input__heading">
            <p className="intake-page__kicker">AOS / BLACK ATLAS / ILLUSTRATIVE SURFACE</p>
            <h1 id="intake-title">DEFINE THE<br />UNKNOWN</h1>
          </div>
          <label className="intake-input__label" htmlFor="research-objective">STATE YOUR RESEARCH OBJECTIVE</label>
          <div className="intake-input__textarea-wrap">
            <textarea id="research-objective" value={objective} maxLength={1000} onChange={(event) => setObjective(event.target.value)} aria-describedby="objective-meta" />
            <span id="objective-meta">{objective.length} / 1000</span>
          </div>
          <div className="intake-context__header"><span>ATTACHED CONTEXT</span><span>{context.length} DOCUMENTS</span></div>
          <ul className="intake-context" aria-label="Attached illustrative context">
            {context.map((item) => <ContextItem item={item} key={item.id} onRemove={(id) => setContext((items) => items.filter((entry) => entry.id !== id))} />)}
          </ul>
          <button type="button" className={`intake-input__drop ${attached ? 'is-attached' : ''}`} onClick={() => setAttached((value) => !value)}>
            <span aria-hidden="true">+</span><b>{attached ? 'DEMO FILE QUEUED' : 'ATTACH FILES OR DRAG AND DROP'}</b><small>PDF&nbsp;&nbsp;PNG&nbsp;&nbsp;CSV&nbsp;&nbsp;TXT</small>
          </button>
          <button type="button" className="intake-input__interpret" onClick={interpret}>INTERPRET GOAL <span aria-hidden="true">→</span></button>
          <p className="intake-input__footnote">Illustrative intake only · no file is uploaded or executed.</p>
        </section>
        <Interpretation objective={objective} active={active} onFormSwarm={formSwarm} />
      </div>
      <div className="intake-page__footer-note" aria-hidden="true">OBJECTIVE / {wordCount} TOKENS IN DRAFT <span>RESEARCH CONTROL PLANE / ILLUSTRATIVE</span></div>
    </section>
  );
}
