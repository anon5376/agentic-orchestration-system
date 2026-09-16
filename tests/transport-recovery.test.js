import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransportRecovery, recoverTransport } from '../src/lib/transportRecovery.js';

test('aos.resync snapshot failure schedules retries and then polling', async () => {
  const reconnectDelays = [];
  let pollingStarts = 0;
  const replayStatuses = [];
  const replay = async (status) => {
    replayStatuses.push(status);
    if (replayStatuses.length === 1) throw new Error('snapshot unavailable');
    return false;
  };

  let attempts = 0;
  let result = await recoverTransport({
    replay,
    status: 'resyncing',
    attempts,
    scheduleReconnect: (delay) => reconnectDelays.push(delay),
    startPolling: () => { pollingStarts += 1; },
  });
  attempts = result.attempts;

  assert.equal(result.action, 'reconnect');
  assert.deepEqual(reconnectDelays, [250]);
  assert.equal(pollingStarts, 0);

  result = await recoverTransport({
    replay,
    status: 'resyncing',
    attempts,
    scheduleReconnect: (delay) => reconnectDelays.push(delay),
    startPolling: () => { pollingStarts += 1; },
  });
  attempts = result.attempts;
  assert.equal(result.action, 'reconnect');
  assert.deepEqual(reconnectDelays, [250, 500]);

  result = await recoverTransport({
    replay,
    status: 'resyncing',
    attempts,
    scheduleReconnect: (delay) => reconnectDelays.push(delay),
    startPolling: () => { pollingStarts += 1; },
  });

  assert.equal(result.action, 'polling');
  assert.equal(pollingStarts, 1);
  assert.deepEqual(reconnectDelays, [250, 500]);
  assert.deepEqual(replayStatuses, ['resyncing', 'resyncing', 'resyncing']);
});

test('queued aos.resync and stream error share one replay and one recovery action', async () => {
  const reconnectDelays = [];
  let pollingStarts = 0;
  const replayStatuses = [];
  let resolveReplay;
  const replay = (status) => {
    replayStatuses.push(status);
    return new Promise((resolve) => { resolveReplay = resolve; });
  };
  const recovery = createTransportRecovery({
    replay,
    scheduleReconnect: (delay) => reconnectDelays.push(delay),
    startPolling: () => { pollingStarts += 1; },
  });

  const first = recovery.recover('resyncing');
  const second = recovery.recover('replaying');
  assert.strictEqual(second, first);
  assert.deepEqual(replayStatuses, ['resyncing']);

  resolveReplay(false);
  const result = await first;
  assert.equal(result.action, 'reconnect');
  assert.deepEqual(reconnectDelays, [250]);
  assert.equal(pollingStarts, 0);
});

test('recovery disposed while replay is pending schedules neither reconnect nor polling', async () => {
  const reconnectDelays = [];
  let pollingStarts = 0;
  let disposed = false;
  let resolveReplay;
  const recovery = createTransportRecovery({
    replay: () => new Promise((resolve) => { resolveReplay = resolve; }),
    isActive: () => !disposed,
    scheduleReconnect: (delay) => reconnectDelays.push(delay),
    startPolling: () => { pollingStarts += 1; },
  });

  const pending = recovery.recover('resyncing');
  disposed = true;
  resolveReplay(false);

  const result = await pending;
  assert.equal(result.action, 'disposed');
  assert.deepEqual(reconnectDelays, []);
  assert.equal(pollingStarts, 0);
});
