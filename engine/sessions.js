import { fingerprint, newId, nowIso } from './ids.js';
import { AosError, invalid, notFound } from './schema.js';

export const HARNESS_SESSION_SCHEMA_VERSION = 1;
export const HARNESS_SESSION_STATUSES = Object.freeze(['active', 'reset', 'expired']);

const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SECRET_SHAPED_REFERENCE = /^(?:sk-|Bearer\b|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const PROVIDER_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function clone(value) {
  return structuredClone(value);
}

function publicView(record) {
  const { harnessReference: _harnessReference, ...safe } = record;
  return clone({ ...safe, referenceStored: Boolean(record.harnessReference) });
}

function assertOpaqueReference(value) {
  if (typeof value !== 'string' || !OPAQUE_REFERENCE.test(value) || SECRET_SHAPED_REFERENCE.test(value)) {
    throw invalid('harnessReference must be an opaque provider identifier, not a token, URL or credential', { field: 'harnessReference' });
  }
  return value;
}

function expiry(createdAt, retentionDays) {
  if (retentionDays == null) return null;
  const days = Number(retentionDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw invalid('retentionDays must be an integer from 1 to 3650 or null', { field: 'retentionDays' });
  }
  return new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
}

export class HarnessSessionRegistry {
  constructor({ engine, clock = () => Date.now() }) {
    this.engine = engine;
    this.clock = clock;
  }

  get records() {
    return this.engine.state.harnessSessions;
  }

  list({ projectId = null, runId = null, taskId = null, provider = null, status = null } = {}) {
    return this.records
      .filter((item) => !projectId || item.projectId === projectId)
      .filter((item) => !runId || item.runId === runId)
      .filter((item) => !taskId || item.taskId === taskId)
      .filter((item) => !provider || item.provider === provider)
      .filter((item) => !status || item.status === status)
      .map(publicView);
  }

  get(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw notFound('harness session', id);
    return publicView(record);
  }

  capture({ provider, harnessReference, projectId, runId, taskId, agentId, roleId = null, attempt, retentionDays = undefined }) {
    const opaque = assertOpaqueReference(harnessReference);
    if (typeof provider !== 'string' || !PROVIDER_ID.test(provider)) throw invalid('provider must be a bounded identifier', { field: 'provider' });
    const digest = fingerprint(`${provider}\0${opaque}`);
    return this.engine.transact(() => {
      const project = this.engine.state.projects.find((item) => item.id === projectId);
      if (!project) throw notFound('project', projectId);
      const run = this.engine.state.runs.find((item) => item.id === runId);
      const task = this.engine.state.tasks.find((item) => item.id === taskId);
      const agent = this.engine.state.agents.find((item) => item.id === agentId);
      if (!run || run.projectId !== projectId) throw new AosError('harness_session_scope_invalid', 'run does not belong to the session project', { statusCode: 409 });
      if (!task || task.runId !== runId) throw new AosError('harness_session_scope_invalid', 'task does not belong to the session run', { statusCode: 409 });
      if (!agent || agent.taskId !== taskId || agent.runId !== runId) throw new AosError('harness_session_scope_invalid', 'agent does not belong to the session task', { statusCode: 409 });
      if (!Number.isInteger(attempt) || attempt < 1) throw invalid('attempt must be a positive integer', { field: 'attempt' });

      const existing = this.records.find((item) => item.provider === provider && item.referenceFingerprint === digest);
      if (existing) {
        const sameScope = existing.projectId === projectId
          && existing.runId === runId
          && existing.taskId === taskId
          && existing.agentId === agentId
          && existing.attempt === attempt;
        if (!sameScope || existing.status !== 'active') {
          throw new AosError('harness_session_scope_conflict', 'provider session reference is already bound or has been reset', {
            statusCode: 409,
            details: { sessionId: existing.id, status: existing.status },
          });
        }
        return publicView(existing);
      }

      const createdAt = nowIso(this.clock);
      const effectiveRetention = retentionDays === undefined ? (project.retentionDays ?? 30) : retentionDays;
      const record = {
        id: newId('harnessSession'),
        schemaVersion: HARNESS_SESSION_SCHEMA_VERSION,
        provider: provider.trim(),
        projectId,
        runId,
        taskId,
        agentId,
        roleId: roleId || null,
        attempt,
        status: 'active',
        harnessReference: opaque,
        referenceFingerprint: digest,
        createdAt,
        expiresAt: expiry(createdAt, effectiveRetention),
        resetAt: null,
        resetBy: null,
        resetReason: null,
      };
      this.records.push(record);
      this.engine.recordEvent('harness_session.created', {
        projectId,
        runId,
        taskId,
        payload: { sessionId: record.id, provider: record.provider, agentId, attempt, expiresAt: record.expiresAt },
      });
      return publicView(record);
    });
  }

  resolve(id, { projectId, runId, taskId, agentId, attempt } = {}) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw notFound('harness session', id);
    if (record.status !== 'active' || !record.harnessReference) {
      throw new AosError('harness_session_inactive', `Harness session ${id} is ${record.status}`, { statusCode: 409 });
    }
    if (record.projectId !== projectId || record.runId !== runId || record.taskId !== taskId || record.agentId !== agentId || record.attempt !== attempt) {
      throw new AosError('harness_session_scope_denied', `Harness session ${id} is outside the requested scope`, { statusCode: 403 });
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.clock()) {
      throw new AosError('harness_session_expired', `Harness session ${id} has expired`, { statusCode: 409 });
    }
    return { id: record.id, provider: record.provider, harnessReference: record.harnessReference };
  }

  reset(id, { actor = 'operator', reason = 'operator reset' } = {}) {
    return this.engine.transact(() => {
      const record = this.records.find((item) => item.id === id);
      if (!record) throw notFound('harness session', id);
      if (record.status !== 'active') return publicView(record);
      record.status = 'reset';
      record.harnessReference = null;
      record.resetAt = nowIso(this.clock);
      record.resetBy = actor || 'operator';
      record.resetReason = String(reason || 'operator reset').slice(0, 500);
      this.engine.recordEvent('harness_session.reset', {
        projectId: record.projectId,
        runId: record.runId,
        taskId: record.taskId,
        payload: { sessionId: record.id, provider: record.provider, actor: record.resetBy, reason: record.resetReason },
      });
      return publicView(record);
    });
  }

  runRetention() {
    const due = this.records.some((item) => item.status === 'active' && item.expiresAt && Date.parse(item.expiresAt) <= this.clock());
    if (!due) return { expired: 0 };
    return this.engine.transact(() => {
      let expired = 0;
      for (const record of this.records) {
        if (record.status !== 'active' || !record.expiresAt || Date.parse(record.expiresAt) > this.clock()) continue;
        record.status = 'expired';
        record.harnessReference = null;
        record.resetAt = nowIso(this.clock);
        record.resetBy = 'retention';
        record.resetReason = 'retention expired';
        expired += 1;
        this.engine.recordEvent('harness_session.expired', {
          projectId: record.projectId,
          runId: record.runId,
          taskId: record.taskId,
          payload: { sessionId: record.id, provider: record.provider },
        });
      }
      return { expired };
    });
  }
}
