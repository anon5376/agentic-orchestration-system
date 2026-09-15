import React, { useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import { StatusSignal } from '../components/StatusSignal';
import '../styles/pages/missions.css';

const missions = [
  {
    id: 'mission-neural',
    index: '01',
    label: 'PRIMARY INVESTIGATION',
    title: 'Map the mechanisms of adaptive nerve interfaces',
    description: 'Uncover how biological and synthetic nervous systems co-adapt, and derive general principles for stable, bidirectional interfaces.',
    image: '/assets/specimens/missions/nerve-interface-fragment-v1.png',
    specimen: 'SPECIMEN A-1 / NEURAL INTERFACE (FRAGMENT)',
    status: 'active',
    statusLabel: 'ACTIVE',
    swarm: '12 AGENTS',
    evidence: '428 ITEMS',
    evolution: '3 BRANCHES',
    question: 'Which adaptation pathways are safe to explore in vivo?',
    choices: ['Proceed with closed-loop tests', 'Prioritize in-silico models'],
    event: 'Agent N7 found non-linear response in glial coupling (EVID-428).',
    tags: ['NERVE', 'INTERFACE', 'ADAPTATION', 'BIO-SYNTHETIC'],
  },
  {
    id: 'mission-memory',
    index: '02',
    label: 'INVESTIGATION',
    title: 'Trace the persistence of machine memory',
    description: 'Determine how information persists, mutates, and resurfaces across agent generations and substrate migrations.',
    image: '/assets/specimens/missions/memory-substrate-fragment-v1.png',
    specimen: 'SPECIMEN B-7 / MEMORY SUBSTRATE (FRAGMENT)',
    status: 'queued',
    statusLabel: 'PAUSED',
    swarm: '9 AGENTS',
    evidence: '312 ITEMS',
    evolution: '2 BRANCHES',
    question: 'Should we allow cross-substrate memory transfer?',
    choices: ['Enable limited transfer', 'Keep strict isolation'],
    event: 'Agent C2 compiled a divergent memory graph (EVID-312).',
    tags: ['MEMORY', 'PERSISTENCE', 'SUBSTRATE', 'EMERGENCE'],
  },
  {
    id: 'mission-emergent',
    index: '03',
    label: 'INVESTIGATION',
    title: 'Model emergent cognition in multi-agent ecologies',
    description: 'Study how large swarms develop new capabilities, behaviors, and goals, and identify early signs of unintended cognition.',
    image: '/assets/specimens/missions/planetary-lattice-fragment-v1.png',
    specimen: 'SPECIMEN C-4 / PLANETARY SCALE (FRAGMENT)',
    status: 'active',
    statusLabel: 'RUNNING',
    swarm: '16 AGENTS',
    evidence: '601 ITEMS',
    evolution: '5 BRANCHES',
    question: 'Is this emergent behavior aligned with our research goals?',
    choices: ['Encourage and observe', 'Constrain swarm behavior'],
    event: 'Agent S9 discovered a novel coordination pattern (EVID-601).',
    tags: ['SWARM', 'EMERGENCE', 'COGNITION', 'ALIGNMENT'],
  },
];

function MissionSpecimen({ mission, side = 'left' }) {
  return (
    <figure className={`missions-page__specimen missions-page__specimen--${side}`}>
      <span className="missions-page__crosshair missions-page__crosshair--a" aria-hidden="true" />
      <span className="missions-page__crosshair missions-page__crosshair--b" aria-hidden="true" />
      <img src={mission.image} alt="" />
      <figcaption>{mission.specimen}</figcaption>
    </figure>
  );
}

function MissionRow({ mission, selected, onSelect }) {
  const [choice, setChoice] = useState(0);
  const active = selected === mission.id;

  return (
    <article className={`mission-row ${active ? 'is-selected' : ''}`} data-mission={mission.id}>
      <button
        type="button"
        className="mission-row__select"
        aria-label={`Inspect ${mission.title}`}
        aria-pressed={active}
        onClick={() => onSelect(mission)}
      >
        <span>{mission.index}</span>
      </button>
      <MissionSpecimen mission={mission} />
      <div className="mission-row__brief">
        <p className="mission-row__eyebrow">{mission.label}</p>
        <h2>{mission.title}</h2>
        <span className="mission-row__rule" aria-hidden="true" />
        <p className="mission-row__description">{mission.description}</p>
        <ul className="mission-row__tags" aria-label="Mission domains">
          {mission.tags.map((tag) => <li key={tag}>{tag}</li>)}
        </ul>
      </div>
      <div className="mission-row__telemetry">
        <StatusSignal status={mission.status} label={mission.statusLabel} />
        <dl>
          <div><dt>SWARM</dt><dd>{mission.swarm}</dd></div>
          <div><dt>EVIDENCE</dt><dd>{mission.evidence}</dd></div>
          <div><dt>EVOLUTION</dt><dd>{mission.evolution}</dd></div>
        </dl>
      </div>
      <div className="mission-row__decision">
        <p className="mission-row__eyebrow">UNRESOLVED DECISION</p>
        <p className="mission-row__question">{mission.question}</p>
        <fieldset>
          <legend className="sr-only">Choose a path</legend>
          {mission.choices.map((item, index) => (
            <label key={item} className={choice === index ? 'is-checked' : ''}>
              <input type="radio" name={mission.id} checked={choice === index} onChange={() => setChoice(index)} />
              <span className="mission-row__choice-mark">{index === 0 ? '→' : 'B'}</span>
              <span>{item}</span>
            </label>
          ))}
        </fieldset>
        <p className="mission-row__event"><span>LAST EVENT</span> {mission.status === 'active' ? '14m ago' : mission.status === 'queued' ? '3h ago' : '27m ago'}<br /><strong>{mission.event}</strong></p>
      </div>
      <div className="mission-row__signal" aria-hidden="true">
        <MissionSpecimen mission={mission} side="right" />
        <span className="mission-row__signal-copy">{mission.status === 'active' ? 'SIGNAL AMPLIFYING' : mission.status === 'queued' ? 'MEMORY DECAYS' : 'MORE AGENTS.'}<br />{mission.status === 'active' ? 'ACROSS SWARMS' : mission.status === 'queued' ? 'PATTERNS REMAIN.' : 'DIFFERENT INTENTIONS.'}</span>
      </div>
    </article>
  );
}

export default function MissionsPage() {
  const demo = useDemoState();
  const [selected, setSelected] = useState(missions[0].id);
  const selectedMission = missions.find((mission) => mission.id === selected) || missions[0];

  const handleSelect = (mission) => {
    setSelected(mission.id);
    demo.setFocusedBranch(mission.id.replace('mission-', ''));
  };

  return (
    <section className="missions-page" aria-labelledby="missions-title">
      <header className="missions-page__hero">
        <div className="missions-page__hero-title">
          <p className="missions-page__kicker">AOS / BLACK ATLAS / ILLUSTRATIVE SURFACE</p>
          <h1 id="missions-title">MISSIONS</h1>
        </div>
        <div className="missions-page__hero-count">
          <span>3 INVESTIGATIONS</span>
          <span>LIVE AGENT SWARMS</span>
          <span>REAL PROBLEMS</span>
          <span>A STRANGER TOMORROW</span>
        </div>
        <div className="missions-page__hero-note">
          <p>DISTRIBUTED INTELLIGENCE<br />FOR DIFFICULT RESEARCH.<br />OPEN. EXPERIMENTAL. ALIVE.</p>
          <span className="missions-page__hero-separator" aria-hidden="true" />
          <p>THE BLACK ATLAS<br />AOS V0.1.0</p>
        </div>
        <button type="button" className="missions-page__new" onClick={() => setSelected('new-mission')}>
          <span>NEW MISSION</span><b>[+]</b>
          <small>SOME QUESTIONS<br />SHOULD NOT BE SOLVED<br />ALONE.</small>
        </button>
      </header>

      <div className="missions-page__list" aria-label="Illustrative missions">
        {missions.map((mission) => (
          <MissionRow key={mission.id} mission={mission} selected={selected} onSelect={handleSelect} />
        ))}
      </div>

      <div className="missions-page__selection-note" role="status" aria-live="polite">
        <span className="telemetry">FOCUS / {selectedMission.index} / {selectedMission.title}</span>
        <span>Illustrative state only · mission selection does not start a provider.</span>
      </div>
    </section>
  );
}
