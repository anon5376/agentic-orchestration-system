import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'aos.read_staged_text';
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    stagedFile: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\x00-\\x1f<>:"|?*]+$' },
  },
  required: ['stagedFile'],
  additionalProperties: false,
};
const TOOL = { name: TOOL_NAME, inputSchema: INPUT_SCHEMA };

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!['--workspace-dir', '--staged-file', '--mode'].includes(key) || typeof value !== 'string') throw new Error('invalid fixture arguments');
    values[key.slice(2).replaceAll('-', '')] = value;
  }
  return { workspaceDir: values.workspacedir, mode: values.mode || 'happy' };
}

let config;
try {
  config = parseArgs(process.argv.slice(2));
  if (!config.workspaceDir) throw new Error('workspace required');
  appendFileSync(join(config.workspaceDir, 'mcp-hostile-child.pid'), `${process.pid}\n`, 'utf8');
} catch {
  process.stderr.write('Fixture configuration rejected.\n');
  process.exitCode = 2;
}

let initialized = false;
let listed = false;
let called = false;
let mode = config?.mode || 'happy';

if (config && ['timeout', 'cancel', 'reap'].includes(mode)) setInterval(() => {}, 1_000);

function handle(message) {
  if (!config) return;
  if (mode === 'malformed' && !initialized) {
    process.stdout.write('not-json\n');
    mode = 'malformed-done';
    return;
  }
  if (mode === 'oversized-stdout' && !initialized) {
    process.stdout.write('x'.repeat(65 * 1024));
    mode = 'oversized-stdout-done';
    return;
  }
  if (mode === 'oversized-stderr' && !initialized) {
    process.stderr.write('e'.repeat(17 * 1024));
    mode = 'oversized-stderr-done';
    return;
  }
  if (mode === 'unsolicited' && !initialized) {
    response(99, { unsolicited: true });
    mode = 'unsolicited-done';
    return;
  }
  if (mode === 'timeout' || mode === 'cancel' || mode === 'reap') return;
  if (message.method === 'notifications/initialized') return;
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    process.exitCode = 2;
    return;
  }
  if (message.method === 'initialize') {
    if (mode === 'wrong-id') {
      response(99, { protocolVersion: PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
      return;
    }
    const version = mode === 'wrong-version' ? '2025-01-01' : PROTOCOL_VERSION;
    const init = { jsonrpc: '2.0', id: message.id, result: { protocolVersion: version, capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } };
    send(init);
    if (mode === 'duplicate') send(init);
    initialized = true;
    return;
  }
  if (message.method === 'tools/list') {
    listed = true;
    if (mode === 'list-drift') response(message.id, { tools: [{ name: 'aos.other', inputSchema: INPUT_SCHEMA }] });
    else response(message.id, { tools: [TOOL] });
    return;
  }
  if (message.method === 'tools/call') {
    called = true;
    if (mode === 'oversized-output') {
      response(message.id, { content: [{ type: 'text', text: 'o'.repeat(4 * 1024 + 1) }], isError: false });
    } else if (mode === 'secret-output') {
      response(message.id, { content: [{ type: 'text', text: '{"apiKey":"fixture-secret-value"}' }], isError: false });
    } else {
      response(message.id, { content: [{ type: 'text', text: 'fixture output' }], isError: false });
    }
    if (mode === 'post-response-hang') setInterval(() => {}, 1_000);
    return;
  }
  response(message.id, { ok: true });
}

process.stdin.on('data', (chunk) => {
  if (!config || process.exitCode) return;
  const lines = chunk.toString('utf8').split('\n');
  // The fixture intentionally only needs small requests. Retain a complete
  // line across chunks by using a property rather than accepting raw payloads.
  const all = `${process.stdin.__mcpPending || ''}${lines.shift()}`;
  process.stdin.__mcpPending = lines.pop() ?? '';
  for (const line of [all, ...lines]) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { process.exitCode = 2; }
  }
});

process.stdin.on('end', () => {
  const line = process.stdin.__mcpPending;
  if (line?.trim()) {
    try { handle(JSON.parse(line)); } catch { process.exitCode = 2; }
  }
  if (mode === 'exit-nonzero') process.exitCode = 7;
});
