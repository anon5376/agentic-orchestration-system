import React, { useMemo, useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import '../styles/pages/evidence.css';

const evidenceCards = [
  {
    id: 'S01', kind: 'PAPER', source: 'ARXIV: 2409.1187', domain: 'paper', year: '2024', type: 'source',
    title: 'Homeostatic Plasticity Enables Stable Multi-Agent Coupling',
    body: '“Adaptive feedback maintains stable coordination under distribution shift…”',
    meta: 'ADAPTIVE FEEDBACK / MAINTAINS STABILITY',
  },
  {
    id: 'S02', kind: 'SIMULATION', source: 'SIM-7731-A', domain: 'simulation', year: '2024', type: 'source',
    title: 'Swarm Dynamics Under Adaptive Feedback',
    body: 'Agents maintain coherence across perturbations in > 10⁴ steps.',
    meta: 'COHERENCE ↑', chart: 'stable',
  },
  {
    id: 'S03', kind: 'CONTRADICTION', source: 'N7-EXP-428', domain: 'experiment', year: '2023', type: 'contradiction',
    title: 'Delayed Feedback Induces Divergence',
    body: 'Under time-delayed feedback, agents exhibit increasing decoupling and collapse.',
    meta: 'DIVERGENT ↑', chart: 'divergent',
  },
  {
    id: 'S04', kind: 'EXPERIMENT', source: 'BIO-4120', domain: 'experiment', year: '2024', type: 'source',
    title: 'Neural Interface Adaptation in vitro',
    body: 'Cultured networks maintain functional coupling with adaptive stimulation.',
    meta: '100 μm', image: '/assets/specimens/missions/nerve-interface-fragment-v1.png',
  },
  {
    id: 'S05', kind: 'AGENT SYNTHESIS', source: 'AOS-SYN-014', domain: 'synthesis', year: '2024', type: 'source',
    title: 'Synthesis Across Sources',
    body: 'Integrates empirical and simulated results. Supports conditional stability.',
    meta: 'CONDITIONAL STABILITY', chart: 'network',
  },
];

const tabs = [
  { id: 'claims', label: 'CLAIMS' },
  { id: 'sources', label: 'SOURCES' },
  { id: 'contradictions', label: 'CONTRADICTIONS' },
];

function MiniChart({ variant = 'stable' }) {
  if (variant === 'network') {
    return (
      <svg className="evidence-card__chart evidence-card__chart--network" viewBox="0 0 210 105" aria-label="Illustrative synthesis network">
        {[[35,49,82,30],[35,49,90,74],[82,30,133,22],[82,30,153,62],[90,74,153,62],[153,62,188,40],[153,62,184,88]].map(([x1,y1,x2,y2]) => <line key={`${x1}-${y1}-${x2}-${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />)}
        {[[35,49],[82,30],[90,74],[133,22],[153,62],[188,40],[184,88]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" />)}
      </svg>
    );
  }
  const points = variant === 'divergent' ? '0,55 18,35 33,61 50,29 68,66 83,25 101,74 119,19 139,83 159,12 180,91 208,9' : '0,55 20,39 38,49 57,40 76,44 96,33 118,40 138,31 160,34 181,24 208,29';
  return (
    <svg className={`evidence-card__chart evidence-card__chart--${variant}`} viewBox="0 0 210 105" aria-label={`Illustrative ${variant} metric chart`}>
      <path d="M0 8V88H208" className="evidence-card__chart-axis" />
      <path d={`M${points}`} className="evidence-card__chart-line" />
      {variant === 'divergent' ? <path d="M0 53 C35 52 49 59 77 49 S115 67 142 56 S181 64 208 45" className="evidence-card__chart-line evidence-card__chart-line--secondary" /> : null}
    </svg>
  );
}

function EvidenceCard({ card, selected, onSelect }) {
  return (
    <button type="button" className={`evidence-card evidence-card--${card.type} ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(card)} aria-pressed={selected}>
      <span className="evidence-card__topline"><b>{card.id}</b><span>{card.kind}</span><small>{card.source}</small></span>
      <span className="evidence-card__body">
        <strong>{card.title}</strong>
        <i aria-hidden="true" />
        <span>{card.body}</span>
      </span>
      {card.image ? <img className="evidence-card__image" src={card.image} alt="" /> : null}
      {card.chart ? <MiniChart variant={card.chart} /> : null}
      <span className="evidence-card__meta"><small>SOURCE</small><small>{card.kind}</small><small>{card.year}</small><small>VIEW ↗</small></span>
      <span className="evidence-card__label">{card.meta}</span>
    </button>
  );
}

function EvidenceFilters({ tab, onTab, domain, onDomain, confidence, onConfidence, status, onStatus }) {
  return (
    <div className="evidence-filters">
      <nav className="evidence-tabs" aria-label="Evidence views">
        {tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'is-active' : ''} onClick={() => onTab(item.id)}>{item.label}</button>)}
      </nav>
      <div className="evidence-filter-row">
        <label>DOMAIN <select value={domain} onChange={(event) => onDomain(event.target.value)}><option value="all">ALL</option><option value="paper">PAPER</option><option value="simulation">SIMULATION</option><option value="experiment">EXPERIMENT</option><option value="synthesis">SYNTHESIS</option></select></label>
        <label>CONFIDENCE <select value={confidence} onChange={(event) => onConfidence(event.target.value)}><option value="all">ALL</option><option value="high">HIGH</option><option value="mixed">MIXED</option></select></label>
        <label>STATUS <select value={status} onChange={(event) => onStatus(event.target.value)}><option value="all">ALL</option><option value="supported">SUPPORTED</option><option value="open">OPEN</option><option value="conflict">CONFLICT</option></select></label>
      </div>
    </div>
  );
}

export default function EvidencePage() {
  const demo = useDemoState();
  const [tab, setTab] = useState('claims');
  const [domain, setDomain] = useState('all');
  const [confidence, setConfidence] = useState('all');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState('C01');

  const visibleCards = useMemo(() => evidenceCards.filter((card) => {
    if (domain !== 'all' && card.domain !== domain) return false;
    if (tab === 'contradictions' && card.type !== 'contradiction') return false;
    if (tab === 'claims' && card.type === 'contradiction' && status === 'supported') return false;
    if (status === 'conflict' && card.type !== 'contradiction') return false;
    if (status === 'supported' && card.type === 'contradiction') return false;
    return confidence === 'all' || (confidence === 'high' ? card.id === 'S01' || card.id === 'S05' : card.id === 'S02' || card.id === 'S03');
  }), [domain, tab, status, confidence]);

  const selectCard = (card) => {
    setSelectedId(card.id);
    demo.setActiveFilter(`${tab}:${card.id}`);
  };

  const changeTab = (next) => {
    setTab(next);
    demo.setActiveFilter(next);
    if (next === 'contradictions') setSelectedId('S03');
  };

  return (
    <section className="evidence-page" aria-labelledby="evidence-title">
      <header className="evidence-page__hero">
        <div className="evidence-page__hero-title">
          <p className="evidence-page__kicker">AOS / BLACK ATLAS / ILLUSTRATIVE SURFACE</p>
          <h1 id="evidence-title">EVIDENCE ATLAS</h1>
        </div>
        <p className="evidence-page__hero-copy">INSPECT CLAIMS.<br />TRACE EVIDENCE.<br />FIND CONTRADICTIONS.<br />CLOSE GAPS.</p>
        <div className="evidence-page__hero-stats"><b>428 ITEMS</b><b>12 CLAIMS</b><b>3 CONTRADICTIONS</b><span>—</span><span>THE BLACK ATLAS<br />AOS V0.1.0</span></div>
        <EvidenceFilters tab={tab} onTab={changeTab} domain={domain} onDomain={(next) => { setDomain(next); demo.setActiveFilter(`domain:${next}`); }} confidence={confidence} onConfidence={setConfidence} status={status} onStatus={setStatus} />
      </header>

      <div className="evidence-page__atlas">
        <svg className="evidence-page__connections" viewBox="0 0 1000 640" preserveAspectRatio="none" aria-hidden="true">
          <path d="M14 96 L330 286" /><path d="M986 96 L670 286" /><path d="M14 372 L330 320" /><path d="M986 372 L670 320" /><path d="M14 558 L330 360" /><path d="M986 558 L670 360" />
          <circle cx="330" cy="286" r="4" /><circle cx="670" cy="286" r="4" /><circle cx="330" cy="320" r="4" /><circle cx="670" cy="320" r="4" />
        </svg>
        <div className="evidence-page__plate evidence-page__plate--s01">{visibleCards.some((card) => card.id === 'S01') ? <EvidenceCard card={evidenceCards[0]} selected={selectedId === 'S01'} onSelect={selectCard} /> : null}</div>
        <section className="evidence-page__hypothesis"><span>HYPOTHESIS</span><p>FEEDBACK LOOPS<br />ALLOW AGENTS TO<br />MAINTAIN COUPLING<br />ACROSS<br />PERTURBATIONS.</p><b>+</b></section>
        <div className="evidence-page__plate evidence-page__plate--s02">{visibleCards.some((card) => card.id === 'S02') ? <EvidenceCard card={evidenceCards[1]} selected={selectedId === 'S02'} onSelect={selectCard} /> : null}</div>
        <div className="evidence-page__plate evidence-page__plate--s03">{visibleCards.some((card) => card.id === 'S03') ? <EvidenceCard card={evidenceCards[2]} selected={selectedId === 'S03'} onSelect={selectCard} /> : null}</div>
        <article className={`evidence-claim ${selectedId === 'C01' ? 'is-selected' : ''}`}>
          <span className="evidence-claim__topline"><b>C01</b><span>CLAIM</span><small>CONFIDENCE <strong>0.62</strong></small></span>
          <h2>Adaptive feedback stabilizes long-term coupling.</h2>
          <div className="evidence-claim__tags"><span>COUPLING</span><span>ADAPTATION</span><span>STABILITY</span><span>MULTI-AGENT</span></div>
        </article>
        <div className="evidence-page__gap-note"><span>MISSING EVIDENCE</span><b>—</b><p>// LONG-TERM REAL-WORLD VALIDATION<br />// SCALING TO HETEROGENEOUS AGENTS<br />// BOUNDARIES OF STABILITY<br />// EFFECTS OF SENSOR NOISE</p></div>
        <div className="evidence-page__plate evidence-page__plate--s04">{visibleCards.some((card) => card.id === 'S04') ? <EvidenceCard card={evidenceCards[3]} selected={selectedId === 'S04'} onSelect={selectCard} /> : null}</div>
        <div className="evidence-page__plate evidence-page__plate--s05">{visibleCards.some((card) => card.id === 'S05') ? <EvidenceCard card={evidenceCards[4]} selected={selectedId === 'S05'} onSelect={selectCard} /> : null}</div>
        <aside className="evidence-page__contradiction"><b>UNRESOLVED</b><p>CONTRADICTS CORE CLAIM.<br />DIFFERENT CONDITIONS<br />OR REAL EFFECT?</p></aside>
        <figure className="evidence-page__specimen"><img src="/assets/specimens/evidence/faceless-coupled-section-v1.png" alt="Illustrative coupled neural section" /><figcaption><span>SPECIMEN C-9</span><br />NEURAL COUPLING<br />(SECTION)<br /><br /><i>SCALE 2 mm</i><br /><br />DISTRIBUTED<br />EVIDENCE.<br />SHARPER<br />QUESTIONS.</figcaption></figure>
      </div>

      <div className="evidence-page__state" role="status" aria-live="polite"><span>VIEW / {tab.toUpperCase()} · FILTER / {domain.toUpperCase()} · SELECTED / {selectedId}</span><span>Illustrative state only · source records are not connected.</span></div>
    </section>
  );
}
