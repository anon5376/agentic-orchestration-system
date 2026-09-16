import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../app/WorkspaceContext';
import { aosApi } from '../lib/aosApi';
import { initialSetupDraft, interpretSetupMessage } from '../lib/setupAssistant';

const INSTRUMENTS = [
  { key: 'setup', label: 'Build swarm', count: '→', note: 'Start here' },
  { key: 'presets', label: 'Instructions', count: '18', note: 'What each worker does' },
  { key: 'templates', label: 'Workers', count: '10', note: 'Models, tools and limits' },
  { key: 'blueprints', label: 'Swarms', count: '03', note: 'Team and hierarchy' },
  { key: 'memory', label: 'Memory', count: '06', note: 'Optional persistence' },
  { key: 'settings', label: 'Advanced', count: '18', note: 'Every system setting' },
];

const MEMORY_SCOPES = ['agent', 'role', 'run', 'swarm', 'project', 'global'];
const MEMORY_POLICY_SCOPES = ['global', 'project', 'swarm', 'role', 'run'];
const IMPLEMENTED_HARNESSES = new Set(['local', 'codex', 'claude', 'openai', 'ollama', 'command']);
const SELECTED_BLUEPRINT_KEY = 'aos-selected-blueprint';

function Aperture({ size = 34, active = false }) {
  return (
    <svg className={`system-aperture ${active ? 'is-active' : ''}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="7 4" />
      <path d="M20 1v8M20 31v8M1 20h8M31 20h8" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="20" cy="20" r="3" fill="currentColor" />
    </svg>
  );
}

function Signal({ tone = 'quiet', children }) {
  return <span className={`system-signal system-signal--${tone}`}><i />{children}</span>;
}

function Limit({ value }) {
  if (value === null || value === undefined) return 'UNLIMITED';
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : String(value);
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined || value === 'unlimited') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function idList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function SystemHeader({ bundle, connection }) {
  const counts = bundle?.diagnostics?.counts || {};
  const liveCounts = bundle ? [
    ['Roles', bundle.presets?.length ?? 0],
    ['Templates', bundle.templates?.length ?? 0],
    ['Swarms', bundle.blueprints?.length ?? 0],
    ['Memories', counts.memoryIndex ?? 0],
  ] : [
    ['Roles', 18],
    ['Templates', 10],
    ['Swarms', 3],
    ['Scopes', 6],
  ];
  return (
    <header className="system-header">
      <div className="system-header__title">
        <Aperture size={44} active={connection === 'ready'} />
        <div>
          <p>System studio</p>
          <h1>Build a swarm, then let it work.</h1>
        </div>
      </div>
      <dl className="system-header__telemetry">
        {liveCounts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
    </header>
  );
}

function InstrumentNav({ active, onChange, bundle }) {
  const counts = {
    setup: '→',
    presets: bundle?.presets?.length,
    templates: bundle?.templates?.length,
    blueprints: bundle?.blueprints?.length,
    memory: Object.keys(bundle?.memoryStats?.scopes || {}).length,
    settings: bundle?.manifest?.groups?.flatMap((group) => group.settings || []).length,
  };
  return (
    <nav className="system-instruments" aria-label="System instruments">
      {INSTRUMENTS.map((item) => (
        <button type="button" key={item.key} className={active === item.key ? 'is-active' : ''} onClick={() => onChange(item.key)} aria-pressed={active === item.key}>
          <span>{item.label}</span>
          <strong>{item.key === 'setup' ? item.count : String(counts[item.key] ?? item.count).padStart(2, '0')}</strong>
          <small>{item.note}</small>
        </button>
      ))}
    </nav>
  );
}

function SetupView({ bundle, selectedBlueprintId, onApplyBlueprint, onOpen, onModels, onLaunch }) {
  const mode = bundle.snapshot?.execution?.mode || 'unknown';
  const runnable = bundle.executionAllowedHarnesses?.value || [];
  const [draft, setDraft] = useState(() => initialSetupDraft(bundle.blueprints, selectedBlueprintId));
  const [messages, setMessages] = useState(() => [{
    id: 'welcome',
    role: 'assistant',
    title: 'What are you trying to build or investigate?',
    body: 'Tell me the outcome in plain language. Add limits only if they matter. I’ll recommend a swarm and show every assumption before anything changes.',
    question: 'For example: “Audit this repository with six workers, prioritize evidence, and use Codex.”',
    unresolved: [],
  }]);
  const [input, setInput] = useState('');
  const [appliedBlueprintId, setAppliedBlueprintId] = useState(selectedBlueprintId);
  const transcriptRef = useRef(null);
  const blueprint = bundle.blueprints?.find((item) => item.id === draft.blueprintId) || null;
  const memoryEnabled = bundle.memoryPolicy?.effective?.enabled !== false;
  const requestedHarnessSupported = draft.requestedHarness === 'inherit current runtime'
    || (draft.requestedHarness.startsWith('Codex') && mode === 'codex');
  const isApplied = Boolean(draft.blueprintId && appliedBlueprintId === draft.blueprintId);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const send = (text = input) => {
    const value = String(text || '').trim();
    if (!value) return;
    const result = interpretSetupMessage(value, bundle.blueprints, draft);
    setDraft(result.draft);
    setAppliedBlueprintId((current) => current === result.draft.blueprintId ? current : null);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', body: value },
      { id: `assistant-${Date.now()}`, role: 'assistant', ...result.reply },
    ]);
    setInput('');
  };

  const reset = () => {
    setDraft(initialSetupDraft(bundle.blueprints, selectedBlueprintId));
    setAppliedBlueprintId(selectedBlueprintId);
    setMessages([{ id: 'welcome', role: 'assistant', title: 'Start again.', body: 'Describe the result you want. I’ll keep the setup bounded and make each assumption visible.', question: 'Nothing from the previous draft was applied.', unresolved: [] }]);
    setInput('');
  };

  const applyRecommendation = () => {
    if (!draft.blueprintId) return;
    onApplyBlueprint(draft.blueprintId);
    setAppliedBlueprintId(draft.blueprintId);
    setMessages((current) => [...current, {
      id: `applied-${Date.now()}`,
      role: 'assistant',
      title: `${blueprint?.name || 'Swarm'} is now selected.`,
      body: 'Only the swarm selection changed. Provider and memory requests remain notes until you configure and save them in their own editors.',
      question: 'You can review the swarm or continue to Goal Intake.',
      unresolved: [],
    }]);
  };

  return (
    <div className="setup-assistant">
      <main className="setup-chat">
        <header className="setup-chat__header">
          <div><Signal tone="verified">SETUP ASSISTANT</Signal><span>local configuration guide</span></div>
          <button type="button" onClick={reset}>Clear conversation</button>
        </header>
        <div className="setup-chat__transcript" ref={transcriptRef} aria-live="polite">
          {messages.map((message) => (
            <article key={message.id} className={`setup-message setup-message--${message.role}`}>
              <span className="setup-message__mark" aria-hidden="true">{message.role === 'user' ? '›' : 'AOS'}</span>
              <div>
                {message.title ? <h2>{message.title}</h2> : null}
                <p>{message.body}</p>
                {message.reason ? <p className="setup-message__reason"><span>Why</span>{message.reason}</p> : null}
                {message.unresolved?.length ? <ul>{message.unresolved.map((item) => <li key={item}>{item}</li>)}</ul> : null}
                {message.question ? <p className="setup-message__question">{message.question}</p> : null}
              </div>
            </article>
          ))}
        </div>
        <div className="setup-chat__suggestions" aria-label="Example requests">
          <button type="button" onClick={() => send('Set up a rigorous research swarm that prioritizes evidence quality.')}>Research</button>
          <button type="button" onClick={() => send('Use 6 workers to audit an existing result and verify every claim.')}>Audit</button>
          <button type="button" onClick={() => send('Run an exhaustive unbounded investigation with persistent memory.')}>Unbounded</button>
        </div>
        <form className="setup-chat__composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <span aria-hidden="true">›</span>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} placeholder="Describe the swarm you need…" aria-label="Message the setup assistant" rows="2" />
          <button type="submit" disabled={!input.trim()}>Send</button>
        </form>
      </main>
      <aside className="setup-draft">
        <header><p>Working draft</p><Signal tone={isApplied ? 'verified' : 'transition'}>{isApplied ? 'SELECTED' : 'NOT APPLIED'}</Signal></header>
        <section className="setup-draft__primary">
          <span>Recommended swarm</span>
          <h2>{blueprint?.name || 'Waiting for a goal'}</h2>
          <p>{blueprint?.description || 'The assistant needs a short objective before it can recommend a configuration.'}</p>
        </section>
        <section className="setup-draft__facts">
          <dl>
            <div><dt>Priority</dt><dd>{draft.priority}</dd></div>
            <div><dt>Requested scale</dt><dd>{draft.requestedWorkers ? `${draft.requestedWorkers} workers` : blueprint?.unlimited ? 'unbounded' : 'blueprint default'}</dd></div>
            <div><dt>Current runtime</dt><dd>{mode}</dd></div>
            <div><dt>Provider request</dt><dd className={requestedHarnessSupported ? '' : 'is-warning'}>{draft.requestedHarness}</dd></div>
            <div><dt>Memory</dt><dd>{draft.memory === 'inherit current policy' ? (memoryEnabled ? 'on · current policy' : 'off · current policy') : draft.memory}</dd></div>
            <div><dt>Allowed by policy</dt><dd>{runnable.length ? runnable.join(' / ') : 'none reported'}</dd></div>
          </dl>
        </section>
        <section className="setup-draft__actions">
          <button type="button" className="system-button system-button--primary" disabled={!draft.blueprintId || isApplied} onClick={applyRecommendation}>{isApplied ? 'Recommendation selected' : 'Use this recommendation'}</button>
          <button type="button" className="system-button" disabled={!draft.blueprintId} onClick={() => onOpen('blueprints', draft.blueprintId)}>Review swarm details</button>
          <button type="button" className="system-button" onClick={onModels}>Choose models</button>
          <button type="button" className="system-button" onClick={() => onOpen('templates')}>Configure workers</button>
          <button type="button" className="system-button" onClick={() => onOpen('memory')}>Configure memory</button>
          <button type="button" className="system-button system-button--next" disabled={!isApplied} onClick={onLaunch}>Continue to goal intake →</button>
        </section>
        <footer><span>Guide only</span><p>This chat does not call a model or silently rewrite configuration. Live Codex remains inside verified swarm runs.</p></footer>
      </aside>
    </div>
  );
}

function RegistryIndex({ label, items, selectedId, onSelect, onCreate, renderMeta }) {
  return (
    <aside className="registry-index">
      <div className="registry-index__header">
        <span>{label}</span>
        {onCreate ? <button type="button" onClick={onCreate}>+ New</button> : null}
      </div>
      <div className="registry-index__list">
        {items.map((item) => (
          <button type="button" key={item.id || item.key} className={selectedId === (item.id || item.key) ? 'is-selected' : ''} onClick={() => onSelect(item.id || item.key)} aria-pressed={selectedId === (item.id || item.key)}>
            <span>{item.name || item.key}</span>
            <small>{renderMeta ? renderMeta(item) : item.id}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

function FactGrid({ items }) {
  return (
    <dl className="system-facts">
      {items.map(([label, value, tone]) => (
        <div key={label}><dt>{label}</dt><dd className={tone ? `is-${tone}` : ''}>{value ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

function EmptyDetail({ title = 'Select an object' }) {
  return <div className="system-empty"><Aperture size={48} /><h2>{title}</h2><p>The inspector opens from the index. Nothing is inferred from an unselected object.</p></div>;
}

function PresetView({ items, selectedId, onSelect, detail, loading, editor, setEditor, onSave, onNext }) {
  const [section, setSection] = useState('Mission');
  useEffect(() => setSection('Mission'), [selectedId]);
  if (editor?.kind === 'preset') return <PresetEditor key={`${editor.mode}-${editor.source?.id}`} editor={editor} onCancel={() => setEditor(null)} onSave={onSave} />;
  const sections = detail?.sections || {};
  const activeSection = sections[section] ?? Object.values(sections)[0];
  return (
    <div className="registry-stage">
      <RegistryIndex label="Worker instructions" items={items} selectedId={selectedId} onSelect={onSelect} renderMeta={(item) => `${item.role} · v${item.headVersion}`} />
      <section className="registry-object">
        {loading ? <p className="system-loading">Resolving role contract…</p> : detail ? (
          <>
            <div className="registry-object__head">
              <div><p>{detail.role} / version {detail.version}</p><h2>{detail.name}</h2></div>
              <Signal tone={detail.abstract ? 'transition' : 'verified'}>{detail.abstract ? 'ABSTRACT' : 'DEPLOYABLE'}</Signal>
            </div>
            <FactGrid items={[
              ['Sections', detail.order?.length || Object.keys(sections).length],
              ['Variables', Object.keys(detail.variables || {}).length],
              ['Inheritance', detail.chain?.map((item) => `${item.id}@${item.version}`).join(' → ')],
            ]} />
            <div className="prompt-reader">
              <div className="prompt-reader__index" role="tablist" aria-label="System prompt sections">
                {(detail.order || Object.keys(sections)).map((name) => <button type="button" role="tab" aria-selected={section === name} key={name} className={section === name ? 'is-active' : ''} onClick={() => setSection(name)}>{name}</button>)}
              </div>
              <article><p>{section}</p><pre>{activeSection}</pre></article>
            </div>
          </>
        ) : <EmptyDetail />}
      </section>
      <aside className="registry-inspector">
        <p>Worker instructions</p>
        <h3>{detail?.name || 'No role selected'}</h3>
        <p>{detail ? 'These are the worker’s actual operating instructions. Copy a built-in set before changing it.' : 'Select a role to inspect its full instructions.'}</p>
        {detail ? (
          <>
            <button type="button" className="system-button system-button--primary" onClick={() => setEditor({ kind: 'preset', mode: 'fork', source: detail })}>Make custom instructions</button>
            {!detail.chain?.[0]?.builtin ? <button type="button" className="system-button" onClick={() => setEditor({ kind: 'preset', mode: 'edit', source: detail })}>Edit these instructions</button> : null}
            <button type="button" className="system-button system-button--next" onClick={onNext}>Next: configure worker →</button>
          </>
        ) : null}
      </aside>
    </div>
  );
}

function PresetEditor({ editor, onCancel, onSave }) {
  const source = editor.source;
  const [id, setId] = useState(editor.mode === 'fork' ? `custom-${source.id}` : source.id);
  const [name, setName] = useState(editor.mode === 'fork' ? `${source.name} / custom` : source.name);
  const [section, setSection] = useState(source.order?.[0] || Object.keys(source.sections || {})[0]);
  const [sections, setSections] = useState({ ...(source.sections || {}) });
  const [variables, setVariables] = useState(JSON.stringify(source.variables || {}, null, 2));
  const [parseError, setParseError] = useState('');
  const submit = () => {
    try {
      setParseError('');
      onSave({ editor, id, name, sections, variables: JSON.parse(variables || '{}') });
    } catch (error) {
      setParseError(`Variables are not valid JSON: ${error.message}`);
    }
  };
  return (
    <section className="system-composer">
      <header><div><p>{editor.mode === 'fork' ? 'New role from existing contract' : 'New prompt version'}</p><h2>{name}</h2></div><button type="button" onClick={onCancel}>Close</button></header>
      <div className="composer-grid">
        <div className="composer-fields">
          <label>Preset id<input value={id} disabled={editor.mode === 'edit'} onChange={(event) => setId(slug(event.target.value))} /></label>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Section<select value={section} onChange={(event) => setSection(event.target.value)}>{Object.keys(sections).map((key) => <option key={key}>{key}</option>)}</select></label>
          <label>Prompt variables (JSON)<textarea value={variables} onChange={(event) => setVariables(event.target.value)} /></label>
          {parseError ? <p className="system-error">{parseError}</p> : null}
          <p>Every section remains explicit. Editing creates a new immutable version; it never rewrites the previous prompt.</p>
        </div>
        <label className="composer-prompt">Section prompt<textarea value={sections[section] || ''} onChange={(event) => setSections((current) => ({ ...current, [section]: event.target.value }))} /></label>
      </div>
      <footer><button type="button" className="system-button" onClick={onCancel}>Cancel</button><button type="button" className="system-button system-button--primary" disabled={!id || !name || !sections[section]?.trim()} onClick={submit}>{editor.mode === 'fork' ? 'Create custom role' : 'Save new version'}</button></footer>
    </section>
  );
}

function TemplateView({ items, presets, manifest, executionAllowedHarnesses, selectedId, onSelect, detail, loading, editor, setEditor, onSave, onNext }) {
  if (editor?.kind === 'template') return <TemplateEditor key={`${editor.mode}-${editor.source?.id || 'new'}`} editor={editor} presets={presets} manifest={manifest} executionAllowedHarnesses={executionAllowedHarnesses} onCancel={() => setEditor(null)} onSave={onSave} />;
  const config = detail?.config;
  return (
    <div className="registry-stage">
      <RegistryIndex label="Workers" items={items} selectedId={selectedId} onSelect={onSelect} onCreate={() => setEditor({ kind: 'template', mode: 'create', source: null })} renderMeta={(item) => `${item.harness} · ${item.preset.id}`} />
      <section className="registry-object">
        {loading ? <p className="system-loading">Resolving execution profile…</p> : detail ? (
          <>
            <div className="registry-object__head"><div><p>Template / version {detail.version}</p><h2>{detail.name}</h2></div><Signal tone={detail.builtin ? 'quiet' : 'active'}>{detail.builtin ? 'BUILT-IN' : 'CUSTOM'}</Signal></div>
            <p className="registry-object__description">{detail.description}</p>
            <FactGrid items={[
              ['Role preset', `${config.preset.id}${config.preset.version ? `@${config.preset.version}` : ''}`],
              ['Harness', `${config.harness.id}${config.harness.model ? ` / ${config.harness.model}` : ''}`],
              ['Reasoning', config.harness.effort || 'provider default'],
              ['Sandbox', config.filesystem.sandbox],
              ['Token budget', <Limit value={config.budget.tokens} />],
              ['Timeout', config.timeoutMs ? `${Math.round(config.timeoutMs / 1000)} s` : 'UNLIMITED'],
            ]} />
            <div className="template-contract">
              <section><p>Delegation</p><strong>{config.delegation.mayDelegate ? 'ENABLED' : 'DISABLED'}</strong><dl><div><dt>Children</dt><dd><Limit value={config.delegation.maxChildren} /></dd></div><div><dt>Depth</dt><dd><Limit value={config.delegation.maxDepth} /></dd></div></dl></section>
              <section><p>Continuous memory</p><strong>{config.memory.read || config.memory.write ? 'SCOPED' : 'OFF'}</strong><dl><div><dt>Read / write</dt><dd>{config.memory.read ? 'R' : '—'} / {config.memory.write ? 'W' : '—'}</dd></div><div><dt>Scopes</dt><dd>{config.memory.scopes.join(', ')}</dd></div></dl></section>
              <section><p>Capabilities</p><strong>{Object.values(config.capabilities).flat().length} BOUND</strong><dl>{Object.entries(config.capabilities).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value.join(', ') || 'none'}</dd></div>)}</dl></section>
            </div>
          </>
        ) : <EmptyDetail />}
      </section>
      <aside className="registry-inspector">
        <p>Runnable worker</p><h3>{detail?.name || 'No worker selected'}</h3>
        <p>A worker combines instructions with a model or harness, access, tools, memory, autonomy and hard limits.</p>
        <button type="button" className="system-button system-button--primary" onClick={() => setEditor({ kind: 'template', mode: 'create', source: null })}>New worker</button>
        {detail ? <button type="button" className="system-button" onClick={() => setEditor({ kind: 'template', mode: detail.builtin ? 'fork' : 'edit', source: detail })}>{detail.builtin ? 'Copy and customize' : 'Edit as new version'}</button> : null}
        <button type="button" className="system-button system-button--next" onClick={onNext}>Next: add to swarm →</button>
      </aside>
    </div>
  );
}

function TemplateEditor({ editor, presets, manifest, executionAllowedHarnesses, onCancel, onSave }) {
  const source = editor.source;
  const config = source?.config || {};
  const [form, setForm] = useState({
    id: editor.mode === 'edit' ? source.id : source ? `custom-${source.id}` : 'custom-worker',
    name: editor.mode === 'edit' ? source.name : source ? `${source.name} / custom` : 'Custom worker',
    description: source?.description || 'User-defined subagent execution profile.',
    presetId: config.preset?.id || 'general-worker', harness: config.harness?.id || 'local', model: config.harness?.model || '', effort: config.harness?.effort || '',
    sandbox: config.filesystem?.sandbox || 'read_only',
    skills: (config.capabilities?.skills || []).join(', '), mcp: (config.capabilities?.mcp || []).join(', '), plugins: (config.capabilities?.plugins || []).join(', '), tools: (config.capabilities?.tools || []).join(', '),
    memoryRead: Boolean(config.memory?.read), memoryWrite: Boolean(config.memory?.write), memoryScopes: config.memory?.scopes || ['agent'],
    mayDelegate: Boolean(config.delegation?.mayDelegate), maxChildren: config.delegation?.maxChildren ?? '', maxDepth: config.delegation?.maxDepth ?? '',
    tokens: config.budget?.tokens ?? '', usd: config.budget?.usd ?? '', timeoutMs: config.timeoutMs ?? '',
  });
  const [advanced, setAdvanced] = useState(JSON.stringify(config, null, 2));
  const [parseError, setParseError] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const toggleScope = (scope) => set('memoryScopes', form.memoryScopes.includes(scope) ? form.memoryScopes.filter((item) => item !== scope) : [...form.memoryScopes, scope]);
  const submit = () => {
    try {
      setParseError('');
      const base = advanced.trim() ? JSON.parse(advanced) : {};
      onSave({
      editor,
      input: {
        id: slug(form.id), name: form.name.trim(), description: form.description.trim(),
        config: {
          ...base,
          preset: { id: form.presetId, version: null },
          harness: { ...(base.harness || {}), id: form.harness, model: form.model.trim() || null, effort: form.effort.trim() || null },
          capabilities: { ...(base.capabilities || {}), skills: idList(form.skills), mcp: idList(form.mcp), plugins: idList(form.plugins), tools: idList(form.tools) },
          filesystem: { ...(base.filesystem || {}), sandbox: form.sandbox, readPaths: base.filesystem?.readPaths || [], writePaths: base.filesystem?.writePaths || [] },
          memory: { ...(base.memory || {}), read: form.memoryRead, write: form.memoryWrite, scopes: form.memoryScopes },
          delegation: { ...(base.delegation || {}), mayDelegate: form.mayDelegate, maxChildren: form.mayDelegate ? numberOrNull(form.maxChildren) : 0, maxDepth: form.mayDelegate ? numberOrNull(form.maxDepth) : 0 },
          timeoutMs: numberOrNull(form.timeoutMs),
          budget: { ...(base.budget || {}), tokens: numberOrNull(form.tokens), usd: numberOrNull(form.usd), timeMs: base.budget?.timeMs ?? null },
        },
      },
      });
    } catch (error) {
      setParseError(`Full configuration is not valid JSON: ${error.message}`);
    }
  };
  const harnesses = manifest?.enumerations?.harnesses || ['local', 'codex', 'claude', 'openai', 'api', 'ollama', 'command'];
  const sandboxTiers = manifest?.enumerations?.sandboxTiers || ['read_only', 'workspace_write', 'network'];
  const allowedHarnesses = executionAllowedHarnesses?.value || ['local', 'codex'];
  const harnessNote = form.harness === 'codex'
    ? 'Codex is the implemented live adapter. Runtime verification remains fail-closed.'
    : form.harness === 'openai'
      ? 'OpenAI Responses uses the exact engine-configured model and a named API-key environment variable. Tools, fallback, delegation and continuation are refused.'
    : form.harness === 'local'
      ? 'Local is the deterministic engine worker, not an external model harness.'
      : IMPLEMENTED_HARNESSES.has(form.harness)
        ? `${form.harness} has a bounded adapter and remains unavailable until its engine configuration and preflight pass.`
        : `${form.harness} can be described by a template, but its adapter is not mounted yet; dispatch fails closed.`;
  return (
    <section className="system-composer">
      <header><div><p>{editor.mode === 'edit' ? 'New worker version' : 'Worker builder'}</p><h2>{form.name}</h2></div><button type="button" onClick={onCancel}>Close</button></header>
      <div className="template-form">
        <fieldset><legend>1 · Name this worker</legend><label>Worker id<input value={form.id} disabled={editor.mode === 'edit'} onChange={(event) => set('id', slug(event.target.value))} /></label><label>Name<input value={form.name} onChange={(event) => set('name', event.target.value)} /></label><label className="field-wide">What should this worker accomplish?<textarea value={form.description} onChange={(event) => set('description', event.target.value)} /></label></fieldset>
        <fieldset><legend>2 · Choose how it thinks and runs</legend><label>Instructions<select value={form.presetId} onChange={(event) => set('presetId', event.target.value)}>{presets.filter((item) => !item.abstract).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Execution harness<select value={form.harness} onChange={(event) => set('harness', event.target.value)}>{harnesses.map((item) => <option key={item} value={item}>{item}{allowedHarnesses.includes(item) ? '' : ' — disallowed by policy'}{IMPLEMENTED_HARNESSES.has(item) ? '' : ' — adapter pending'}</option>)}</select></label><label>Model<input value={form.model} placeholder="provider default" onChange={(event) => set('model', event.target.value)} /></label><label>Reasoning effort<input value={form.effort} placeholder="provider default" onChange={(event) => set('effort', event.target.value)} /></label><label>Workspace access<select value={form.sandbox} onChange={(event) => set('sandbox', event.target.value)}>{sandboxTiers.map((item) => <option key={item}>{item}</option>)}</select></label><p className="field-wide execution-note">{harnessNote}</p></fieldset>
        <fieldset><legend>3 · Give it capabilities</legend><label>Skills<input value={form.skills} placeholder="search, analyze" onChange={(event) => set('skills', event.target.value)} /></label><label>MCP servers<input value={form.mcp} placeholder="filesystem, github" onChange={(event) => set('mcp', event.target.value)} /></label><label>Plugins<input value={form.plugins} placeholder="literature-review" onChange={(event) => set('plugins', event.target.value)} /></label><label>Tools<input value={form.tools} placeholder="figure-analyzer" onChange={(event) => set('tools', event.target.value)} /></label><p className="field-wide execution-note">Bindings are saved exactly as entered. Unavailable capabilities fail closed when this worker is dispatched.</p></fieldset>
        <fieldset><legend>4 · Set memory and autonomy</legend><label className="switch-field"><input type="checkbox" checked={form.memoryRead} onChange={(event) => set('memoryRead', event.target.checked)} /><span>Read memory</span></label><label className="switch-field"><input type="checkbox" checked={form.memoryWrite} onChange={(event) => set('memoryWrite', event.target.checked)} /><span>Write memory</span></label><div className="scope-picker field-wide">{MEMORY_SCOPES.map((scope) => <button type="button" key={scope} aria-pressed={form.memoryScopes.includes(scope)} className={form.memoryScopes.includes(scope) ? 'is-active' : ''} onClick={() => toggleScope(scope)}>{scope}</button>)}</div><label className="switch-field"><input type="checkbox" checked={form.mayDelegate} onChange={(event) => set('mayDelegate', event.target.checked)} /><span>May create subagents</span></label><label>Maximum children<input type="number" min="0" value={form.maxChildren} disabled={!form.mayDelegate} placeholder="blank = unlimited" onChange={(event) => set('maxChildren', event.target.value)} /></label><label>Maximum depth<input type="number" min="0" value={form.maxDepth} disabled={!form.mayDelegate} placeholder="blank = unlimited" onChange={(event) => set('maxDepth', event.target.value)} /></label></fieldset>
        <fieldset><legend>5 · Set hard limits</legend><label>Token budget<input type="number" min="0" value={form.tokens} placeholder="blank = unlimited" onChange={(event) => set('tokens', event.target.value)} /></label><label>USD budget<input type="number" min="0" step="0.01" value={form.usd} placeholder="blank = unlimited" onChange={(event) => set('usd', event.target.value)} /></label><label>Timeout (ms)<input type="number" min="1000" value={form.timeoutMs} placeholder="blank = unlimited" onChange={(event) => set('timeoutMs', event.target.value)} /></label></fieldset>
        <details className="advanced-config"><summary>Advanced worker configuration</summary><p>Fallbacks, network policy, context inputs, output limits, retries, escalation and stop criteria remain directly editable as JSON. The guided fields above override matching values.</p><label>Configuration JSON<textarea value={advanced} onChange={(event) => setAdvanced(event.target.value)} /></label>{parseError ? <p className="system-error">{parseError}</p> : null}</details>
      </div>
      <footer><p>Blank hierarchy and budget ceilings mean explicitly unlimited. Provider quotas and sandbox policy still apply.</p><button type="button" className="system-button" onClick={onCancel}>Cancel</button><button type="button" className="system-button system-button--primary" disabled={!slug(form.id) || !form.name.trim()} onClick={submit}>{editor.mode === 'edit' ? 'Save new version' : 'Create template'}</button></footer>
    </section>
  );
}

function BlueprintView({ items, templates, selectedId, onSelect, detail, estimate, loading, editor, setEditor, onSave, onNext }) {
  if (editor?.kind === 'blueprint') return <BlueprintEditor key={`${editor.mode}-${editor.source?.id || 'new'}`} editor={editor} templates={templates} onCancel={() => setEditor(null)} onSave={onSave} />;
  const config = detail?.config;
  return (
    <div className="registry-stage">
      <RegistryIndex label="Swarms" items={items} selectedId={selectedId} onSelect={onSelect} onCreate={() => setEditor({ kind: 'blueprint', mode: 'create', source: null })} renderMeta={(item) => `${item.unlimited ? 'unlimited' : 'bounded'} · v${item.headVersion}`} />
      <section className="registry-object">
        {loading ? <p className="system-loading">Calculating hierarchy…</p> : detail && config?.lead ? (
          <>
            <div className="registry-object__head"><div><p>Swarm / version {detail.version}</p><h2>{detail.name}</h2></div><Signal tone={estimate?.unbounded ? 'consequence' : 'verified'}>{estimate?.unbounded ? 'UNBOUNDED' : 'BOUNDED'}</Signal></div>
            <div className="swarm-schema" aria-label="Swarm hierarchy">
              {(estimate?.levels || []).map((level, index) => <div className="swarm-level" key={level.depth}><span>DEPTH {level.depth}</span><strong>{level.indeterminate ? '∞' : level.maxAgents}</strong><p>{level.templates.join(' · ')}</p>{index < estimate.levels.length - 1 ? <i /> : null}</div>)}
            </div>
            <FactGrid items={[
              ['Lead', config.lead.templateId], ['Children', config.childTemplates.length], ['Depth', config.depth.unlimited ? 'UNLIMITED' : config.depth.max],
              ['Concurrency', config.concurrency.unlimited ? 'UNLIMITED' : config.concurrency.global], ['Worst-case agents', estimate?.unbounded || estimate?.indeterminate ? 'UNBOUNDED' : estimate?.totalAgents],
              ['Token ceiling', estimate?.unbounded || estimate?.totalTokens == null ? 'UNBOUNDED' : Number(estimate.totalTokens).toLocaleString()],
            ]} />
            {estimate?.warnings?.length ? <div className="system-warning"><p>Constraint conflict</p>{estimate.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div> : null}
          </>
        ) : <EmptyDetail />}
      </section>
      <aside className="registry-inspector"><p>Coordinated team</p><h3>{detail?.name || 'No swarm selected'}</h3><p>A swarm chooses the lead, its available workers, hierarchy, parallelism, memory boundaries, approval gates and run limits.</p><button type="button" className="system-button system-button--primary" onClick={() => setEditor({ kind: 'blueprint', mode: 'create', source: null })}>New swarm</button>{detail ? <button type="button" className="system-button" onClick={() => setEditor({ kind: 'blueprint', mode: detail.config ? 'edit' : 'fork', source: detail })}>Edit as new version</button> : null}<button type="button" className="system-button system-button--next" onClick={onNext}>Next: create research goal →</button></aside>
    </div>
  );
}

function BlueprintEditor({ editor, templates, onCancel, onSave }) {
  const source = editor.source;
  const config = source?.config || {};
  const [form, setForm] = useState({
    id: editor.mode === 'edit' ? source.id : source ? `custom-${source.id}` : 'custom-research-swarm', name: editor.mode === 'edit' ? source.name : source ? `${source.name} / custom` : 'Custom research swarm', description: source?.description || 'User-defined coordinated agent swarm.',
    lead: config.lead?.templateId || 'default-lead', children: config.childTemplates || ['default-worker'], depthUnlimited: Boolean(config.depth?.unlimited), depth: config.depth?.max ?? 3,
    concurrencyUnlimited: Boolean(config.concurrency?.unlimited), concurrency: config.concurrency?.global ?? 4, perBranch: config.concurrency?.perBranch ?? 2,
    ceilingUnlimited: Boolean(config.ceilings?.unlimited), tasks: config.ceilings?.tasks ?? 200, tokens: config.ceilings?.tokens ?? 2000000, usd: config.ceilings?.usd ?? 50,
    memoryRead: Boolean(config.memory?.readByDefault), memoryWrite: Boolean(config.memory?.writeByDefault), memoryScopes: config.memory?.scopes || ['agent', 'run'], gateExpansion: config.gates?.human?.includes('on_expansion') || false,
  });
  const [advanced, setAdvanced] = useState(JSON.stringify(config, null, 2));
  const [parseError, setParseError] = useState('');
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const toggle = (key, value) => set(key, form[key].includes(value) ? form[key].filter((item) => item !== value) : [...form[key], value]);
  const submit = () => {
    try {
      setParseError('');
      const base = advanced.trim() ? JSON.parse(advanced) : {};
      onSave({ editor, input: { id: slug(form.id), name: form.name.trim(), description: form.description.trim(), config: {
      ...base,
      lead: { templateId: form.lead, templateVersion: null }, childTemplates: form.children,
      depth: { max: form.depthUnlimited ? null : Number(form.depth), unlimited: form.depthUnlimited },
      concurrency: { global: form.concurrencyUnlimited ? null : Number(form.concurrency), perBranch: form.concurrencyUnlimited ? null : Number(form.perBranch), unlimited: form.concurrencyUnlimited },
      memory: { scopes: form.memoryScopes, readByDefault: form.memoryRead, writeByDefault: form.memoryWrite },
      gates: { ...(base.gates || {}), verification: base.gates?.verification || [], human: [...new Set([...(base.gates?.human || ['before_adopt']).filter((item) => item !== 'on_expansion'), ...(form.gateExpansion ? ['on_expansion'] : [])])] },
      ceilings: { tasks: form.ceilingUnlimited ? null : Number(form.tasks), tokens: form.ceilingUnlimited ? null : Number(form.tokens), usd: form.ceilingUnlimited ? null : Number(form.usd), timeMs: form.ceilingUnlimited ? null : (base.ceilings?.timeMs || 21600000), unlimited: form.ceilingUnlimited },
      } } });
    } catch (error) {
      setParseError(`Full configuration is not valid JSON: ${error.message}`);
    }
  };
  return (
    <section className="system-composer"><header><div><p>Swarm builder</p><h2>{form.name}</h2></div><button type="button" onClick={onCancel}>Close</button></header>
      <div className="template-form">
        <fieldset><legend>1 · Name this swarm</legend><label>Swarm id<input value={form.id} disabled={editor.mode === 'edit'} onChange={(event) => set('id', slug(event.target.value))} /></label><label>Name<input value={form.name} onChange={(event) => set('name', event.target.value)} /></label><label className="field-wide">What should this swarm accomplish?<textarea value={form.description} onChange={(event) => set('description', event.target.value)} /></label></fieldset>
        <fieldset><legend>2 · Choose the team</legend><label>Lead worker<select value={form.lead} onChange={(event) => set('lead', event.target.value)}>{templates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="check-matrix field-wide">{templates.map((item) => <label key={item.id}><input type="checkbox" checked={form.children.includes(item.id)} onChange={() => toggle('children', item.id)} /><span>{item.name}</span></label>)}</div><label className="switch-field"><input type="checkbox" checked={form.depthUnlimited} onChange={(event) => set('depthUnlimited', event.target.checked)} /><span>Unlimited hierarchy depth</span></label><label>Maximum hierarchy depth<input type="number" min="0" disabled={form.depthUnlimited} value={form.depth} onChange={(event) => set('depth', event.target.value)} /></label></fieldset>
        <fieldset><legend>3 · Set pace and ceilings</legend><label className="switch-field"><input type="checkbox" checked={form.concurrencyUnlimited} onChange={(event) => set('concurrencyUnlimited', event.target.checked)} /><span>Unlimited parallel workers</span></label><label>Workers at once<input type="number" min="1" disabled={form.concurrencyUnlimited} value={form.concurrency} onChange={(event) => set('concurrency', event.target.value)} /></label><label>Workers per branch<input type="number" min="1" disabled={form.concurrencyUnlimited} value={form.perBranch} onChange={(event) => set('perBranch', event.target.value)} /></label><label className="switch-field"><input type="checkbox" checked={form.ceilingUnlimited} onChange={(event) => set('ceilingUnlimited', event.target.checked)} /><span>Unlimited run ceilings</span></label><label>Maximum tasks<input type="number" min="1" disabled={form.ceilingUnlimited} value={form.tasks} onChange={(event) => set('tasks', event.target.value)} /></label><label>Maximum tokens<input type="number" min="1" disabled={form.ceilingUnlimited} value={form.tokens} onChange={(event) => set('tokens', event.target.value)} /></label><label>Maximum USD<input type="number" min="0" step="0.01" disabled={form.ceilingUnlimited} value={form.usd} onChange={(event) => set('usd', event.target.value)} /></label></fieldset>
        <fieldset><legend>4 · Set memory and approvals</legend><label className="switch-field"><input type="checkbox" checked={form.memoryRead} onChange={(event) => set('memoryRead', event.target.checked)} /><span>Read memory by default</span></label><label className="switch-field"><input type="checkbox" checked={form.memoryWrite} onChange={(event) => set('memoryWrite', event.target.checked)} /><span>Write memory by default</span></label><div className="scope-picker field-wide">{MEMORY_SCOPES.map((scope) => <button type="button" key={scope} aria-pressed={form.memoryScopes.includes(scope)} className={form.memoryScopes.includes(scope) ? 'is-active' : ''} onClick={() => toggle('memoryScopes', scope)}>{scope}</button>)}</div><label className="switch-field"><input type="checkbox" checked={form.gateExpansion} onChange={(event) => set('gateExpansion', event.target.checked)} /><span>Ask before expanding the swarm</span></label></fieldset>
        <details className="advanced-config"><summary>Advanced swarm configuration</summary><p>Routing, capability bindings, priority, context partitioning, messaging, artifacts, failure policy, verification gates, stop criteria and task-to-worker mapping remain directly editable as JSON.</p><label>Configuration JSON<textarea value={advanced} onChange={(event) => setAdvanced(event.target.value)} /></label>{parseError ? <p className="system-error">{parseError}</p> : null}</details>
      </div>
      <footer><p>“Unlimited” removes AOS product caps. Provider limits, budgets and sandbox rules remain real constraints.</p><button type="button" className="system-button" onClick={onCancel}>Cancel</button><button type="button" className="system-button system-button--primary" disabled={!slug(form.id) || !form.name.trim() || !form.children.length} onClick={submit}>{editor.mode === 'edit' ? 'Save new version' : 'Create blueprint'}</button></footer>
    </section>
  );
}

function MemoryView({ basePolicyRecord, stats, resources, onSave, onUnset, busy }) {
  const [policyScope, setPolicyScope] = useState('global');
  const [scopeId, setScopeId] = useState('');
  const [policy, setPolicy] = useState({ effective: basePolicyRecord?.effective || {}, record: basePolicyRecord?.record || null, layers: [] });
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const [policyRevision, setPolicyRevision] = useState(0);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  const policyTargets = useMemo(() => {
    if (policyScope === 'global') return [{ id: '', name: 'All projects' }];
    if (policyScope === 'project') return (resources?.projects || []).map((item) => ({ id: item.id, name: item.name || item.id }));
    if (policyScope === 'swarm') return (resources?.blueprints || []).map((item) => ({ id: item.id, name: item.name || item.id }));
    if (policyScope === 'role') return (resources?.presets || []).filter((item) => !item.abstract).map((item) => ({ id: item.id, name: item.name || item.id }));
    return (resources?.runs || []).filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)).map((item) => ({ id: item.id, name: `${item.objective || item.id} · ${item.status}` }));
  }, [policyScope, resources]);

  useEffect(() => {
    setScopeId(policyScope === 'global' ? '' : policyTargets[0]?.id || '');
  }, [policyScope, policyTargets]);

  useEffect(() => {
    if (policyScope !== 'global' && !scopeId) {
      setPolicy({ effective: basePolicyRecord?.effective || {}, record: null, layers: [] });
      setDraft({});
      setDirty(false);
      return undefined;
    }
    let cancelled = false;
    setPolicyLoading(true);
    setPolicyError('');
    const context = policyScope === 'project' ? { projectId: scopeId }
      : policyScope === 'swarm' ? { blueprintId: scopeId }
        : policyScope === 'role' ? { presetId: scopeId }
          : policyScope === 'run' ? { runId: scopeId }
            : {};
    const layerRequest = policyScope === 'run' ? Promise.resolve({ record: null }) : aosApi.memoryPolicy(policyScope, scopeId || null);
    Promise.all([layerRequest, aosApi.effectiveSetting('memory', context)]).then(([layer, effective]) => {
      if (cancelled) return;
      const expanded = { ...(basePolicyRecord?.effective || {}), ...(effective?.value || {}) };
      const runLayer = policyScope === 'run' ? effective?.layers?.filter((item) => item.layer === 'run').at(-1) : null;
      setPolicy({ effective: expanded, record: layer?.record || runLayer || null, layers: effective?.layers || [], provenance: effective?.provenance || null });
      setDraft(policyScope === 'run' ? runLayer?.value || {} : layer?.record?.value || {});
      setDirty(false);
    }).catch((error) => { if (!cancelled) setPolicyError(error.message); }).finally(() => { if (!cancelled) setPolicyLoading(false); });
    return () => { cancelled = true; };
  }, [basePolicyRecord, policyRevision, policyScope, scopeId]);

  const current = (key) => draft[key] ?? policy.effective?.[key];
  const set = (key, value) => { setDraft((valueNow) => ({ ...valueNow, [key]: value })); setDirty(true); };
  const selectedScopes = current('scopes') || [];
  const toggleScope = (scope) => set('scopes', selectedScopes.includes(scope) ? selectedScopes.filter((item) => item !== scope) : [...selectedScopes, scope]);
  const retentionDays = current('retentionDays') || {};
  const save = async () => {
    const result = await onSave(draft, policyScope, scopeId || null);
    if (result) setPolicyRevision((value) => value + 1);
  };
  const remove = async () => {
    const result = await onUnset(policyScope, scopeId || null);
    if (result) setPolicyRevision((value) => value + 1);
  };
  const search = async (event) => { event.preventDefault(); const response = await aosApi.searchMemory({ query, includeProposed: true }); setResults(Array.isArray(response) ? response : response.items || response.results || []); };
  const active = Boolean(current('enabled'));
  return (
    <div className="memory-studio">
      <section className="memory-policy">
        <div className="memory-layer-controls">
          <label>Policy layer<select value={policyScope} onChange={(event) => setPolicyScope(event.target.value)}>{MEMORY_POLICY_SCOPES.map((scope) => <option value={scope} key={scope}>{scope}</option>)}</select></label>
          {policyScope !== 'global' ? <label>Target<select value={scopeId} onChange={(event) => setScopeId(event.target.value)}><option value="">Select {policyScope}</option>{policyTargets.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label> : null}
          <div><span>Effective source</span><strong>{policy.provenance?.source || 'built-in default'}</strong></div>
        </div>
        <header><div><p>{policyScope} memory policy</p><h2>{active ? 'Continuous memory is active.' : 'Continuous memory is off.'}</h2></div><Signal tone={active ? 'verified' : 'quiet'}>{active ? 'ENABLED' : 'DISABLED'}</Signal></header>
        <p className="registry-object__description">Global enablement gates every inner layer. Project, swarm, role, run and per-agent template policies can only narrow access. Run changes are versioned patches.</p>
        {policyLoading ? <p className="system-loading">Resolving effective memory layers…</p> : null}
        {policyError ? <p className="system-error">{policyError}</p> : null}
        <div className="memory-switches">
          {[['enabled', 'Enable continuous memory'], ['read', 'Retrieve before tasks'], ['write', 'Accept scoped writes'], ['reflect', 'Reflect when runs end']].map(([key, label]) => <label className="switch-field" key={key}><input type="checkbox" checked={Boolean(current(key))} onChange={(event) => set(key, event.target.checked)} /><span>{label}</span></label>)}
        </div>
        <div><p className="system-label">Permitted storage scopes</p><div className="scope-picker">{MEMORY_SCOPES.map((scope) => <button type="button" key={scope} aria-pressed={selectedScopes.includes(scope)} className={selectedScopes.includes(scope) ? 'is-active' : ''} onClick={() => toggleScope(scope)}>{scope}</button>)}</div></div>
        <div className="retention-grid"><p className="system-label">Retention days</p>{MEMORY_SCOPES.map((scope) => <label key={scope}>{scope}<input type="number" min="0" value={retentionDays[scope] ?? ''} placeholder="never" onChange={(event) => set('retentionDays', { ...retentionDays, [scope]: event.target.value === '' ? null : Number(event.target.value) })} /></label>)}</div>
        <div className="memory-actions"><button type="button" className="system-button system-button--primary" onClick={save} disabled={busy || policyLoading || !dirty || (policyScope !== 'global' && !scopeId)}>Save {policyScope} policy</button>{policyScope !== 'run' && policy.record ? <button type="button" className="system-button" onClick={remove} disabled={busy || policyLoading}>Remove layer</button> : null}</div>
        <div className="memory-provenance"><p className="system-label">Effective layer order</p>{(policy.layers || []).map((layer) => <span key={`${layer.layer}-${layer.scopeId || ''}`}><b>{layer.layer}</b>{layer.source}</span>)}</div>
      </section>
      <aside className="memory-ledger"><p>Memory ledger</p><FactGrid items={[
        ['Indexed records', Object.values(stats?.scopes || {}).reduce((total, scope) => total + (scope.items || scope.count || 0), 0)], ['Retrieval', stats?.retrieval || 'lexical'], ['Writes', stats?.diagnostics?.writes || 0], ['Write failures', stats?.diagnostics?.writeFailures || 0],
      ]} /><form onSubmit={search}><label>Search all permitted memory<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="procedure, failure, decision…" /></label><button className="system-button" type="submit">Search</button></form><div className="memory-results">{results.length ? results.map((item) => <article key={item.id}><span>{item.scope} / {item.type}</span><strong>{item.title}</strong><p>{item.content}</p></article>) : <p>No matching records in the current local store.</p>}</div></aside>
    </div>
  );
}

function parseSettingValue(schema, raw, checked) {
  if (schema.kind === 'boolean') return checked;
  if (schema.nullable && raw.trim().toLowerCase() === 'null') return null;
  if (schema.kind === 'integer') return Number.parseInt(raw, 10);
  if (schema.kind === 'number') return Number(raw);
  if (schema.kind === 'array' && schema.items?.kind !== 'object') return raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (['object', 'record', 'array'].includes(schema.kind)) return JSON.parse(raw);
  return raw;
}

function settingText(value, schema) {
  if (schema.kind === 'boolean') return String(Boolean(value));
  if (['object', 'record'].includes(schema.kind) || (schema.kind === 'array' && schema.items?.kind === 'object')) return JSON.stringify(value, null, 2);
  if (Array.isArray(value)) return value.join(', ');
  return value === null ? 'null' : String(value ?? '');
}

function SettingsView({ manifest, selectedKey, setSelectedKey, effective, onReloadEffective, onSave, onUnset, busy }) {
  const definitions = useMemo(() => (manifest?.groups || []).flatMap((group) => (group.settings || []).map((setting) => ({ ...setting, groupName: group.name }))), [manifest]);
  const selected = definitions.find((item) => item.key === selectedKey) || definitions[0];
  const [scope, setScope] = useState('global');
  const [scopeId, setScopeId] = useState('');
  const [raw, setRaw] = useState('');
  const [checked, setChecked] = useState(false);
  const [parseError, setParseError] = useState('');
  useEffect(() => { if (!selected) return; setRaw(settingText(effective?.value ?? selected.default, selected.schema)); setChecked(Boolean(effective?.value ?? selected.default)); setParseError(''); }, [selected?.key, effective]);
  useEffect(() => { if (selected && !selected.scopes.includes(scope)) setScope(selected.scopes[0] || 'global'); }, [selected, scope]);
  if (!selected) return <EmptyDetail title="No settings published by the engine" />;
  const save = () => { try { setParseError(''); const value = parseSettingValue(selected.schema, raw, checked); onSave(selected.key, value, scope, scope === 'global' ? null : scopeId); } catch (error) { setParseError(`Value is not valid JSON: ${error.message}`); } };
  return (
    <div className="registry-stage settings-stage">
      <aside className="settings-groups">{(manifest?.groups || []).filter((group) => group.settings?.length).map((group) => <section key={group.id}><p>{group.name}</p>{group.settings.map((setting) => <button type="button" aria-pressed={selected.key === setting.key} className={selected.key === setting.key ? 'is-selected' : ''} onClick={() => setSelectedKey(setting.key)} key={setting.key}>{setting.key}</button>)}</section>)}</aside>
      <section className="setting-object"><div className="registry-object__head"><div><p>{selected.groupName}</p><h2>{selected.key}</h2></div><Signal tone={selected.readOnly ? 'quiet' : selected.runPatchable ? 'transition' : 'verified'}>{selected.readOnly ? 'READ ONLY' : selected.runPatchable ? 'RUN PATCHABLE' : 'CONFIGURABLE'}</Signal></div><p className="registry-object__description">{selected.description}</p><FactGrid items={[["Effective value", settingText(effective?.value ?? selected.default, selected.schema)], ['Source', effective?.provenance?.source || 'built-in default'], ['Layer', effective?.provenance?.layer || 'builtin'], ['Schema', selected.schema.kind]]} /><div className="provenance-stack"><p>Resolution order</p>{(effective?.layers || [{ layer: 'builtin', source: 'built-in default', value: selected.default }]).map((layer) => <div key={`${layer.layer}-${layer.scopeId || ''}`}><span>{layer.layer}</span><strong>{settingText(layer.value, selected.schema)}</strong><small>{layer.source}</small></div>)}</div></section>
      <aside className="registry-inspector setting-editor"><p>Edit layer</p><label>Scope<select value={scope} disabled={selected.readOnly} onChange={(event) => { setScope(event.target.value); onReloadEffective(selected.key); }}>{selected.scopes.map((item) => <option key={item}>{item}</option>)}</select></label>{scope !== 'global' && !selected.readOnly ? <label>Scope id<input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder={`${scope} id`} /></label> : null}{selected.schema.kind === 'boolean' ? <label className="switch-field"><input type="checkbox" checked={checked} disabled={selected.readOnly} onChange={(event) => setChecked(event.target.checked)} /><span>{checked ? 'Enabled' : 'Disabled'}</span></label> : selected.schema.kind === 'enum' ? <label>Value<select value={raw} disabled={selected.readOnly} onChange={(event) => setRaw(event.target.value)}>{selected.schema.values.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select></label> : <label>Value{['object', 'record'].includes(selected.schema.kind) ? <textarea value={raw} disabled={selected.readOnly} onChange={(event) => setRaw(event.target.value)} /> : <input value={raw} disabled={selected.readOnly} onChange={(event) => setRaw(event.target.value)} />}</label>}{parseError ? <p className="system-error">{parseError}</p> : null}<button type="button" className="system-button system-button--primary" disabled={selected.readOnly || busy || (scope !== 'global' && !scopeId)} onClick={save}>Save layer</button><button type="button" className="system-button" disabled={selected.readOnly || busy || (scope !== 'global' && !scopeId)} onClick={() => onUnset(selected.key, scope, scope === 'global' ? null : scopeId)}>Remove layer</button></aside>
    </div>
  );
}

function IllustrativeSystem({ active, setActive, setMode }) {
  const item = INSTRUMENTS.find((candidate) => candidate.key === active);
  return (
    <div className="system-preview">
      <div><Aperture size={74} /><p>Illustrative preview</p><h2>{item.label}</h2><span>{item.note}. The live registry is not being read in preview mode.</span></div>
      <aside><p>What exists in the engine</p><ul><li>17 concrete role prompts plus the base contract</li><li>10 reusable subagent templates</li><li>Bounded and explicitly unlimited swarm blueprints</li><li>Optional memory across six isolated scopes</li><li>Manifest-driven settings with provenance</li></ul><button type="button" className="system-button system-button--primary" onClick={() => setMode('live')}>Connect to live local engine</button></aside>
    </div>
  );
}

export function SystemPage({ onNavigate }) {
  const workspace = useWorkspace();
  const live = workspace.mode === 'live';
  const [active, setActive] = useState('setup');
  const [bundle, setBundle] = useState(null);
  const [selected, setSelected] = useState({ presets: null, templates: null, blueprints: null, settings: null });
  const [detail, setDetail] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState(null);
  const [detailRevision, setDetailRevision] = useState(0);

  const loadBundle = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [manifest, diagnostics, presets, templates, blueprints, memoryPolicy, memoryStats, snapshot, executionAllowedHarnesses] = await Promise.all([
        aosApi.systemManifest(), aosApi.systemDiagnostics(), aosApi.presets(), aosApi.templates(), aosApi.blueprints(), aosApi.memoryPolicy(), aosApi.memoryStats(), aosApi.snapshot(), aosApi.effectiveSetting('execution.allowedHarnesses'),
      ]);
      const next = { manifest, diagnostics, presets, templates, blueprints, memoryPolicy, memoryStats, snapshot, executionAllowedHarnesses };
      setBundle(next);
      setSelected((current) => ({
        presets: presets.some((item) => item.id === current.presets) ? current.presets : presets.find((item) => item.id === 'lead-investigator')?.id || presets[0]?.id,
        templates: templates.some((item) => item.id === current.templates) ? current.templates : templates.find((item) => item.id === 'default-lead')?.id || templates[0]?.id,
        blueprints: blueprints.some((item) => item.id === current.blueprints) ? current.blueprints : blueprints.find((item) => item.id === 'default-research-swarm')?.id || blueprints[0]?.id,
        settings: current.settings || manifest.groups.flatMap((group) => group.settings || [])[0]?.key || null,
      }));
    } catch (caught) {
      setError(caught.message || 'Could not read the live system registry.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (live) loadBundle(); }, [live, loadBundle]);

  const selectedId = selected[active];
  useEffect(() => {
    if (!live || !selectedId || !['presets', 'templates', 'blueprints', 'settings'].includes(active)) { setDetail(null); setEstimate(null); return undefined; }
    let cancelled = false;
    setDetailLoading(true);
    const promise = active === 'presets' ? aosApi.preset(selectedId)
      : active === 'templates' ? aosApi.template(selectedId)
        : active === 'blueprints' ? Promise.all([aosApi.blueprint(selectedId), aosApi.blueprintEstimate(selectedId)]).then(([record, projection]) => { if (!cancelled) setEstimate(projection); return record; })
          : aosApi.effectiveSetting(selectedId);
    promise.then((record) => { if (!cancelled) setDetail(record); }).catch((caught) => { if (!cancelled) setError(caught.message); }).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [active, detailRevision, live, selectedId]);

  const mutate = async (label, operation, after) => {
    setNotice(`${label}…`); setError('');
    try { const result = await operation(); await loadBundle(); after?.(result); setDetailRevision((value) => value + 1); setEditor(null); setNotice(`${label} · recorded`); return result; }
    catch (caught) { setError(caught.message || `${label} failed`); setNotice(''); return null; }
  };

  const savePreset = ({ editor: current, id, name, sections, variables }) => mutate(current.mode === 'fork' ? 'Create custom role' : 'Save role version', async () => {
    if (current.mode === 'fork') await aosApi.forkPreset(current.source.id, { newId: id, name });
    return aosApi.editPreset(id, { id, name, role: current.source.role, extends: current.source.role === 'base' ? null : { id: 'aos-base' }, abstract: current.source.abstract, variables, sections, sectionModes: Object.fromEntries(Object.keys(sections).map((key) => [key, 'replace'])), note: 'Edited in System Studio' });
  }, () => setSelected((value) => ({ ...value, presets: id })));

  const saveTemplate = ({ editor: current, input }) => mutate(current.mode === 'edit' ? 'Save template version' : 'Create template', () => current.mode === 'edit' ? aosApi.editTemplate(current.source.id, input) : aosApi.createTemplate(input), () => setSelected((value) => ({ ...value, templates: input.id })));
  const saveBlueprint = ({ editor: current, input }) => mutate(current.mode === 'edit' ? 'Save swarm version' : 'Create swarm blueprint', () => current.mode === 'edit' ? aosApi.editBlueprint(current.source.id, input) : aosApi.createBlueprint(input), () => {
    setSelected((value) => ({ ...value, blueprints: input.id }));
    try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, input.id); } catch { /* ignore */ }
  });
  const openInstrument = (key, id = null) => {
    setActive(key);
    setDetail(null);
    setEstimate(null);
    setEditor(null);
    setError('');
    if (id) {
      setSelected((value) => ({ ...value, [key]: id }));
      if (key === 'blueprints') {
        try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, id); } catch { /* ignore */ }
      }
    }
  };
  const launchSelectedSwarm = () => {
    try { if (selected.blueprints) window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, selected.blueprints); } catch { /* ignore */ }
    onNavigate('/intake');
  };
  const applySelectedSwarm = (id) => {
    setSelected((value) => ({ ...value, blueprints: id }));
    try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, id); } catch { /* ignore */ }
    setNotice('Swarm recommendation selected · no run started');
  };

  return (
    <div className="system-page">
      <SystemHeader bundle={bundle} connection={workspace.connection} />
      <InstrumentNav active={active} onChange={openInstrument} bundle={bundle} />
      {notice || error ? <div className={`system-notice ${error ? 'is-error' : ''}`} role="status">{error || notice}</div> : null}
      {!live ? <IllustrativeSystem active={active} setActive={setActive} setMode={workspace.setMode} />
        : loading && !bundle ? <div className="system-loading system-loading--page">Reading the live engine manifest…</div>
          : bundle ? (
            <>
              {active === 'setup' ? <SetupView bundle={bundle} selectedBlueprintId={selected.blueprints} onApplyBlueprint={applySelectedSwarm} onOpen={openInstrument} onModels={() => onNavigate('/models')} onLaunch={launchSelectedSwarm} /> : null}
              {active === 'presets' ? <PresetView items={bundle.presets} selectedId={selected.presets} onSelect={(id) => setSelected((value) => ({ ...value, presets: id }))} detail={detail} loading={detailLoading} editor={editor} setEditor={setEditor} onSave={savePreset} onNext={() => openInstrument('templates')} /> : null}
              {active === 'templates' ? <TemplateView items={bundle.templates} presets={bundle.presets} manifest={bundle.manifest} executionAllowedHarnesses={bundle.executionAllowedHarnesses} selectedId={selected.templates} onSelect={(id) => setSelected((value) => ({ ...value, templates: id }))} detail={detail} loading={detailLoading} editor={editor} setEditor={setEditor} onSave={saveTemplate} onNext={() => openInstrument('blueprints')} /> : null}
              {active === 'blueprints' ? <BlueprintView items={bundle.blueprints} templates={bundle.templates} selectedId={selected.blueprints} onSelect={(id) => { setSelected((value) => ({ ...value, blueprints: id })); try { window.localStorage.setItem(SELECTED_BLUEPRINT_KEY, id); } catch { /* ignore */ } }} detail={detail} estimate={estimate} loading={detailLoading} editor={editor} setEditor={setEditor} onSave={saveBlueprint} onNext={launchSelectedSwarm} /> : null}
              {active === 'memory' ? <MemoryView basePolicyRecord={bundle.memoryPolicy} stats={bundle.memoryStats} resources={{ projects: bundle.snapshot?.projects || [], runs: bundle.snapshot?.runs || [], blueprints: bundle.blueprints, presets: bundle.presets }} busy={loading} onSave={(value, scope, scopeId) => mutate('Save memory policy', () => scope === 'run' ? aosApi.patchRun(scopeId, 'memory', value, 'Changed in System Studio') : aosApi.setMemoryPolicy(value, scope, scopeId))} onUnset={(scope, scopeId) => { if (!window.confirm(`Remove the ${scope} memory layer? Effective memory will fall back to its outer policy.`)) return Promise.resolve(null); return mutate('Remove memory policy layer', () => aosApi.unsetSetting('memory', scope, scopeId)); }} /> : null}
              {active === 'settings' ? <SettingsView manifest={bundle.manifest} selectedKey={selected.settings} setSelectedKey={(key) => setSelected((value) => ({ ...value, settings: key }))} effective={detail} busy={loading} onReloadEffective={(key) => aosApi.effectiveSetting(key).then(setDetail)} onSave={(key, value, scope, scopeId) => mutate('Save setting layer', () => aosApi.setSetting(key, value, scope, scopeId))} onUnset={(key, scope, scopeId) => { if (window.confirm(`Remove ${key} from the ${scope} layer? The value will fall back to its outer layer.`)) mutate('Remove setting layer', () => aosApi.unsetSetting(key, scope, scopeId)); }} /> : null}
            </>
          ) : <div className="system-failure"><h2>Live engine unavailable.</h2><p>{error || workspace.error || 'Start the local engine, then reload this route.'}</p><button type="button" className="system-button" onClick={loadBundle}>Retry connection</button></div>}
    </div>
  );
}
