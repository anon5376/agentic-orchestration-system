import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AosEngine } from '../engine/engine.js';
import { JsonStore, STORE_VERSION } from '../engine/store.js';
import { COLLECTIONS_V2, COLLECTIONS_V3, COLLECTIONS_V5, COLLECTIONS_V6, COLLECTIONS_V7, COLLECTIONS_V8, COLLECTIONS_V9, COLLECTIONS_V10, CURRENT_STORE_VERSION, migrateState } from '../engine/migrate.js';
import { AosError, check, notFound, t, validate } from '../engine/schema.js';

const FIXTURE = new URL('./fixtures/state-v1.json', import.meta.url);

function tempStore(prefix = 'aos-migrate-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('a version 1 store from the real project migrates to the current version with every record preserved', () => {
  const dataDir = tempStore();
  copyFileSync(FIXTURE, join(dataDir, 'state.json'));
  const before = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(before.version, 1);

  const aos = new AosEngine({ dataDir });
  aos.load();

  assert.equal(aos.state.version, CURRENT_STORE_VERSION);
  assert.equal(STORE_VERSION, CURRENT_STORE_VERSION);
  for (const name of ['projects', 'goals', 'runs', 'tasks', 'agents', 'dependencies', 'evidence', 'decisions', 'policies', 'retrospectives', 'proposals']) {
    assert.equal(aos.state[name].length, before[name].length, `${name} count preserved`);
    assert.deepEqual(aos.state[name].map((item) => item.id), before[name].map((item) => item.id), `${name} ids preserved in order`);
  }
  assert.deepEqual(aos.state.providers.slice(0, before.providers.length), before.providers, 'historical provider records preserved in order');
  assert.deepEqual(aos.state.providers.slice(before.providers.length).map((item) => item.id), ['ollama', 'openai'], 'new catalog providers append without rewriting history');
  for (const name of [...COLLECTIONS_V2, ...COLLECTIONS_V3, ...COLLECTIONS_V5, ...COLLECTIONS_V6, ...COLLECTIONS_V7, ...COLLECTIONS_V8, ...COLLECTIONS_V9, ...COLLECTIONS_V10]) assert.deepEqual(aos.state[name], [], `${name} added empty`);
  assert.equal(aos.state.eventCursor, aos.state.events.length, 'legacy in-state event tail seeds the cursor when no durable log exists');
  assert.ok(aos.state.tasks.every((task) => task.lease === null), 'old tasks gain lease: null');
  assert.ok(aos.state.tasks.every((task) => Array.isArray(task.questions) && task.wait === null && task.blockedBy === null));
  assert.equal(aos.state.migrations.length, CURRENT_STORE_VERSION - 1);
  assert.deepEqual(aos.state.migrations.map((item) => [item.from, item.to]), Array.from({ length: CURRENT_STORE_VERSION - 1 }, (_, index) => [index + 1, index + 2]));

  const backup = join(dataDir, 'state.json.v1.bak');
  assert.ok(existsSync(backup), 'pre-migration file kept');
  assert.equal(JSON.parse(readFileSync(backup, 'utf8')).version, 1);
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  assert.equal(onDisk.version, CURRENT_STORE_VERSION);
  assert.equal(onDisk.runs.length, before.runs.length);

  const again = new AosEngine({ dataDir });
  again.load();
  assert.equal(again.state.migrations.length, CURRENT_STORE_VERSION - 1, 'a second load does not migrate again');
  assert.equal(again.getRun(before.runs[0].id).status, before.runs[0].status);
});

test('migration preserves unknown top-level fields and record fields it does not know', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  raw.experimental = { keep: true };
  raw.tasks[0].customNote = 'kept';
  const { state, applied } = migrateState(raw);
  assert.deepEqual(state.experimental, { keep: true });
  assert.equal(state.tasks[0].customNote, 'kept');
  assert.equal(applied.length, CURRENT_STORE_VERSION - 1);
  assert.equal(JSON.parse(readFileSync(FIXTURE, 'utf8')).version, 1, 'fixture untouched');
});

test('v4 to current migration preserves unknown fields and current task wait records', () => {
  const raw = {
    version: 4,
    tasks: [{ id: 'task_current', questions: [{ id: 'q1', prompt: 'Already here' }], wait: { status: 'awaiting_user' }, blockedBy: { code: 'dependency_failed' }, custom: 'keep' }],
    experimental: { keep: true },
  };
  const { state, applied } = migrateState(raw);
  assert.equal(applied.length, CURRENT_STORE_VERSION - 4);
  assert.deepEqual(state.tasks[0], raw.tasks[0]);
  assert.deepEqual(state.experimental, raw.experimental);
  assert.deepEqual(state.leadPlans, []);
  for (const name of COLLECTIONS_V6) assert.deepEqual(state[name], []);
  for (const name of COLLECTIONS_V7) assert.deepEqual(state[name], []);
  for (const name of COLLECTIONS_V8) assert.deepEqual(state[name], []);
  for (const name of COLLECTIONS_V9) assert.deepEqual(state[name], []);
  for (const name of COLLECTIONS_V10) assert.deepEqual(state[name], []);
});

test('a store from a newer engine is refused with a stable error code', () => {
  const dataDir = tempStore();
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: CURRENT_STORE_VERSION + 1, projects: [] }), 'utf8');
  const store = new JsonStore({ dataDir });
  assert.throws(() => store.load(), (error) => error instanceof AosError && error.code === 'store_version_unsupported' && error.details.found === CURRENT_STORE_VERSION + 1);
});

test('new collections persist across restart on a version 2 store', () => {
  const dataDir = tempStore();
  const aos = new AosEngine({ dataDir });
  aos.load();
  aos.transact(() => {
    aos.state.settings.push({ id: 'set_probe', key: 'memory.enabled', value: false, scope: 'project' });
  });
  const reloaded = new AosEngine({ dataDir });
  reloaded.load();
  assert.deepEqual(reloaded.state.settings, [{ id: 'set_probe', key: 'memory.enabled', value: false, scope: 'project' }]);
  assert.equal(reloaded.state.migrations.length, 0);
});

test('unknown ids raise not_found with a 404 status and unchanged message', () => {
  const aos = new AosEngine({ dataDir: tempStore() });
  aos.load();
  assert.throws(() => aos.getRun('run_missing'), (error) => error instanceof AosError && error.code === 'not_found' && error.statusCode === 404 && error.message === 'Unknown run: run_missing');
  const error = notFound('goal', 'g1');
  assert.deepEqual(error.toJSON(), { error: 'Unknown goal: g1', code: 'not_found', details: { label: 'goal', id: 'g1' } });
});

test('schema validation reports typed problems with paths and rejects unknown fields', () => {
  const schema = t.object({
    name: t.string({ minLength: 1, maxLength: 10 }),
    depth: t.optional(t.integer({ min: 0, max: 5 })),
    mode: t.enumOf(['manual', 'auto_safe']),
    tags: t.array(t.string(), { maxItems: 2, unique: true }),
    nested: t.optional(t.object({ on: t.boolean() })),
  });
  assert.deepEqual(check(schema, { name: 'ok', mode: 'manual', tags: ['a'] }), []);
  const errors = check(schema, { name: '', depth: 9, mode: 'nope', tags: ['a', 'a', 'b'], nested: { on: 'yes' }, extra: 1 });
  const codes = errors.map((item) => `${item.path}:${item.code}`).sort();
  assert.deepEqual(codes, [
    '$.depth:max', '$.extra:unknown', '$.mode:enum', '$.name:minLength', '$.nested.on:type', '$.tags:maxItems', '$.tags[1]:unique',
  ].sort());
  assert.throws(() => validate(schema, { mode: 'manual' }, 'preset'), (error) => error instanceof AosError && error.code === 'invalid_input' && error.statusCode === 400 && error.details.errors.length >= 2);
  assert.equal(validate(t.nullable(t.string()), null), null);
  assert.deepEqual(check(t.oneOf([t.string(), t.integer()]), 1.5).map((item) => item.code), ['oneOf']);
});
