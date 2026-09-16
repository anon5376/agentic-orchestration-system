import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';
import { assertLoopbackApiTarget } from '../vite.config.js';

const OPERATOR_TOKEN = 'test_operator_token_abcdefghijklmnopqrstuvwxyz';

test('Vite proxy targets stay on the loopback engine', () => {
  assert.equal(assertLoopbackApiTarget('http://127.0.0.1:7740'), 'http://127.0.0.1:7740/');
  assert.equal(assertLoopbackApiTarget('https://localhost:7740'), 'https://localhost:7740/');
  assert.equal(assertLoopbackApiTarget('http://[::1]:7740'), 'http://[::1]:7740/');
  for (const target of ['https://attacker.example', 'http://127.0.0.2:7740', 'ftp://localhost:7740']) {
    assert.throws(() => assertLoopbackApiTarget(target), /HTTP\(S\) loopback URL/);
  }
});

function engine() {
  const instance = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-http-security-')) });
  instance.load();
  return instance;
}

async function service() {
  const instance = engine();
  const server = createAosServer({ engine: instance, host: '127.0.0.1', port: 0, operatorToken: OPERATOR_TOKEN });
  await server.listen();
  return { instance, server, base: `http://127.0.0.1:${server.server.address().port}` };
}

test('HTTP control plane refuses public binds and non-loopback browser origins', async () => {
  assert.throws(
    () => createAosServer({ engine: engine(), host: '0.0.0.0', port: 0 }),
    (error) => error.code === 'public_bind_denied',
  );

  const { server, base } = await service();
  try {
    const denied = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'https://hostile.example' } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'request_origin_denied');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const allowed = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://localhost:5174' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5174');
    assert.notEqual(allowed.headers.get('access-control-allow-origin'), '*');
    const ipv6Origin = await fetch(`${base}/api/v1/health`, { headers: { Origin: 'http://[::1]:5174' } });
    assert.equal(ipv6Origin.status, 200);
    assert.equal(ipv6Origin.headers.get('access-control-allow-origin'), 'http://[::1]:5174');
  } finally {
    await server.close();
  }
});

test('HTTP control plane rejects JSON bodies above one MiB before mutation', async () => {
  const { instance, server, base } = await service();
  try {
    const unauthorized = await fetch(`${base}/api/v1/projects`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).code, 'operator_authorization_required');

    const response = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_TOKEN}` },
      body: JSON.stringify({ name: 'x'.repeat(1024 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'request_body_too_large');
    assert.equal(instance.state.projects.length, 1);
  } finally {
    await server.close();
  }
});

test('worker-pool routes require the operator token and forward exact fenced-claim arguments', async () => {
  const calls = [];
  let claimCount = 0;
  const fake = {
    sync() {},
    claimPoolTask(input) {
      calls.push(['claim', input]);
      claimCount += 1;
      if (claimCount === 1) return null;
      return {
        claimId: 'claim-1',
        status: 'claimed',
        providerRef: 'provider-private',
        credentials: { token: 'secret-private' },
        metadata: { threadId: 'thread-private', nested: { thread_id: 'thread-private' }, harnessReference: 'harness-private', deeper: { harness_reference: 'harness-private' } },
      };
    },
    heartbeatPoolClaim(claimId, input) {
      calls.push(['heartbeat', claimId, input]);
      return { claimId, status: 'alive', providerReference: 'provider-private', metadata: { threadId: 'thread-private', nested: { thread_id: 'thread-private', harnessReference: 'harness-private', deeper: { harness_reference: 'harness-private' } } } };
    },
    completePoolClaim(claimId, input) {
      calls.push(['complete', claimId, input]);
      return { claimId, status: 'completed', result: input.result, providerSessionRef: 'provider-private', metadata: { threadId: 'thread-private', harnessReference: 'harness-private' } };
    },
  };
  const service = createAosServer({ engine: fake, host: '127.0.0.1', port: 0, operatorToken: OPERATOR_TOKEN });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_TOKEN}` };
  try {
    const missing = await fetch(`${base}/api/v1/worker-pool/claims`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker: 'worker-1', ownerId: 'owner-1', requestId: 'request-1' }),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'operator_authorization_required');
    assert.deepEqual(calls, []);

    const noWorkInput = { worker: 'worker-1', ownerId: 'owner-1', requestId: 'no-work-request', runId: 'run-1' };
    const noWork = await fetch(`${base}/api/v1/worker-pool/claims`, { method: 'POST', headers, body: JSON.stringify(noWorkInput) });
    assert.equal(noWork.status, 200);
    assert.deepEqual(await noWork.json(), { claim: null });

    const claimInput = {
      worker: 'worker-1', ownerId: 'owner-1', requestId: 'request-1', runId: 'run-1',
      protocol: 'provider-adapter-v1', profileFingerprint: '0123456789abcdef',
    };
    const claimed = await fetch(`${base}/api/v1/worker-pool/claims`, { method: 'POST', headers, body: JSON.stringify(claimInput) });
    assert.equal(claimed.status, 201);
    const claimedBody = await claimed.json();
    assert.equal(claimedBody.providerRef, undefined);
    assert.equal(claimedBody.credentials, undefined);
    assert.equal(claimedBody.metadata.threadId, undefined);
    assert.equal(claimedBody.metadata.nested.thread_id, undefined);
    assert.equal(claimedBody.metadata.harnessReference, undefined);
    assert.equal(claimedBody.metadata.deeper.harness_reference, undefined);

    const heartbeatInput = { ownerId: 'owner-1', attempt: 2, workerPid: 101, workerPgid: 202 };
    const heartbeat = await fetch(`${base}/api/v1/worker-pool/claims/claim-1/heartbeat`, { method: 'POST', headers, body: JSON.stringify(heartbeatInput) });
    assert.equal(heartbeat.status, 200);
    const heartbeatBody = await heartbeat.json();
    assert.equal(heartbeatBody.providerReference, undefined);
    assert.equal(heartbeatBody.metadata.threadId, undefined);
    assert.equal(heartbeatBody.metadata.nested.thread_id, undefined);
    assert.equal(heartbeatBody.metadata.nested.harnessReference, undefined);
    assert.equal(heartbeatBody.metadata.nested.deeper.harness_reference, undefined);

    const completeInput = { ownerId: 'owner-1', attempt: 2, result: { status: 'ok', providerRef: 'input-private' } };
    const complete = await fetch(`${base}/api/v1/worker-pool/claims/claim-1/complete`, { method: 'POST', headers, body: JSON.stringify(completeInput) });
    assert.equal(complete.status, 200);
    const completeBody = await complete.json();
    assert.equal(completeBody.providerSessionRef, undefined);
    assert.equal(completeBody.result.providerRef, undefined);
    assert.equal(completeBody.metadata.threadId, undefined);
    assert.equal(completeBody.metadata.harnessReference, undefined);

    assert.deepEqual(calls, [
      ['claim', noWorkInput],
      ['claim', claimInput],
      ['heartbeat', 'claim-1', heartbeatInput],
      ['complete', 'claim-1', completeInput],
    ]);
  } finally {
    await service.close();
  }
});
