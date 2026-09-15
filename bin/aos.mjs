#!/usr/bin/env node
import { dispatch, HELP, loadEngineFromEnv, parseArgs } from '../engine/cli.js';
import { bootEngine, createAosServer } from '../engine/http.js';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const { args, flags } = parseArgs(argv);

if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

if (args[0] === 'serve') {
  const host = flags.host || process.env.AOS_HOST || '127.0.0.1';
  const port = Number(flags.port || process.env.AOS_PORT || 7740);
  const dataDir = resolve(flags.data || process.env.AOS_HOME || '.aos');
  const engine = bootEngine({ dataDir });
  const { listen } = createAosServer({ engine, host, port });
  const addr = await listen();
  console.log(`AOS engine listening on http://${addr.host}:${addr.port}`);
  console.log(`data  ${dataDir}`);
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

async function tryRemote(commandArgv, flags) {
  if (process.env.AOS_LOCAL_ONLY === '1') return null;
  const host = flags.host || process.env.AOS_HOST || '127.0.0.1';
  const port = Number(flags.port || process.env.AOS_PORT || 7740);
  try {
    const response = await fetch(`http://${host}:${port}/api/v1/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argv: commandArgv }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
