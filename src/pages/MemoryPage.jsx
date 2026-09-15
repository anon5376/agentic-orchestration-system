import React, { useMemo, useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import '../styles/pages/memory.css';

const layers = [
  {
    id: 'global', number: '01', title: 'GLOBAL MEMORY', subtitle: 'CORE KNOWLEDGE  •  CROSS-PROJECT', count: '1,248 ITEMS', description: 'SHARED KNOWLEDGE FOUNDATION (CURATED)', access: ['INHERIT TO PROJECTS', 'SENSITIVE (RESTRICTED)'], items: [['alignment_principles.md', 'AOS', 'NEVER'], ['safety_constraints.md', 'AOS', 'NEVER'], ['architectural_patterns.md', 'AOS', 'NEVER'], ['tool_capabilities.md', 'AOS', 'NEVER'], ['prior_research_summaries.md', 'AOS', '2026-01-01']],
  },
  {
    id: 'project', number: '02', title: 'PROJECT MEMORY', subtitle: 'MISSION-SPECIFIC  •  ISOLATED', count: '428 ITEMS', description: 'MISSION CONTEXT AND ASSETS (ISOLATED)', access: ['INHERIT TO AGENTS', 'READ FROM GLOBAL', 'BLOCK EXTERNAL EXPORT'], items: [['project_brief.md', 'user', '2025-12-01'], ['experimental_results.csv', 'agent', '2025-11-20'], ['design_notes.md', 'user', '2025-11-15'], ['open_questions.md', 'agent', '2025-12-01'], ['meeting_summary.md', 'user', '2025-11-10']],
  },
  {
    id: 'agent', number: '03', title: 'AGENT MEMORY', subtitle: 'WORKING CONTEXT  •  TEMPORARY', count: '137 ITEMS', description: 'EPHEMERAL WORKING MEMORY (TEMPORARY)', access: ['READ FROM PROJECT', 'DO NOT PERSIST TO GLOBAL', 'ISOLATED BY DEFAULT'], items: [['current_task.md', 'runtime', '2025-11-08'], ['intermediate_plan.md', 'agent', '2025-11-08'], ['tool_output.md', 'runtime', '2025-11-08'], ['reasoning_trace.md', 'agent', '2025-11-08'], ['draft_response.md', 'runtime', '2025-11-08']],
  },
];

const policies = [
  { id: 'file', icon: '▱', name: 'FILE ACCESS', detail: 'Read/write workspace files', state: 'ALLOWED', source: 'Project', inherits: 'Global' },
  { id: 'network', icon: '◎', name: 'NETWORK', detail: 'Internet and external APIs', state: 'RESTRICTED', source: 'Global', inherits: 'Global' },
  { id: 'actions', icon: '↗', name: 'EXTERNAL ACTIONS', detail: 'Run commands, trigger tools', state: 'ALLOWED', source: 'Project', inherits: 'Global' },
  { id: 'improvement', icon: '↑', name: 'SELF-IMPROVEMENT', detail: 'Modify own code or behavior', state: 'APPROVAL REQUIRED', source: 'Global', inherits: 'Global' },
  { id: 'retention', icon: '◉', name: 'RETENTION', detail: 'How long to keep memory', state: 'PROJECT RULE', source: 'Project', inherits: 'Global' },
  { id: 'audit', icon: '⌕', name: 'AUDIT', detail: 'Log and review memory activity', state: 'ENABLED', source: 'Global', inherits: 'Global' },
];

function AssetImage({ source, fallback, alt, className }) {
  const [current, setCurrent] = useState(source);
  return <img className={className} src={current} alt={alt} onError={() => current !== fallback && setCurrent(fallback)} />;
}

function MemorySpecimen({ activeLayer }) {
  return (
    <figure className="memory-specimen">
      <div className="memory-specimen__crosshair memory-specimen__crosshair--one" aria-hidden="true" />
      <div className="memory-specimen__crosshair memory-specimen__crosshair--two" aria-hidden="true" />
      <div className="memory-specimen__image">
        <AssetImage source="/assets/specimens/memory-layers.png" fallback="/assets/specimens/synthesis/split-dual-head-organism-v1.png" alt="Sliced layered research memory specimen" />
        <span className={`memory-specimen__slice memory-specimen__slice--global ${activeLayer === 'global' ? 'is-active' : ''}`} />
        <span className={`memory-specimen__slice memory-specimen__slice--project ${activeLayer === 'project' ? 'is-active' : ''}`} />
        <span className={`memory-specimen__slice memory-specimen__slice--agent ${activeLayer === 'agent' ? 'is-active' : ''}`} />
      </div>
      <figcaption><span>SUBJECT A-0<br />MEMORY STRATA</span><span>CONTEXT<br />LIVES IN LAYERS<br />NOT IN LINES.</span></figcaption>
    </figure>
  );
}

function MemoryLayer({ layer, active, onSelect }) {
  return (
    <article className={`memory-layer ${active ? 'is-active' : ''}`}>
      <button type="button" className="memory-layer__head" onClick={onSelect} aria-expanded={active}>
        <span><strong>{layer.title}</strong><small>{layer.subtitle}</small></span><b>{layer.count}</b>
      </button>
      <div className="memory-layer__body">
        <div className="memory-layer__table-head"><span>FRAGMENT</span><span>SOURCE</span><span>EXPIRY</span></div>
        {layer.items.map(([name, source, expiry]) => <div className="memory-layer__row" key={name}><span><i>▤</i>{name}</span><span>{source}</span><span>{expiry}</span></div>)}
        <div className="memory-layer__paths"><span>ACCESS PATHS</span>{layer.access.map((path, index) => <b key={path} className={index === layer.access.length - 1 ? 'is-blocked' : ''}>{index === layer.access.length - 1 ? '×' : '↑'} {path}</b>)}</div>
      </div>
    </article>
  );
}

function PolicyLedger({ selected, onSelect }) {
  return (
    <section className="policy-ledger">
      <header><h2>POLICY LEDGER</h2><span className="telemetry">EFFECTIVE NOW</span></header>
      <div className="policy-ledger__list">
        {policies.map((policy) => <button type="button" className={`policy-row ${selected === policy.id ? 'is-selected' : ''}`} key={policy.id} onClick={() => onSelect(policy.id)} aria-pressed={selected === policy.id}><span className="policy-row__icon">{policy.icon}</span><span className="policy-row__copy"><strong>{policy.name}</strong><small>{policy.detail}</small></span><span className="policy-row__state"><strong>{policy.state}</strong><small>Source: {policy.source}<br />Inherits: {policy.inherits}</small></span></button>)}
      </div>
      <footer><button type="button" onClick={() => onSelect('edit')}>EDIT POLICY</button><button type="button" onClick={() => onSelect('preview')}>PREVIEW EFFECTIVE ACCESS</button><button type="button" onClick={() => onSelect('audit')}>VIEW AUDIT</button></footer>
    </section>
  );
}

export default function MemoryPage() {
  const { state } = useDemoState();
  const [activeLayer, setActiveLayer] = useState('project');
  const [selectedPolicy, setSelectedPolicy] = useState('improvement');
  const [notice, setNotice] = useState('AUTO-IMPROVEMENT: APPROVAL REQUIRED');
  const selected = useMemo(() => policies.find((policy) => policy.id === selectedPolicy), [selectedPolicy]);
  const selectPolicy = (id) => {
    setSelectedPolicy(id);
    const policy = policies.find((item) => item.id === id);
    setNotice(policy ? `${policy.name}: ${policy.state}` : `${id.toUpperCase()} / LOCAL PREVIEW`);
  };

  return (
    <div className="memory-page" data-active-layer={activeLayer}>
      <header className="memory-hero">
        <div><p className="memory-kicker">AOS / CONTEXT CONTROL / {state.run.id}</p><h1>MEMORY &amp; POLICIES</h1></div>
        <p className="memory-hero__thesis">WHAT THE SWARM<br />MAY REMEMBER<br /><span>CONTEXT WITH BOUNDARIES.<br />USEFUL PERSISTENCE.<br />ALIGNED EVOLUTION.</span></p>
        <div className="memory-hero__context"><p>MEMORY SHAPES BEHAVIOR.<br />POLICY PRESERVES TRUST.</p><span /><p>THE BLACK ATLAS<br />AOS v0.1.0</p></div>
        <div className="memory-hero__decision"><strong>{notice}</strong><p>MORE CAPABILITY<br />SHOULD NOT MEAN<br />LESS CONTROL.</p></div>
      </header>

      <main className="memory-field">
        <MemorySpecimen activeLayer={activeLayer} />
        <section className="memory-layers" aria-label="Memory inheritance layers">
          {layers.map((layer) => <MemoryLayer key={layer.id} layer={layer} active={activeLayer === layer.id} onSelect={() => setActiveLayer(layer.id)} />)}
        </section>
        <PolicyLedger selected={selectedPolicy} onSelect={selectPolicy} />
      </main>

      <section className="memory-status" aria-live="polite"><span><i /> ACTIVE LAYER / {activeLayer.toUpperCase()}</span><strong>{selected ? `${selected.name} / ${selected.state}` : notice}</strong><small>RETENTION {state.memory.retention} · INHERITANCE {state.memory.inheritance}</small></section>
    </div>
  );
}
