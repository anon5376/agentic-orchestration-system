import { createServer } from 'node:http';
import { AosEngine } from './engine.js';
import { dispatch, executeCommand, executionFromEnv } from './cli.js';
import { redactSecrets } from './providers.js';
import { errorEnvelope } from './schema.js';
import { apiActions, matchResourceRoute } from './api.js';

export function createAosServer({ engine, host = '127.0.0.1', port = 7740 }) {
  const server = createServer(async (req, res) => {
    try {
      await handle(engine, req, res);
    } catch (error) {
      send(res, error.statusCode || 500, errorEnvelope(error));
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
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (path === '/health' || path === '/api/v1/health')) {
    return send(res, 200, { ok: true, service: 'aos', generatedAt: engine.now() });
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
    return send(res, 201, engine.createGoal({
      projectId: body.projectId,
      prompt: body.prompt,
      contextPaths: body.contextPaths || [],
    }));
  }
  if (req.method === 'GET' && path === '/api/v1/goals') {
    return send(res, 200, { goals: engine.state.goals });
  }
  const goalMatch = path.match(/^\/api\/v1\/goals\/([^/]+)$/);
  if (req.method === 'GET' && goalMatch) {
    return send(res, 200, engine.getGoal(goalMatch[1]));
  }
  const goalAnswers = path.match(/^\/api\/v1\/goals\/([^/]+)\/answers$/);
  if (req.method === 'POST' && goalAnswers) {
    const body = await readJson(req);
    return send(res, 200, engine.answerQuestions(goalAnswers[1], body.answers || []));
  }
  if (req.method === 'POST' && path === '/api/v1/runs') {
    const body = await readJson(req);
    return send(res, 201, engine.startRun({ goalId: body.goalId, projectId: body.projectId, maxConcurrency: body.maxConcurrency, blueprintId: body.blueprintId ?? null, blueprintVersion: body.blueprintVersion ?? null }));
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
    return send(res, 200, engine.getRunTree(runTree[1]));
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
    return send(res, 200, engine.getTask(taskMatch[1]));
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
  if (req.method === 'GET' && path === '/api/v1/events') {
    const runId = url.searchParams.get('runId');
    const events = engine.store.readEventLog().filter((item) => !runId || item.runId === runId);
    return send(res, 200, { events: events.slice(-200) });
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

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body) {
  cors(res);
  const json = `${JSON.stringify(redactSecrets(body), null, 2)}\n`;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
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
