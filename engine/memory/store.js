// One memory store per scope namespace, as an append-only JSONL file where each line is a
// full record snapshot; the newest line per id wins. Compaction rewrites the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class MemoryStore {
  constructor({ dir, scope, namespace }) {
    this.dir = dir;
    this.scope = scope;
    this.namespace = namespace;
    this.path = join(dir, 'items.jsonl');
    this.items = new Map();
    this.loaded = false;
    this.malformed = 0;
  }

  static exists(dir) {
    return existsSync(join(dir, 'items.jsonl'));
  }

  load() {
    this.items = new Map();
    this.malformed = 0;
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record && typeof record.id === 'string') this.items.set(record.id, record);
        } catch {
          this.malformed += 1;
        }
      }
    }
    this.loaded = true;
    return this;
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
    return this;
  }

  get(id) {
    return this.ensureLoaded().items.get(id) || null;
  }

  all() {
    return [...this.ensureLoaded().items.values()];
  }

  live() {
    return this.all().filter((item) => !item.tombstoned && !item.supersededBy && item.status === 'committed');
  }

  put(record) {
    this.ensureLoaded();
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    this.items.set(record.id, record);
    return record;
  }

  compact(keep = () => true) {
    this.ensureLoaded();
    const kept = this.all().filter(keep);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map((item) => JSON.stringify(item)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    renameSync(tmp, this.path);
    this.items = new Map(kept.map((item) => [item.id, item]));
    return kept.length;
  }
}
