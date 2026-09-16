// Role runtime policy is intentionally small and provider-specific. It assigns
// the exact Codex model/effort for a resolved preset role; it does not change
// scheduling, provider capacity, sandboxing, or delegation authority.
export const ROLE_RUNTIME_POLICY_VERSION = 1;
export const MANAGER_ROLE_TASK_LIMIT = 7;

export const MANAGER_ROLE_KINDS = Object.freeze([
  'lead',
  'coordinator',
  'planner',
  'branch-manager',
  'manager',
  'supervisor',
]);

export const ROLE_RUNTIME_PROFILES = Object.freeze({
  manager: Object.freeze({ model: 'gpt-5.6-terra', effort: 'max' }),
  worker: Object.freeze({ model: 'gpt-5.6-luna', effort: 'max' }),
});

export function roleRuntimeFor(role) {
  if (typeof role !== 'string' || !role.trim()) return null;
  const normalizedRole = role.trim().toLowerCase();
  const classId = MANAGER_ROLE_KINDS.includes(normalizedRole) ? 'manager' : 'worker';
  const profile = ROLE_RUNTIME_PROFILES[classId];
  return Object.freeze({
    role: normalizedRole,
    class: classId,
    model: profile.model,
    effort: profile.effort,
  });
}

export function roleRuntimePolicyView() {
  return {
    version: ROLE_RUNTIME_POLICY_VERSION,
    managerTaskLimit: MANAGER_ROLE_TASK_LIMIT,
    managerRoles: [...MANAGER_ROLE_KINDS],
    profiles: {
      manager: { ...ROLE_RUNTIME_PROFILES.manager },
      worker: { ...ROLE_RUNTIME_PROFILES.worker },
    },
    // This is intentionally logical only. Provider, project, and run
    // concurrency limits continue to govern simultaneous processes.
    logicalWorkerFanout: 'unbounded_by_role_policy',
  };
}
