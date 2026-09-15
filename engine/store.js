import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, rmSync, statSync, openSync, closeSync } from 'node:fs';
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
    migrations: [],
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
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
  }

  load() {
    ensureDir(this.dataDir);
    ensureDir(this.workspacesDir);
    if (!existsSync(this.statePath)) {
      this.state = emptyState();
      this.save();
      return this.state;
    }
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'));
    const { state, applied } = migrateState(parsed, { clock: this.clock });
    this.state = { ...emptyState(), ...state, version: STORE_VERSION };
    this.loadedMtime = this.mtime();
    this.loadedSize = this.size();
    if (applied.length) {
      // Keep the pre-migration file once, then persist the upgraded schema.
      const backup = `${this.statePath}.v${applied[0].from}.bak`;
      if (!existsSync(backup)) copyFileSync(this.statePath, backup);
      this.diagnostics.lastMigration = { applied, backup };
      this.save();
    }
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
        return () => {
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
  }

  appendEvent(event) {
    const record = {
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
    this.state.events.push(record);
    if (this.state.events.length > 2000) {
      this.state.events = this.state.events.slice(-1000);
    }
    return record;
  }

  readEventLog() {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  workspacePath(runId, taskId) {
    return join(this.workspacesDir, runId, taskId);
  }

  resetForTests() {
    if (existsSync(this.dataDir)) rmSync(this.dataDir, { recursive: true, force: true });
    this.state = emptyState();
    this.load();
  }
}
