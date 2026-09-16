#!/usr/bin/env node
import { dispatch, executionFromEnv, HELP, loadEngineFromEnv, parseArgs } from '../engine/cli.js';
import { bootEngine, createAosServer } from '../engine/http.js';
import { loadOperatorToken, operatorAuthorizationHeader } from '../engine/operator-auth.js';
import { PoolHttpClient, PoolRunner } from '../engine/pool-runner.js';
import { createWorkerRegistry } from '../engine/workers.js';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const { args, flags } = parseArgs(argv);

if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (args[0] === 'pool' && args[1] === 'run') {
  try {
    const result = await runPool(flags);
    process.stdout.write(`${poolResultLine(result)}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
} else if (args[0] === 'serve') {
  const host = flags.host || process.env.AOS_HOST || '127.0.0.1';
  const port = Number(flags.port || process.env.AOS_PORT || 7740);
  const dataDir = resolve(flags.data || process.env.AOS_HOME || '.aos');
  const engine = bootEngine({ dataDir });
  const operatorAuth = loadOperatorToken({ dataDir });
  const { listen } = createAosServer({ engine, host, port, operatorToken: operatorAuth.token });
  const addr = await listen();
  console.log(`AOS engine listening on http://${addr.host}:${addr.port}`);
  console.log(`data  ${dataDir}`);
  console.log(`auth  operator token required (${operatorAuth.source})`);
  console.log(`exec  ${engine.live ? `live codex ${engine.execution.codex.model}/${engine.execution.codex.effort}` : 'local deterministic worker'}`);
} else {
  const commandArgv = argv.filter((token, index, all) => {
    if (token === '--data' || token === '--port' || token === '--host') return false;
    if (['--data', '--port', '--host'].includes(all[index - 1])) return false;
    return true;
  });
  const remote = await tryRemote(commandArgv, flags);
  if (remote) {
    process.stdout.write(`${(remote.lines || []).join('\n')}\n`);
    if (!remote.ok) process.exitCode = 1;
  } else {
    try {
      const engine = loadEngineFromEnv({ dataDir: flags.data });
      const lines = await dispatch(engine, commandArgv);
      process.stdout.write(`${lines.join('\n')}\n`);
    } catch (error) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

async function runPool(flags) {
  const workerId = String(flags.worker || '').trim();
  if (workerId !== 'codex') {
    throw new Error('pool run currently requires --worker codex');
  }
  const host = String(flags.host || process.env.AOS_HOST || '127.0.0.1');
  const port = Number(flags.port || process.env.AOS_PORT || 7740);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('pool run port must be 1 to 65535');
  const dataDir = resolve(flags.data || process.env.AOS_HOME || '.aos');
  const authorization = operatorAuthorizationHeader(loadOperatorToken({ dataDir, create: false }).token);
  const hostname = host === '::1' ? '[::1]' : host;
  const client = new PoolHttpClient({ baseUrl: `http://${hostname}:${port}`, authorization });
  const execution = executionFromEnv();
  const workers = createWorkerRegistry({
    codex: execution.codex || null,
    claude: execution.claude || null,
    ollama: execution.ollama || null,
    adapters: execution.adapters || null,
  });
  const worker = workers.get(workerId);
  if (!worker?.config) throw new Error(`${workerId} is not enabled in this process environment`);
  const heartbeatMs = flags.heartbeat == null ? 5_000 : Number(flags.heartbeat);
  const runner = new PoolRunner({ client, worker, dataDir, ownerId: flags.owner || null, heartbeatMs });
  return flags.once
    ? runner.runOnce({ runId: flags.run || null })
    : runner.runUntilIdle({ runId: flags.run || null });
}

function poolResultLine(result) {
  if (result.status === 'idle') return `pool ${result.worker} idle${Array.isArray(result.completed) ? ` after ${result.completed.length} task(s)` : ''}`;
  return `pool ${result.worker} ${result.status} run=${result.runId} task=${result.taskId} attempt=${result.attempt}`;
}

async function tryRemote(commandArgv, flags) {
  if (process.env.AOS_LOCAL_ONLY === '1') return null;
  const host = flags.host || process.env.AOS_HOST || '127.0.0.1';
  const port = Number(flags.port || process.env.AOS_PORT || 7740);
  const dataDir = resolve(flags.data || process.env.AOS_HOME || '.aos');
  let authorization = null;
  try {
    authorization = operatorAuthorizationHeader(loadOperatorToken({ dataDir, create: false }).token);
  } catch {
    authorization = null;
  }
  try {
    const response = await fetch(`http://${host}:${port}/api/v1/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify({ argv: commandArgv }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, lines: [`error: ${payload?.error || `AOS engine returned HTTP ${response.status}`}`] };
    }
    return payload;
  } catch {
    return null;
  }
}
