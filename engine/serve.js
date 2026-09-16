import { resolve } from 'node:path';
import { bootEngine, createAosServer } from './http.js';
import { loadOperatorToken } from './operator-auth.js';

const flags = parse(process.argv.slice(2));
const host = flags.host || process.env.AOS_HOST || '127.0.0.1';
const port = Number(flags.port || process.env.AOS_PORT || 7740);
const dataDir = resolve(flags.data || process.env.AOS_HOME || '.aos');
const concurrency = flags.concurrency != null ? Number(flags.concurrency) : undefined;

const engine = bootEngine({ dataDir, concurrency });
const operatorAuth = loadOperatorToken({ dataDir });
const { listen } = createAosServer({ engine, host, port, operatorToken: operatorAuth.token });
const addr = await listen();
console.log(`AOS engine listening on http://${addr.host}:${addr.port}`);
console.log(`data  ${dataDir}`);
console.log(`bind  loopback only; dashboard proxy: /api → this service`);
console.log(`auth  operator token required (${operatorAuth.source})`);
console.log(`exec  ${executionLabel(engine)}`);

function executionLabel(engine) {
  if (engine.execution.mode === 'codex') {
    const config = engine.execution.codex;
    return `live codex ${config.model}/${config.effort}, ChatGPT login, max ${config.maxConcurrency} workers`;
  }
  if (engine.execution.mode === 'mixed') {
    const providers = Object.entries(engine.execution.adapters || {})
      .filter(([, config]) => config.enabled !== false)
      .map(([id, config]) => `${id}${config.model ? ` ${config.model}/${config.effort}` : ''}`);
    return `mixed providers: ${providers.join(', ') || 'none'}`;
  }
  return 'local deterministic worker';
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}
