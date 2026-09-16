import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, rmSync, statSync, truncateSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { newId, nowIso } from './ids.js';
import { CURRENT_STORE_VERSION, migrateState } from './migrate.js';

export const STORE_VERSION = CURRENT_STORE_VERSION;

export function emptyState() {
  return {
    version: STORE_VERSION,
    projects: [],
    goals: [],
    runs: [],
    tasks: [],
    agents: [],
    dependencies: [],
    evidence: [],
    decisions: [],
    policies: [],
    retrospectives: [],
    proposals: [],
    providers: [],
    events: [],
    presets: [],
    templates: [],
    blueprints: [],
    settings: [],
    memoryIndex: [],
    planVersions: [],
    planPatches: [],
    leadPlans: [],
    leadPlanCreationRequests: [],
    capabilities: [],
    capabilityTests: [],
    capabilityPermissions: [],
    capabilityStates: [],
    capabilityExecutions: [],
    effectApprovals: [],
    effectClaims: [],
    effectReceipts: [],
    effectRollbackReceipts: [],
    resourceReservations: [],
    resourceReceipts: [],
    harnessSessions: [],
    improvementEvaluations: [],
    genomeVersions: [],
    eventCursor: 0,
    migrations: [],
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function atomicWriteJson(filePath, value) {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

export class JsonStore {
  constructor({ dataDir, clock = () => Date.now() }) {
    this.dataDir = resolve(dataDir);
    this.clock = clock;
    this.statePath = join(this.dataDir, 'state.json');
    this.eventsPath = join(this.dataDir, 'events.jsonl');
    this.lockPath = join(this.dataDir, '.lock');
    this.workspacesDir = join(this.dataDir, 'workspaces');
    this.state = emptyState();
    this.loadedMtime = 0;
    this.diagnostics = {};
    this.loadedSize = 0;
    this.eventLogMaxCursor = 0;
    this.loadedStateSnapshot = null;
    this.lockHeld = false;
  }

  load() {
    ensureDir(this.dataDir);
    ensureDir(this.workspacesDir);
    if (!existsSync(this.statePath)) {
      this.state = emptyState();
      this.eventLogMaxCursor = this.readEventLog().reduce((max, event) => Math.max(max, Number(event.cursor) || 0), 0);
      this.state.eventCursor = this.eventLogMaxCursor;
      this.save();
      this.loadedStateSnapshot = structuredClone(this.state);
      return this.state;
    }
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
    const { state, applied } = migrateState(parsed, { clock: this.clock });
    this.state = { ...emptyState(), ...state, version: STORE_VERSION };
    const durableEvents = this.readEventLog();
    const stateEvents = Array.isArray(this.state.events) ? this.state.events : [];
    this.eventLogMaxCursor = Math.max(
      durableEvents.reduce((max, event) => Math.max(max, Number(event.cursor) || 0), 0),
      stateEvents.reduce((max, event, index) => Math.max(max, Number(event?.cursor) || index + 1), 0),
    );
    this.state.eventCursor = Math.max(Number.isInteger(Number(this.state.eventCursor)) && Number(this.state.eventCursor) >= 0 ? Number(this.state.eventCursor) : 0, this.eventLogMaxCursor);
    this.loadedMtime = this.mtime();
    this.loadedSize = this.size();
    if (applied.length) {
      // Keep the pre-migration file once, then persist the upgraded schema.
      const backup = `${this.statePath}.v${applied[0].from}.bak`;
      if (!existsSync(backup)) copyFileSync(this.statePath, backup);
      this.diagnostics.lastMigration = { applied, backup };
      this.save();
    }
    this.loadedStateSnapshot = structuredClone(this.state);
    return this.state;
  }

  mtime() {
    return existsSync(this.statePath) ? statSync(this.statePath).mtimeMs : 0;
  }

  size() {
    return existsSync(this.statePath) ? statSync(this.statePath).size : 0;
  }

  // Another process's save changes the mtime; size is compared too so two saves that
  // land within the same timestamp tick are still noticed when their content differs.
  stale() {
    return this.mtime() !== this.loadedMtime || this.size() !== this.loadedSize;
  }

  lock() {
    ensureDir(this.dataDir);
    const started = Date.now();
    while (Date.now() - started < 2000) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        writeFileSync(fd, String(process.pid));
        this.lockHeld = true;
        return () => {
          this.lockHeld = false;
          try { closeSync(fd); } catch { /* already closed */ }
          try { rmSync(this.lockPath, { force: true }); } catch { /* ignore */ }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        this.#breakStaleLock();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    throw new Error('Timed out waiting for the AOS store lock');
  }

  #breakStaleLock() {
    try {
      const raw = readFileSync(this.lockPath, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error?.code !== 'ESRCH') return false;
        }
      } else if (Date.now() - statSync(this.lockPath).mtimeMs < 2000) {
        return false;
      }
      rmSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  save() {
    ensureDir(this.dataDir);
    const snapshot = {
      ...this.state,
      events: this.state.events.slice(-500),
    };
    atomicWriteJson(this.statePath, snapshot);
    this.loadedMtime = this.mtime();
    this.loadedSize = this.size();
    this.loadedStateSnapshot = structuredClone(this.state);
  }

  appendEvent(event) {
    if (!this.lockHeld) return this.appendEventAtomic(event);
    return this.#appendEventUnlocked(event);
  }

  #appendEventUnlocked(event) {
    const persistedCursor = Number(this.state.eventCursor) || 0;
    const cursor = Math.max(persistedCursor, this.eventLogMaxCursor || 0) + 1;
    const record = {
      cursor,
      id: event.id || newId('event'),
      ts: event.ts || nowIso(this.clock),
      type: event.type,
      projectId: event.projectId || null,
      runId: event.runId || null,
      taskId: event.taskId || null,
      actor: event.actor || 'engine',
      payload: event.payload || {},
    };
    ensureDir(this.dataDir);
    appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
    this.state.eventCursor = cursor;
    this.eventLogMaxCursor = cursor;
    this.state.events.push(record);
    if (this.state.events.length > 2000) {
      this.state.events = this.state.events.slice(-1000);
    }
    return record;
  }

  // Event callbacks can run after an outer engine transaction has released the
  // lock (for example, while a worker is executing). Allocate their cursor from
  // fresh durable state while holding the same lock used by state mutations.
  // Keep the live state object intact: worker callbacks may still hold references
  // to a run/task while they emit. Only fields known to be event-owned are changed
  // in memory; the next state transaction will sync the fresh durable merge.
  appendEventAtomic(event) {
    const unlock = this.lock();
    const stateCheckpoint = this.stateCheckpoint();
    const eventCheckpoint = this.eventCheckpoint();
    const loadedMtime = this.loadedMtime;
    const loadedSize = this.loadedSize;
    const localState = this.state;
    const localSnapshot = this.loadedStateSnapshot;
    try {
      const durable = this.readDurableState();
      const durableEvents = this.readEventLog();
      const durableCursor = Math.max(
        Number(durable.eventCursor) || 0,
        durableEvents.reduce((max, item) => Math.max(max, Number(item.cursor) || 0), 0),
      );
      const cursor = durableCursor + 1;
      const record = this.#eventRecord(event, cursor);
      const merged = { ...durable };
      const baseline = localSnapshot || durable;
      if (localSnapshot) {
        for (const key of Object.keys(localState)) {
          if (key === 'events' || key === 'eventCursor') continue;
          if (!sameValue(localState[key], baseline[key])) merged[key] = structuredClone(localState[key]);
        }
      }
      merged.eventCursor = cursor;
      merged.events = [...(Array.isArray(durable.events) ? durable.events : []), record].slice(-500);
      appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
      atomicWriteJson(this.statePath, merged);

      // Preserve the caller's object identity while reflecting the new event.
      localState.eventCursor = cursor;
      localState.events.push(record);
      if (localState.events.length > 2000) localState.events.splice(0, localState.events.length - 1000);
      this.eventLogMaxCursor = cursor;
      // The durable file contains fresher non-event state than this in-memory
      // object may have. Leave stale markers unchanged so the next transaction
      // reloads it before mutating any caller-owned records.
      this.loadedStateSnapshot = structuredClone(localState);
      return record;
    } catch (error) {
      try { this.rollbackEventLog(eventCheckpoint); } catch { /* preserve original failure */ }
      try { this.restoreStateCheckpoint(stateCheckpoint); } catch { /* preserve original failure */ }
      this.state = localState;
      this.loadedStateSnapshot = localSnapshot;
      this.loadedMtime = loadedMtime;
      this.loadedSize = loadedSize;
      throw error;
    } finally {
      unlock();
    }
  }

  readDurableState() {
    if (!existsSync(this.statePath)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
    const { state } = migrateState(parsed, { clock: this.clock });
    return { ...emptyState(), ...state, version: STORE_VERSION };
  }

  #eventRecord(event, cursor) {
    return {
      cursor,
      id: event.id || newId('event'),
      ts: event.ts || nowIso(this.clock),
      type: event.type,
      projectId: event.projectId || null,
      runId: event.runId || null,
      taskId: event.taskId || null,
      actor: event.actor || 'engine',
      payload: event.payload || {},
    };
  }

  eventCheckpoint() {
    return existsSync(this.eventsPath)
      ? { existed: true, size: statSync(this.eventsPath).size }
      : { existed: false, size: 0 };
  }

  rollbackEventLog(checkpoint) {
    if (!checkpoint?.existed) {
      rmSync(this.eventsPath, { force: true });
      this.eventLogMaxCursor = 0;
      return;
    }
    truncateSync(this.eventsPath, checkpoint.size);
    this.eventLogMaxCursor = this.readEventLog().reduce((max, event) => Math.max(max, Number(event.cursor) || 0), 0);
  }

  readEventLog() {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        const event = JSON.parse(line);
        const cursor = Number(event.cursor);
        return Number.isInteger(cursor) && cursor > 0 ? { ...event, cursor } : { ...event, cursor: index + 1 };
      });
  }

  replay(options = {}) {
    return replayEventLog(this.readEventLog(), options);
  }

  stateCheckpoint() {
    return existsSync(this.statePath)
      ? { existed: true, contents: readFileSync(this.statePath) }
      : { existed: false, contents: null };
  }

  restoreStateCheckpoint(checkpoint) {
    if (!checkpoint?.existed) {
      rmSync(this.statePath, { force: true });
    } else {
      writeFileSync(this.statePath, checkpoint.contents);
    }
    this.loadedMtime = this.mtime();
    this.loadedSize = this.size();
  }

  workspacePath(runId, taskId) {
    return join(this.workspacesDir, runId, taskId);
  }

  resetForTests() {
    if (existsSync(this.dataDir)) rmSync(this.dataDir, { recursive: true, force: true });
    this.state = emptyState();
    this.eventLogMaxCursor = 0;
    this.load();
  }
}

// Returns a bounded, reconnect-safe slice of the append-only event log. A cursor is
// unavailable when it is ahead of the log, expired, missing from an otherwise bounded
// range, or the log itself is not strictly ordered. Old records are normalised by
// readEventLog() before this helper runs.
export function replayEventLog(events = [], { after = 0, limit = 100 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const earliestCursor = list[0]?.cursor ?? null;
  const latestCursor = list.at(-1)?.cursor ?? null;
  const numericAfter = Number(after);
  const malformed = !Number.isInteger(numericAfter) || numericAfter < 0;
  const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
  let ordered = true;
  let previous = 0;
  for (const event of list) {
    const cursor = Number(event?.cursor);
    if (!Number.isInteger(cursor) || cursor < 1 || cursor <= previous) ordered = false;
    previous = cursor;
  }
  const currentAfter = malformed ? 0 : numericAfter;
  const ahead = !malformed && (latestCursor === null ? currentAfter > 0 : currentAfter > latestCursor);
  const expired = !malformed && currentAfter > 0 && earliestCursor !== null && currentAfter < earliestCursor - 1;
  const hasCursor = list.some((event) => Number(event?.cursor) === currentAfter);
  const unavailable = !malformed && currentAfter > 0 && !ahead && !expired && !hasCursor;
  const resyncRequired = malformed || !ordered || ahead || expired || unavailable;
  const selected = resyncRequired
    ? []
    : list.filter((event) => Number(event.cursor) > currentAfter).slice(0, boundedLimit);
  return {
    events: selected,
    nextCursor: selected.at(-1)?.cursor ?? (malformed ? null : currentAfter),
    earliestCursor,
    latestCursor,
    resyncRequired,
  };
}
