import { fingerprint, newId, nowIso } from './ids.js';
import { AosError, invalid, notFound } from './schema.js';

const CLAIMED = 'claimed';
const RECOVERABLE = 'recoverable';
const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back']);
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 15 * 60_000;
const FINGERPRINT = /^[a-f0-9]{16,64}$/i;

function clone(value) {
  return structuredClone(value);
}

function requiredString(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw invalid(`${field} must be 1 to ${max} characters`, { field });
  }
  return value.trim();
}

function exactFingerprint(value, field) {
  const normalized = requiredString(value, field, 64);
  if (!FINGERPRINT.test(normalized)) throw invalid(`${field} must be a hexadecimal fingerprint`, { field });
  return normalized.toLowerCase();
}

function leaseMs(value) {
  const normalized = value == null ? DEFAULT_LEASE_MS : Number(value);
  if (!Number.isInteger(normalized) || normalized < 1_000 || normalized > MAX_LEASE_MS) {
    throw invalid(`leaseMs must be an integer between 1000 and ${MAX_LEASE_MS}`, { field: 'leaseMs' });
  }
  return normalized;
}

function publicClaim(claim, extra = {}) {
  return { ...clone(claim), ...extra };
}

export class EffectClaimService {
  constructor({ engine, clock = () => Date.now() }) {
    this.engine = engine;
    this.clock = clock;
  }

  #now() {
    return nowIso(this.clock);
  }

  #identity(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('effect identity must be an object');
    const identity = {
      projectId: requiredString(input.projectId, 'projectId'),
      runId: requiredString(input.runId, 'runId'),
      taskId: requiredString(input.taskId, 'taskId'),
      attempt: Number(input.attempt),
      capabilityReference: requiredString(input.capabilityReference, 'capabilityReference'),
      capabilityFingerprint: exactFingerprint(input.capabilityFingerprint, 'capabilityFingerprint'),
      inputFingerprint: exactFingerprint(input.inputFingerprint, 'inputFingerprint'),
      effectType: input.effectType ?? 'workspace_write',
      isolationMode: input.isolationMode ?? 'task_workspace',
      isolationFingerprint: exactFingerprint(input.isolationFingerprint, 'isolationFingerprint'),
      rollbackPlanFingerprint: exactFingerprint(input.rollbackPlanFingerprint, 'rollbackPlanFingerprint'),
    };
    if (!Number.isInteger(identity.attempt) || identity.attempt < 1) throw invalid('attempt must be a positive integer', { field: 'attempt' });
    if (identity.effectType !== 'workspace_write') {
      throw new AosError('effect_type_unsupported', 'Only deterministic task-workspace writes may be claimed', { statusCode: 409 });
    }
    if (identity.isolationMode !== 'task_workspace') {
      throw new AosError('effect_isolation_unsupported', 'Effect claims require task_workspace isolation', { statusCode: 409 });
    }
    const run = this.engine.state.runs.find((item) => item.id === identity.runId);
    const task = this.engine.state.tasks.find((item) => item.id === identity.taskId);
    if (!run) throw notFound('run', identity.runId);
    if (!task) throw notFound('task', identity.taskId);
    if (run.projectId !== identity.projectId || task.projectId !== identity.projectId || task.runId !== identity.runId) {
      throw new AosError('effect_scope_mismatch', 'Effect identity does not match the durable run and task scope', { statusCode: 409 });
    }
    return identity;
  }

  #verifyCapability(identity) {
    const task = this.engine.state.tasks.find((item) => item.id === identity.taskId);
    const current = this.engine.capabilities.resolve(identity.capabilityReference, {
      projectId: identity.projectId,
      roleId: task?.presetId || task?.kind || null,
      workerId: task?.agentId || null,
      runId: identity.runId,
    });
    if (current.fingerprint !== identity.capabilityFingerprint) {
      throw new AosError('effect_capability_mismatch', 'Effect identity does not match the current capability fingerprint', { statusCode: 409 });
    }
    if (!current.permissions.includes('filesystem_write')
      || current.permissions.includes('network')
      || current.permissions.includes('external_actions')) {
      throw new AosError('effect_permission_unsupported', 'Effect claims require filesystem_write without network or external_actions', { statusCode: 409 });
    }
    return current;
  }

  #actionFingerprint(identity) {
    return fingerprint(JSON.stringify(identity));
  }

  #requireClaim(id) {
    const claim = this.engine.state.effectClaims.find((item) => item.id === id);
    if (!claim) throw notFound('effect claim', id);
    return claim;
  }

  #assertOwner(claim, ownerId, fence) {
    if (claim.status !== CLAIMED) throw new AosError('effect_claim_stale', `Effect claim ${claim.id} is not active`, { statusCode: 409 });
    if (claim.ownerId !== ownerId) throw new AosError('effect_claim_owner_mismatch', `Effect claim ${claim.id} belongs to another owner`, { statusCode: 409 });
    if (claim.fence !== fence) throw new AosError('effect_claim_fence_mismatch', `Effect claim ${claim.id} has a newer fencing token`, { statusCode: 409 });
    if (Date.parse(claim.leaseUntil) <= this.clock()) throw new AosError('effect_claim_expired', `Effect claim ${claim.id} lease expired`, { statusCode: 409 });
  }

  approve(input) {
    return this.engine.transact(() => {
      const identity = this.#identity(input);
      this.#verifyCapability(identity);
      const requestId = requiredString(input.requestId, 'requestId');
      const actor = requiredString(input.actor ?? 'operator', 'actor');
      const actionFingerprint = this.#actionFingerprint(identity);
      const existing = this.engine.state.effectApprovals.find((item) => item.requestId === requestId);
      if (existing) {
        if (existing.actionFingerprint !== actionFingerprint || existing.actor !== actor) {
          throw new AosError('effect_approval_request_conflict', `Approval request ${requestId} was already used`, { statusCode: 409 });
        }
        return clone(existing);
      }
      const approval = {
        id: newId('effectApproval'),
        requestId,
        actor,
        decision: 'approved',
        actionFingerprint,
        identity,
        approvedAt: this.#now(),
      };
      this.engine.state.effectApprovals.push(approval);
      this.engine.recordEvent('effect.approved', {
        projectId: identity.projectId,
        runId: identity.runId,
        taskId: identity.taskId,
        actor,
        payload: { approvalId: approval.id, actionFingerprint, capabilityReference: identity.capabilityReference },
      });
      return clone(approval);
    });
  }

  claim(input) {
    return this.engine.transact(() => {
      const identity = this.#identity(input);
      this.#verifyCapability(identity);
      const approvalId = requiredString(input.approvalId, 'approvalId');
      const ownerId = requiredString(input.ownerId, 'ownerId');
      const requestId = requiredString(input.requestId, 'requestId');
      const ttl = leaseMs(input.leaseMs);
      const actionFingerprint = this.#actionFingerprint(identity);
      const approval = this.engine.state.effectApprovals.find((item) => item.id === approvalId);
      if (!approval || approval.decision !== 'approved' || approval.actionFingerprint !== actionFingerprint) {
        throw new AosError('effect_approval_mismatch', 'No exact operator approval exists for this effect identity', { statusCode: 409 });
      }
      const existing = this.engine.state.effectClaims.find((item) => item.actionFingerprint === actionFingerprint);
      if (existing) {
        if (TERMINAL.has(existing.status)) return publicClaim(existing, { idempotent: true });
        const live = existing.status === CLAIMED && Date.parse(existing.leaseUntil) > this.clock();
        if (live) {
          if (existing.ownerId === ownerId && existing.requestId === requestId) return publicClaim(existing, { idempotent: true });
          throw new AosError('effect_claim_conflict', 'An active owner already holds this effect claim', { statusCode: 409, details: { claimId: existing.id } });
        }
        existing.status = CLAIMED;
        existing.ownerId = ownerId;
        existing.requestId = requestId;
        existing.fence += 1;
        existing.claimedAt = this.#now();
        existing.leaseUntil = new Date(this.clock() + ttl).toISOString();
        existing.recoveredAt = this.#now();
        this.engine.recordEvent('effect.claim_recovered', {
          projectId: identity.projectId, runId: identity.runId, taskId: identity.taskId,
          payload: { claimId: existing.id, fence: existing.fence, actionFingerprint },
        });
        return publicClaim(existing, { recovered: true });
      }
      const claim = {
        id: newId('effectClaim'),
        approvalId,
        actionFingerprint,
        identity,
        status: CLAIMED,
        ownerId,
        requestId,
        fence: 1,
        claimedAt: this.#now(),
        leaseUntil: new Date(this.clock() + ttl).toISOString(),
        terminalReceiptId: null,
        rollbackReceiptId: null,
      };
      this.engine.state.effectClaims.push(claim);
      this.engine.recordEvent('effect.claimed', {
        projectId: identity.projectId, runId: identity.runId, taskId: identity.taskId,
        payload: { claimId: claim.id, approvalId, fence: claim.fence, actionFingerprint, isolationMode: identity.isolationMode },
      });
      return clone(claim);
    });
  }

  heartbeat(id, { ownerId, fence, leaseMs: requestedLeaseMs } = {}) {
    return this.engine.transact(() => {
      const claim = this.#requireClaim(id);
      this.#assertOwner(claim, requiredString(ownerId, 'ownerId'), Number(fence));
      claim.leaseUntil = new Date(this.clock() + leaseMs(requestedLeaseMs)).toISOString();
      return clone(claim);
    });
  }

  complete(id, input = {}) {
    return this.engine.transact(() => {
      const claim = this.#requireClaim(id);
      const ownerId = requiredString(input.ownerId, 'ownerId');
      const fence = Number(input.fence);
      if (TERMINAL.has(claim.status)) return { claim: clone(claim), receipt: clone(this.engine.state.effectReceipts.find((item) => item.id === claim.terminalReceiptId)), idempotent: true };
      this.#assertOwner(claim, ownerId, fence);
      this.#verifyCapability(claim.identity);
      const status = input.status;
      if (!['succeeded', 'failed'].includes(status)) throw invalid('effect completion status must be succeeded or failed', { field: 'status' });
      const receiptFingerprint = exactFingerprint(input.receiptFingerprint, 'receiptFingerprint');
      const receipt = {
        id: newId('effectReceipt'),
        claimId: claim.id,
        actionFingerprint: claim.actionFingerprint,
        status,
        receiptFingerprint,
        ownerId,
        fence,
        completedAt: this.#now(),
      };
      this.engine.state.effectReceipts.push(receipt);
      claim.status = status;
      claim.terminalReceiptId = receipt.id;
      claim.leaseUntil = null;
      claim.completedAt = receipt.completedAt;
      this.engine.recordEvent('effect.completed', {
        projectId: claim.identity.projectId, runId: claim.identity.runId, taskId: claim.identity.taskId,
        payload: { claimId: claim.id, receiptId: receipt.id, status, fence },
      });
      return { claim: clone(claim), receipt: clone(receipt), idempotent: false };
    });
  }

  rollback(id, input = {}) {
    return this.engine.transact(() => {
      const claim = this.#requireClaim(id);
      const requestId = requiredString(input.requestId, 'requestId');
      const existing = this.engine.state.effectRollbackReceipts.find((item) => item.claimId === id && item.requestId === requestId);
      if (existing) return { claim: clone(claim), receipt: clone(existing), idempotent: true };
      if (claim.status !== 'succeeded') throw new AosError('effect_rollback_unavailable', 'Only a succeeded effect claim may record rollback', { statusCode: 409 });
      const actor = requiredString(input.actor ?? 'operator', 'actor');
      const receipt = {
        id: newId('effectRollbackReceipt'),
        claimId: claim.id,
        requestId,
        actor,
        rollbackPlanFingerprint: claim.identity.rollbackPlanFingerprint,
        receiptFingerprint: exactFingerprint(input.receiptFingerprint, 'receiptFingerprint'),
        status: 'succeeded',
        rolledBackAt: this.#now(),
      };
      this.engine.state.effectRollbackReceipts.push(receipt);
      claim.status = 'rolled_back';
      claim.rollbackReceiptId = receipt.id;
      claim.rolledBackAt = receipt.rolledBackAt;
      this.engine.recordEvent('effect.rolled_back', {
        projectId: claim.identity.projectId, runId: claim.identity.runId, taskId: claim.identity.taskId,
        actor,
        payload: { claimId: claim.id, receiptId: receipt.id },
      });
      return { claim: clone(claim), receipt: clone(receipt), idempotent: false };
    });
  }

  recoverExpired() {
    return this.engine.transact(() => {
      let recovered = 0;
      for (const claim of this.engine.state.effectClaims) {
        if (claim.status !== CLAIMED || Date.parse(claim.leaseUntil) > this.clock()) continue;
        claim.status = RECOVERABLE;
        claim.ownerId = null;
        claim.requestId = null;
        claim.leaseUntil = null;
        claim.recoverableAt = this.#now();
        recovered += 1;
        this.engine.recordEvent('effect.claim_expired', {
          projectId: claim.identity.projectId, runId: claim.identity.runId, taskId: claim.identity.taskId,
          payload: { claimId: claim.id, fence: claim.fence },
        });
      }
      return recovered;
    });
  }

  get(id) {
    this.engine.sync();
    return clone(this.#requireClaim(id));
  }

  list({ runId = null, taskId = null, status = null } = {}) {
    this.engine.sync();
    return this.engine.state.effectClaims
      .filter((item) => !runId || item.identity.runId === runId)
      .filter((item) => !taskId || item.identity.taskId === taskId)
      .filter((item) => !status || item.status === status)
      .map(clone);
  }
}

export const EFFECT_CLAIM_STATUSES = Object.freeze([CLAIMED, RECOVERABLE, ...TERMINAL]);
