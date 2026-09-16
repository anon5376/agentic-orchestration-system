import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL = {
  name: 'local.read_staged_text',
  inputSchema: {
    type: 'object',
    properties: {
      stagedFile: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: '^[^/\\\\\\x00-\\x1f<>:"|?*]+$',
      },
    },
    required: ['stagedFile'],
    additionalProperties: false,
  },
};

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

function modeFrom(argv) {
  if (argv.length !== 2 || argv[0] !== '--mode' || !/^[a-z][a-z0-9-]{0,48}$/.test(argv[1])) throw new Error('fixed arguments required');
  return argv[1];
}

let mode;
try {
  mode = modeFrom(process.argv.slice(2));
} catch {
  process.stderr.write('Local MCP fixture configuration rejected.\n');
  process.exitCode = 2;
}

function handle(message) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    process.exitCode = 2;
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    response(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'local-mcp-fixture', version: '1' } });
    return;
  }
  if (message.method === 'tools/list') {
    if (mode === 'list-drift') response(message.id, { tools: [{ ...TOOL, name: 'local.other' }] });
    else response(message.id, { tools: [TOOL] });
    return;
  }
  if (message.method === 'tools/call') {
    if (mode === 'timeout') return;
    const args = message.params?.arguments;
    if (!record(message.params) || message.params.name !== TOOL.name || !exactKeys(args, ['stagedFile'])
      || typeof args.stagedFile !== 'string' || args.stagedFile !== basename(args.stagedFile)) {
      process.exitCode = 2;
      return;
    }
    if (mode === 'oversized-output') {
      response(message.id, { content: [{ type: 'text', text: 'x'.repeat(4 * 1024 + 1) }], isError: false });
      return;
    }
    if (mode === 'secret-output') {
      response(message.id, { content: [{ type: 'text', text: '{"apiKey":"fixture-secret-value"}' }], isError: false });
      return;
    }
    try {
      const path = resolve(process.cwd(), args.stagedFile);
      response(message.id, { content: [{ type: 'text', text: `local:${readFileSync(path, 'utf8')}` }], isError: false });
    } catch {
      process.exitCode = 2;
    }
    return;
  }
  process.exitCode = 2;
}

let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk.toString('utf8');
  const lines = pending.split('\n');
  pending = lines.pop() || '';
  for (const line of lines) {
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { process.exitCode = 2; }
  }
});

process.stdin.on('end', () => {
  if (pending.trim()) {
    try { handle(JSON.parse(pending)); } catch { process.exitCode = 2; }
  }
});
