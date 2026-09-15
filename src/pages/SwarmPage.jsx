import React, { useMemo, useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import { StatusSignal } from '../components/StatusSignal';
import '../styles/pages/swarm.css';

const branches = [
  {
    id: 'sensory', index: '01', name: 'SENSORY ADAPTATION', agents: 8, state: 'ACTIVE', accent: false,
    detail: 'Environmental input, signal processing, adaptive filters.',
    assignment: 'Map the signal conditions that trigger plastic response.',
    members: ['N2', 'N4', 'N8', 'N16', 'N22', 'N29', 'N31', 'N37'],
    evidence: '142 items', hypothesis: 'Adaptation begins at the boundary where signal noise becomes patterned.',
  },
  {
    id: 'memory', index: '02', name: 'MEMORY DYNAMICS', agents: 9, state: 'ACTIVE', accent: false,
    detail: 'Persistence, compression, recall strategies.',
    assignment: 'Trace retention across substrate handoffs and branch resets.',
    members: ['C2', 'C6', 'C12', 'C14', 'C19', 'C23', 'C27', 'C34', 'C41'],
    evidence: '198 items', hypothesis: 'Memory is stable only while its compression strategy remains legible to the next branch.',
  },
  {
    id: 'interface', index: '03', name: 'INTERFACE PHYSIOLOGY', agents: 7, state: 'ACTIVE', accent: true,
    detail: 'Nerve interfaces, bio-synthetic coupling, plasticity.',
    assignment: 'Investigate mechanisms of neural interface adaptation and bidirectional plasticity in synthetic systems.',
    members: ['N7', 'N11', 'N14', 'N18', 'N21', 'N27', 'N33'],
    evidence: '428 items', hypothesis: 'Bidirectional interface plasticity emerges from constrained signal competition across neural timescales.',
  },
  {
    id: 'social', index: '04', name: 'SOCIAL COORDINATION', agents: 12, state: 'IDLE', accent: false,
    detail: 'Agent communication, hierarchy formation, conflict resolution.',
    assignment: 'Test whether branch-to-branch feedback produces coordination overhead.',
    members: ['S1', 'S3', 'S5', 'S10', 'S15', 'S18'],
    evidence: '286 items', hypothesis: 'Coordination cost increases faster than branch count after the first shared objective.',
  },
  {
    id: 'emergent', index: '05', name: 'EMERGENT BEHAVIOR', agents: 12, state: 'IDLE', accent: false,
    detail: 'Pattern detection, behavioral models, scaling laws.',
    assignment: 'Locate the first repeatable pattern not present in the initial task graph.',
    members: ['E4', 'E9', 'E13', 'E17', 'E26', 'E30'],
    evidence: '601 items', hypothesis: 'Novel coordination appears as a low-frequency deviation before it becomes a goal.',
  },
];

const tracePaths = [
  'M500 76 C430 145 345 154 232 234 S152 367 103 493',
  'M500 76 C462 156 435 185 391 242 S343 389 310 509',
  'M500 76 C500 160 501 206 501 270 S501 406 499 527',
  'M500 76 C539 155 580 182 624 245 S673 382 701 510',
  'M500 76 C576 145 664 152 775 228 S865 358 904 487',
  'M500 88 C431 112 378 147 309 186',
  'M500 88 C578 117 644 150 698 189',
];

function SwarmMap({ selectedId, onSelect }) {
  return (
    <div className="swarm-field" aria-label="Illustrative swarm topology">
      <span className="swarm-field__crosshair swarm-field__crosshair--tl" aria-hidden="true" />
      <span className="swarm-field__crosshair swarm-field__crosshair--tr" aria-hidden="true" />
      <span className="swarm-field__crosshair swarm-field__crosshair--bl" aria-hidden="true" />
      <span className="swarm-field__crosshair swarm-field__crosshair--br" aria-hidden="true" />
      <img className="swarm-field__root-art" src="/assets/specimens/swarm/root-branch-organism-v1.png" alt="" />
      <svg className="swarm-field__traces" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
        {tracePaths.map((path, index) => <path key={path} d={path} className={index === 2 || index === 5 ? 'is-accent' : ''} />)}
        <circle cx="500" cy="76" r="22" className="swarm-field__root-node" />
        {[103, 310, 499, 701, 904].map((x, index) => (
          <circle key={x} cx={x} cy={index === 2 ? 527 : 493} r={index === 2 ? 15 : 10} className={`swarm-field__leaf ${selectedId === branches[index].id ? 'is-selected' : ''}`} />
        ))}
      </svg>
      <button type="button" className="swarm-field__root-label" onClick={() => onSelect('interface')}>
        <span>ROOT</span><b>AOS-CORE</b><strong>48 AGENTS</strong>
      </button>
      <div className="swarm-field__system-copy">DISTRIBUTED INTELLIGENCE<br />FOR DIFFICULT RESEARCH.<br />OPEN. EXPERIMENTAL. ALIVE.<br /><span>—</span><br />REAL PROBLEMS<br />A STRANGER TOMORROW.</div>
      <div className="swarm-field__bottom-copy"><span>ENVIRONMENTAL INPUT</span><span>SIGNAL PROCESSING</span><span>ADAPTIVE FILTERS</span></div>
    </div>
  );
}

function BranchCard({ branch, selected, onSelect }) {
  return (
    <button type="button" className={`swarm-branch ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(branch.id)} aria-pressed={selected}>
      <span className="swarm-branch__node" aria-hidden="true" />
      <span className="swarm-branch__heading"><b>{branch.index}</b><strong>{branch.name}</strong></span>
      <span className="swarm-branch__agents">{branch.agents} AGENTS</span>
      <span className="swarm-branch__details">{branch.detail}</span>
    </button>
  );
}

function BranchInspector({ branch, onSteer }) {
  return (
    <aside className="swarm-inspector" aria-label="Branch inspection">
      <div className="swarm-inspector__heading">
        <span>BRANCH <b>{branch.index}</b></span>
        <button type="button" aria-label="Expand branch inspection">↗</button>
        <h2>{branch.name}</h2>
      </div>
      <figure className="swarm-inspector__specimen">
        <img src="/assets/specimens/missions/planetary-lattice-fragment-v1.png" alt="" />
        <figcaption>BIOLOGICAL<br />INTERFACES<br />ENABLE<br />NEW FORMS<br />OF COGNITION.</figcaption>
      </figure>
      <dl className="swarm-inspector__rows">
        <div><dt>STATUS</dt><dd><StatusSignal status="active" label={branch.state} /></dd></div>
        <div><dt>ASSIGNMENT</dt><dd>{branch.assignment}</dd></div>
        <div><dt>AGENTS <b>{branch.agents}</b></dt><dd className="swarm-inspector__dots">{branch.members.map((member, index) => <i className={index < 3 ? 'is-active' : ''} key={member} aria-label={member} />)}</dd></div>
      </dl>
      <div className="swarm-inspector__members">
        {branch.members.map((member, index) => <div key={member}><span>{member}</span><strong>{['analyzing interface stability', 'running in-silico model', 'processing biological priors', 'testing adaptation pathways', 'evaluating failure modes', 'synthesizing evidence', 'drafting interim report'][index % 7]}</strong></div>)}
      </div>
      <div className="swarm-inspector__section"><h3>DEPENDENCIES</h3><p>→ 02 Memory Dynamics <span>(data)</span></p><p>→ 01 Sensory Adaptation <span>(methods)</span></p><p className="is-conflict">← 04 Social Coordination <span>(feedback)</span></p></div>
      <div className="swarm-inspector__section"><h3>EVIDENCE <b>{branch.evidence}</b></h3><p className="swarm-inspector__hypothesis">CURRENT HYPOTHESIS<br /><strong>{branch.hypothesis}</strong></p></div>
      <div className="swarm-inspector__actions"><button type="button" onClick={onSteer}>STEER</button><button type="button">PAUSE BRANCH</button></div>
    </aside>
  );
}

export default function SwarmPage() {
  const demo = useDemoState();
  const [selectedId, setSelectedId] = useState('interface');
  const selectedBranch = useMemo(() => branches.find((branch) => branch.id === selectedId) || branches[2], [selectedId]);

  const selectBranch = (id) => {
    setSelectedId(id);
    demo.setFocusedBranch(id);
    const agent = demo.state.agents.find((candidate) => candidate.branch === id);
    if (agent) demo.setSelectedAgent(agent.id);
  };

  return (
    <section className="swarm-page" aria-labelledby="swarm-title">
      <div className="swarm-page__heading">
        <div>
          <p className="swarm-page__kicker">AOS / BLACK ATLAS / ILLUSTRATIVE SURFACE</p>
          <h1 id="swarm-title">LIVE SWARM</h1>
        </div>
        <div className="swarm-page__objective"><span>GLOBAL OBJECTIVE</span><p>Understand adaptive mechanisms<br />of biological intelligence,<br />inform resilient synthetic agents.</p><b>—</b><span>EXPLORE<br />SYNTHESIZE<br />VALIDATE<br />ITERATE</span></div>
      </div>
      <div className="swarm-page__body">
        <aside className="swarm-metrics" aria-label="Swarm telemetry">
          <dl>
            <div><dt>TOTAL AGENTS</dt><dd>48</dd></div>
            <div><dt>ACTIVE</dt><dd>29 <i className="is-active" /></dd></div>
            <div><dt>IDLE</dt><dd>12 <i /></dd></div>
            <div><dt>BLOCKED</dt><dd>7 <i /></dd></div>
            <div><dt>RESEARCH BRANCHES</dt><dd>5</dd></div>
            <div><dt>COMPLETED TASKS</dt><dd>17</dd></div>
            <div><dt>GENERATED EVIDENCE</dt><dd>1,284</dd></div>
            <div><dt>UPTIME</dt><dd>03:42:17</dd></div>
          </dl>
          <figure className="swarm-metrics__specimen"><img src="/assets/specimens/missions/memory-substrate-fragment-v1.png" alt="" /><figcaption>SWARM INTELLIGENCE<br />EXPANDS<br />UNDERSTANDING.</figcaption></figure>
        </aside>
        <div className="swarm-page__field-wrap">
          <SwarmMap selectedId={selectedId} onSelect={selectBranch} />
          <div className="swarm-branches" aria-label="Research branches">
            {branches.map((branch) => <BranchCard key={branch.id} branch={branch} selected={selectedId === branch.id} onSelect={selectBranch} />)}
          </div>
        </div>
        <BranchInspector branch={selectedBranch} onSteer={() => demo.setFocusedBranch(`${selectedId}-steer`)} />
      </div>
      <div className="swarm-page__controls"><span>ZOOM <b>−</b><i /><i /><i /><i /><i /><i /><b>+</b></span><span>DEPTH 3 / 5</span><span>NODES 48</span><span>VIEW HIERARCHY</span><span className="swarm-page__legend"><i className="is-active" /> ACTIVE <i /> IDLE <i className="is-muted" /> BLOCKED <em>⋯</em> DEPENDENCY</span><span className="swarm-page__live"><i className="is-active" /> LIVE <small>00:00</small></span></div>
      <p className="swarm-page__state" role="status" aria-live="polite">FOCUS / {selectedBranch.name} · Illustrative state only</p>
    </section>
  );
}
