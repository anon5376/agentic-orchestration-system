import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { createAosServer } from '../engine/http.js';
import { replayEventLog } from '../engine/store.js';

function engine(dataDir = null) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'aos-events-'));
  const aos = new AosEngine({ dataDir: dir, concurrency: 2 });
  aos.load();
  return aos;
}

async function serverFor(aos) {
  const service = createAosServer({ engine: aos, port: 0, host: '127.0.0.1', operatorToken: false });
  await service.listen();
  return { ...service, base: `http://127.0.0.1:${service.server.address().port}` };
}

test('new event cursors are global, persisted across restart, and old lines synthesize by line order', () => {
  const aos = engine();
  aos.createProject({ name: 'one' });
  aos.createProject({ name: 'two' });
  const first = aos.store.readEventLog();
  assert.ok(first.length >= 2);
  assert.deepEqual(first.map((event) => event.cursor), first.map((_, index) => index + 1));
  assert.equal(aos.state.eventCursor, first.at(-1).cursor);
  const oldLines = first.map(({ cursor, ...event }) => JSON.stringify(event)).join('\n') + '\n';
  writeFileSync(aos.store.eventsPath, oldLines, 'utf8');
  const reloaded = engine(aos.store.dataDir);
  const synthesized = reloaded.store.readEventLog();
  assert.deepEqual(synthesized.map((event) => event.cursor), synthesized.map((_, index) => index + 1));
  reloaded.createProject({ name: 'three' });
  const after = reloaded.store.readEventLog();
  assert.equal(after.at(-1).cursor, first.length + 1);
  assert.equal(JSON.parse(readFileSync(reloaded.store.eventsPath, 'utf8').trim().split('\n').at(-1)).cursor, first.length + 1);
});

test('event cursors remain unique across barrier-synchronised child processes', async () => {
  const aos = engine();
  const childCount = 40;
  const releasePath = join(aos.store.dataDir, 'event-race.release');
  const childPath = join(aos.store.dataDir, 'event-race-child.mjs');
  const engineModule = new URL('../engine/engine.js', import.meta.url).href;
  writeFileSync(childPath, `
import { existsSync } from 'node:fs';
import { AosEngine } from ${JSON.stringify(engineModule)};

const releasePath = process.env.AOS_EVENT_RELEASE;
process.send?.({ type: 'ready' });
const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
try {
  const aos = new AosEngine({ dataDir: process.env.AOS_EVENT_DATA });
  aos.load();
  aos.recordEvent('race.event', { payload: { child: process.pid } });
  process.send?.({ type: 'done' });
} catch (error) {
  process.send?.({ type: 'error', message: error.message });
  process.exitCode = 1;
}
`, 'utf8');
  const children = Array.from({ length: childCount }, () => fork(childPath, [], {
    env: { ...process.env, AOS_EVENT_DATA: aos.store.dataDir, AOS_EVENT_RELEASE: releasePath },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  const exits = children.map((child) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`event child exited ${code ?? signal}`)));
  }));
  await new Promise((resolve, reject) => {
    let ready = 0;
    const onMessage = (message) => {
      if (message?.type === 'error') return reject(new Error(message.message));
      if (message?.type === 'ready' && ++ready === childCount) resolve();
    };
    for (const child of children) {
      child.on('message', onMessage);
      child.once('error', reject);
    }
  });
  writeFileSync(releasePath, 'go\n', 'utf8');
  await Promise.all(exits);

  const events = aos.store.readEventLog().filter((event) => event.type === 'race.event');
  const cursors = events.map((event) => event.cursor);
  assert.equal(events.length, childCount);
  assert.equal(new Set(cursors).size, childCount);
  assert.deepEqual(cursors, [...cursors].sort((left, right) => left - right));
  const reloaded = engine(aos.store.dataDir);
  assert.equal(reloaded.state.eventCursor, cursors.at(-1));
});

test('recordEvent does not reacquire the store lock inside an outer transaction', () => {
  const aos = engine();
  const record = aos.transact(() => aos.recordEvent('inside.transaction', { payload: { ok: true } }));
  assert.equal(record.type, 'inside.transaction');
  assert.equal(aos.store.readEventLog().at(-1).cursor, record.cursor);
});

test('replay returns bounded duplicate-free pages and explicit resync bounds', async () => {
  const aos = engine();
  aos.createProject({ name: 'one' });
  aos.createProject({ name: 'two' });
  const service = await serverFor(aos);
  try {
    const firstResponse = await fetch(`${service.base}/api/v1/events/replay?after=0&limit=1`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.events.length, 1);
    assert.equal(first.resyncRequired, false);
    assert.equal(first.nextCursor, first.events[0].cursor);
    const second = await fetch(`${service.base}/api/v1/events/replay?after=${first.nextCursor}&limit=500`).then((response) => response.json());
    assert.equal(second.resyncRequired, false);
    assert.ok(second.events.every((event) => event.cursor > first.nextCursor));
    assert.equal(new Set(second.events.map((event) => event.cursor)).size, second.events.length);
    const ahead = await fetch(`${service.base}/api/v1/events/replay?after=999999&limit=10`).then((response) => response.json());
    assert.equal(ahead.resyncRequired, true);
    assert.equal(ahead.events.length, 0);
    assert.equal(typeof ahead.earliestCursor, 'number');
    assert.equal(typeof ahead.latestCursor, 'number');
    const malformed = await fetch(`${service.base}/api/v1/events/replay?after=nope&limit=10`).then((response) => response.json());
    assert.equal(malformed.resyncRequired, true);
  } finally {
    await service.close();
  }
});

test('SSE replays existing events, delivers a new event once, and resyncs invalid cursors', async () => {
  const aos = engine();
  aos.createProject({ name: 'before stream' });
  const service = await serverFor(aos);
  const controller = new AbortController();
  try {
    const response = await fetch(`${service.base}/api/v1/events/stream?after=0`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value || new Uint8Array());
    assert.match(firstChunk, /event: aos\.event/);
    assert.match(firstChunk, /"type":"(?:project\.created|goal\.created|plan\.created)"/);
    const existingCursor = aos.store.readEventLog().at(-1).cursor;
    aos.createProject({ name: 'after stream' });
    let received = firstChunk;
    const deadline = Date.now() + 2_000;
    while (!received.includes('after stream') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 250)),
      ]);
      if (result.timeout) continue;
      if (result.done) break;
      received += new TextDecoder().decode(result.value || new Uint8Array());
    }
    assert.match(received, /after stream/);
    const ids = [...received.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]));
    assert.equal(new Set(ids).size, ids.length, 'SSE does not duplicate cursors');
    assert.ok(ids.some((id) => id > existingCursor));
    controller.abort();
    await reader.cancel().catch(() => {});

    const invalid = await fetch(`${service.base}/api/v1/events/stream?after=bad`).then(async (res) => ({ status: res.status, text: await res.text() }));
    assert.equal(invalid.status, 200);
    assert.match(invalid.text, /event: aos\.resync/);
    assert.match(invalid.text, /earliestCursor/);
  } finally {
    controller.abort();
    await service.close();
  }
});

test('replay helper marks a cursor gap unavailable', () => {
  const result = replayEventLog([{ cursor: 3, type: 'one' }, { cursor: 5, type: 'two' }], { after: 4, limit: 10 });
  assert.equal(result.resyncRequired, true);
  assert.equal(result.earliestCursor, 3);
  assert.equal(result.latestCursor, 5);
});

test('a failed transaction restores state and the durable event log', () => {
  const aos = engine();
  const beforeState = readFileSync(aos.store.statePath);
  const beforeEvents = readFileSync(aos.store.eventsPath);
  const beforeProjects = structuredClone(aos.state.projects);
  const beforeCursor = aos.state.eventCursor;
  assert.throws(() => aos.transact(() => {
    aos.createProject({ name: 'callback failure' });
    throw new Error('callback failure');
  }), /callback failure/);
  assert.deepEqual(aos.state.projects, beforeProjects);
  assert.equal(aos.state.eventCursor, beforeCursor);
  assert.deepEqual(readFileSync(aos.store.statePath), beforeState);
  assert.deepEqual(readFileSync(aos.store.eventsPath), beforeEvents);

  const originalSave = aos.store.save.bind(aos.store);
  aos.store.save = () => { throw new Error('save failure'); };
  assert.throws(() => aos.createProject({ name: 'save failure' }), /save failure/);
  aos.store.save = originalSave;
  assert.deepEqual(aos.state.projects, beforeProjects);
  assert.equal(aos.state.eventCursor, beforeCursor);
  assert.deepEqual(readFileSync(aos.store.statePath), beforeState);
  assert.deepEqual(readFileSync(aos.store.eventsPath), beforeEvents);
});
