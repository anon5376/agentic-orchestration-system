import React, { useState } from 'react';
import { useDemoState } from '../app/DemoContext';
import { DocketFigure } from '../components/DocketFigure';

const researchRuns = [
  {
    id: 'adaptive-interfaces',
    title: 'Adaptive nerve interfaces',
    question: 'Which feedback conditions support stable, bidirectional adaptation?',
    status: 'In review',
    updated: '12 min ago',
    agents: 12,
    sources: 48,
    note: 'One boundary condition still needs an independent check.',
  },
  {
    id: 'machine-memory',
    title: 'Persistence of machine memory',
    question: 'What survives when context moves between workers and substrates?',
    status: 'Paused',
    updated: '3 hr ago',
    agents: 9,
    sources: 31,
    note: 'Waiting for a narrower definition of persistence.',
  },
  {
    id: 'agent-ecologies',
    title: 'Coordination in agent ecologies',
    question: 'When does delegation improve work, and when does it add noise?',
    status: 'Running',
    updated: '27 min ago',
    agents: 16,
    sources: 22,
    note: 'A new coordination pattern was reproduced by two branches.',
  },
];

const branchData = [
  { id: 'lead', name: 'Lead synthesis', owner: 'Ari', status: 'Working', children: ['Mechanism', 'Evidence', 'Adversarial review'] },
  { id: 'mechanism', name: 'Mechanism', owner: 'Mina', status: 'Complete', children: ['Material response', 'Signal timing'] },
  { id: 'evidence', name: 'Evidence', owner: 'Theo', status: 'Working', children: ['Primary sources', 'Source lineage'] },
  { id: 'adversarial', name: 'Adversarial review', owner: 'Nora', status: 'Blocked', children: ['Boundary conditions'] },
];

const sourceData = [
  { id: 'S-18', title: 'Closed-loop adaptation in peripheral interfaces', kind: 'Paper', year: '2024', confidence: 'High', relation: 'Supports' },
  { id: 'S-11', title: 'Delayed feedback and coupling instability', kind: 'Experiment', year: '2023', confidence: 'High', relation: 'Challenges' },
  { id: 'S-07', title: 'Adaptive stimulation across cultured networks', kind: 'Dataset', year: '2024', confidence: 'Medium', relation: 'Supports' },
  { id: 'S-03', title: 'Review of bio-synthetic interface stability', kind: 'Review', year: '2022', confidence: 'Medium', relation: 'Context' },
];

function PageHeader({ title, description, action, onAction, context = 'Current research', figure }) {
  return (
    <header className={`docket-header docket-header--${figure}`}>
      <div>
        <p className="docket-context">{context}</p>
        <h1>{title}</h1>
      </div>
      <div className="docket-header__aside">
        <p>{description}</p>
        {action ? <button type="button" className="docket-button docket-button--primary" onClick={onAction}>{action}</button> : null}
      </div>
      <DocketFigure variant={figure} />
    </header>
  );
}

function State({ children, tone = 'neutral' }) {
  return <span className={`docket-state docket-state--${tone}`}>{children}</span>;
}

function SectionHeading({ title, note }) {
  return <div className="docket-section-heading"><h2>{title}</h2>{note ? <p>{note}</p> : null}</div>;
}

function DefinitionList({ items }) {
  return <dl className="docket-definitions">{items.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>;
}

export function MissionsPage({ onNavigate }) {
  const demo = useDemoState();
  const [selectedId, setSelectedId] = useState(researchRuns[0].id);
  const selected = researchRuns.find((run) => run.id === selectedId) || researchRuns[0];

  const selectRun = (run) => {
    setSelectedId(run.id);
    demo.setFocusedBranch(run.id);
  };

  return (
    <div className="docket-page docket-page--missions">
      <PageHeader title="Research runs" description="Questions currently being decomposed, checked, and brought back together." action="New research" onAction={() => onNavigate('/intake')} figure="missions" />
      <div className="docket-split docket-split--wide">
        <section>
          <SectionHeading title="Open work" note="Illustrative state" />
          <div className="run-list">
            {researchRuns.map((run) => (
              <button type="button" className={`run-row ${selectedId === run.id ? 'is-selected' : ''}`} key={run.id} onClick={() => selectRun(run)} aria-pressed={selectedId === run.id}>
                <span className="run-row__main"><strong>{run.title}</strong><span>{run.question}</span></span>
                <span className="run-row__facts"><State tone={run.status === 'Running' ? 'active' : run.status === 'Paused' ? 'quiet' : 'review'}>{run.status}</State><small>{run.updated}</small></span>
              </button>
            ))}
          </div>
        </section>
        <aside className="docket-note" aria-label="Selected research run">
          <p className="docket-context">Selected run</p>
          <h2>{selected.title}</h2>
          <p className="docket-note__question">{selected.question}</p>
          <DefinitionList items={[["Workers", selected.agents], ["Sources", selected.sources], ["Updated", selected.updated]]} />
          <div className="docket-note__callout"><span>Needs attention</span><p>{selected.note}</p></div>
          <button type="button" className="docket-link" onClick={() => { demo.setFocusedBranch(selected.id); onNavigate('/swarm'); }}>Open run →</button>
        </aside>
      </div>
    </div>
  );
}

export function IntakePage({ onNavigate }) {
  const demo = useDemoState();
  const [objective, setObjective] = useState('Understand how biological and synthetic nervous systems adapt at their interface, and identify conditions for stable two-way signalling.');
  const [interpreted, setInterpreted] = useState(false);
  const [files, setFiles] = useState(['interface-studies.pdf', 'response-series.csv', 'project-notes.md']);

  const interpret = () => {
    setInterpreted(true);
    demo.setFocusedBranch('intake-ready');
  };

  return (
    <div className="docket-page docket-page--intake">
      <PageHeader title="Start with a question" description="AOS turns an objective and its source material into a reviewable research plan." context="New research" figure="intake" />
      <div className="docket-split">
        <section className="docket-form">
          <label htmlFor="research-question">Research objective</label>
          <textarea id="research-question" value={objective} onChange={(event) => setObjective(event.target.value)} />
          <div className="source-list__header"><span>Context</span><button type="button" className="docket-link" onClick={() => setFiles((current) => [...current, `context-${current.length + 1}.txt`])}>Add file</button></div>
          <ul className="source-list source-list--compact">
            {files.map((file) => <li key={file}><span>{file}</span><button type="button" aria-label={`Remove ${file}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))}>Remove</button></li>)}
          </ul>
          <button type="button" className="docket-button docket-button--primary" onClick={interpret}>Prepare research plan</button>
          <p className="form-note">Prototype only. Files are represented locally and are not uploaded.</p>
        </section>
        <aside className={`interpretation ${interpreted ? 'is-ready' : ''}`}>
          <SectionHeading title="Working interpretation" note={interpreted ? 'Ready for review' : 'Draft'} />
          <p className="interpretation__summary">Study the mechanisms, limits, and failure conditions of adaptive coupling across biological and synthetic interfaces.</p>
          <DefinitionList items={[["Include", "Peripheral nerve interfaces, adaptive stimulation, bidirectional signalling"], ["Exclude", "Clinical deployment and human trials"], ["Success", "A mechanism with testable predictions and explicit uncertainty"]]} />
          <div className="question-list"><h3>Questions to resolve</h3><ol><li>Which feedback variables drive adaptation?</li><li>Where does coupling become unstable?</li><li>Which findings replicate across methods?</li></ol></div>
          {interpreted ? <button type="button" className="docket-button docket-button--primary" onClick={() => onNavigate('/swarm')}>Open work plan</button> : null}
        </aside>
      </div>
    </div>
  );
}

export function SwarmPage() {
  const demo = useDemoState();
  const [selectedId, setSelectedId] = useState('lead');
  const [steerNotice, setSteerNotice] = useState('4 branches · 12 workers');
  const selected = branchData.find((branch) => branch.id === selectedId) || branchData[0];
  const workers = demo.state.agents.filter((agent) => selectedId === 'lead' || agent.branch === selectedId || agent.branch === 'root');

  const selectBranch = (id) => {
    setSelectedId(id);
    demo.setFocusedBranch(id);
  };

  const steerBranch = () => {
    demo.setFocusedBranch(`${selectedId}:steered`);
    setSteerNotice(`${selected.name} marked for steering`);
  };

  return (
    <div className="docket-page docket-page--swarm">
      <PageHeader title="Work in progress" description="A readable hierarchy of responsibility. Dependencies and execution history stay separate." action="Steer selected branch" onAction={steerBranch} figure="swarm" />
      <div className="swarm-layout">
        <section className="branch-outline">
          <SectionHeading title="Research structure" note={steerNotice} />
          <ul>
            {branchData.map((branch) => <li key={branch.id}><button type="button" className={selectedId === branch.id ? 'is-selected' : ''} onClick={() => selectBranch(branch.id)} aria-pressed={selectedId === branch.id}><span className="branch-line"><i /><strong>{branch.name}</strong></span><State tone={branch.status === 'Complete' ? 'complete' : branch.status === 'Blocked' ? 'warning' : 'active'}>{branch.status}</State></button>{selectedId === branch.id ? <ul>{branch.children.map((child) => <li key={child}>{child}</li>)}</ul> : null}</li>)}
          </ul>
        </section>
        <section className="branch-detail">
          <p className="docket-context">Selected branch</p>
          <h2>{selected.name}</h2>
          <p>{selected.id === 'lead' ? 'Reconcile the mechanism, evidence, and adversarial branches into one bounded conclusion.' : `Complete the ${selected.name.toLowerCase()} work and return evidence to the lead.`}</p>
          <DefinitionList items={[["Owner", selected.owner], ["Status", selected.status], ["Depends on", selected.id === 'lead' ? 'All research branches' : 'Lead synthesis'], ["Workspace", `branch/${selected.id}`]]} />
          <div className="branch-next"><span>Next handoff</span><p>{selected.id === 'adversarial' ? 'Needs a source that tests delayed feedback under the same conditions.' : 'Return a concise finding with source lineage and known limits.'}</p></div>
        </section>
        <aside className="worker-list">
          <SectionHeading title="Workers" note={`${workers.length} shown`} />
          {workers.map((agent) => <button type="button" key={agent.id} onClick={() => demo.setSelectedAgent(agent.id)}><span><i className={`presence presence--${agent.status}`} />{agent.name}</span><small>{agent.role}</small></button>)}
        </aside>
      </div>
    </div>
  );
}

export function EvidencePage() {
  const demo = useDemoState();
  const [filter, setFilter] = useState('All');
  const [selectedId, setSelectedId] = useState('S-18');
  const [showProvenance, setShowProvenance] = useState(false);
  const filters = ['All', 'Supports', 'Challenges', 'Context'];
  const sources = sourceData.filter((source) => filter === 'All' || source.relation === filter);
  const selected = sourceData.find((source) => source.id === selectedId) || sourceData[0];

  const selectSource = (source) => {
    setSelectedId(source.id);
    setShowProvenance(false);
    demo.setActiveFilter(source.id);
  };

  return (
    <div className="docket-page docket-page--evidence">
      <PageHeader title="Evidence" description="Sources are organised around the claim they support, challenge, or qualify." figure="evidence" />
      <div className="filter-row" role="group" aria-label="Evidence relation">
        {filters.map((item) => <button type="button" className={filter === item ? 'is-active' : ''} key={item} onClick={() => setFilter(item)} aria-pressed={filter === item}>{item}</button>)}
      </div>
      <div className="docket-split docket-split--wide">
        <section>
          <SectionHeading title="Source record" note={`${sources.length} visible`} />
          <div className="evidence-list">
            {sources.map((source) => <button type="button" className={selectedId === source.id ? 'is-selected' : ''} key={source.id} onClick={() => selectSource(source)} aria-pressed={selectedId === source.id}><span className="evidence-list__id">{source.id}</span><span><strong>{source.title}</strong><small>{source.kind} · {source.year}</small></span><State tone={source.relation === 'Challenges' ? 'warning' : source.relation === 'Supports' ? 'complete' : 'quiet'}>{source.relation}</State></button>)}
          </div>
        </section>
        <aside className="docket-note">
          <p className="docket-context">Selected source</p>
          <h2>{selected.title}</h2>
          <DefinitionList items={[["Record", selected.id], ["Type", selected.kind], ["Confidence", selected.confidence], ["Relation", selected.relation]]} />
          <div className="docket-note__callout"><span>Current reading</span><p>{selected.relation === 'Challenges' ? 'Delayed feedback appears to destabilise coupling. The conditions do not yet match the supporting studies.' : 'The result is consistent with conditional stability, but does not establish long-term performance.'}</p></div>
          <button type="button" className="docket-link" onClick={() => setShowProvenance((shown) => !shown)}>{showProvenance ? 'Hide provenance' : 'View provenance →'}</button>
          {showProvenance ? <p className="provenance-note" role="status">Imported from the illustrative project source index. Record → extraction → claim linkage is intact.</p> : null}
        </aside>
      </div>
    </div>
  );
}

export function SynthesisPage() {
  const { state, setDecision } = useDemoState();
  const [notice, setNotice] = useState('No decision recorded');
  const choose = (value, label) => {
    setDecision(value);
    setNotice(label);
  };

  return (
    <div className="docket-page docket-page--decision" data-decision={state.decision}>
      <PageHeader title="Decision" description="The current conclusion, the objection that limits it, and the next useful move." context="Adaptive nerve interfaces" figure="synthesis" />
      <main className="decision-layout">
        <section className="decision-main">
          <p className="docket-context">Provisional conclusion</p>
          <h2>Adaptive feedback can stabilise bidirectional signal transfer under bounded timing conditions.</h2>
          <p className="decision-summary">Evidence from simulation, cultured networks, and interface studies converges on conditional stability. It does not yet support a claim of long-term stability in vivo.</p>
          <div className="decision-confidence"><span>Confidence</span><strong>Moderate</strong><div><i style={{ width: '68%' }} /></div></div>
        </section>
        <aside className="decision-objection">
          <p className="docket-context">What prevents closure</p>
          <h2>Long-term stability is untested under matched conditions.</h2>
          <p>A longer experiment must preserve the same interface material, timing window, and signal load used by the supporting studies.</p>
          <DefinitionList items={[["Evidence gap", "Long-duration matched experiment"], ["Owner", "Adversarial review"], ["Estimate", "2 research cycles"]]} />
        </aside>
      </main>
      <section className="check-list">
        <SectionHeading title="Review checks" note={notice} />
        <div><span><strong>Mechanism</strong><small>Consistent across the strongest sources</small></span><State tone="complete">Pass</State></div>
        <div><span><strong>Adversarial</strong><small>One plausible failure condition remains open</small></span><State tone="warning">Open</State></div>
        <div><span><strong>Provenance</strong><small>All current claims resolve to source records</small></span><State tone="complete">Pass</State></div>
      </section>
      <div className="decision-actions">
        <button type="button" className="docket-button docket-button--primary" onClick={() => choose('continue', 'Missing experiment queued')}>Continue research</button>
        <button type="button" className="docket-button docket-button--quiet" onClick={() => choose('restructure', 'Swarm structure marked for review')}>Change the plan</button>
        <button type="button" className="docket-link" onClick={() => choose('complete', 'Recorded as inconclusive')}>Close as inconclusive</button>
      </div>
    </div>
  );
}

export function EvolutionPage() {
  const { state, setDecision } = useDemoState();
  const [result, setResult] = useState('Awaiting review');
  const adopt = () => { setDecision('adopt'); setResult('Adoption queued after safety checks'); };

  return (
    <div className="docket-page docket-page--review">
      <PageHeader title="Run review" description="A specific failure, a proposed change, and the evidence for or against adopting it." context={state.run.id} figure="evolution" />
      <div className="review-statement">
        <p className="docket-context">Observed problem</p>
        <h2>Workers kept exploring low-information branches after the result stopped changing.</h2>
      </div>
      <div className="review-grid">
        <section><SectionHeading title="Proposed change" /><p>Stop a branch when uncertainty remains high and no new information appears for five consecutive steps.</p><pre>{`if uncertainty > 0.75\nand steps_without_gain > 5:\n    end_branch()`}</pre></section>
        <section><SectionHeading title="Evaluation" /><DefinitionList items={[["Tasks", "100 held-out research prompts"], ["Success", "62% → 78%"], ["Median latency", "4.2s → 2.9s"], ["Regression", "−3% on adversarial prompts"]]} /></section>
        <aside><SectionHeading title="Recommendation" note={result} /><p>Adopt only after expanding the adversarial set and confirming the rollback path.</p><button type="button" className="docket-button docket-button--primary" onClick={adopt}>Adopt after checks</button><button type="button" className="docket-link" onClick={() => setResult('More evaluation requested')}>Run more evaluation</button></aside>
      </div>
    </div>
  );
}

export function CapabilitiesPage() {
  const { state } = useDemoState();
  const [selectedId, setSelectedId] = useState(state.capabilities[0].id);
  const [notice, setNotice] = useState('');
  const selected = state.capabilities.find((item) => item.id === selectedId) || state.capabilities[0];
  const connections = [
    { id: 'cap-codex', name: 'Codex', category: 'Worker', detail: '4 of 8 slots available', state: 'Connected' },
    { id: 'cap-claude', name: 'Claude Code', category: 'Worker', detail: '2 of 4 slots available', state: 'Connected' },
    { id: 'cap-mcp', name: 'Source index', category: 'MCP server', detail: 'Read-only research records', state: 'Needs attention' },
    { id: 'cap-local', name: 'Local model', category: 'Worker', detail: 'Not assigned to this run', state: 'Standby' },
    { id: 'cap-files', name: 'Workspace files', category: 'Tool', detail: 'Project-scoped access', state: 'Connected' },
    { id: 'cap-web', name: 'Web research', category: 'Tool', detail: 'Approval follows project policy', state: 'Connected' },
  ];

  return (
    <div className="docket-page docket-page--connections">
      <PageHeader title="Connections" description="Workers and tools available to this project. Configuration stays separate from live research." action="Inspect standby" onAction={() => { setSelectedId('cap-local'); setNotice('Local model selected'); }} figure="capabilities" />
      <div className="docket-split docket-split--wide">
        <section>
          <SectionHeading title="Available to this project" note="Illustrative" />
          <div className="connection-list">
            {connections.map((item) => <button type="button" className={selectedId === item.id ? 'is-selected' : ''} key={item.id} onClick={() => { setSelectedId(item.id); setNotice(''); }} aria-pressed={selectedId === item.id}><span><strong>{item.name}</strong><small>{item.category}</small></span><span>{item.detail}</span><State tone={item.state === 'Connected' ? 'complete' : item.state === 'Needs attention' ? 'warning' : 'quiet'}>{item.state}</State></button>)}
          </div>
        </section>
        <aside className="docket-note">
          <p className="docket-context">Selected connection</p>
          <h2>{connections.find((item) => item.id === selectedId)?.name || selected.name}</h2>
          <DefinitionList items={[["Status", connections.find((item) => item.id === selectedId)?.state || selected.state], ["Scope", "This project"], ["Credentials", "Not configured in this prototype"], ["Last check", "2 min ago"]]} />
          <button type="button" className="docket-button docket-button--quiet" onClick={() => setNotice(`Configuration opened for ${connections.find((item) => item.id === selectedId)?.name || selected.name}`)}>Configure</button>
          {notice ? <p className="form-note action-notice" role="status">{notice}. Prototype only; no credentials are requested.</p> : null}
        </aside>
      </div>
    </div>
  );
}

export function MemoryPage() {
  const { state } = useDemoState();
  const [scope, setScope] = useState('Project');
  const [policy, setPolicy] = useState('Self-improvement');
  const [notice, setNotice] = useState('');
  const scopes = [
    { name: 'Global', detail: 'Shared principles and reusable knowledge', count: state.memory.global },
    { name: 'Project', detail: 'Research brief, sources, and accepted findings', count: state.memory.project },
    { name: 'Worker', detail: 'Temporary task context and intermediate output', count: state.memory.agent },
  ];

  return (
    <div className="docket-page docket-page--memory">
      <PageHeader title="Memory & policy" description="What this project can retain, inherit, and change." figure="memory" />
      <div className="memory-layout">
        <section>
          <SectionHeading title="Memory scopes" note="Select a scope to inspect" />
          <div className="scope-list">{scopes.map((item) => <button type="button" className={scope === item.name ? 'is-selected' : ''} key={item.name} onClick={() => setScope(item.name)} aria-pressed={scope === item.name}><span><strong>{item.name}</strong><small>{item.detail}</small></span><b>{item.count}</b></button>)}</div>
          <div className="scope-detail"><p className="docket-context">{scope} memory</p><h2>{scope === 'Project' ? 'The active research record' : scope === 'Global' ? 'Knowledge shared across projects' : 'Context held for the current task'}</h2><p>{scope === 'Worker' ? 'Discarded when the assignment ends unless a reviewed finding is promoted.' : 'Inheritance follows explicit project rules and remains visible in the audit history.'}</p></div>
        </section>
        <aside>
          <SectionHeading title="Project policies" note={`Selected: ${policy}`} />
          <div className="policy-list">
            {['File access', 'Network access', 'External actions', 'Self-improvement', 'Retention', 'Audit history'].map((item) => <button type="button" className={policy === item ? 'is-selected' : ''} key={item} onClick={() => { setPolicy(item); setNotice(''); }} aria-pressed={policy === item}><span>{item}</span><State tone={item === 'Self-improvement' || item === 'Network access' ? 'review' : 'complete'}>{item === 'Self-improvement' ? 'Approval required' : item === 'Network access' ? 'Restricted' : 'Allowed'}</State></button>)}
          </div>
          <button type="button" className="docket-button docket-button--primary" onClick={() => setNotice(`${policy} opened for review`)}>Edit {policy.toLowerCase()}</button>
          {notice ? <p className="form-note action-notice" role="status">{notice}. No policy was changed.</p> : null}
        </aside>
      </div>
    </div>
  );
}
