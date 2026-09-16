import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { AosError } from './schema.js';

export const OPERATOR_TOKEN_ENV = 'AOS_OPERATOR_TOKEN';
export const OPERATOR_TOKEN_FILE = 'operator.token';

function invalidToken() {
  return new AosError('operator_token_invalid', 'Operator token must be 32 to 512 non-whitespace characters', {
    statusCode: 500,
  });
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (token.length < 32 || token.length > 512 || /\s/.test(token)) throw invalidToken();
  return token;
}

export function operatorTokenPath(dataDir) {
  return join(resolve(dataDir), OPERATOR_TOKEN_FILE);
}

export function loadOperatorToken({ dataDir, env = process.env, create = true } = {}) {
  const configured = env?.[OPERATOR_TOKEN_ENV];
  if (configured) return { token: normalizeToken(configured), source: 'environment', path: null };
  if (!dataDir) throw new AosError('operator_token_path_required', 'AOS data directory is required for operator-token storage', { statusCode: 500 });

  const path = operatorTokenPath(dataDir);
  if (!existsSync(path) && create) {
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString('base64url');
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      try { unlinkSync(temporary); } catch { /* another process may own the final file */ }
    }
  }
  if (!existsSync(path)) {
    throw new AosError('operator_token_missing', 'Operator token is unavailable', { statusCode: 503 });
  }
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return { token: normalizeToken(readFileSync(path, 'utf8')), source: 'file', path };
}

export function assertOperatorAuthorization(header, token) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(header || '').trim());
  const supplied = match?.[1] || '';
  const expected = normalizeToken(token);
  const digest = (value) => createHash('sha256').update(value).digest();
  const valid = Boolean(match) && timingSafeEqual(digest(supplied), digest(expected));
  if (!valid) {
    throw new AosError('operator_authorization_required', 'Valid operator authorization is required', {
      statusCode: 401,
    });
  }
  return true;
}

export function operatorAuthorizationHeader(token) {
  return `Bearer ${normalizeToken(token)}`;
}
