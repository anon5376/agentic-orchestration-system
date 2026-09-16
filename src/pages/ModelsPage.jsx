/*
 * THESIS: Models belong to a worker assignment, not a gallery; this route makes
 * the execution seam inspectable and refuses the category-default model grid.
 * OWN-WORLD: Cobalt masthead, void plates, square one-pixel rules, and mono
 * telemetry keep provider truth separate from the operator's editable draft.
 * STORY: The operator sees what can run, selects one saved worker, reviews only
 * its harness/model/effort delta, then commits a fork or immutable version.
 * FIRST VIEWPORT: Runtime truth leads; the worker index, assignment facts, and
 * focused editor share the work field, with Review changes before Save.
 * FORM: Operate / configuration index + selected object + inspector; compact
 * table plates carry provider and policy detail below the assignment seam.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../app/WorkspaceContext';
import { aosApi } from '../lib/aosApi';
import '../styles/models.css';

const KNOWN_HARNESSES = ['local', 'codex', 'claude', 'api', 'ollama', 'command'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const PREVIEW_PROVIDERS = [
  {
    id: 'local',
    name: 'Deterministic local worker',
    authType: 'none',
    configured: true,
    liveExecutionEnabled: false,
    readiness: { status: 'preview_only' },
    note: 'Illustrative route only. The local acceptance worker does not execute from preview mode.',
  },
  {
    id: 'codex',
    name: 'Codex',
    authType: 'cli_session',
    configured: false,
    liveExecutionEnabled: false,
    readiness: { status: 'not_live' },
    note: 'AOS does not store the CLI session. Live execution is verified by the local engine.',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    authType: 'cli_session',
    configured: false,
    liveExecutionEnabled: false,
    readiness: { status: 'not_live' },
    note: 'Account login is typed but its live adapter is not mounted in this MVP.',
  },
  {
    id: 'api',
    name: 'Generic HTTP worker',
    authType: 'unsupported_oauth',
    configured: false,
    liveExecutionEnabled: false,
    readiness: { status: 'not_live' },
    note: 'Arbitrary API OAuth is not implemented; configurations fail closed at dispatch.',
  },
];

const PREVIEW_TEMPLATES = [
  {
    id: 'default-lead',
    name: 'Default lead',
    description: 'Illustrative lead assignment for planning and delegation.',
    version: 1,
    builtin: true,
    headVersion: 1,
    config: { preset: { id: 'lead-investigator', version: null }, harness: { id: 'local', model: null, effort: null, fallback: [] } },
  },
  {
    id: 'default-researcher',
    name: 'Default researcher',
    description: 'Illustrative source scout with a read-only boundary.',
    version: 1,
    builtin: true,
    headVersion: 1,
    config: { preset: { id: 'researcher-source-scout', version: null }, harness: { id: 'local', model: null, effort: null, fallback: [] } },
  },
  {
    id: 'default-critic',
    name: 'Default critic',
    description: 'Illustrative adversarial review assignment.',
    version: 1,
    builtin: true,
    headVersion: 1,
    config: { preset: { id: 'adversarial-critic', version: null }, harness: { id: 'local', model: null, effort: null, fallback: [] } },
  },
  {
    id: 'default-bulk',
    name: 'Default bulk worker',
    description: 'Illustrative mechanical worker on the cheapest configured harness.',
    version: 1,
    builtin: true,
    headVersion: 1,
    config: { preset: { id: 'low-cost-bulk-worker', version: null }, harness: { id: 'local', model: null, effort: null, fallback: [] } },
  },
];

function statusLabel(value) {
  return String(value || 'unknown').replaceAll('_', ' ').toUpperCase();
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizedProvider(item) {
  const readiness = item?.readiness;
  return {
    ...item,
    id: String(item?.id || 'unknown'),
    name: item?.name || item?.id || 'Unnamed provider',
    authType: item?.authType || item?.auth?.type || 'unknown',
    configured: Boolean(item?.configured),
    liveExecutionEnabled: Boolean(item?.live?.enabled ?? item?.liveExecutionEnabled),
    readinessStatus: typeof readiness === 'string' ? readiness : readiness?.status || item?.status || 'not_live',
    runnable: Boolean(item?.runnable),
    implementationStatus: item?.implementation?.status || 'unknown',
    note: item?.note || 'No provider note was published by the engine.',
  };
}

function normalizedTemplate(source = {}) {
  const config = source.config || null;
  const harness = config?.harness || {};
  const engineAssignment = source.assignment || {};
  return {
    ...source,
    id: String(source.id || 'unknown-worker'),
    name: source.name || source.id || 'Unnamed worker',
    description: source.description || 'No description published.',
    builtin: Boolean(source.builtin),
    version: source.version ?? 1,
    headVersion: source.version ?? 1,
    config,
    detailReady: Boolean(config),
    assignment: {
      ...engineAssignment,
      preset: config?.preset?.id || 'not published',
      harness: engineAssignment.harness || harness.id || 'not published',
      model: engineAssignment.model ?? harness.model ?? null,
      effort: engineAssignment.effort ?? harness.effort ?? null,
    },
  };
}

function policySource(record) {
  const provenance = record?.provenance || {};
  return provenance.source || provenance.layer || 'built-in default';
}

function normalizedRegistry(snapshot) {
  const policy = snapshot?.policy || {};
  const execution = snapshot?.execution || snapshot?.runtime || {};
  return {
    preview: false,
    providers: (snapshot?.providers || []).map(normalizedProvider),
    templates: (snapshot?.templates || []).map(normalizedTemplate),
    runtimeMode: snapshot?.mode || execution.mode || 'unknown',
    runtime: execution,
    allowedHarnesses: snapshot?.allowedHarnesses || policy.allowedHarnesses || [],
    allowedModels: snapshot?.allowedModels || policy.allowedModels || {},
    defaultEffort: snapshot?.defaultEffort ?? policy.defaultEffort ?? null,
    constraints: snapshot?.constraints || {},
    harnessSource: policySource(policy.effective?.allowedHarnesses),
    modelSource: policySource(policy.effective?.allowedModels),
    settingWarning: '',
  };
}

function previewRegistry() {
  return {
    preview: true,
    providers: PREVIEW_PROVIDERS.map(normalizedProvider),
    templates: PREVIEW_TEMPLATES.map(normalizedTemplate),
    runtimeMode: 'illustrative',
    runtime: { provider: 'none', model: null, effort: null, sandbox: 'none' },
    allowedHarnesses: ['local', 'codex'],
    allowedModels: { codex: ['gpt-5.6-luna'] },
    defaultEffort: null,
    constraints: { codex: { models: ['gpt-5.6-luna'], efforts: ['max'] } },
    harnessSource: 'Illustrative defaults · not read from the engine',
    modelSource: 'Illustrative defaults · not read from the engine',
    settingWarning: '',
  };
}

function assignmentDraft(worker) {
  const harness = worker?.config?.harness || {};
  return {
    harness: harness.id || worker?.assignment?.harness || 'local',
    model: harness.model || worker?.assignment?.model || '',
    effort: harness.effort || worker?.assignment?.effort || '',
    forkId: slug(`${worker?.id || 'worker'}-custom`),
    forkName: `${worker?.name || 'Worker'} / custom`,
  };
}

function getHarnesses(registry) {
  const values = new Set(KNOWN_HARNESSES);
  (registry?.providers || []).forEach((provider) => values.add(provider.id));
  (registry?.allowedHarnesses || []).forEach((harness) => values.add(harness));
  (registry?.templates || []).forEach((worker) => values.add(worker.assignment?.harness));
  return [...values].filter(Boolean);
}

function providerFor(registry, harness) {
  return registry?.providers?.find((provider) => provider.id === harness) || null;
}

function harnessTruth(registry, harness) {
  if (registry?.preview) return { tone: 'preview', label: 'PREVIEW ONLY', detail: 'No dispatch from illustrative mode.' };
  const allowed = registry?.allowedHarnesses?.includes(harness);
  const provider = providerFor(registry, harness);
  if (!allowed) return { tone: 'blocked', label: 'DISALLOWED BY POLICY', detail: 'Selectable for configuration; dispatch is blocked.' };
  if (!provider) return { tone: 'pending', label: 'ADAPTER PENDING', detail: 'No provider adapter is published for this harness.' };
  if (!provider.runnable) {
    const readiness = statusLabel(provider.readinessStatus);
    return { tone: 'pending', label: readiness === 'NOT LIVE' ? 'ADAPTER PENDING' : readiness, detail: provider.note };
  }
  return { tone: 'ready', label: 'RUNNABLE', detail: provider.note };
}

function savedAssignmentTruth(registry, assignment) {
  if (registry?.preview) return harnessTruth(registry, assignment?.harness);
  const status = assignment?.status || 'not_ready';
  if (status === 'available' && assignment?.runnable) return { tone: 'ready', label: 'RUNNABLE', detail: 'Confirmed by the engine model-control snapshot.' };
  if (status === 'disallowed') return { tone: 'blocked', label: 'DISALLOWED', detail: 'The saved assignment is outside current execution policy.' };
  if (status === 'pending_adapter') return { tone: 'pending', label: 'ADAPTER PENDING', detail: 'Configuration is saved; no runnable adapter is mounted.' };
  return { tone: 'pending', label: statusLabel(status), detail: 'The engine does not currently consider this assignment runnable.' };
}

function draftTruth(registry, draft) {
  if (registry?.preview) return harnessTruth(registry, draft?.harness);
  const harness = draft?.harness;
  if (!registry?.allowedHarnesses?.includes(harness)) return { tone: 'blocked', label: 'DISALLOWED BY POLICY', detail: 'Choose an allowed harness before review.', allowed: false };
  const model = draft?.model?.trim() || null;
  const modelList = modelPolicy(registry, harness);
  if (model && (!modelList.length || !modelList.includes(model))) return { tone: 'blocked', label: 'MODEL DISALLOWED', detail: 'The model is not in this project policy allowlist.', allowed: false };
  const constraint = registry?.constraints?.[harness];
  if (model && Array.isArray(constraint?.models) && !constraint.models.includes(model)) return { tone: 'blocked', label: 'ADAPTER REJECTS MODEL', detail: 'The mounted adapter cannot run this model.', allowed: false };
  const effort = draft?.effort?.trim() || null;
  if (effort && Array.isArray(constraint?.efforts) && !constraint.efforts.includes(effort)) return { tone: 'blocked', label: 'ADAPTER REJECTS EFFORT', detail: 'The mounted adapter cannot run this effort.', allowed: false };
  return { tone: 'pending', label: 'UNVALIDATED DRAFT', detail: 'The engine validates policy and adapter constraints only when you save.', allowed: true };
}

function modelPolicy(registry, harness) {
  const values = registry?.allowedModels?.[harness];
  return Array.isArray(values) ? values : [];
}

function assignmentModelLabel(value) {
  return value || 'provider default';
}

function assignmentEffortLabel(value, registry) {
  return value || registry?.defaultEffort || 'provider default';
}

function Aperture({ active = false, size = 42 }) {
  return (
    <svg className={`models-aperture ${active ? 'is-active' : ''}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="7 4" />
      <path d="M20 1v8M20 31v8M1 20h8M31 20h8" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="20" cy="20" r="3" fill="currentColor" />
    </svg>
  );
}

function Signal({ tone = 'quiet', children }) {
  return <span className={`models-signal models-signal--${tone}`}><i aria-hidden="true" />{children}</span>;
}

function Flag({ value, tone = 'quiet' }) {
  return <span className={`models-flag models-flag--${tone}`}>{value}</span>;
}

function RuntimeStrip({ registry, live, connection }) {
  const runtime = registry.runtime || {};
  const mode = registry.runtimeMode || 'unknown';
  const settingMode = mode === 'codex' ? 'CODEX' : mode === 'local' ? 'LOCAL' : statusLabel(mode);
  return (
    <section className="models-runtime" aria-labelledby="models-runtime-title">
      <div className="models-runtime__lead">
        <p className="models-kicker" id="models-runtime-title">Current runtime</p>
        <strong>{settingMode}</strong>
        <Signal tone={live ? (connection === 'ready' ? 'ready' : 'pending') : 'preview'}>{live ? (connection === 'ready' ? 'ENGINE CONNECTED' : statusLabel(connection)) : 'ILLUSTRATIVE'}</Signal>
      </div>
      <dl className="models-runtime__facts">
        <div><dt>Provider</dt><dd>{runtime.provider || (mode === 'codex' ? 'codex' : mode === 'local' ? 'local' : 'none')}</dd></div>
        <div><dt>Runtime model</dt><dd>{runtime.model || 'not declared'}</dd></div>
        <div><dt>Effort</dt><dd>{runtime.effort || registry.defaultEffort || 'provider default'}</dd></div>
        <div><dt>Sandbox</dt><dd>{runtime.sandbox || 'not declared'}</dd></div>
      </dl>
    </section>
  );
}

function PolicyPlate({ registry }) {
  const harnesses = getHarnesses(registry);
  return (
    <section className="models-policy" aria-labelledby="models-policy-title">
      <div className="models-section-heading">
        <div><p className="models-kicker">Execution policy</p><h2 id="models-policy-title">Allowed harnesses and models</h2></div>
        <p>Policy is a gate, not an adapter. A listed harness may still fail closed until its provider is configured and ready.</p>
      </div>
      <div className="models-policy__grid">
        <div className="models-harness-list" role="list" aria-label="Harness policy">
          {harnesses.map((harness) => {
            const truth = harnessTruth(registry, harness);
            const provider = providerFor(registry, harness);
            return (
              <div className="models-harness-row" role="listitem" key={harness}>
                <div><strong>{harness}</strong><small>{provider?.name || 'No provider record'}</small></div>
                <Flag value={registry.allowedHarnesses?.includes(harness) ? 'ALLOWED' : 'BLOCKED'} tone={registry.preview ? 'preview' : registry.allowedHarnesses?.includes(harness) ? 'ready' : 'blocked'} />
                <Flag value={truth.label} tone={truth.tone} />
                <p>{truth.detail}</p>
              </div>
            );
          })}
        </div>
        <div className="models-model-policy">
          <p className="models-label">Model allowlist</p>
          {harnesses.map((harness) => {
            const models = modelPolicy(registry, harness);
            const allowed = registry.allowedHarnesses?.includes(harness);
            return (
              <div className="models-model-row" key={harness}>
                <span>{harness}</span>
                <p>{models.length ? models.join(' · ') : allowed ? 'provider default / no explicit model list' : 'not available by policy'}</p>
              </div>
            );
          })}
          <small className="models-source">{registry.modelSource}</small>
        </div>
      </div>
    </section>
  );
}

function ProviderTruth({ providers, preview }) {
  return (
    <section className="models-providers" aria-labelledby="models-providers-title">
      <div className="models-section-heading">
        <div><p className="models-kicker">Adapter registry</p><h2 id="models-providers-title">Provider truth</h2></div>
        <p>{preview ? 'Illustrative provider records show the shape of the live registry. No provider is queried or invoked in preview mode.' : 'Read-only provider and adapter state from the local engine. Credentials are never rendered.'}</p>
      </div>
      {providers.length ? (
        <div className="models-provider-table" role="table" aria-label="Provider and adapter truth">
          <div className="models-provider-row models-provider-row--head" role="row">
            <span role="columnheader">Provider / adaptor</span><span role="columnheader">Auth type</span><span role="columnheader">Configured</span><span role="columnheader">Live enabled</span><span role="columnheader">Readiness</span><span role="columnheader">Note</span>
          </div>
          {providers.map((provider) => (
            <div className="models-provider-row" role="row" key={provider.id}>
              <strong role="cell" data-label="Provider / adaptor">{provider.name}<small>{provider.id}</small></strong>
              <span role="cell" data-label="Auth type">{provider.authType}</span>
              <span role="cell" data-label="Configured"><Flag value={provider.configured ? 'YES' : 'NO'} tone={provider.configured ? 'ready' : 'quiet'} /></span>
              <span role="cell" data-label="Live enabled"><Flag value={provider.liveExecutionEnabled ? 'YES' : 'NO'} tone={provider.liveExecutionEnabled ? 'ready' : 'blocked'} /></span>
              <span role="cell" data-label="Readiness"><Flag value={statusLabel(provider.readinessStatus)} tone={provider.readinessStatus === 'available' ? 'ready' : preview ? 'preview' : 'pending'} /></span>
              <p role="cell" data-label="Note">{provider.note}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="models-empty models-empty--inline"><Signal tone="quiet">NO PROVIDER RECORDS</Signal><p>The live engine returned no provider/adaptor records.</p></div>
      )}
    </section>
  );
}

function WorkerIndex({ workers, selectedId, onSelect, loading, preview }) {
  return (
    <aside className="models-worker-index" aria-labelledby="models-worker-index-title">
      <header><div><p className="models-label" id="models-worker-index-title">Saved workers</p><small>{preview ? 'Illustrative registry' : `${workers.length} records`}</small></div><span className="models-count">{String(workers.length).padStart(2, '0')}</span></header>
      {loading ? <div className="models-loading models-loading--index">Reading workers…</div> : workers.length ? (
        <div className="models-worker-list" role="listbox" aria-label="Saved workers">
          {workers.map((worker) => (
            <button type="button" role="option" aria-selected={selectedId === worker.id} className={`models-worker-row ${selectedId === worker.id ? 'is-selected' : ''}`} onClick={() => onSelect(worker.id)} key={worker.id}>
              <span className="models-worker-row__name"><strong>{worker.name}</strong><small>{worker.id} · v{worker.headVersion || worker.version || 1}</small></span>
              <span className="models-worker-row__assignment"><span>{worker.assignment?.preset || 'preset unavailable'}</span><b>{worker.assignment?.harness || 'harness unavailable'}</b><small>{assignmentModelLabel(worker.assignment?.model)} · {assignmentEffortLabel(worker.assignment?.effort, { defaultEffort: null })}</small></span>
              <i aria-hidden="true">{worker.builtin ? 'B' : 'U'}</i>
            </button>
          ))}
        </div>
      ) : <div className="models-empty models-empty--index"><Signal tone="quiet">NO SAVED WORKERS</Signal><p>Nothing is available to assign yet. Open System Studio to create a worker.</p></div>}
    </aside>
  );
}

function AssignmentFacts({ worker, registry, draft, live }) {
  if (!worker) {
    return <section className="models-assignment models-assignment--empty"><Signal tone="quiet">NO WORKER SELECTED</Signal><h2>Select a saved worker.</h2><p>The assignment inspector stays focused on one worker at a time.</p></section>;
  }
  const config = worker.config || {};
  const current = worker.assignment || {};
  const selectedTruth = savedAssignmentTruth(registry, current);
  const selectedModels = modelPolicy(registry, draft?.harness || current.harness);
  return (
    <section className="models-assignment" aria-labelledby="models-assignment-title">
      <header className="models-assignment__head">
        <div><p className="models-kicker">Selected assignment</p><h2 id="models-assignment-title">{worker.name}</h2><small>{worker.id} · version {worker.version || worker.headVersion || 1}</small></div>
        <Signal tone={worker.builtin ? 'quiet' : 'active'}>{worker.builtin ? 'BUILT-IN' : 'CUSTOM'}</Signal>
      </header>
      <p className="models-assignment__description">{worker.description}</p>
      <dl className="models-facts">
        <div><dt>Role preset</dt><dd>{current.preset || config.preset?.id || 'not published'}</dd></div>
        <div><dt>Saved harness</dt><dd>{current.harness || 'not published'}</dd></div>
        <div><dt>Saved model</dt><dd>{assignmentModelLabel(current.model)}</dd></div>
        <div><dt>Saved effort</dt><dd>{assignmentEffortLabel(current.effort, registry)}</dd></div>
        <div><dt>Dispatch truth</dt><dd className={`is-${selectedTruth.tone}`}>{selectedTruth.label}</dd></div>
        <div><dt>Policy models</dt><dd>{selectedModels.length ? selectedModels.join(' · ') : 'no explicit list'}</dd></div>
      </dl>
      <div className="models-assignment__scope">
        <span>Scope</span><strong>Only config.harness changes on save.</strong><p>{live ? 'Selection and draft edits are local until the explicit save action.' : 'Preview values are deterministic and cannot be saved.'}</p>
      </div>
    </section>
  );
}

function AssignmentEditor({ worker, registry, draft, setDraftValue, onReview, onSave, reviewOpen, saveState, live, loading }) {
  if (!worker || !draft) {
    return <aside className="models-editor models-editor--empty"><p className="models-label">Assignment editor</p><h2>Waiting for a worker</h2><p>Select one saved worker to edit its harness, model and effort.</p></aside>;
  }
  const harnesses = getHarnesses(registry);
  const truth = draftTruth(registry, draft);
  const models = modelPolicy(registry, draft.harness);
  const source = worker.assignment || {};
  const assignmentChanged = draft.harness !== source.harness || (draft.model || '') !== (source.model || '') || (draft.effort || '') !== (source.effort || '');
  const identityValid = worker.builtin ? Boolean(slug(draft.forkId) && draft.forkName.trim()) : true;
  const canReview = live && !loading && worker.detailReady && identityValid && truth.allowed !== false && (assignmentChanged || worker.builtin);
  const canSave = canReview && reviewOpen && saveState?.status !== 'saving';
  return (
    <aside className="models-editor" aria-labelledby="models-editor-title">
      <header className="models-editor__head"><div><p className="models-kicker">Focused editor</p><h2 id="models-editor-title">Assignment</h2></div><Signal tone={truth.tone}>{truth.label}</Signal></header>
      <p className="models-editor__instruction">Change how <strong>{worker.name}</strong> is addressed. The rest of the template config remains intact.</p>
      <fieldset disabled={!live || loading || !worker.detailReady || saveState?.status === 'saving'}>
        <legend>Execution seam</legend>
        <label>Harness<select aria-label="Execution harness" value={draft.harness} onChange={(event) => setDraftValue('harness', event.target.value)}>{harnesses.map((harness) => { const itemTruth = harnessTruth(registry, harness); return <option value={harness} key={harness}>{harness} · {itemTruth.label.toLowerCase()}</option>; })}</select></label>
        <p className={`models-editor__status models-editor__status--${truth.tone}`}><strong>{truth.label}</strong> {truth.detail}</p>
        <label>Model override <span>(optional)</span><input aria-label="Model" list="models-allowed-list" value={draft.model} placeholder="provider default" onChange={(event) => setDraftValue('model', event.target.value)} /></label>
        <datalist id="models-allowed-list">{models.map((model) => <option value={model} key={model} />)}</datalist>
        <p className="models-editor__allowlist">Allowed for {draft.harness}: {models.length ? models.join(' · ') : 'no explicit model list; provider default only'}</p>
        <label>Reasoning effort <span>(optional)</span><input aria-label="Reasoning effort" list="models-efforts-list" value={draft.effort} placeholder={registry.defaultEffort || 'provider default'} onChange={(event) => setDraftValue('effort', event.target.value)} /></label>
        <datalist id="models-efforts-list">{EFFORTS.map((effort) => <option value={effort} key={effort} />)}</datalist>
      </fieldset>
      {worker.builtin ? (
        <fieldset disabled={!live || loading || saveState?.status === 'saving'}>
          <legend>Fork identity</legend>
          <label>New worker id<input aria-label="New worker id" value={draft.forkId} onChange={(event) => setDraftValue('forkId', slug(event.target.value))} /></label>
          <label>New worker name<input aria-label="New worker name" value={draft.forkName} onChange={(event) => setDraftValue('forkName', event.target.value)} /></label>
          <p className="models-editor__allowlist">Built-in workers are immutable. One validated save creates the user-owned assignment at fork version 1.</p>
        </fieldset>
      ) : <p className="models-editor__allowlist">Custom worker: save creates version {Number(worker.headVersion || worker.version || 1) + 1}; its id and identity stay unchanged.</p>}
      {!live ? <p className="models-editor__disabled">Preview only · switch to Live / local to edit or save.</p> : null}
      {live && !worker.detailReady ? <p className="models-editor__disabled">Full worker configuration is unavailable. Retry the live registry before saving.</p> : null}
      {reviewOpen ? (
        <section className="models-review" aria-labelledby="models-review-title">
          <p className="models-label" id="models-review-title">Review before save</p>
          <dl><div><dt>Harness</dt><dd>{source.harness || 'provider default'} <b>→</b> {draft.harness}</dd></div><div><dt>Model</dt><dd>{assignmentModelLabel(source.model)} <b>→</b> {assignmentModelLabel(draft.model)}</dd></div><div><dt>Effort</dt><dd>{assignmentEffortLabel(source.effort, registry)} <b>→</b> {assignmentEffortLabel(draft.effort, registry)}</dd></div></dl>
          <p className="models-review__consequence">UNVALIDATED DRAFT. Save asks the engine to validate policy, hard adapter constraints and versioning atomically. Rejection creates no assignment.</p>
        </section>
      ) : null}
      {saveState?.message ? <p className={`models-save-state models-save-state--${saveState.status}`} role="status">{saveState.message}</p> : null}
      <footer className="models-editor__actions">
        <button type="button" className="models-button" disabled={!canReview} onClick={onReview}>{reviewOpen ? 'Review updated draft' : 'Review changes'}</button>
        <button type="button" className="models-button models-button--primary" disabled={!canSave} onClick={onSave}>{saveState?.status === 'saving' ? 'Saving…' : worker.builtin ? 'Save fork assignment' : 'Save new version'}</button>
      </footer>
    </aside>
  );
}

function EmptyState({ title, body, action, onAction, tone = 'quiet' }) {
  return <div className="models-empty models-empty--page"><Signal tone={tone}>{tone === 'error' ? 'ENGINE ERROR' : 'STATE'}</Signal><h2>{title}</h2><p>{body}</p>{action ? <button type="button" className="models-button models-button--primary" onClick={onAction}>{action}</button> : null}</div>;
}

export function ModelsPage({ onNavigate }) {
  const workspace = useWorkspace();
  const live = workspace.mode === 'live';
  const [registry, setRegistry] = useState(previewRegistry);
  const [loadState, setLoadState] = useState({ status: 'preview', error: '' });
  const [selectedId, setSelectedId] = useState(PREVIEW_TEMPLATES[0].id);
  const [draft, setDraft] = useState(() => assignmentDraft(normalizedTemplate(PREVIEW_TEMPLATES[0], PREVIEW_TEMPLATES[0])));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });

  const loadRegistry = useCallback(async () => {
    if (!live) return { ok: false, skipped: true };
    setLoadState({ status: 'loading', error: '' });
    try {
      const next = normalizedRegistry(await aosApi.modelControl());
      setRegistry(next);
      setLoadState({ status: 'ready', error: '' });
      setSelectedId((current) => next.templates.some((worker) => worker.id === current) ? current : next.templates[0]?.id || null);
      return { ok: true, registry: next };
    } catch (error) {
      setLoadState({ status: 'error', error: error.message || 'Could not read the live model registry.' });
      return { ok: false, error };
    }
  }, [live]);

  useEffect(() => {
    if (!live) {
      setRegistry(previewRegistry());
      setLoadState({ status: 'preview', error: '' });
      setSelectedId(PREVIEW_TEMPLATES[0].id);
      setReviewOpen(false);
      setSaveState({ status: 'idle', message: '' });
      return undefined;
    }
    loadRegistry();
    return undefined;
  }, [live, loadRegistry]);

  const selectedWorker = useMemo(() => registry.templates.find((worker) => worker.id === selectedId) || null, [registry.templates, selectedId]);

  useEffect(() => {
    setDraft(selectedWorker ? assignmentDraft(selectedWorker) : null);
    setReviewOpen(false);
  }, [selectedWorker]);

  const selectWorker = (id) => {
    setSelectedId(id);
    setReviewOpen(false);
    setSaveState({ status: 'idle', message: '' });
  };

  const setDraftValue = (key, value) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setReviewOpen(false);
    setSaveState((current) => current.status === 'error' ? { status: 'idle', message: '' } : current);
  };

  const saveAssignment = async () => {
    if (!live || !selectedWorker || !draft) return;
    if (!selectedWorker.detailReady) {
      setSaveState({ status: 'error', message: 'Save blocked: the full worker configuration was not read. Retry the live registry.' });
      return;
    }
    const targetId = selectedWorker.builtin ? slug(draft.forkId) : selectedWorker.id;
    const targetName = selectedWorker.builtin ? draft.forkName.trim() : selectedWorker.name;
    if (!targetId || !targetName) {
      setSaveState({ status: 'error', message: 'Save blocked: a valid user-owned id and name are required for a built-in fork.' });
      return;
    }
    const input = {
      templateId: selectedWorker.id,
      templateVersion: selectedWorker.version,
      harness: draft.harness,
      model: draft.model.trim() || null,
      effort: draft.effort.trim() || null,
      note: 'Assignment edited in Models workspace; all non-harness configuration preserved.',
    };
    if (selectedWorker.builtin) input.fork = { id: targetId, name: targetName, note: input.note };
    setSaveState({ status: 'saving', message: 'Validating policy and recording one versioned assignment…' });
    try {
      const result = await aosApi.assignModel(input);
      const refreshed = await loadRegistry();
      setSelectedId(result.template?.id || targetId);
      setReviewOpen(false);
      setSaveState({
        status: 'success',
        message: refreshed.ok ? `Saved ${result.template?.id || targetId} v${result.template?.version || '?'}. Engine verdict: ${statusLabel(result.assignment?.status)}.` : `Saved ${targetId}, but the registry refresh failed. Retry to verify the new version.`,
      });
    } catch (error) {
      setSaveState({ status: 'error', message: `Save failed: ${error.message || 'the engine rejected this assignment.'}` });
    }
  };

  const title = live ? 'Models live at the worker seam.' : 'Models are assigned at the worker seam.';
  const description = live
    ? 'Inspect provider readiness and policy, then version one worker assignment at a time.'
    : 'Preview of the assignment registry. Connect to the local engine before treating any value as current or editable.';
  const pageError = loadState.status === 'error' || (live && workspace.connection === 'error');
  const connection = live ? workspace.connection : 'illustrative';
  const isLoading = loadState.status === 'loading' || (live && workspace.connection === 'loading');

  return (
    <div className="models-page">
      <header className="models-header">
        <div className="models-header__title"><Aperture active={live && workspace.connection === 'ready'} /><div><p className="models-kicker">Models / harnesses</p><h1>{title}</h1><span>{description}</span></div></div>
        <dl className="models-header__telemetry"><div><dt>Workers</dt><dd>{String(registry.templates.length).padStart(2, '0')}</dd></div><div><dt>Providers</dt><dd>{String(registry.providers.length).padStart(2, '0')}</dd></div><div><dt>Allowed</dt><dd>{String(registry.allowedHarnesses.length).padStart(2, '0')}</dd></div></dl>
      </header>

      {registry.settingWarning ? <div className="models-notice models-notice--warning" role="status">Policy settings partially unavailable: {registry.settingWarning} Defaults shown only where the engine did not respond.</div> : null}
      {pageError ? <div className="models-error" role="alert"><Signal tone="error">LIVE REGISTRY UNAVAILABLE</Signal><p>{loadState.error || workspace.error || 'The local engine did not answer.'}</p><button type="button" className="models-button" onClick={loadRegistry}>Retry live registry</button></div> : null}
      {!pageError ? <>
        <RuntimeStrip registry={registry} live={live} connection={connection} />
        <div className="models-workbench">
          <WorkerIndex workers={registry.templates} selectedId={selectedId} onSelect={selectWorker} loading={isLoading} preview={registry.preview} />
          {registry.templates.length ? <AssignmentFacts worker={selectedWorker} registry={registry} draft={draft} live={live} /> : <EmptyState title="No saved workers in the live registry." body="Create a worker in System Studio, then return here to assign its harness, model and effort." action="Open System Studio" onAction={() => onNavigate?.('/system')} />}
          <AssignmentEditor worker={selectedWorker} registry={registry} draft={draft} setDraftValue={setDraftValue} onReview={() => setReviewOpen(true)} onSave={saveAssignment} reviewOpen={reviewOpen} saveState={saveState} live={live} loading={isLoading} />
        </div>
        <div className="models-navigation"><button type="button" className="models-button" onClick={() => onNavigate?.('/system')}>Open System Studio</button><span>Create workers and change project-wide execution policy in the full configuration workspace.</span></div>
        <PolicyPlate registry={registry} />
        <ProviderTruth providers={registry.providers} preview={registry.preview} />
      </> : null}
    </div>
  );
}

export default ModelsPage;
