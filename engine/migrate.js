// Store schema migrations. Each step upgrades one version and preserves every field it
// does not know about. Migrations only add or normalise; they never delete records.
import { nowIso } from './ids.js';
import { AosError } from './schema.js';

export const CURRENT_STORE_VERSION = 2;

// Collections introduced by version 2 (presets, templates, blueprints, settings, memory index).
export const COLLECTIONS_V2 = ['presets', 'templates', 'blueprints', 'settings', 'memoryIndex'];

const MIGRATIONS = {
  1: {
    to: 2,
    apply(state) {
      for (const name of COLLECTIONS_V2) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      for (const task of state.tasks || []) {
        if (task.lease === undefined) task.lease = null;
      }
      return state;
    },
  },
};

export function migrateState(raw, { clock = () => Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AosError('store_corrupt', 'state.json is not a JSON object', { statusCode: 500 });
  }
  const state = { ...raw };
  let version = Number.isInteger(state.version) && state.version > 0 ? state.version : 1;
  if (version > CURRENT_STORE_VERSION) {
    throw new AosError('store_version_unsupported', `state.json is version ${version}; this engine supports up to ${CURRENT_STORE_VERSION}`, {
      statusCode: 500,
      details: { found: version, supported: CURRENT_STORE_VERSION },
    });
  }
  const applied = [];
  while (version < CURRENT_STORE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new AosError('store_migration_missing', `no migration from store version ${version}`, { statusCode: 500, details: { from: version } });
    }
    step.apply(state);
    applied.push({ from: version, to: step.to, at: nowIso(clock) });
    version = step.to;
  }
  state.version = CURRENT_STORE_VERSION;
  state.migrations = [...(Array.isArray(state.migrations) ? state.migrations : []), ...applied];
  return { state, applied };
}
