import { createServer } from 'node:http';
import { AosEngine } from './engine.js';
import { dispatch, executeCommand, executionFromEnv } from './cli.js';
import { redactSecrets } from './providers.js';
import { AosError, errorEnvelope, identifier, t, validate } from './schema.js';
import { apiActions, matchResourceRoute } from './api.js';
import { assertOperatorAuthorization, loadOperatorToken } from './operator-auth.js';

const MAX_JSON_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const POOL_CLAIM_INPUT = t.object({
  worker: identifier(),
  ownerId: identifier(),
  requestId: identifier(),
  runId: t.optional(identifier()),
  protocol: t.optional(t.enumOf(['provider-adapter-v1'])),
  profileFingerprint: t.optional(t.string({ minLength: 1, maxLength: 128 })),
});
const POOL_HEARTBEAT_INPUT = t.object({
  ownerId: identifier(),
  attempt: t.integer({ min: 1 }),
  workerPid: t.optional(t.integer({ min: 1 })),
  workerPgid: t.optional(t.integer({ min: 1 })),
});
const POOL_COMPLETE_INPUT = t.object({
  ownerId: identifier(),
  attempt: t.integer({ min: 1 }),
  result: t.nullable(t.any()),
});

export function createAosServer({ engine, host = '127.0.0.1', port = 7740, operatorToken } = {}) {
  assertLoopbackHost(host);
  const token = operatorToken === false
    ? null
    : operatorToken || loadOperatorToken({ dataDir: engine?.store?.dataDir }).token;
  const server = createServer(async (req, res) => {
    try {
      authorizeLocalRequest(req, res, token);
      await handle(engine, req, res);
    } catch (error) {
      if (error?.code === 'operator_authorization_required') res.setHeader('WWW-Authenticate', 'Bearer realm="AOS operator"');
      const payload = isPoolRequest(req) ? publicPoolResponse(errorEnvelope(error)) : errorEnvelope(error);
      send(res, error.statusCode || 500, payload);
    }
  });
  return {
    server,
    engine,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    auth: { required: Boolean(token) },
  };
}

export function bootEngine({ dataDir, concurrency, execution }) {
  const engine = new AosEngine({ dataDir, concurrency, execution: execution ?? executionFromEnv() });
  engine.load();
  return engine;
}

async function handle(engine, req, res) {
  engine.sync();
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (path === '/health' || path === '/api/v1/health')) {
    return send(res, 200, { ok: true, service: 'aos', generatedAt: engine.now() });
  }
  const poolHeartbeatPath = url.pathname.match(/^\/api\/v1\/worker-pool\/claims\/([^/]+)\/heartbeat$/);
  const poolCompletePath = url.pathname.match(/^\/api\/v1\/worker-pool\/claims\/([^/]+)\/complete$/);
  if (req.method === 'POST' && path === '/api/v1/worker-pool/claims' && url.pathname === path) {
    const body = validate(POOL_CLAIM_INPUT, await readJson(req), 'worker-pool claim');
    const result = await engine.claimPoolTask(body);
    if (result == null || result?.claim === null) return send(res, 200, { claim: null });
    return send(res, result.idempotent ? 200 : 201, publicPoolResponse(result));
  }
  if (req.method === 'POST' && poolHeartbeatPath) {
    const claimId = boundedPoolIdentifier(poolHeartbeatPath[1], 'claimId');
    const body = validate(POOL_HEARTBEAT_INPUT, await readJson(req), 'worker-pool heartbeat');
    const result = await engine.heartbeatPoolClaim(claimId, body);
    return send(res, 200, publicPoolResponse(result));
  }
  if (req.method === 'POST' && poolCompletePath) {
    const claimId = boundedPoolIdentifier(poolCompletePath[1], 'claimId');
    const body = validate(POOL_COMPLETE_INPUT, await readJson(req), 'worker-pool completion');
    const result = await engine.completePoolClaim(claimId, body);
    return send(res, 200, publicPoolResponse(result));
  }
  if (req.method === 'GET' && path === '/api/v1/snapshot') {
    return send(res, 200, engine.snapshot());
  }
  if (req.method === 'GET' && path === '/api/v1/projects') {
    return send(res, 200, { projects: engine.state.projects });
  }
  if (req.method === 'POST' && path === '/api/v1/projects') {
    const body = await readJson(req);
    return send(res, 201, engine.createProject({ name: body.name }));
  }
  if (req.method === 'POST' && path === '/api/v1/goals') {
    const body = await readJson(req);
    if (body.planningMode === 'lead') {
      const result = await engine.createLeadGoalProposal({
        projectId: body.projectId,
        prompt: body.prompt,
        contextPaths: body.contextPaths || [],
        requestId: body.requestId,
      });
      return send(res, result.idempotent ? 200 : 201, result);
    }
    if (body.planningMode != null && body.planningMode !== '') {
      throw new AosError('lead_planning_mode_invalid', 'planningMode must be "lead" when supplied', { statusCode: 400, details: { field: 'planningMode', expected: 'lead' } });
    }
    return send(res, 201, engine.createGoal({
      projectId: body.projectId,
      prompt: body.prompt,
      contextPaths: body.contextPaths || [],
      plan: body.plan ?? null,
    }));
  }
  if (req.method === 'GET' && path === '/api/v1/goals') {
    return send(res, 200, { goals: engine.state.goals });
  }
  const goalMatch = path.match(/^\/api\/v1\/goals\/([^/]+)$/);
  if (req.method === 'GET' && goalMatch) {
    return send(res, 200, engine.getGoal(goalMatch[1]));
  }
  const goalLeadPlans = path.match(/^\/api\/v1\/goals\/([^/]+)\/lead-plans$/);
  if (req.method === 'POST' && goalLeadPlans) {
    const body = await readJson(req);
    return send(res, 200, await engine.planGoal({
      goalId: goalLeadPlans[1],
      requestId: body.requestId,
      derivedFromProposalId: body.derivedFromProposalId,
    }));
  }
  if (req.method === 'GET' && goalLeadPlans) {
    return send(res, 200, { plans: engine.listLeadPlans(goalLeadPlans[1], { status: url.searchParams.get('status') || null }) });
  }
  const goalAnswers = path.match(/^\/api\/v1\/goals\/([^/]+)\/answers$/);
  if (req.method === 'POST' && goalAnswers) {
    const body = await readJson(req);
    return send(res, 200, engine.answerQuestions(goalAnswers[1], body.answers || []));
  }
  const leadPlanMatch = path.match(/^\/api\/v1\/lead-plans\/([^/]+)$/);
  if (req.method === 'GET' && leadPlanMatch) {
    return send(res, 200, engine.getLeadPlan(leadPlanMatch[1]));
  }
  const leadPlanAccept = path.match(/^\/api\/v1\/lead-plans\/([^/]+)\/accept$/);
  if (req.method === 'POST' && leadPlanAccept) {
    const body = await readJson(req);
    return send(res, 200, engine.acceptLeadPlan(leadPlanAccept[1], { actor: body.actor }));
  }
  const leadPlanReject = path.match(/^\/api\/v1\/lead-plans\/([^/]+)\/reject$/);
  if (req.method === 'POST' && leadPlanReject) {
    const body = await readJson(req);
    return send(res, 200, engine.rejectLeadPlan(leadPlanReject[1], { actor: body.actor, reason: body.reason }));
  }
  if (req.method === 'POST' && path === '/api/v1/runs') {
    const body = await readJson(req);
    return send(res, 201, engine.startRun({ goalId: body.goalId, projectId: body.projectId, maxConcurrency: body.maxConcurrency, blueprintId: body.blueprintId ?? null, blueprintVersion: body.blueprintVersion ?? null }));
  }
  const runPlan = path.match(/^\/api\/v1\/runs\/([^/]+)\/plan$/);
  if (req.method === 'GET' && runPlan) {
    const rawVersion = url.searchParams.get('version');
    const version = rawVersion == null || rawVersion === '' ? null : parseCursor(rawVersion);
    if (rawVersion != null && version == null) return send(res, 400, { error: 'version must be a positive integer', code: 'invalid_input', details: { field: 'version' } });
    return send(res, 200, engine.plans.get(runPlan[1], version));
  }
  const runPlanPatch = path.match(/^\/api\/v1\/runs\/([^/]+)\/plan\/patches$/);
  if (req.method === 'POST' && runPlanPatch) {
    const body = await readJson(req);
    return send(res, 201, engine.plans.patch(runPlanPatch[1], body));
  }
  if (req.method === 'GET' && path === '/api/v1/runs') {
    return send(res, 200, { runs: engine.listRuns() });
  }
  const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runMatch) {
    return send(res, 200, engine.getRun(runMatch[1]));
  }
  const runTree = path.match(/^\/api\/v1\/runs\/([^/]+)\/tree$/);
  if (req.method === 'GET' && runTree) {
    return send(res, 200, engine.getPublicRunTree(runTree[1]));
  }
  const runAdvance = path.match(/^\/api\/v1\/runs\/([^/]+)\/advance$/);
  if (req.method === 'POST' && runAdvance) {
    const body = await readJson(req);
    return send(res, 200, await engine.advanceRun(runAdvance[1], {
      untilIdle: body.untilIdle !== false,
      steps: body.steps,
    }));
  }
  const runCancel = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && runCancel) {
    return send(res, 200, engine.cancelRun(runCancel[1]));
  }
  const runPause = path.match(/^\/api\/v1\/runs\/([^/]+)\/pause$/);
  if (req.method === 'POST' && runPause) {
    return send(res, 200, engine.pauseRun(runPause[1]));
  }
  const runResume = path.match(/^\/api\/v1\/runs\/([^/]+)\/resume$/);
  if (req.method === 'POST' && runResume) {
    return send(res, 200, engine.resumeRun(runResume[1]));
  }
  const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && taskMatch) {
    return send(res, 200, engine.getPublicTask(taskMatch[1]));
  }
  const taskAnswers = path.match(/^\/api\/v1\/tasks\/([^/]+)\/answers$/);
  if (req.method === 'POST' && taskAnswers) {
    const body = await readJson(req);
    return send(res, 200, engine.answerTaskQuestions(taskAnswers[1], body?.answers));
  }
  const taskApprove = path.match(/^\/api\/v1\/tasks\/([^/]+)\/approve$/);
  if (req.method === 'POST' && taskApprove) {
    return send(res, 200, engine.approveTask(taskApprove[1]));
  }
  if (req.method === 'GET' && path === '/api/v1/decisions') {
    const runId = url.searchParams.get('runId');
    return send(res, 200, { decision: runId ? engine.getDecision(runId) : engine.snapshot().decision });
  }
  if (req.method === 'GET' && path === '/api/v1/proposals') {
    return send(res, 200, { proposals: engine.listProposals(url.searchParams.get('runId')) });
  }
  const proposalApprove = path.match(/^\/api\/v1\/proposals\/([^/]+)\/approve$/);
  if (req.method === 'POST' && proposalApprove) {
    const proposal = engine.approveProposal(proposalApprove[1]);
    if (!proposal.runId) return send(res, 200, { proposal, run: null });
    const advanced = await engine.advanceRun(proposal.runId, { untilIdle: true });
    return send(res, 200, { proposal, run: advanced.run });
  }
  const proposalReject = path.match(/^\/api\/v1\/proposals\/([^/]+)\/reject$/);
  if (req.method === 'POST' && proposalReject) {
    const body = await readJson(req);
    return send(res, 200, engine.rejectProposal(proposalReject[1], body.reason));
  }
  if (req.method === 'GET' && path === '/api/v1/providers') {
    return send(res, 200, { providers: engine.listProviders() });
  }
  if (req.method === 'GET' && path === '/api/v1/models') {
    return send(res, 200, engine.modelControl.snapshot({ projectId: url.searchParams.get('projectId') }));
  }
  if (req.method === 'POST' && path === '/api/v1/models/assign') {
    const body = await readJson(req);
    return send(res, 201, engine.modelControl.assign(body));
  }
  if (req.method === 'GET' && path === '/api/v1/events') {
    const runId = url.searchParams.get('runId');
    const events = engine.store.readEventLog().filter((item) => !runId || item.runId === runId);
    return send(res, 200, { events: events.slice(-200) });
  }
  if (req.method === 'GET' && path === '/api/v1/events/replay') {
    const rawAfter = url.searchParams.get('after');
    const rawLimit = url.searchParams.get('limit');
    const parsedAfter = rawAfter == null || rawAfter === '' ? 0 : parseCursor(rawAfter);
    const after = parsedAfter == null ? Number.NaN : parsedAfter;
    const limit = rawLimit == null || rawLimit === '' ? 100 : parseCursor(rawLimit);
    if (limit == null || limit < 1 || limit > 500) return send(res, 400, { error: 'limit must be an integer from 1 to 500', code: 'invalid_input', details: { field: 'limit' } });
    return send(res, 200, engine.store.replay({ after, limit }));
  }
  if (req.method === 'GET' && path === '/api/v1/events/stream') {
    return streamEvents(engine, req, res, url);
  }
  if (req.method === 'POST' && path === '/api/v1/cli') {
    const body = await readJson(req);
    try {
      const result = Array.isArray(body.argv) && body.argv.length
        ? { ok: true, lines: await dispatch(engine, body.argv) }
        : await executeCommand(engine, String(body.command || ''));
      return send(res, 200, result);
    } catch (error) {
      return send(res, 200, { ok: false, lines: [`error: ${error.message}`] });
    }
  }

  const route = matchResourceRoute(req.method, path);
  if (route) {
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    const query = Object.fromEntries(url.searchParams.entries());
    for (const listKey of ['tags', 'ids']) if (typeof query[listKey] === 'string') query[listKey] = query[listKey].split(',').filter(Boolean);
    for (const flag of ['includeArchived', 'includeBuiltin', 'includeProposed', 'includeInactive', 'confirm']) if (query[flag] !== undefined) query[flag] = query[flag] === 'true' || query[flag] === '1';
    const params = { ...query, ...body, ...route.params };
    const actions = apiActions(engine);
    const result = await actions[route.resource][route.action](params);
    return send(res, route.status, result === undefined ? { ok: true } : result);
  }

  send(res, 404, { error: `no route ${req.method} ${path}`, code: 'not_found', details: { method: req.method, path } });
}

function authorizeLocalRequest(req, res, operatorToken) {
  const requestHost = hostnameOf(req.headers.host);
  if (!LOOPBACK_HOSTS.has(requestHost)) {
    throw new AosError('request_host_denied', 'AOS accepts requests only through a loopback host', {
      statusCode: 403,
      details: { host: requestHost || null },
    });
  }

  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    throw new AosError('request_origin_denied', 'AOS accepts browser requests only from a loopback origin', {
      statusCode: 403,
      details: { origin },
    });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (operatorToken && req.method !== 'OPTIONS') {
    const path = String(req.url || '').split('?', 1)[0].replace(/\/$/, '') || '/';
    if (path !== '/health' && path !== '/api/v1/health') {
      assertOperatorAuthorization(req.headers.authorization, operatorToken);
    }
  }
}

function send(res, status, body) {
  const json = `${JSON.stringify(redactSecrets(body), null, 2)}\n`;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function isPoolRequest(req) {
  const pathname = String(req?.url || '').split('?', 1)[0];
  return pathname === '/api/v1/worker-pool/claims' || pathname.startsWith('/api/v1/worker-pool/claims/');
}

function boundedPoolIdentifier(value, field) {
  return validate(identifier(), value, field);
}

// Pool responses carry only the public claim/result view. The engine owns the
// durable record, but provider handles and credentials never cross this door.
function publicPoolResponse(value, ancestors = new WeakSet(), parentKey = '') {
  if (value == null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[cycle]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => publicPoolResponse(item, ancestors, parentKey));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isPoolPrivateKey(key, parentKey)) continue;
      out[key] = publicPoolResponse(item, ancestors, key);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function isPoolPrivateKey(key, parentKey = '') {
  const normalized = String(key).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  if (['secret', 'token', 'password', 'authorization', 'api_key', 'access_key', 'private_key', 'credential', 'credentials', 'thread_id', 'harness_reference'].includes(normalized)) return true;
  if (/^credential_/.test(normalized)) return true;
  if (/^provider_(?:ref|reference|session|credential)(?:_|$)/.test(normalized)) return true;
  if (/^provider(?:ref|reference|session|credential)(?:_|$)/.test(normalized)) return true;
  if (/^(?:provider|auth)$/.test(String(parentKey).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase())
    && /^(?:ref|reference|session|credential|token|secret)(?:_|$)/.test(normalized)) return true;
  return false;
}

function readJson(req) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    req.resume();
    return Promise.reject(new AosError('request_body_too_large', `JSON body exceeds ${MAX_JSON_BYTES} bytes`, {
      statusCode: 413,
      details: { maxBytes: MAX_JSON_BYTES },
    }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new AosError('request_body_too_large', `JSON body exceeds ${MAX_JSON_BYTES} bytes`, {
          statusCode: 413,
          details: { maxBytes: MAX_JSON_BYTES },
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        const wrapped = new Error(`Invalid JSON: ${error.message}`);
        wrapped.statusCode = 400;
        reject(wrapped);
      }
    });
    req.on('error', reject);
  });
}

function assertLoopbackHost(host) {
  const normalized = hostnameOf(host);
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new AosError('public_bind_denied', 'AOS refuses non-loopback binds', {
      statusCode: 400,
      details: { host: normalized || null },
    });
  }
}

function hostnameOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === '::1') return text;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    return end === -1 ? text : text.slice(1, end);
  }
  return text.split(':')[0];
}

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(hostnameOf(url.host));
  } catch {
    return false;
  }
}

function parseCursor(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)$/.test(text)) return null;
  const cursor = Number(text);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

// Native SSE delivery is intentionally bounded. Clients reconnect with the last
// cursor they received; the server replays the gap, polls briefly for new records,
// emits heartbeats, and closes so a dead client cannot leave an immortal handle.
function streamEvents(engine, req, res, url) {
  const rawAfter = url.searchParams.has('after') ? url.searchParams.get('after') : req.headers['last-event-id'];
  const parsedAfter = rawAfter == null || rawAfter === '' ? 0 : parseCursor(rawAfter);
  const after = parsedAfter == null ? Number.NaN : parsedAfter;
  const initial = engine.store.replay({ after, limit: 500 });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let lastCursor = Number.isNaN(after) ? 0 : after;
  let pollTimer;
  let heartbeatTimer;
  let closeTimer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(closeTimer);
    if (!res.writableEnded) res.end();
  };
  const write = (chunk) => {
    if (closed || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      close();
      return false;
    }
  };
  const writeResync = (bounds) => {
    const payload = { earliestCursor: bounds.earliestCursor, latestCursor: bounds.latestCursor, resyncRequired: true };
    const id = bounds.latestCursor == null ? '' : `id: ${bounds.latestCursor}\n`;
    write(`${id}event: aos.resync\ndata: ${JSON.stringify(payload)}\n\n`);
    close();
  };
  const writeEvent = (event) => {
    const id = Number(event.cursor);
    if (!Number.isSafeInteger(id)) return;
    // EventSource only dispatches named events when the client registers one
    // listener per name. Keep one stable event name; the original event.type
    // remains in the redacted JSON payload for client-side routing.
    if (write(`id: ${id}\nevent: aos.event\ndata: ${JSON.stringify(redactSecrets(event))}\n\n`)) lastCursor = id;
  };

  if (initial.resyncRequired) {
    writeResync(initial);
    return undefined;
  }
  for (const event of initial.events) writeEvent(event);
  if (!initial.events.length) write(': aos.keepalive\n\n');

  const poll = () => {
    if (closed) return;
    const next = engine.store.replay({ after: lastCursor, limit: 500 });
    if (next.resyncRequired) return writeResync(next);
    for (const event of next.events) writeEvent(event);
  };
  pollTimer = setInterval(poll, 100);
  heartbeatTimer = setInterval(() => write(': aos.keepalive\n\n'), 1000);
  closeTimer = setTimeout(close, 10_000);
  req.on('close', close);
  res.on('close', close);
  return undefined;
}
