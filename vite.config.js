import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { loadOperatorToken, operatorAuthorizationHeader } from './engine/operator-auth.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function assertLoopbackApiTarget(target) {
  let url;
  try {
    url = new URL(String(target || '').trim());
  } catch {
    throw new Error('AOS_API_TARGET must be an HTTP(S) loopback URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('AOS_API_TARGET must be an HTTP(S) loopback URL');
  }
  return url.toString();
}

export default defineConfig(() => {
  const apiTarget = assertLoopbackApiTarget(process.env.AOS_API_TARGET || 'http://127.0.0.1:7740');
  const operatorToken = loadOperatorToken({ dataDir: resolve(process.env.AOS_HOME || '.aos') }).token;
  const proxy = () => ({
    target: apiTarget,
    changeOrigin: true,
    configure(server) {
      server.on('proxyReq', (request) => request.setHeader('Authorization', operatorAuthorizationHeader(operatorToken)));
    },
  });
  return {
    publicDir: 'public-runtime',
    server: {
      port: 5173,
      proxy: {
        '/api': proxy(),
        '/health': proxy(),
      },
    },
  };
});
