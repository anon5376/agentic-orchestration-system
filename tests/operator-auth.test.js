import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOperatorAuthorization, loadOperatorToken, operatorAuthorizationHeader } from '../engine/operator-auth.js';

test('operator token is created once with private permissions and reused', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-operator-token-'));
  const first = loadOperatorToken({ dataDir, env: {} });
  assert.equal(first.source, 'file');
  assert.equal(first.token.length >= 32, true);
  assert.equal(statSync(first.path).mode & 0o077, 0);

  chmodSync(first.path, 0o644);
  const second = loadOperatorToken({ dataDir, env: {} });
  assert.equal(second.token, first.token);
  assert.equal(statSync(first.path).mode & 0o077, 0);
  assert.equal(readFileSync(first.path, 'utf8').trim(), first.token);
});

test('environment token takes precedence without creating a file', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-operator-env-'));
  const configured = 'configured_operator_token_1234567890';
  const result = loadOperatorToken({ dataDir, env: { AOS_OPERATOR_TOKEN: configured } });
  assert.deepEqual(result, { token: configured, source: 'environment', path: null });
});

test('concurrent processes converge on one fully written token', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aos-operator-race-'));
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'engine', 'operator-auth.js')).href;
  const script = `
    const [dataDir, moduleUrl] = process.argv.slice(1);
    const { loadOperatorToken } = await import(moduleUrl);
    process.stdout.write(loadOperatorToken({ dataDir, env: {} }).token);
  `;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir, moduleUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const tokens = await Promise.all(Array.from({ length: 6 }, launch));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(tokens[0].length >= 32, true);
  assert.deepEqual(readdirSync(dataDir), ['operator.token']);
  assert.equal(statSync(join(dataDir, 'operator.token')).mode & 0o077, 0);
});

test('bearer authorization accepts only the exact token', () => {
  const token = 'operator_token_abcdefghijklmnopqrstuvwxyz';
  assert.equal(assertOperatorAuthorization(operatorAuthorizationHeader(token), token), true);
  assert.throws(() => assertOperatorAuthorization('Bearer operator_token_abcdefghijklmnopqrstuvwx', token), (error) => error.code === 'operator_authorization_required');
  assert.throws(() => assertOperatorAuthorization('', token), (error) => error.code === 'operator_authorization_required');
});
