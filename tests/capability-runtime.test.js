import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRuntime, BOUNDED_ECHO_SOURCE } from '../engine/capability-runtime.js';

const scope = { projectId: 'prj_1', runId: 'run_1', taskId: 'tsk_1', agentId: 'agt_1', invocationId: 'invocation-local', harnessSessionId: null, attempt: 1 };
const mount = { reference: 'echo@1', kind: 'tool', fingerprint: 'fingerprint', adapter: { type: 'generated', reference: BOUNDED_ECHO_SOURCE } };

test('bounded echo returns a redacted receipt and replays only the exact idempotency request', async () => {
  const runtime = new CapabilityRuntime();
  const first = await runtime.execute({ mount, scope, input: { value: 'secret-value' }, idempotencyKey: 'run_1:echo@1:1' });
  assert.deepEqual(first.output, { echoed: { value: 'secret-value' } });
  assert.equal(first.receipt.inputFingerprint.length, 16);
  assert.equal(JSON.stringify(first.receipt).includes('secret-value'), false);
  const replay = await runtime.execute({ mount, scope, input: { value: 'secret-value' }, idempotencyKey: 'run_1:echo@1:1' });
  assert.equal(replay.idempotent, true);
  await assert.rejects(() => runtime.execute({ mount, scope, input: { value: 'different' }, idempotencyKey: 'run_1:echo@1:1' }), (error) => error.code === 'capability_idempotency_conflict');
});

test('only the deterministic generated adapter runs and cancellation is typed', async () => {
  const runtime = new CapabilityRuntime();
  await assert.rejects(() => runtime.execute({ mount: { ...mount, adapter: { type: 'local', reference: 'other' } }, scope, idempotencyKey: 'unsupported' }), (error) => error.code === 'capability_adapter_unsupported');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runtime.execute({ mount, scope, input: { delayMs: 20 }, signal: controller.signal, idempotencyKey: 'cancelled' }), (error) => error.code === 'capability_cancelled' && error.receipt.status === 'cancelled');
  await assert.rejects(() => runtime.execute({ mount, scope, input: { delayMs: 20 }, timeoutMs: 1, idempotencyKey: 'timed-out' }), (error) => error.code === 'capability_timed_out' && error.receipt.status === 'failed');
  await assert.rejects(() => runtime.execute({ mount, scope, input: { delayMs: 20 }, timeoutMs: 1, idempotencyKey: 'timed-out' }), (error) => error.code === 'capability_timed_out' && error.receipt.status === 'failed');
});

test('bounded echo timeout is typed and retains only a redacted receipt', async () => {
  const runtime = new CapabilityRuntime();
  await assert.rejects(
    () => runtime.execute({
      mount,
      scope,
      input: { delayMs: 20, apiKey: 'timeout-secret' },
      timeoutMs: 1,
      idempotencyKey: 'timed-out',
    }),
    (error) => error.code === 'capability_timed_out'
      && error.receipt
      && error.receipt.errorCode === 'capability_timed_out'
      && !JSON.stringify(error.receipt).includes('timeout-secret'),
  );
});
