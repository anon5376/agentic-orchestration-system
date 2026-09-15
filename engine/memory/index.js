// Memory service: scoped, policy-gated, file-backed memory with lifecycle hooks the engine
// calls (retrieve before a task, absorb worker writes, reflect at run end, retention on
// load) and operator operations (inspect, search, add, correct, pin, forget, clear, promote,
// export, import). Disabled means no retrieval and no writes. Events never carry content.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newId, nowIso } from '../ids.js';
import { AosError, check, invalid, notFound, t } from '../schema.js';
import { redactText } from '../codex.js';
import { MemoryStore } from './store.js';
import { LexicalRetrieval } from './retrieval.js';
import { DEFAULT_MEMORY_POLICY, MEMORY_SCOPES, MEMORY_TYPES, SENSITIVITY_LEVELS, resolveMemoryPolicy } from './policy.js';

export { MEMORY_SCOPES, MEMORY_TYPES, DEFAULT_MEMORY_POLICY, resolveMemoryPolicy };
export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_EXPORT_FORMAT = 'aos-memory/1';

const TAG = /^[a-z0-9][a-z0-9_.-]{0,40}$/;
export const MEMORY_WRITE_SCHEMA = t.object({
  scope: t.enumOf(MEMORY_SCOPES),
  type: t.enumOf(MEMORY_TYPES),
  title: t.string({ minLength: 3, maxLength: 200 }),
  content: t.string({ minLength: 1, maxLength: 20_000 }),
  tags: t.optional(t.array(t.string({ pattern: TAG, patternName: 'tag' }), { maxItems: 20, unique: true })),
  confidence: t.optional(t.number({ min: 0, max: 1 })),
  sensitivity: t.optional(t.enumOf(SENSITIVITY_LEVELS)),
  evidence: t.optional(t.array(t.string({ maxLength: 500 }), { maxItems: 20 })),
  expiresAt: t.optional(t.nullable(t.string({ maxLength: 40 }))),
  supersedes: t.optional(t.nullable(t.string({ maxLength: 60 }))),
});

function stripControl(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += ch;
  }
  return out;
}

function contentHash(title, content) {
  let hash = 0;
  for (const ch of `${title}\n${content}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(16);
}

export class MemoryService {
  constructor({ engine, clock = () => Date.now(), globalDir = null, retrieval = new LexicalRetrieval() } = {}) {
    if (!engine) throw new Error('MemoryService requires an engine');
    this.engine = engine;
    this.clock = clock;
    this.globalDir = globalDir || join(homedir(), '.aos', 'memory');
    this.retrieval = retrieval;
    this.stores = new Map();
    this.diagnostics = { writeFailures: 0, retrievals: 0, writes: 0, lastError: null };
  }

  // ---------- policy ----------

  #setting(scope, scopeId) {
    return (this.engine.state.settings || []).find((item) => item.key === 'memory' && item.scope === scope && (item.scopeId ?? null) === (scopeId ?? null))?.value ?? null;
  }

  setPolicy(scope, scopeId, patch, { actor = 'operator' } = {}) {
    if (!['global', 'project', 'swarm', 'role'].includes(scope)) throw invalid(`memory policy scope must be global, project, swarm or role; got ${scope}`);
    if (this.engine.settings) return this.engine.settings.set('memory', patch, { scope, scopeId: scopeId ?? null, actor });
    throw new Error('settings registry unavailable');
  }

  policyFor({ project = null, run = null, task = null } = {}) {
    const projectId = project?.id ?? run?.projectId ?? this.engine.defaultProject()?.id ?? null;
    return resolveMemoryPolicy({
      globalSetting: this.#setting('global', null),
      projectSetting: projectId ? this.#setting('project', projectId) : null,
      swarmSetting: run?.blueprint?.id ? this.#setting('swarm', run.blueprint.id) : null,
      roleSetting: task?.presetId ? this.#setting('role', task.presetId) : null,
      runPolicy: run?.policies?.memory ?? null,
      taskMemory: task?.memory ?? null,
    });
  }

  // ---------- stores ----------

  #dirFor(scope, namespace) {
    if (scope === 'global') return this.globalDir;
    const base = join(this.engine.store.dataDir, 'memory');
    return join(base, scope === 'project' ? 'project' : scope === 'run' ? 'runs' : scope === 'role' ? 'roles' : scope === 'swarm' ? 'swarms' : 'agents', namespace);
  }

  #store(scope, namespace) {
    const key = `${scope}/${namespace}`;
    if (!this.stores.has(key)) this.stores.set(key, new MemoryStore({ dir: this.#dirFor(scope, namespace), scope, namespace }));
    return this.stores.get(key);
  }

  #existingStores() {
    const found = [];
    const base = join(this.engine.store.dataDir, 'memory');
    const scan = (scope, dir, named) => {
      if (!existsSync(dir)) return;
      if (!named) {
        if (MemoryStore.exists(dir)) found.push(this.#store(scope, scope === 'global' ? 'global' : this.engine.defaultProject()?.id || 'project'));
        return;
      }
      for (const namespace of readdirSync(dir)) if (MemoryStore.exists(join(dir, namespace))) found.push(this.#store(scope, namespace));
    };
    scan('global', this.globalDir, false);
    scan('project', join(base, 'project'), true);
    scan('run', join(base, 'runs'), true);
    scan('role', join(base, 'roles'), true);
    scan('swarm', join(base, 'swarms'), true);
    scan('agent', join(base, 'agents'), true);
    return found;
  }

  namespacesFor(run, task = null) {
    return {
      global: 'global',
      project: run?.projectId ?? this.engine.defaultProject()?.id ?? null,
      swarm: run?.blueprint?.id ?? null,
      run: run?.id ?? null,
      role: task?.presetId ?? null,
      agent: task?.agentId ?? null,
    };
  }

  // ---------- index ----------

  get index() {
    if (!Array.isArray(this.engine.state.memoryIndex)) this.engine.state.memoryIndex = [];
    return this.engine.state.memoryIndex;
  }

  #indexPut(record) {
    const entry = { id: record.id, scope: record.scope, namespace: record.namespace, type: record.type, title: record.title, status: record.status, tombstoned: Boolean(record.tombstoned), supersededBy: record.supersededBy || null, pinned: Boolean(record.pinned), createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt || null };
    const position = this.index.findIndex((item) => item.id === record.id);
    if (position === -1) this.index.push(entry);
    else this.index[position] = entry;
  }

  #locate(id) {
    const entry = this.index.find((item) => item.id === id);
    if (!entry) throw notFound('memory item', id);
    const record = this.#store(entry.scope, entry.namespace).get(id);
    if (!record) throw notFound('memory item', id);
    return { entry, record, store: this.#store(entry.scope, entry.namespace) };
  }

  // ---------- record creation ----------

  #build(input, { scope, namespace, status, provenance, owner }) {
    const errors = check(MEMORY_WRITE_SCHEMA, { ...input, scope });
    if (errors.length) throw invalid(`memory write failed validation: ${errors[0].path} ${errors[0].message}`, { errors });
    const title = stripControl(input.title).trim();
    const content = stripControl(input.content).trim();
    const policy = this.policyFor({});
    if (content.length > (policy.maxContentChars || DEFAULT_MEMORY_POLICY.maxContentChars)) throw invalid(`memory content exceeds ${policy.maxContentChars} characters`, { length: content.length });
    if (redactText(`${title}\n${content}`) !== `${title}\n${content}`) throw new AosError('memory_secret_like', 'memory content looks like a credential or token and was refused', { statusCode: 400 });
    const now = nowIso(this.clock);
    return {
      id: newId('memory'),
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope,
      namespace,
      type: input.type,
      title,
      content,
      hash: contentHash(title, content),
      tags: [...new Set((input.tags || []).map((tag) => String(tag).toLowerCase()))],
      confidence: input.confidence ?? 0.5,
      sensitivity: input.sensitivity || 'normal',
      status,
      owner,
      provenance,
      evidence: input.evidence || [],
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
      pinned: false,
      supersedes: input.supersedes ?? null,
      supersededBy: null,
      tombstoned: false,
      tombstonedAt: null,
      tombstoneReason: null,
    };
  }

  #write(record, { eventType = 'memory.written', extra = {} } = {}) {
    const store = this.#store(record.scope, record.namespace);
    const duplicate = store.all().find((item) => !item.tombstoned && !item.supersededBy && item.hash === record.hash);
    if (duplicate) {
      this.engine.recordEvent('memory.duplicate_skipped', { payload: { scope: record.scope, namespace: record.namespace, itemId: duplicate.id } });
      return { record: duplicate, duplicate: true };
    }
    if (record.supersedes) {
      const old = store.get(record.supersedes);
      if (!old) throw notFound('memory item', record.supersedes);
      old.supersededBy = record.id;
      old.updatedAt = record.createdAt;
      store.put(old);
      this.#indexPut(old);
      this.engine.recordEvent('memory.superseded', { payload: { scope: record.scope, namespace: record.namespace, itemId: old.id, by: record.id } });
    } else {
      const sameTitle = store.all().find((item) => !item.tombstoned && !item.supersededBy && item.status === 'committed' && item.title.toLowerCase() === record.title.toLowerCase());
      if (sameTitle && record.status === 'committed') {
        record.supersedes = sameTitle.id;
        sameTitle.supersededBy = record.id;
        sameTitle.updatedAt = record.createdAt;
        store.put(sameTitle);
        this.#indexPut(sameTitle);
        this.engine.recordEvent('memory.superseded', { payload: { scope: record.scope, namespace: record.namespace, itemId: sameTitle.id, by: record.id, reason: 'same title' } });
      }
    }
    store.put(record);
    this.#indexPut(record);
    this.diagnostics.writes += 1;
    this.engine.recordEvent(eventType, { payload: { scope: record.scope, namespace: record.namespace, itemId: record.id, type: record.type, status: record.status, sensitivity: record.sensitivity, ...extra } });
    return { record, duplicate: false };
  }

  // ---------- lifecycle hooks ----------

  retrieveForTask(run, task, { query = null } = {}) {
    const policy = this.policyFor({ run, task });
    if (!policy.enabled || !policy.read) return { enabled: false, items: [], text: null, policy };
    const namespaces = this.namespacesFor(run, task);
    const goal = this.engine.state.goals.find((item) => item.id === run.goalId);
    const text = query ?? [task.brief || task.summary || task.title, goal?.prompt || ''].join('\n');
    const candidates = [];
    for (const scope of policy.scopes) {
      const namespace = namespaces[scope];
      if (!namespace) continue;
      const store = this.#store(scope, namespace);
      if (!MemoryStore.exists(store.dir)) continue;
      for (const item of store.live()) {
        if (item.expiresAt && Date.parse(item.expiresAt) < this.clock()) continue;
        candidates.push(item);
      }
    }
    const { selected, truncated } = this.retrieval.search(candidates, { query: text, limit: policy.maxItemsPerQuery, maxChars: policy.maxCharsPerQuery, now: this.clock() });
    const items = selected.map((entry) => entry.item);
    this.diagnostics.retrievals += 1;
    this.engine.recordEvent('memory.retrieved', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { count: items.length, truncated, considered: candidates.length, itemIds: items.map((item) => item.id), provider: this.retrieval.id } });
    const rendered = items.length
      ? items.map((item) => `- [${item.id}] ${item.scope}/${item.type}, confidence ${item.confidence}, from ${item.provenance?.runId ? `run ${item.provenance.runId}` : item.provenance?.source || 'operator'}${item.pinned ? ', pinned' : ''}: ${item.title}. ${item.content}`).join('\n')
      : 'Memory is enabled but nothing relevant was found.';
    return { enabled: true, items, text: rendered, truncated, policy };
  }

  absorbWrites(run, task, writes, { source = 'worker' } = {}) {
    const policy = this.policyFor({ run, task });
    const report = { written: [], proposed: [], skipped: [], failed: [] };
    if (!Array.isArray(writes) || !writes.length) return report;
    if (!policy.enabled || !policy.write) {
      this.engine.recordEvent('memory.write_skipped', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { count: writes.length, reason: policy.enabled ? 'writes disabled' : 'memory disabled' } });
      report.skipped = writes.map((item) => ({ title: item?.title ?? null, reason: policy.enabled ? 'writes disabled' : 'memory disabled' }));
      return report;
    }
    const namespaces = this.namespacesFor(run, task);
    for (const write of writes) {
      try {
        const scope = write?.scope;
        if (!policy.scopes.includes(scope) || !namespaces[scope]) {
          report.skipped.push({ title: write?.title ?? null, reason: `scope ${scope} not allowed` });
          this.engine.recordEvent('memory.write_skipped', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { reason: `scope ${scope} not allowed` } });
          continue;
        }
        if (scope === 'global' && source === 'worker') {
          report.skipped.push({ title: write?.title ?? null, reason: 'workers cannot write global memory; propose a promotion' });
          continue;
        }
        const status = policy.autoCommitScopes.includes(scope) ? 'committed' : 'proposed';
        const record = this.#build(write, {
          scope,
          namespace: namespaces[scope],
          status,
          owner: { role: task.presetId ?? null, agentId: task.agentId ?? null },
          provenance: { projectId: run.projectId, runId: run.id, taskId: task.id, attempt: task.attempts, source },
        });
        const { record: stored, duplicate } = this.#write(record, { eventType: status === 'committed' ? 'memory.written' : 'memory.proposed', extra: { taskId: task.id } });
        if (duplicate) report.skipped.push({ title: record.title, reason: 'duplicate', itemId: stored.id });
        else (status === 'committed' ? report.written : report.proposed).push(stored.id);
      } catch (error) {
        this.diagnostics.writeFailures += 1;
        this.diagnostics.lastError = error.message;
        report.failed.push({ title: write?.title ?? null, code: error.code || 'error', message: error.message });
        this.engine.recordEvent('memory.write_failed', { projectId: run.projectId, runId: run.id, taskId: task.id, payload: { code: error.code || 'error', message: String(error.message).slice(0, 200) } });
      }
    }
    return report;
  }

  reflectRun(run) {
    const policy = this.policyFor({ run });
    if (!policy.enabled || !policy.write || !policy.reflect || !policy.scopes.includes('run')) return null;
    const decision = this.engine.state.decisions.find((item) => item.runId === run.id);
    const tasks = this.engine.state.tasks.filter((item) => item.runId === run.id);
    const counts = tasks.reduce((total, item) => { total[item.status] = (total[item.status] || 0) + 1; return total; }, {});
    const content = [
      `Run ${run.id} ended ${run.status}.`,
      decision ? `Decision: ${decision.conclusion} (confidence ${decision.confidence}). Objection: ${decision.objection}` : 'No decision was recorded.',
      `Tasks: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(', ')}.`,
    ].join(' ');
    try {
      const record = this.#build({ type: 'summary', title: `Run summary ${run.id}`, content, tags: ['run-summary', run.status], confidence: decision ? Number(decision.confidence) || 0.5 : 0.3 }, {
        scope: 'run', namespace: run.id, status: 'committed', owner: { role: null, agentId: null }, provenance: { projectId: run.projectId, runId: run.id, taskId: null, attempt: null, source: 'reflection' },
      });
      const { record: stored } = this.#write(record, { eventType: 'memory.reflected' });
      return stored;
    } catch (error) {
      this.diagnostics.writeFailures += 1;
      this.engine.recordEvent('memory.write_failed', { projectId: run.projectId, runId: run.id, payload: { code: error.code || 'error', message: String(error.message).slice(0, 200), stage: 'reflect' } });
      return null;
    }
  }

  // ---------- operator operations ----------

  inspect(id) {
    return this.#locate(id).record;
  }

  search({ scope = null, namespace = null, query = '', tags = [], limit = 20, includeProposed = false, includeInactive = false } = {}) {
    const stores = scope ? [this.#store(scope, namespace ?? (scope === 'global' ? 'global' : this.engine.defaultProject()?.id))] : this.#existingStores();
    const items = [];
    for (const store of stores) {
      if (!MemoryStore.exists(store.dir)) continue;
      for (const item of store.all()) {
        if (!includeInactive && (item.tombstoned || item.supersededBy)) continue;
        if (!includeProposed && item.status !== 'committed') continue;
        items.push(item);
      }
    }
    const { selected, truncated } = this.retrieval.search(items, { query, tags, limit, maxChars: Number.MAX_SAFE_INTEGER, now: this.clock(), minScore: query || tags.length ? 0 : -1 });
    return { items: selected.map((entry) => ({ ...entry.item, score: Number(entry.score.toFixed(3)) })), truncated, considered: items.length };
  }

  add(scope, namespace, input, { actor = 'operator' } = {}) {
    const record = this.#build(input, { scope, namespace, status: 'committed', owner: { role: null, agentId: null }, provenance: { projectId: scope === 'project' ? namespace : null, runId: scope === 'run' ? namespace : null, taskId: null, attempt: null, source: actor } });
    return this.engine.transact(() => this.#write(record, { extra: { actor } }).record);
  }

  correct(id, patch, { actor = 'operator' } = {}) {
    const { record } = this.#locate(id);
    if (record.tombstoned) throw new AosError('memory_tombstoned', `memory item ${id} is tombstoned`, { statusCode: 409 });
    const replacement = this.#build({ type: patch.type ?? record.type, title: patch.title ?? record.title, content: patch.content ?? record.content, tags: patch.tags ?? record.tags, confidence: patch.confidence ?? record.confidence, sensitivity: patch.sensitivity ?? record.sensitivity, evidence: patch.evidence ?? record.evidence, expiresAt: patch.expiresAt === undefined ? record.expiresAt : patch.expiresAt, supersedes: id }, { scope: record.scope, namespace: record.namespace, status: record.status, owner: record.owner, provenance: { ...record.provenance, source: actor, correctedFrom: id } });
    return this.engine.transact(() => this.#write(replacement, { eventType: 'memory.corrected', extra: { actor, from: id } }).record);
  }

  commit(id, { actor = 'curator' } = {}) {
    return this.engine.transact(() => {
      const { record, store } = this.#locate(id);
      if (record.status === 'committed') return record;
      record.status = 'committed';
      record.updatedAt = nowIso(this.clock);
      store.put(record);
      this.#indexPut(record);
      this.engine.recordEvent('memory.committed', { payload: { scope: record.scope, namespace: record.namespace, itemId: id, actor } });
      return record;
    });
  }

  pin(id, pinned = true, { actor = 'operator' } = {}) {
    return this.engine.transact(() => {
      const { record, store } = this.#locate(id);
      record.pinned = Boolean(pinned);
      record.updatedAt = nowIso(this.clock);
      store.put(record);
      this.#indexPut(record);
      this.engine.recordEvent(pinned ? 'memory.pinned' : 'memory.unpinned', { payload: { scope: record.scope, namespace: record.namespace, itemId: id, actor } });
      return record;
    });
  }

  forget(id, reason = 'forgotten by operator', { actor = 'operator' } = {}) {
    return this.engine.transact(() => {
      const { record, store } = this.#locate(id);
      if (record.pinned && actor !== 'operator') throw new AosError('memory_pinned', `memory item ${id} is pinned; only the operator may forget it`, { statusCode: 409 });
      record.tombstoned = true;
      record.tombstonedAt = nowIso(this.clock);
      record.tombstoneReason = String(reason).slice(0, 200);
      record.updatedAt = record.tombstonedAt;
      store.put(record);
      this.#indexPut(record);
      this.engine.recordEvent('memory.tombstoned', { payload: { scope: record.scope, namespace: record.namespace, itemId: id, actor } });
      return record;
    });
  }

  // Destructive: without an explicit confirmation this creates a proposal for the approval gate.
  clearScope(scope, namespace, { confirm = false, actor = 'operator', reason = 'clear scope' } = {}) {
    if (!MEMORY_SCOPES.includes(scope)) throw invalid(`unknown memory scope ${scope}`);
    if (!confirm) {
      return this.engine.transact(() => {
        const proposal = { id: newId('proposal'), projectId: this.engine.defaultProject()?.id ?? null, runId: null, createdAt: nowIso(this.clock), status: 'proposed', decidedAt: null, type: 'memory_clear', title: `Clear ${scope} memory ${namespace}`, change: reason, payload: { scope, namespace }, selfModification: false, proposedBy: actor };
        this.engine.state.proposals.push(proposal);
        this.engine.recordEvent('proposal.created', { payload: { proposalId: proposal.id, type: proposal.type } });
        return { proposed: true, proposalId: proposal.id };
      });
    }
    return this.engine.transact(() => this.#applyClear({ scope, namespace }, actor));
  }

  #applyClear({ scope, namespace }, actor) {
    const store = this.#store(scope, namespace);
    if (!MemoryStore.exists(store.dir)) return { cleared: 0 };
    const now = nowIso(this.clock);
    let cleared = 0;
    for (const item of store.all()) {
      if (item.tombstoned) continue;
      item.tombstoned = true;
      item.tombstonedAt = now;
      item.tombstoneReason = 'scope cleared';
      item.updatedAt = now;
      store.put(item);
      this.#indexPut(item);
      cleared += 1;
    }
    store.compact((item) => false);
    for (let position = this.index.length - 1; position >= 0; position -= 1) {
      if (this.index[position].scope === scope && this.index[position].namespace === namespace) this.index.splice(position, 1);
    }
    this.engine.recordEvent('memory.cleared', { payload: { scope, namespace, cleared, actor } });
    return { cleared };
  }

  // Promotion between scopes follows the policy: auto, curator, approval, or never.
  promote(id, toScope, { actor = 'operator', reason = null } = {}) {
    const { record } = this.#locate(id);
    if (!MEMORY_SCOPES.includes(toScope)) throw invalid(`unknown memory scope ${toScope}`);
    if (record.sensitivity === 'sensitive') throw new AosError('memory_sensitive', 'sensitive items never promote', { statusCode: 409, details: { itemId: id } });
    if (record.tombstoned || record.supersededBy) throw new AosError('memory_inactive', 'only active items promote', { statusCode: 409, details: { itemId: id } });
    const policy = this.policyFor({});
    const mode = policy.promotion[`${record.scope}_to_${toScope}`] || 'never';
    const namespace = toScope === 'global' ? 'global' : toScope === 'project' ? (record.provenance?.projectId || this.engine.defaultProject()?.id) : toScope === 'run' ? record.provenance?.runId : toScope === 'role' ? record.owner?.role : toScope === 'swarm' ? record.provenance?.blueprintId : record.owner?.agentId;
    if (!namespace) throw invalid(`no ${toScope} namespace can be derived for item ${id}`);
    if (mode === 'never') throw new AosError('memory_promotion_denied', `promotion ${record.scope} -> ${toScope} is not allowed by policy`, { statusCode: 409 });
    // Curator-gated promotions: a curator or the operator applies them; anyone else gets a proposal.
    if (mode === 'approval' || (mode === 'curator' && !['operator', 'curator'].includes(actor))) {
      return this.engine.transact(() => {
        const proposal = { id: newId('proposal'), projectId: record.provenance?.projectId ?? this.engine.defaultProject()?.id ?? null, runId: record.provenance?.runId ?? null, createdAt: nowIso(this.clock), status: 'proposed', decidedAt: null, type: 'memory_promotion', title: `Promote memory ${id} to ${toScope}`, change: reason || `Promote "${record.title}" from ${record.scope} to ${toScope}`, payload: { itemId: id, toScope, namespace }, selfModification: false, proposedBy: actor };
        this.engine.state.proposals.push(proposal);
        this.engine.recordEvent('proposal.created', { payload: { proposalId: proposal.id, type: proposal.type } });
        return { proposed: true, proposalId: proposal.id };
      });
    }
    return this.engine.transact(() => this.#applyPromotion({ itemId: id, toScope, namespace }, actor));
  }

  #applyPromotion({ itemId, toScope, namespace }, actor) {
    const { record } = this.#locate(itemId);
    const copy = { ...record, id: newId('memory'), scope: toScope, namespace, status: 'committed', createdAt: nowIso(this.clock), updatedAt: nowIso(this.clock), pinned: false, supersedes: null, supersededBy: null, provenance: { ...record.provenance, promotedFrom: itemId, promotedBy: actor } };
    const { record: stored } = this.#write(copy, { eventType: 'memory.promoted', extra: { from: itemId, fromScope: record.scope, actor } });
    return stored;
  }

  applyProposal(proposal, { actor = 'operator' } = {}) {
    if (proposal.type === 'memory_promotion') return this.#applyPromotion(proposal.payload, actor);
    if (proposal.type === 'memory_clear') return this.#applyClear(proposal.payload, actor);
    throw invalid(`memory cannot apply proposal type ${proposal.type}`);
  }

  // ---------- retention and export ----------

  #projectIdForStore(store) {
    if (store.scope === 'project') return store.namespace;
    if (store.scope === 'run') return this.engine.state.runs.find((item) => item.id === store.namespace)?.projectId ?? this.engine.defaultProject()?.id ?? null;
    return this.engine.defaultProject()?.id ?? null;
  }

  runRetention({ now = this.clock() } = {}) {
    const report = [];
    for (const store of this.#existingStores()) {
      const policy = this.policyFor({ project: { id: this.#projectIdForStore(store) } });
      const retentionDays = policy.retentionDays?.[store.scope] ?? null;
      let expired = 0;
      let evicted = 0;
      const nowIsoText = nowIso(() => now);
      for (const item of store.all()) {
        if (item.tombstoned) continue;
        const explicit = item.expiresAt ? Date.parse(item.expiresAt) < now : false;
        const aged = retentionDays != null && !item.pinned ? Date.parse(item.createdAt) + retentionDays * 86_400_000 < now : false;
        if (explicit || aged) {
          item.tombstoned = true;
          item.tombstonedAt = nowIsoText;
          item.tombstoneReason = explicit ? 'expired' : `older than ${retentionDays} days`;
          item.updatedAt = nowIsoText;
          store.put(item);
          this.#indexPut(item);
          expired += 1;
        }
      }
      const limit = policy.maxItemsPerScope?.[store.scope] ?? null;
      if (limit != null) {
        const live = store.live().filter((item) => !item.pinned).sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const excess = store.live().length - limit;
        for (const item of live.slice(0, Math.max(0, excess))) {
          item.tombstoned = true;
          item.tombstonedAt = nowIsoText;
          item.tombstoneReason = `evicted: scope over ${limit} items`;
          item.updatedAt = nowIsoText;
          store.put(item);
          this.#indexPut(item);
          evicted += 1;
        }
      }
      if (expired || evicted) {
        const keepUntil = now - 7 * 86_400_000;
        store.compact((item) => !item.tombstoned || Date.parse(item.tombstonedAt || item.updatedAt) > keepUntil);
        this.engine.recordEvent('memory.retention', { payload: { scope: store.scope, namespace: store.namespace, expired, evicted } });
        report.push({ scope: store.scope, namespace: store.namespace, expired, evicted });
      }
    }
    if (report.length) this.engine.transact(() => { /* persist index changes */ });
    return report;
  }

  exportScope(scope, namespace, { includeInactive = false } = {}) {
    const store = this.#store(scope, namespace);
    const items = MemoryStore.exists(store.dir) ? store.all().filter((item) => includeInactive || (!item.tombstoned && !item.supersededBy)) : [];
    return { format: MEMORY_EXPORT_FORMAT, exportedAt: nowIso(this.clock), scope, namespace, items };
  }

  importScope(payload, { actor = 'import', scope = null, namespace = null } = {}) {
    if (!payload || payload.format !== MEMORY_EXPORT_FORMAT || !Array.isArray(payload.items)) throw invalid(`import payload must have format ${MEMORY_EXPORT_FORMAT} and an items array`);
    const targetScope = scope || payload.scope;
    const targetNamespace = namespace || payload.namespace;
    const report = { imported: [], skipped: [], errors: [] };
    this.engine.transact(() => {
      for (const item of payload.items) {
        try {
          if (item.tombstoned || item.supersededBy) { report.skipped.push({ id: item.id, reason: 'inactive' }); continue; }
          const record = this.#build({ type: item.type, title: item.title, content: item.content, tags: item.tags, confidence: item.confidence, sensitivity: item.sensitivity, evidence: item.evidence, expiresAt: item.expiresAt ?? null }, { scope: targetScope, namespace: targetNamespace, status: item.status === 'committed' ? 'committed' : 'proposed', owner: item.owner || { role: null, agentId: null }, provenance: { ...(item.provenance || {}), source: actor, importedFrom: item.id } });
          const { record: stored, duplicate } = this.#write(record, { eventType: 'memory.imported' });
          if (duplicate) report.skipped.push({ id: item.id, reason: 'duplicate', itemId: stored.id });
          else report.imported.push({ from: item.id, id: stored.id });
        } catch (error) {
          report.errors.push({ id: item?.id ?? null, code: error.code || 'error', message: error.message });
        }
      }
    });
    return report;
  }

  stats() {
    const counts = {};
    for (const entry of this.index) {
      const key = entry.scope;
      counts[key] = counts[key] || { items: 0, committed: 0, proposed: 0, tombstoned: 0, pinned: 0 };
      counts[key].items += 1;
      if (entry.tombstoned) counts[key].tombstoned += 1;
      else if (entry.status === 'committed') counts[key].committed += 1;
      else counts[key].proposed += 1;
      if (entry.pinned) counts[key].pinned += 1;
    }
    return { policy: this.policyFor({}), scopes: counts, diagnostics: { ...this.diagnostics }, retrieval: this.retrieval.id, globalDir: this.globalDir };
  }
}
