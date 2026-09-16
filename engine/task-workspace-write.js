import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fingerprint, nowIso } from './ids.js';
import { AosError, invalid } from './schema.js';
import {
  TASK_WORKSPACE_WRITE_EFFECT,
  TASK_WORKSPACE_WRITE_SOURCE,
  TASK_WORKSPACE_WRITE_TARGET_KIND,
} from './capabilities.js';

// These names are engine-owned implementation details. Neither is accepted
// from a plan, capability, API request, or worker.
export const TASK_WORKSPACE_WRITE_FILE = 'aos-task-workspace-write.json';
export const TASK_WORKSPACE_WRITE_JOURNAL_DIR = 'effect-workspace-journals';
// Version 2 fingerprints raw bytes, not lossy UTF-8 decoding. Version 1
// journals are intentionally not restored because their byte image cannot be
// authenticated safely.
export const TASK_WORKSPACE_WRITE_JOURNAL_VERSION = 2;
export const TASK_WORKSPACE_WRITE_MAX_BYTES = 1024;
export const TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES = 16 * 1024;

const SAFE_COMPONENT = /^[A-Za-z0-9_-]{1,160}$/;

function fail(code, message, details = null) {
  return new AosError(code, message, { statusCode: 409, details });
}

function safeComponent(value, field) {
  if (typeof value !== 'string' || !SAFE_COMPONENT.test(value)) {
    throw invalid(`${field} must be an engine-owned identifier`, { field });
  }
  return value;
}

function contained(root, target, code = 'workspace_write_scope_invalid') {
  const base = resolve(root);
  const candidate = resolve(target);
  const rel = relative(base, candidate);
  if (!rel || rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    if (candidate === base) return candidate;
    throw fail(code, 'Task-workspace write target is outside the engine-owned scope');
  }
  return candidate;
}

function lstat(path, { missing = false } = {}) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (missing && error?.code === 'ENOENT') return null;
    throw fail('workspace_write_filesystem_error', 'Task-workspace write could not inspect an engine-owned file');
  }
}

function assertDirectory(path, code = 'workspace_write_directory_invalid') {
  const stat = lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail(code, 'Task-workspace write requires a real engine-owned directory');
  }
}

function assertRegularOrAbsent(path, code = 'workspace_write_target_invalid') {
  const stat = lstat(path, { missing: true });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail(code, 'Task-workspace write target must be a regular file or absent');
  }
  return stat;
}

function readBoundedRegular(path, limit, code) {
  const stat = assertRegularOrAbsent(path, code);
  if (!stat) return { exists: false, bytes: null, fingerprint: null };
  if (stat.size > limit) throw fail(code, 'Task-workspace write rollback image exceeds the bounded limit');
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    throw fail(code, 'Task-workspace write could not read a regular file');
  }
  if (bytes.length > limit) throw fail(code, 'Task-workspace write rollback image exceeds the bounded limit');
  return { exists: true, bytes, fingerprint: bytesFingerprint(bytes) };
}

function sameBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && left.equals(right);
}

function bytesFingerprint(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  return fingerprint(bytes.toString('base64'));
}

function expectedBytesFromIdentity(identity) {
  const scopeFingerprint = fingerprint(JSON.stringify({
    projectId: identity.projectId,
    runId: identity.runId,
    taskId: identity.taskId,
    attempt: identity.attempt,
  }));
  return Buffer.from(`${JSON.stringify({
    adapter: TASK_WORKSPACE_WRITE_SOURCE,
    version: 1,
    effect: TASK_WORKSPACE_WRITE_EFFECT,
    scopeFingerprint,
  })}\n`, 'utf8');
}

export function taskWorkspaceWriteBytes(scope) {
  const identity = {
    projectId: safeComponent(scope?.projectId, 'projectId'),
    runId: safeComponent(scope?.runId, 'runId'),
    taskId: safeComponent(scope?.taskId, 'taskId'),
    attempt: Number(scope?.attempt),
  };
  if (!Number.isInteger(identity.attempt) || identity.attempt < 1) {
    throw invalid('attempt must be a positive integer', { field: 'attempt' });
  }
  const bytes = expectedBytesFromIdentity(identity);
  if (bytes.length > TASK_WORKSPACE_WRITE_MAX_BYTES) throw fail('workspace_write_input_oversize', 'Task-workspace write input exceeds its bounded limit');
  return bytes;
}

export function taskWorkspaceIsolationFingerprint({ runId, taskId }) {
  return fingerprint(JSON.stringify({
    isolationMode: 'task_workspace',
    runId: safeComponent(runId, 'runId'),
    taskId: safeComponent(taskId, 'taskId'),
  }));
}

export function taskWorkspaceRollbackPlanFingerprint() {
  return fingerprint(JSON.stringify({
    adapter: TASK_WORKSPACE_WRITE_SOURCE,
    version: 1,
    targetKind: TASK_WORKSPACE_WRITE_TARGET_KIND,
    rollback: 'restore_bounded_prior_regular_bytes_or_remove_absent_file',
  }));
}

export function buildTaskWorkspaceWriteIdentity({ projectId, runId, taskId, attempt, capabilityReference, capabilityFingerprint }) {
  const bytes = taskWorkspaceWriteBytes({ projectId, runId, taskId, attempt });
  return {
    projectId: safeComponent(projectId, 'projectId'),
    runId: safeComponent(runId, 'runId'),
    taskId: safeComponent(taskId, 'taskId'),
    attempt: Number(attempt),
    capabilityReference: String(capabilityReference || '').trim(),
    capabilityFingerprint: String(capabilityFingerprint || '').trim().toLowerCase(),
    inputFingerprint: bytesFingerprint(bytes),
    effectType: 'workspace_write',
    isolationMode: 'task_workspace',
    isolationFingerprint: taskWorkspaceIsolationFingerprint({ runId, taskId }),
    rollbackPlanFingerprint: taskWorkspaceRollbackPlanFingerprint(),
  };
}

function assertIdentityAndBytes(identity, expectedBytes) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw invalid('effect identity is required');
  const derived = taskWorkspaceWriteBytes(identity);
  const supplied = Buffer.isBuffer(expectedBytes) ? Buffer.from(expectedBytes) : Buffer.from(expectedBytes || '');
  if (!sameBytes(derived, supplied) || supplied.length > TASK_WORKSPACE_WRITE_MAX_BYTES
    || identity.inputFingerprint !== bytesFingerprint(supplied)
    || identity.isolationFingerprint !== taskWorkspaceIsolationFingerprint(identity)
    || identity.rollbackPlanFingerprint !== taskWorkspaceRollbackPlanFingerprint()) {
    throw fail('workspace_write_identity_mismatch', 'Task-workspace write identity does not match the engine-derived bytes and rollback plan');
  }
  return supplied;
}

function workspacePaths({ workspaceRoot, workspaceDir, identity }) {
  const root = resolve(workspaceRoot || '');
  const runId = safeComponent(identity.runId, 'runId');
  const taskId = safeComponent(identity.taskId, 'taskId');
  assertDirectory(root);
  const runDir = contained(root, join(root, runId));
  assertDirectory(runDir);
  const expectedWorkspace = contained(runDir, join(runDir, taskId));
  assertDirectory(expectedWorkspace);
  if (resolve(workspaceDir || '') !== expectedWorkspace) {
    throw fail('workspace_write_workspace_mismatch', 'Task-workspace write was not given its claimed engine workspace');
  }
  const target = contained(expectedWorkspace, join(expectedWorkspace, TASK_WORKSPACE_WRITE_FILE));
  if (basename(target) !== TASK_WORKSPACE_WRITE_FILE) throw fail('workspace_write_target_invalid', 'Task-workspace write target is not engine-owned');
  return { root, workspace: expectedWorkspace, target };
}

function journalPath(journalRoot, claimId) {
  const root = resolve(journalRoot || '');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDirectory(root, 'workspace_write_journal_root_invalid');
  const path = contained(root, join(root, `${safeComponent(claimId, 'claimId')}.json`), 'workspace_write_journal_scope_invalid');
  return { root, path };
}

function journalFingerprint(journal) {
  return fingerprint(JSON.stringify({
    version: journal.version,
    claimId: journal.claimId,
    actionFingerprint: journal.actionFingerprint,
    ownerId: journal.ownerId,
    fence: journal.fence,
    inputFingerprint: journal.inputFingerprint,
    expectedFingerprint: journal.expectedFingerprint,
    prior: {
      exists: journal.prior.exists,
      fingerprint: journal.prior.fingerprint,
      bytesLength: journal.prior.bytesLength,
    },
  }));
}

function writeAtomic(path, bytes, tempTag) {
  const parent = resolve(path, '..');
  assertDirectory(parent, 'workspace_write_parent_invalid');
  const temp = join(parent, `.${basename(path)}.${safeComponent(tempTag, 'tempTag')}.tmp`);
  const existing = lstat(temp, { missing: true });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw fail('workspace_write_temp_invalid', 'Task-workspace write temporary file is unsafe');
    try { unlinkSync(temp); } catch { throw fail('workspace_write_temp_cleanup_failed', 'Task-workspace write could not clear an engine-owned temporary file'); }
  }
  let fd = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // The destination is checked immediately before replacement. rename() does
    // not follow a destination symlink; it replaces the directory entry.
    assertRegularOrAbsent(path);
    renameSync(temp, path);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try {
      const tempStat = lstat(temp, { missing: true });
      if (tempStat) {
        if (tempStat.isSymbolicLink() || !tempStat.isFile()) throw fail('workspace_write_temp_invalid', 'Task-workspace write temporary file is unsafe');
        unlinkSync(temp);
      }
    } catch (cleanupError) {
      if (cleanupError instanceof AosError) throw cleanupError;
    }
    if (error instanceof AosError) throw error;
    throw fail('workspace_write_apply_failed', 'Task-workspace write could not atomically update the engine-owned file');
  }
}

function loadJournal(path, claim, expectedBytes) {
  const stat = assertRegularOrAbsent(path, 'workspace_write_journal_invalid');
  if (!stat) return null;
  if (stat.size > TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES * 3) {
    throw fail('workspace_write_journal_invalid', 'Task-workspace write journal exceeds its bounded limit');
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw fail('workspace_write_journal_invalid', 'Task-workspace write journal is invalid');
  }
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)
    || journal.version !== TASK_WORKSPACE_WRITE_JOURNAL_VERSION
    || journal.claimId !== claim.id
    || journal.actionFingerprint !== claim.actionFingerprint
    // Owner and fence are historical journal metadata, not its authorization
    // boundary. A legitimate post-expiry claim gets a new fence but must be
    // able to reuse the immutable, bounded prior image. The effect service
    // fences every mutation and completion with the current claim instead.
    || typeof journal.ownerId !== 'string'
    || !Number.isInteger(journal.fence)
    || journal.fence < 1
    || journal.inputFingerprint !== claim.identity.inputFingerprint
    || journal.expectedFingerprint !== bytesFingerprint(expectedBytes)
    || !journal.prior || typeof journal.prior !== 'object' || Array.isArray(journal.prior)
    || typeof journal.prior.exists !== 'boolean'
    || typeof journal.prior.bytesLength !== 'number'
    || typeof journal.prior.fingerprint !== 'string') {
    throw fail('workspace_write_journal_mismatch', 'Task-workspace write journal does not match its fenced claim');
  }
  if (journal.prior.exists) {
    if (typeof journal.prior.bytesBase64 !== 'string') throw fail('workspace_write_journal_invalid', 'Task-workspace write journal is incomplete');
    const bytes = Buffer.from(journal.prior.bytesBase64, 'base64');
    if (bytes.length !== journal.prior.bytesLength || bytes.length > TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES
      || bytesFingerprint(bytes) !== journal.prior.fingerprint) {
      throw fail('workspace_write_journal_invalid', 'Task-workspace write journal prior bytes are invalid');
    }
    journal.prior.bytes = bytes;
  } else if (journal.prior.bytesLength !== 0 || journal.prior.fingerprint !== 'absent' || journal.prior.bytesBase64 !== undefined) {
    throw fail('workspace_write_journal_invalid', 'Task-workspace write journal absence record is invalid');
  }
  return journal;
}

function createJournal(path, claim, prior, expectedBytes, clock) {
  const journal = {
    version: TASK_WORKSPACE_WRITE_JOURNAL_VERSION,
    claimId: claim.id,
    actionFingerprint: claim.actionFingerprint,
    ownerId: claim.ownerId,
    fence: claim.fence,
    inputFingerprint: claim.identity.inputFingerprint,
    expectedFingerprint: bytesFingerprint(expectedBytes),
    prior: prior.exists
      ? {
        exists: true,
        fingerprint: prior.fingerprint,
        bytesLength: prior.bytes.length,
        bytesBase64: prior.bytes.toString('base64'),
      }
      : { exists: false, fingerprint: 'absent', bytesLength: 0 },
    createdAt: nowIso(clock),
  };
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8');
  if (bytes.length > TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES * 3) {
    throw fail('workspace_write_journal_oversize', 'Task-workspace write journal exceeds its bounded limit');
  }
  writeAtomic(path, bytes, claim.id);
  return loadJournal(path, claim, expectedBytes);
}

function targetMatchesPrior(target, prior) {
  const current = readBoundedRegular(target, TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES, 'workspace_write_target_invalid');
  if (current.exists !== prior.exists) return false;
  return !prior.exists || sameBytes(current.bytes, prior.bytes);
}

function targetMatchesExpected(target, expectedBytes) {
  const current = readBoundedRegular(target, TASK_WORKSPACE_WRITE_MAX_BYTES, 'workspace_write_target_invalid');
  return current.exists && sameBytes(current.bytes, expectedBytes);
}

function targetMatchesExpectedSafely(target, expectedBytes) {
  try {
    return targetMatchesExpected(target, expectedBytes);
  } catch {
    return false;
  }
}

function applyReceipt({ claim, journal, status = 'succeeded', receipt = null, idempotent = false, recovered = false }) {
  return {
    claimId: claim.id,
    receiptId: receipt?.id || claim.terminalReceiptId || null,
    status,
    idempotent: Boolean(idempotent),
    recovered: Boolean(recovered),
    adapter: TASK_WORKSPACE_WRITE_SOURCE,
    targetKind: TASK_WORKSPACE_WRITE_TARGET_KIND,
    inputFingerprint: claim.identity.inputFingerprint,
    rollbackPlanFingerprint: claim.identity.rollbackPlanFingerprint,
    priorStateFingerprint: journal.prior.fingerprint,
    receiptFingerprint: receipt?.receiptFingerprint || null,
  };
}

function rollbackReceiptFingerprint(claim, journal) {
  return fingerprint(JSON.stringify({
    actionFingerprint: claim.actionFingerprint,
    rollbackPlanFingerprint: claim.identity.rollbackPlanFingerprint,
    priorStateFingerprint: journal.prior.fingerprint,
    targetKind: TASK_WORKSPACE_WRITE_TARGET_KIND,
  }));
}

function successReceiptFingerprint(claim, journal, expectedBytes) {
  return fingerprint(JSON.stringify({
    actionFingerprint: claim.actionFingerprint,
    inputFingerprint: claim.identity.inputFingerprint,
    outputFingerprint: bytesFingerprint(expectedBytes),
    priorStateFingerprint: journal.prior.fingerprint,
    targetKind: TASK_WORKSPACE_WRITE_TARGET_KIND,
  }));
}

function failureReceiptFingerprint(claim, journal, code) {
  return fingerprint(JSON.stringify({
    actionFingerprint: claim.actionFingerprint,
    priorStateFingerprint: journal?.prior?.fingerprint || 'unavailable',
    targetKind: TASK_WORKSPACE_WRITE_TARGET_KIND,
    status: 'failed',
    code: String(code || 'workspace_write_failed').slice(0, 120),
  }));
}

function checkNotCancelled(signal) {
  if (signal?.aborted) throw Object.assign(fail('effect_cancelled', 'Task-workspace write was cancelled before mutation'), { retryable: false });
}

function requireFn(value, name) {
  if (typeof value !== 'function') throw invalid(`${name} must be a function`, { field: name });
  return value;
}

export class TaskWorkspaceWriteAdapter {
  constructor({ effects, clock = () => Date.now() } = {}) {
    if (!effects || typeof effects.claim !== 'function' || typeof effects.complete !== 'function'
      || typeof effects.rollback !== 'function' || typeof effects.rollbackWith !== 'function') {
      throw new Error('TaskWorkspaceWriteAdapter requires an EffectClaimService');
    }
    this.effects = effects;
    this.clock = clock;
  }

  apply({ identity, approvalId, ownerId, requestId, workspaceRoot, workspaceDir, journalRoot, expectedBytes, signal = null, revalidate, afterMutation = null } = {}) {
    const bytes = assertIdentityAndBytes(identity, expectedBytes);
    const verify = requireFn(revalidate, 'revalidate');
    const paths = workspacePaths({ workspaceRoot, workspaceDir, identity });
    const journals = journalPath(journalRoot, '__journal_probe__');
    // The probe above verifies the root once. The claim id below selects the
    // only journal file that this invocation can read or write.
    void journals;
    checkNotCancelled(signal);
    verify();
    const claim = this.effects.claim({ ...identity, approvalId, ownerId, requestId });
    let journal = null;
    let targetMayHoldExpectedBytes = false;
    try {
      const path = journalPath(journalRoot, claim.id).path;
      const existing = loadJournal(path, claim, bytes);
      journal = existing || createJournal(
        path,
        claim,
        readBoundedRegular(paths.target, TASK_WORKSPACE_WRITE_MAX_ROLLBACK_BYTES, 'workspace_write_target_invalid'),
        bytes,
        this.clock,
      );

      if (claim.status === 'rolled_back') {
        throw fail('effect_already_rolled_back', 'Task-workspace write claim was already rolled back');
      }
      if (claim.status === 'failed') {
        throw fail('effect_already_failed', 'Task-workspace write claim already reached a terminal failure');
      }
      if (claim.status === 'succeeded') {
        if (!targetMatchesExpected(paths.target, bytes)) {
          throw fail('workspace_write_target_integrity', 'Task-workspace write target no longer matches its completed receipt');
        }
        return applyReceipt({ claim, journal, receipt: null, idempotent: true });
      }

      // A heartbeat is a fenced owner check immediately before the mutable path.
      this.effects.heartbeat(claim.id, { ownerId: claim.ownerId, fence: claim.fence });
      checkNotCancelled(signal);
      verify();
      if (targetMatchesExpected(paths.target, bytes)) {
        targetMayHoldExpectedBytes = true;
        verify();
        const completed = this.effects.complete(claim.id, {
          ownerId: claim.ownerId,
          fence: claim.fence,
          status: 'succeeded',
          receiptFingerprint: successReceiptFingerprint(claim, journal, bytes),
        });
        return applyReceipt({ claim: completed.claim, journal, receipt: completed.receipt, idempotent: completed.idempotent, recovered: true });
      }
      if (!targetMatchesPrior(paths.target, journal.prior)) {
        throw fail('workspace_write_target_changed', 'Task-workspace write target changed outside its fenced effect');
      }
      checkNotCancelled(signal);
      verify();
      // Reassert the fence after the last state/capability check. A reclaimed
      // claim cannot cross this boundary into the filesystem mutation path.
      this.effects.heartbeat(claim.id, { ownerId: claim.ownerId, fence: claim.fence });
      targetMayHoldExpectedBytes = true;
      writeAtomic(paths.target, bytes, claim.id);
      if (!targetMatchesExpected(paths.target, bytes)) {
        throw fail('workspace_write_target_integrity', 'Task-workspace write could not verify the engine-owned bytes');
      }
      if (afterMutation !== null) requireFn(afterMutation, 'afterMutation')();
      checkNotCancelled(signal);
      // The service itself re-resolves current capability/test/permission/state
      // while committing this receipt. The immediate callback makes the same
      // boundary explicit for the adapter before completion.
      verify();
      const completed = this.effects.complete(claim.id, {
        ownerId: claim.ownerId,
        fence: claim.fence,
        status: 'succeeded',
        receiptFingerprint: successReceiptFingerprint(claim, journal, bytes),
      });
      return applyReceipt({ claim: completed.claim, journal, receipt: completed.receipt, idempotent: completed.idempotent });
    } catch (error) {
      // Preflight happens after an exact durable claim so the journal can bind
      // its claim id. Close that claim on every pre-mutation refusal. Once
      // exact bytes might have landed, preserve the claim only when the target
      // still proves them byte-for-byte for lifecycle/reload reconciliation.
      const bytesLanded = targetMayHoldExpectedBytes && targetMatchesExpectedSafely(paths.target, bytes);
      if (!bytesLanded) {
        try {
          this.effects.complete(claim.id, {
            ownerId: claim.ownerId,
            fence: claim.fence,
            status: 'failed',
            receiptFingerprint: failureReceiptFingerprint(claim, journal, error?.code),
          });
        } catch {
          // A newer fenced owner or revoked capability cannot be overwritten.
          // Preserve the original error for the caller to handle safely.
        }
      }
      throw error;
    }
  }

  recover({ claim, workspaceRoot, workspaceDir, journalRoot, expectedBytes, revalidate } = {}) {
    if (!claim || claim.status !== 'claimed') return null;
    const bytes = assertIdentityAndBytes(claim.identity, expectedBytes);
    const verify = requireFn(revalidate, 'revalidate');
    const paths = workspacePaths({ workspaceRoot, workspaceDir, identity: claim.identity });
    const journal = loadJournal(journalPath(journalRoot, claim.id).path, claim, bytes);
    if (!journal || !targetMatchesExpected(paths.target, bytes)) return null;
    verify();
    const completed = this.effects.complete(claim.id, {
      ownerId: claim.ownerId,
      fence: claim.fence,
      status: 'succeeded',
      receiptFingerprint: successReceiptFingerprint(claim, journal, bytes),
    });
    return applyReceipt({ claim: completed.claim, journal, receipt: completed.receipt, idempotent: completed.idempotent, recovered: true });
  }

  rollback({ claim, workspaceRoot, workspaceDir, journalRoot, requestId, actor = 'operator', revalidate } = {}) {
    if (!claim || !claim.identity) throw invalid('claim is required', { field: 'claim' });
    const bytes = taskWorkspaceWriteBytes(claim.identity);
    const verify = requireFn(revalidate, 'revalidate');
    const paths = workspacePaths({ workspaceRoot, workspaceDir, identity: claim.identity });
    const journal = loadJournal(journalPath(journalRoot, claim.id).path, claim, bytes);
    if (!journal) throw fail('workspace_write_journal_missing', 'Task-workspace write rollback journal is unavailable');
    const receiptFingerprint = rollbackReceiptFingerprint(claim, journal);

    // Check the caller's durable rollback authority even for an idempotent
    // replay. The callback below repeats it while the effect transaction lock
    // is held immediately before and after filesystem mutation.
    verify(claim);
    const rolledBack = this.effects.rollbackWith(claim.id, { requestId, actor, receiptFingerprint }, (activeClaim) => {
      verify(activeClaim);
      if (!targetMatchesPrior(paths.target, journal.prior)) {
        if (!targetMatchesExpected(paths.target, bytes)) {
          throw fail('workspace_write_rollback_integrity', 'Task-workspace write rollback target changed outside its fenced effect');
        }
        if (journal.prior.exists) writeAtomic(paths.target, journal.prior.bytes, claim.id);
        else {
          assertRegularOrAbsent(paths.target);
          try { unlinkSync(paths.target); } catch { throw fail('workspace_write_rollback_failed', 'Task-workspace write could not remove its engine-owned file'); }
        }
      }
      if (!targetMatchesPrior(paths.target, journal.prior)) {
        throw fail('workspace_write_rollback_integrity', 'Task-workspace write could not verify the restored prior state');
      }
      verify(activeClaim);
    }, (activeClaim) => verify(activeClaim));
    if (rolledBack.idempotent && !targetMatchesPrior(paths.target, journal.prior)) {
      throw fail('workspace_write_rollback_integrity', 'Task-workspace write rollback target no longer matches its prior state');
    }
    return { ...applyReceipt({ claim: rolledBack.claim, journal, receipt: rolledBack.receipt, idempotent: rolledBack.idempotent }), rollback: true };
  }
}
