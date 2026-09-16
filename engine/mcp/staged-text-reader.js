import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'aos.read_staged_text';
const MAX_STAGED_FILE_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
const MAX_STDIO_LINE_BYTES = 64 * 1024;
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    stagedFile: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\x00-\\x1f<>:"|?*]+$' },
  },
  required: ['stagedFile'],
  additionalProperties: false,
};
const TOOL = { name: TOOL_NAME, inputSchema: INPUT_SCHEMA };

const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value, keys) => record(value)
  && Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');

function send(value) {
  let line;
  try { line = JSON.stringify(value); } catch { process.exitCode = 2; return; }
  if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_LINE_BYTES - 1) { process.exitCode = 2; return; }
  try { process.stdout.write(`${line}\n`); } catch { process.exitCode = 2; }
}

function errorReply(id, code = -32000) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: 'MCP request was rejected.' } };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (!['--workspace-dir', '--staged-file'].includes(key) || typeof value !== 'string' || !value) throw new Error('arguments');
    values[key] = value;
  }
  if (!values['--workspace-dir'] || !values['--staged-file']) throw new Error('arguments');
  return { workspaceDir: values['--workspace-dir'], configuredFile: values['--staged-file'] };
}

function normalizeBasename(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..') return null;
  if (value !== basename(value) || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f<>:"|?*]/.test(value)) return null;
  return value;
}

function boundedRead(workspaceDir, stagedFile) {
  const file = normalizeBasename(stagedFile);
  if (!file) throw new Error('file');
  const path = resolve(workspaceDir, file);
  const child = relative(workspaceDir, path);
  if (child !== '' && (child.startsWith('..') || isAbsolute(child))) throw new Error('file');
  const descriptor = lstatSync(path);
  if (descriptor.isSymbolicLink() || !descriptor.isFile()) throw new Error('file');
  if (descriptor.size > MAX_STAGED_FILE_BYTES) throw new Error('size');
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_STAGED_FILE_BYTES) throw new Error('file');
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_STAGED_FILE_BYTES) throw new Error('size');
    const text = bytes.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_OUTPUT_BYTES) throw new Error('size');
    return text;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* descriptor already closed */ }
    }
  }
}

function parseLine(line) {
  if (!line.length || line.length > MAX_STDIO_LINE_BYTES) throw new Error('line');
  const value = JSON.parse(line.toString('utf8'));
  if (!record(value) || value.jsonrpc !== '2.0') throw new Error('line');
  return value;
}

let config;
try {
  config = parseArgs(process.argv.slice(2));
  if (!isAbsolute(config.workspaceDir)) throw new Error('workspace');
  config.workspaceDir = realpathSync(config.workspaceDir);
  if (!statSync(config.workspaceDir).isDirectory()) throw new Error('workspace');
} catch {
  process.stderr.write('MCP server configuration rejected.\n');
  process.exitCode = 2;
}

let initialized = false;
let listed = false;
let called = false;
let pending = Buffer.alloc(0);

function handle(message) {
  if (!config) return;
  if (message.method === 'notifications/initialized') {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) process.exitCode = 2;
    return;
  }
  if (!record(message) || typeof message.method !== 'string' || !Object.prototype.hasOwnProperty.call(message, 'id')) {
    process.exitCode = 2;
    return;
  }
  if (message.method === 'initialize') {
    if (initialized || message.id !== 1 || !record(message.params) || message.params.protocolVersion !== PROTOCOL_VERSION) {
      send(errorReply(message.id, -32602));
      return;
    }
    initialized = true;
    send({ jsonrpc: '2.0', id: 1, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'aos.staged-text-reader', version: '1' } } });
    return;
  }
  if (message.method === 'tools/list') {
    if (!initialized || listed || message.id !== 2 || !record(message.params)) { send(errorReply(message.id, -32602)); return; }
    listed = true;
    send({ jsonrpc: '2.0', id: 2, result: { tools: [TOOL] } });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments;
    if (!listed || called || message.id !== 3 || !record(message.params) || message.params.name !== TOOL_NAME
      || !exactKeys(args, ['stagedFile']) || args.stagedFile !== config.configuredFile) {
      send(errorReply(message.id, -32602));
      return;
    }
    called = true;
    try {
      const text = boundedRead(config.workspaceDir, args.stagedFile);
      send({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text }], isError: false } });
    } catch {
      send(errorReply(message.id, -32001));
    }
    return;
  }
  send(errorReply(message.id, -32601));
}

process.stdin.on('data', (chunk) => {
  if (!config || process.exitCode) return;
  pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
  if (pending.length > MAX_STDIO_LINE_BYTES && !pending.includes(0x0a)) { process.exitCode = 2; return; }
  while (!process.exitCode) {
    const index = pending.indexOf(0x0a);
    if (index < 0) break;
    let line = pending.subarray(0, index);
    pending = pending.subarray(index + 1);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    try { handle(parseLine(line)); } catch { process.exitCode = 2; }
  }
  if (!process.exitCode && pending.length > MAX_STDIO_LINE_BYTES) process.exitCode = 2;
});

process.stdin.on('end', () => {
  if (!process.exitCode && pending.length) {
    try { handle(parseLine(pending)); } catch { process.exitCode = 2; }
  }
});
