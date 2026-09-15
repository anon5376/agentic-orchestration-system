import React, { useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import '../styles/pages/evolution.css';

const observations = [
  {
    number: '01',
    mark: '×',
    title: 'OBSERVED FAILURE',
    body: 'Agents frequently enter unproductive exploration loops on ambiguous tasks.',
    label: 'EXAMPLE TRACE (BASELINE)',
    detail: '217  explore_hypothesis()  → uncertain\n218  evaluate()            → uncertain\n219  explore_hypothesis()  → uncertain\n220  explore_hypothesis()  → uncertain',
    foot: 'LOOP DETECTED AT STEP 218–325.',
  },
  {
    number: '02',
    mark: '✳',
    title: 'CAUSAL HYPOTHESIS',
    body: 'Lack of early termination on low-information branches leads to exploration loops.',
    label: 'EVIDENCE',
    detail: '→ 73% OF FAILURES SHOW PATTERN\n→ HIGH TOKEN CHURN, LOW INFORMATION GAIN\n→ SIMILAR BEHAVIOR ACROSS TASK TYPES',
  },
  {
    number: '03',
    mark: '⚒',
    title: 'PROPOSED CHANGE',
    body: 'Add an uncertainty-based early stop rule to prune low-value branches.',
    label: 'EXACT CHANGE',
    detail: 'if uncertainty_score > 0.75\n  and steps_since_gain > 5:\n    terminate_branch()',
  },
  {
    number: '04',
    mark: '▤',
    title: 'EVALUATION SET',
    body: 'Task set: REASONING v1.2 / 100 curated problems held out from training.',
    label: 'DOMAINS',
    detail: '→ MULTI-STEP REASONING     25\n→ TOOL USE & SYNTHESIS      25\n→ ADVERSARIAL PROMPTS       25\n→ AMBIGUOUS QUERIES         25',
  },
];

function StatusLine({ tone = 'neutral', children }) {
  return <span className={`evolution-status evolution-status--${tone}`}><i aria-hidden="true" />{children}</span>;
}

function TraceDiagram({ candidate = false }) {
  const points = candidate
    ? '10,26 35,26 35,52 60,52 60,78 92,78 92,104 119,104 119,130 151,130 151,156 179,156'
    : '10,26 35,26 35,52 66,52 66,78 46,78 46,104 92,104 92,130 60,130 60,156 179,156';
  return (
    <svg className={`evolution-trace ${candidate ? 'is-candidate' : ''}`} viewBox="0 0 190 176" role="img" aria-label={`${candidate ? 'Candidate' : 'Baseline'} execution trace`}>
      <path d={`M ${points}`} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {points.split(' ').map((pair, index) => {
        const [cx, cy] = pair.split(',');
        return <circle key={`${cx}-${cy}-${index}`} cx={cx} cy={cy} r="2" fill="currentColor" />;
      })}
      {[candidate ? 4 : 2, candidate ? 7 : 4, candidate ? 9 : 6].map((index) => {
        const [x, y] = points.split(' ')[index].split(',');
        return <text key={`${x}-${y}`} x={Number(x) + 8} y={Number(y) + 4} fill="var(--atlas-vermilion)" fontSize="11">×</text>;
      })}
    </svg>
  );
}

function SpecimenImage({ candidate = false }) {
  const fallback = '/assets/specimens/synthesis/split-dual-head-organism-v1.png';
  const source = candidate ? '/assets/specimens/evolution-candidate.png' : '/assets/specimens/evolution-baseline.png';
  return (
    <img
      src={source}
      alt={`${candidate ? 'Candidate' : 'Baseline'} abstract execution organism`}
      onError={(event) => {
        if (event.currentTarget.src.endsWith(fallback)) return;
        event.currentTarget.src = fallback;
      }}
    />
  );
}

function VersionCard({ candidate = false }) {
  return (
    <article className={`evolution-version ${candidate ? 'is-candidate' : ''}`}>
      <header className="evolution-version__header">
        <h2>{candidate ? 'CANDIDATE v0.1.1' : 'BASELINE v0.1.0'}</h2>
        {candidate ? <StatusLine tone="signal">PROPOSED IMPROVEMENT</StatusLine> : <small>REFERENCE BEHAVIOR</small>}
      </header>
      <div className="evolution-version__organism">
        <SpecimenImage candidate={candidate} />
        <div className="evolution-version__labels">
          <span>SWARM <b>12 AGENTS</b></span>
          <span>TASK <b>COMPLEX REASONING</b></span>
          <span>TRACES <b>{candidate ? '391' : '428'} STEPS</b></span>
          <span>SUCCESS <b className={candidate ? 'is-signal' : ''}>{candidate ? '78%' : '62%'}</b></span>
          <span>AVG LATENCY <b className={candidate ? 'is-signal' : ''}>{candidate ? '2.9 s' : '4.2 s'}</b></span>
          <span>TOTAL COST <b className={candidate ? 'is-signal' : ''}>{candidate ? '$0.31' : '$0.38'}</b></span>
        </div>
      </div>
      <div className="evolution-version__trace">
        <span className="telemetry">EXECUTION TRACE</span>
        <TraceDiagram candidate={candidate} />
        <small>{candidate ? '391 STEPS / 78% SUCCESS / 1 FAILURE' : '428 STEPS / 62% SUCCESS / 3 FAILURES'}</small>
      </div>
      <footer className="evolution-version__footer telemetry">SPECIMEN B-0 {candidate ? '→ C-1' : 'REFERENCE'} / LATERAL VIEW</footer>
    </article>
  );
}

function MutationSeam() {
  return (
    <div className="mutation-seam" aria-label="Functional rule and metric diff seam">
      <div className="mutation-seam__field">
        <svg viewBox="0 0 180 420" role="img" aria-label="Changed rules and metric deltas">
          <path d="M20 22 H160 M20 68 H144 M36 113 H163 M18 162 H153 M33 208 H145 M16 259 H166 M28 307 H149 M17 360 H160" />
          <path className="mutation-seam__signal" d="M98 0 C79 38 113 67 86 105 S112 169 86 212 S109 272 81 316 S104 376 87 420" />
          <path d="M62 44 H79 M118 92 H145 M47 184 H77 M106 233 H153 M41 335 H71" />
          {[28, 74, 122, 171, 216, 268, 315, 370].map((y, index) => <circle key={y} cx={index % 2 ? 108 : 87} cy={y} r="3" />)}
        </svg>
        <div className="mutation-seam__diffs">
          <span><b>+08</b> RULES</span>
          <span><b>−31%</b> LATENCY</span>
          <span><b>+16%</b> SUCCESS</span>
        </div>
      </div>
      <p className="mutation-seam__caption">SPECIMEN B-0 → C-1<br />RULE / TRACE / METRIC DIFF<br /><small>SAME ENVIRONMENT. A DIFFERENT POSSIBILITY.</small></p>
    </div>
  );
}

export default function EvolutionPage() {
  const { state, setDecision } = useDemoState();
  const [action, setAction] = useState('RUN RETROSPECTIVE');
  const [evalCount, setEvalCount] = useState(0);

  const act = (label, value) => {
    setAction(label);
    setDecision(value);
  };

  return (
    <div className="evolution-page" data-evolution-action={action}>
      <header className="evolution-hero">
        <div>
          <p className="evolution-kicker">AOS / SELF-EVALUATION / {state.run.id}</p>
          <h1>EVOLUTION</h1>
        </div>
        <p className="evolution-hero__thesis">THE SYSTEM STUDIES<br />ITS OWN FAILURES.<br /><span>DIAGNOSE.<br />HYPOTHESIZE.<br />TEST. IMPROVE.<br />REPEAT.</span></p>
        <div className="evolution-hero__context"><p>AGENTS EVOLVE<br />THROUGH EXPERIENCE.<br />NOT INTUITION.</p><span /> <p>THE BLACK ATLAS<br />AOS v0.1.0</p></div>
        <button type="button" className="evolution-hero__action" onClick={() => act('RETROSPECTIVE OPEN', 'retrospective')}><span>RUN RETROSPECTIVE</span><b>[+]</b><small>SAFER AGENTS<br />THROUGH HARDER TRUTHS.</small></button>
      </header>

      <main className="evolution-main">
        <VersionCard />
        <MutationSeam />
        <VersionCard candidate />
      </main>

      <section className="evolution-observations" aria-label="Retrospective findings">
        {observations.map((item) => (
          <article className={`evolution-observation ${item.number === '03' ? 'is-focus' : ''}`} key={item.number}>
            <header><b>{item.number}</b><span>{item.mark}</span><h2>{item.title}</h2></header>
            <p>{item.body}</p>
            <div className="evolution-observation__detail"><span className="telemetry">{item.label}</span><pre>{item.detail}</pre>{item.foot ? <small>{item.foot}</small> : null}</div>
          </article>
        ))}
        <article className="evolution-results">
          <header><b>05</b><span>▥</span><h2>RESULTS <small>(CANDIDATE vs BASELINE)</small></h2></header>
          <table><thead><tr><th>METRIC</th><th>v0.1.0</th><th>v0.1.1</th><th>Δ</th></tr></thead><tbody>
            <tr><th>SUCCESS RATE</th><td>62%</td><td className="is-signal">78%</td><td className="is-signal">+16%</td></tr>
            <tr><th>AVG LATENCY</th><td>4.2 s</td><td className="is-signal">2.9 s</td><td className="is-signal">−31%</td></tr>
            <tr><th>TOTAL COST</th><td>$0.38</td><td className="is-signal">$0.31</td><td className="is-signal">−18%</td></tr>
            <tr><th>REGRESSIONS</th><td>—</td><td className="is-signal">1</td><td className="is-signal">+1</td></tr>
          </tbody></table>
          <div className="evolution-results__foot"><p>REGRESSION NOTE<br /><span>Slight decrease in performance on highly adversarial prompts (−3%).</span></p><p>ROLLBACK STATE<br /><span>Ready on v0.1.0.<br />No data migration required.</span></p></div>
        </article>
      </section>

      <section className="evolution-actions" aria-label="Candidate actions">
        <button type="button" className={state.decision === 'adopt' ? 'is-selected' : ''} onClick={() => act('CANDIDATE ADOPTED', 'adopt')}><b>[+]</b><strong>ADOPT CANDIDATE</strong><small>PROMOTE TO v0.1.1<br />AFTER SAFETY CHECKS</small></button>
        <button type="button" className={state.decision === 'reject' ? 'is-selected' : ''} onClick={() => act('CANDIDATE REJECTED', 'reject')}><b>[ ]</b><strong>REJECT</strong><small>KEEP v0.1.0<br />RECORD LESSONS</small></button>
        <button type="button" className={evalCount ? 'is-selected' : ''} onClick={() => { setEvalCount((count) => count + 1); act(`EVALUATION RUN ${evalCount + 1}`, 'evaluate'); }}><b>[↻]</b><strong>RUN MORE EVALS</strong><small>EXPAND TEST SET<br />TUNE THRESHOLDS</small></button>
      </section>
    </div>
  );
}
