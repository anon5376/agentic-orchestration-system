// Store schema migrations. Each step upgrades one version and preserves every field it
// does not know about. Migrations only add or normalise; they never delete records.
import { nowIso } from './ids.js';
import { AosError } from './schema.js';

export const CURRENT_STORE_VERSION = 10;

// Collections introduced by version 2 (presets, templates, blueprints, settings, memory index).
export const COLLECTIONS_V2 = ['presets', 'templates', 'blueprints', 'settings', 'memoryIndex'];
export const COLLECTIONS_V3 = ['planVersions', 'planPatches'];
export const COLLECTIONS_V5 = ['leadPlans', 'leadPlanCreationRequests'];
export const COLLECTIONS_V6 = ['capabilities', 'capabilityTests', 'capabilityPermissions', 'capabilityStates'];
export const COLLECTIONS_V7 = ['harnessSessions'];
export const COLLECTIONS_V8 = ['improvementEvaluations', 'genomeVersions'];
export const COLLECTIONS_V9 = ['capabilityExecutions'];
export const COLLECTIONS_V10 = ['resourceReservations', 'resourceReceipts'];
// Capability registry collections are added without a destructive schema bump. The
// migration remains v5-compatible so existing stores retain their recorded migration
// history while the normalizer fills the new append-only collections.
export const CAPABILITY_COLLECTIONS = ['capabilities', 'capabilityTests'];

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
  2: {
    to: 3,
    apply(state) {
      for (const name of COLLECTIONS_V3) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      if (!Number.isInteger(state.eventCursor) || state.eventCursor < 0) {
        state.eventCursor = (state.events || []).reduce((max, event) => {
          const cursor = Number(event?.cursor);
          return Number.isInteger(cursor) && cursor > max ? cursor : max;
        }, 0);
      }
      return state;
    },
  },
  3: {
    to: 4,
    apply(state) {
      for (const task of state.tasks || []) {
        if (!task || typeof task !== 'object') continue;
        if (task.questions === undefined) task.questions = [];
        if (task.wait === undefined) task.wait = null;
        if (task.blockedBy === undefined) task.blockedBy = null;
      }
      return state;
    },
  },
  4: {
    to: 5,
    apply(state) {
      for (const name of COLLECTIONS_V5) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      return state;
    },
  },
  5: {
    to: 6,
    apply(state) {
      for (const name of COLLECTIONS_V6) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      return state;
    },
  },
  6: {
    to: 7,
    apply(state) {
      for (const name of COLLECTIONS_V7) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      return state;
    },
  },
  7: {
    to: 8,
    apply(state) {
      for (const name of COLLECTIONS_V8) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      return state;
    },
  },
  8: {
    to: 9,
    apply(state) {
      for (const name of COLLECTIONS_V9) {
        if (!Array.isArray(state[name])) state[name] = [];
      }
      return state;
    },
  },
  9: {
    to: 10,
    apply(state) {
      for (const name of COLLECTIONS_V10) if (!Array.isArray(state[name])) state[name] = [];
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
  for (const name of [...CAPABILITY_COLLECTIONS, ...COLLECTIONS_V9, ...COLLECTIONS_V10]) {
    if (!Array.isArray(state[name])) state[name] = [];
  }
  state.version = CURRENT_STORE_VERSION;
  state.migrations = [...(Array.isArray(state.migrations) ? state.migrations : []), ...applied];
  return { state, applied };
}
