import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';

const OPERATOR_TOKEN = 'test_operator_token_delegation_123';

function stubEngine() {
  const calls = [];
  const receipt = {
    id: 'delegationReceipt_1',
    runId: 'run_1',
    status: 'awaiting_approval',
    childCount: 1,
    childPlanTaskIds: ['child_1'],
  };
  return {
    calls,
    receipt,
    sync() {},
    now() { return '2026-09-16T00:00:00.000Z'; },
    listDelegationExpansions(runId) {
      calls.push({ method: 'listDelegationExpansions', runId });
      return [structuredClone(receipt)];
    },
    decideDelegationExpansion(input) {
      calls.push({ method: 'decideDelegationExpansion', input: structuredClone(input) });
      return { ...structuredClone(receipt), status: input.decision === 'approve' ? 'accepted' : 'rejected', requestId: input.requestId };
    },
  };
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_TOKEN}`, ...(options.headers || {}) },
    ...options,
  });
  return { status: response.status, body: await response.json() };
}

test('delegation action, HTTP, and CLI doors preserve canonical receipt decisions', async () => {
  const engine = stubEngine();
  const service = createAosServer({ engine, host: '127.0.0.1', port: 0, operatorToken: OPERATOR_TOKEN });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const unauthorized = await fetch(`${base}/api/v1/runs/run_1/delegations`);
    assert.equal(unauthorized.status, 401);

    const httpList = await request(base, '/api/v1/runs/run_1/delegations');
    assert.equal(httpList.status, 200);
    const cliList = await executeCommand(engine, 'delegation list run_1');
    assert.equal(cliList.ok, true);
    assert.deepEqual(JSON.parse(cliList.lines.join('\n')), httpList.body);
    assert.deepEqual(engine.calls.slice(0, 2), [
      { method: 'listDelegationExpansions', runId: 'run_1' },
      { method: 'listDelegationExpansions', runId: 'run_1' },
    ]);

    const approved = await request(base, '/api/v1/delegations/delegationReceipt_1/approve', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'approve_1', actor: 'ignored', provider: 'ignored', model: 'ignored', patch: { additions: [] } }),
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'accepted');
    assert.deepEqual(engine.calls[2], {
      method: 'decideDelegationExpansion',
      input: { receiptId: 'delegationReceipt_1', decision: 'approve', requestId: 'approve_1' },
    });

    const rejected = await executeCommand(engine, 'delegation reject delegationReceipt_1 --request-id reject_1');
    assert.equal(rejected.ok, true);
    assert.equal(JSON.parse(rejected.lines.join('\n')).status, 'rejected');
    assert.deepEqual(engine.calls[3], {
      method: 'decideDelegationExpansion',
      input: { receiptId: 'delegationReceipt_1', decision: 'reject', requestId: 'reject_1' },
    });

    const missing = await request(base, '/api/v1/delegations/delegationReceipt_1/approve', { method: 'POST', body: '{}' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'invalid_input');
  } finally {
    await service.close();
  }
});
