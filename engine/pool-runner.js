import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fingerprint } from './ids.js';
import { claimWorkspace } from './workers.js';

const POOL_PROTOCOL = 'provider-adapter-v1';
const POOL_WORKERS = new Set(['codex']);

export class PoolRunnerError extends Error {
  constructor(code, message, { statusCode = null } = {}) {
    super(message);
    this.name = 'PoolRunnerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PoolHttpClient {
  constructor({ baseUrl, authorization, fetchImpl = globalThis.fetch, requestTimeoutMs = 10_000, heartbeatTimeoutMs = 4_000 } = {}) {
    this.baseUrl = assertLoopbackPoolUrl(baseUrl);
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new PoolRunnerError('pool_authorization_required', 'Worker-pool authorization is required');
    }
    if (typeof fetchImpl !== 'function') throw new PoolRunnerError('pool_transport_invalid', 'Worker-pool fetch transport is unavailable');
    this.authorization = authorization;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = boundedTimeout(requestTimeoutMs, 'requestTimeoutMs');
    this.heartbeatTimeoutMs = boundedTimeout(heartbeatTimeoutMs, 'heartbeatTimeoutMs');
  }

  claim(input) {
    return this.#post('/api/v1/worker-pool/claims', input);
  }

  heartbeat(claimId, input) {
    return this.#post(`/api/v1/worker-pool/claims/${encodeURIComponent(claimId)}/heartbeat`, input, this.heartbeatTimeoutMs);
  }

  complete(claimId, input) {
    return this.#post(`/api/v1/worker-pool/claims/${encodeURIComponent(claimId)}/complete`, input);
  }

  async #post(path, body, timeoutMs = this.requestTimeoutMs) {
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await this.fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: this.authorization },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new PoolRunnerError('pool_transport_failed', `Worker-pool request failed: ${String(error?.message || error).slice(0, 300)}`);
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new PoolRunnerError(payload?.code || 'pool_request_failed', payload?.error || `Worker-pool request returned HTTP ${response.status}`, { statusCode: response.status });
    }
    return payload;
  }
}

export class PoolRunner {
  constructor({ client, worker, dataDir, ownerId = null, heartbeatMs = 5_000, requestIdFactory = null } = {}) {
    if (!client || typeof client.claim !== 'function' || typeof client.heartbeat !== 'function' || typeof client.complete !== 'function') {
      throw new PoolRunnerError('pool_client_invalid', 'Worker-pool client is invalid');
    }
    if (!worker || !POOL_WORKERS.has(worker.id) || typeof worker.execute !== 'function') {
      throw new PoolRunnerError('pool_worker_unsupported', 'Pool runner currently supports only the Codex adapter');
    }
    if (!dataDir) throw new PoolRunnerError('pool_data_dir_required', 'AOS data directory is required');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 60_000) {
      throw new PoolRunnerError('pool_heartbeat_invalid', 'Heartbeat interval must be 1000 to 60000 milliseconds');
    }
    this.client = client;
    this.worker = worker;
    this.dataDir = resolve(dataDir);
    this.ownerId = boundedId(ownerId || `pool-${process.pid}-${randomUUID().slice(0, 12)}`, 'ownerId');
    this.heartbeatMs = heartbeatMs;
    this.requestIdFactory = requestIdFactory || (() => `poolreq-${randomUUID()}`);
    this.profile = adapterProfile(worker);
  }

  async runOnce({ runId = null } = {}) {
    const requestId = boundedId(this.requestIdFactory(), 'requestId');
    const claim = await this.client.claim({
      worker: this.worker.id,
      ownerId: this.ownerId,
      requestId,
      ...(runId ? { runId: boundedId(runId, 'runId') } : {}),
      protocol: POOL_PROTOCOL,
      profileFingerprint: this.profile.fingerprint,
    });
    if (claim?.claim === null || claim == null) return { status: 'idle', worker: this.worker.id };
    validateClaim(claim, this.worker.id, this.ownerId, this.profile);

    const expectedWorkspace = resolve(this.dataDir, 'workspaces', claim.runId, claim.taskId);
    if (resolve(claim.workspacePath || claim.workspace || '') !== expectedWorkspace) {
      throw new PoolRunnerError('pool_workspace_mismatch', 'Claim workspace does not match the local AOS store');
    }
    const workspace = claimWorkspace({
      root: resolve(this.dataDir, 'workspaces'),
      runId: claim.runId,
      taskId: claim.taskId,
      agentId: claim.agentId,
      now: new Date().toISOString(),
    });
    const task = {
      ...claim.task,
      id: claim.taskId,
      nonce: claim.nonce,
      attempts: claim.attempt,
      readPaths: claim.task?.readPaths || claim.readPaths || [],
    };
    const controller = new AbortController();
    let heartbeatFailure = null;
    let leaseUntil = claim.leaseUntil;
    let heartbeatChain = Promise.resolve();
    const queueHeartbeat = (processInfo = {}) => {
      heartbeatChain = heartbeatChain.then(async () => {
        if (heartbeatFailure) return;
        try {
          const heartbeat = await withDeadline(this.client.heartbeat(claim.claimId, {
            ownerId: this.ownerId,
            attempt: claim.attempt,
            ...(Number.isInteger(processInfo.pid) ? { workerPid: processInfo.pid } : {}),
            ...(Number.isInteger(processInfo.pgid) ? { workerPgid: processInfo.pgid } : {}),
          }), heartbeatDeadline(this.heartbeatMs, leaseUntil));
          if (heartbeat?.leaseUntil) leaseUntil = heartbeat.leaseUntil;
        } catch (error) {
          heartbeatFailure = error;
          controller.abort();
        }
      });
      return heartbeatChain;
    };
    await queueHeartbeat();
    if (heartbeatFailure) throw heartbeatFailure;
    const timer = setInterval(() => { void queueHeartbeat(); }, this.heartbeatMs);

    let result;
    try {
      result = await this.worker.execute(task, {
        goal: claim.goal,
        run: claim.run,
        task,
        workspace,
        attempt: claim.attempt,
        signal: controller.signal,
        repoRoot: this.worker.config?.repoRoot || null,
        providerProfile: claim.providerProfile || claim.profile,
        dependencies: claim.dependencies || [],
        systemPrompt: claim.systemPrompt || null,
        emit: () => null,
        heartbeat: () => { void queueHeartbeat(); },
        recordWorkerProcess: (info) => { void queueHeartbeat(info || {}); },
      });
    } catch (error) {
      result = { status: 'failed', retryable: false, error: String(error?.message || error).slice(0, 4_000) };
    } finally {
      clearInterval(timer);
      await heartbeatChain;
    }
    if (heartbeatFailure) throw heartbeatFailure;
    validateAdapterResult(result);
    const completion = await this.client.complete(claim.claimId, {
      ownerId: this.ownerId,
      attempt: claim.attempt,
      result: { ...result, task_nonce: claim.nonce },
    });
    return {
      status: completion?.status || result.status,
      worker: this.worker.id,
      runId: claim.runId,
      taskId: claim.taskId,
      attempt: claim.attempt,
      refused: completion?.refused === true,
    };
  }

  async runUntilIdle({ runId = null } = {}) {
    const completed = [];
    for (;;) {
      const result = await this.runOnce({ runId });
      if (result.status === 'idle') return { status: 'idle', worker: this.worker.id, completed };
      completed.push(result);
    }
  }
}

export function assertLoopbackPoolUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PoolRunnerError('pool_target_invalid', 'Worker-pool target must be a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new PoolRunnerError('pool_target_invalid', 'Worker-pool target must be a loopback HTTP URL');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function adapterProfile(worker) {
  const config = worker.config || {};
  const profile = {
    provider: worker.id,
    model: config.model || null,
    effort: config.effort || null,
    sandbox: 'read-only',
    authPathKind: 'external_cli_session',
    maxConcurrency: Number.isInteger(config.maxConcurrency) ? config.maxConcurrency : null,
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : null,
  };
  return { ...profile, fingerprint: fingerprint(JSON.stringify(profile)) };
}

function validateClaim(claim, workerId, ownerId, profile) {
  if (!claim || claim.protocol !== POOL_PROTOCOL || claim.worker !== workerId || claim.ownerId !== ownerId) {
    throw new PoolRunnerError('pool_claim_invalid', 'Worker-pool claim does not match this runner');
  }
  if (!claim.claimId || !claim.runId || !claim.taskId || !claim.agentId || !claim.nonce || !Number.isInteger(claim.attempt)) {
    throw new PoolRunnerError('pool_claim_invalid', 'Worker-pool claim is incomplete');
  }
  boundedId(claim.claimId, 'claimId');
  boundedId(claim.runId, 'runId');
  boundedId(claim.taskId, 'taskId');
  boundedId(claim.agentId, 'agentId');
  if (claim.profile?.fingerprint !== profile.fingerprint || claim.providerProfile?.fingerprint !== profile.fingerprint) {
    throw new PoolRunnerError('pool_claim_profile_mismatch', 'Worker-pool claim profile does not match the local adapter');
  }
  if (claim.task?.mayDelegate === true || claim.stagedMcpFile || (claim.capabilityMounts || []).length) {
    throw new PoolRunnerError('pool_claim_unsupported', 'Pool runner refuses delegation and capability execution');
  }
  if (claim.sandbox !== profile.sandbox) throw new PoolRunnerError('pool_claim_sandbox_mismatch', 'Worker-pool sandbox does not match the local adapter');
}

function validateAdapterResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new PoolRunnerError('pool_result_invalid', 'Provider adapter returned no result object');
  if (!['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(result.status)) {
    throw new PoolRunnerError('pool_result_invalid', 'Provider adapter returned an unsupported status');
  }
  if (['succeeded', 'awaiting_user'].includes(result.status) && (!result.runtime || typeof result.runtime !== 'object')) {
    throw new PoolRunnerError('pool_result_invalid', 'Successful provider adapter result lacks a runtime receipt');
  }
}

function boundedId(value, field) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(id)) throw new PoolRunnerError('pool_input_invalid', `${field} must be a bounded identifier`);
  return id;
}

function boundedTimeout(value, field) {
  if (!Number.isInteger(value) || value < 250 || value > 60_000) {
    throw new PoolRunnerError('pool_timeout_invalid', `${field} must be 250 to 60000 milliseconds`);
  }
  return value;
}

function heartbeatDeadline(intervalMs, leaseUntil) {
  const leaseRemaining = Date.parse(leaseUntil || '') - Date.now() - 500;
  const intervalBound = Math.max(250, intervalMs - 250);
  return Number.isFinite(leaseRemaining) ? Math.max(250, Math.min(intervalBound, leaseRemaining)) : intervalBound;
}

function withDeadline(promise, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new PoolRunnerError('pool_heartbeat_timeout', 'Worker-pool heartbeat timed out')), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

export { POOL_PROTOCOL };
