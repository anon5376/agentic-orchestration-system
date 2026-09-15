// Field names that carry secret values. A bare `key` is a setting or record name, not a secret;
// the patterns below still cover apiKey, api_key, accessKey, privateKey and the like.
const SECRET_KEY = /api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|authorization|credential/i;

export function envPresent(name) {
  if (!name) return false;
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0;
}

export function defaultProviders() {
  return [
    {
      id: 'local',
      name: 'Deterministic local worker',
      kind: 'local',
      auth: { type: 'none', secretEnv: null, session: null },
      liveAuthSupported: true,
      liveExecutionEnabled: true,
      configured: true,
      secretPresent: false,
      note: 'Offline worker used for acceptance. No credentials.',
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'cli_session',
      auth: { type: 'cli_session', secretEnv: null, session: 'codex-cli' },
      liveAuthSupported: true,
      liveExecutionEnabled: false,
      configured: false,
      secretPresent: false,
      note: 'Supported live auth is a Codex CLI ChatGPT account session. AOS does not store or print that session. Live execution runs only when the engine starts with AOS_EXECUTION=codex.',
    },
    {
      id: 'claude',
      name: 'Claude Code',
      kind: 'cli_session',
      auth: { type: 'cli_session', secretEnv: null, session: 'claude-cli' },
      liveAuthSupported: true,
      liveExecutionEnabled: false,
      configured: false,
      secretPresent: false,
      note: 'Supported live auth is a Claude Code CLI account session. AOS does not store or print that session. Live execution is not invoked in this MVP.',
    },
    {
      id: 'grok',
      name: 'Grok',
      kind: 'api_key',
      auth: { type: 'api_key', secretEnv: 'XAI_API_KEY', session: null },
      liveAuthSupported: true,
      liveExecutionEnabled: false,
      configured: envPresent('XAI_API_KEY'),
      secretPresent: envPresent('XAI_API_KEY'),
      note: 'API key via XAI_API_KEY. The value is never stored or printed. Live Grok calls are not invoked in this MVP.',
    },
    {
      id: 'command',
      name: 'Generic command worker',
      kind: 'command',
      auth: { type: 'none', secretEnv: null, session: null },
      liveAuthSupported: true,
      liveExecutionEnabled: true,
      configured: true,
      secretPresent: false,
      note: 'Runs an operator-supplied command inside the task workspace. No command is attached by default.',
    },
    {
      id: 'api',
      name: 'Generic HTTP worker',
      kind: 'api_key',
      auth: { type: 'unsupported_oauth', secretEnv: null, session: null },
      liveAuthSupported: false,
      liveExecutionEnabled: false,
      configured: false,
      secretPresent: false,
      note: 'Unsupported live auth: OAuth/account login for arbitrary HTTP APIs is not implemented. Typed boundary only.',
    },
  ];
}

export function publicProviderView(provider) {
  const readiness = provider.readiness || {
    status: provider.liveExecutionEnabled ? 'available' : provider.configured ? 'configured' : 'not_live',
    checkedAt: null,
  };
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    authType: provider.auth?.type || 'none',
    secretEnv: provider.auth?.secretEnv || null,
    session: provider.auth?.session || null,
    liveAuthSupported: Boolean(provider.liveAuthSupported),
    liveExecutionEnabled: Boolean(provider.liveExecutionEnabled),
    configured: Boolean(provider.configured),
    secretPresent: Boolean(provider.secretPresent),
    readiness,
    note: provider.note,
  };
}

export function redactSecrets(value, ancestors = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[cycle]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item, ancestors));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof item === 'string') {
        out[key] = item ? '[present]' : '[empty]';
      } else {
        out[key] = redactSecrets(item, ancestors);
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

// Live mode is a process setting, so it is applied to views at read time rather than stored.
export function applyExecutionToProviders(providers, execution, codexReadiness = null) {
  if (execution?.mode !== 'codex') return providers;
  const { model, effort, maxConcurrency } = execution.codex;
  return providers.map((provider) => {
    if (provider.id === 'codex') {
      const readiness = codexReadiness || { status: 'unverified', checkedAt: null };
      const available = readiness.status === 'available';
      return {
        ...provider,
        liveExecutionEnabled: available,
        configured: true,
        readiness,
        note: available
          ? `Live preflight verified ${readiness.checkedAt || 'for this engine process'}: Codex CLI ChatGPT login, model ${model}, effort ${effort}, read-only sandbox, at most ${maxConcurrency} concurrent workers. AOS never reads or stores the session token.`
          : `Codex execution is configured for model ${model}, effort ${effort}, and a read-only sandbox, but availability is ${readiness.status.replace('_', ' ')} until live preflight succeeds. There is no fallback.`,
      };
    }
    if (provider.liveExecutionEnabled) {
      return {
        ...provider,
        liveExecutionEnabled: false,
        readiness: { status: 'disabled', checkedAt: null },
        note: `${provider.note} Disabled while live Codex execution is configured; there is no fallback.`,
      };
    }
    return provider;
  });
}

export function refreshProviderSecrets(providers) {
  return providers.map((provider) => {
    if (provider.auth?.type === 'api_key' && provider.auth.secretEnv) {
      const present = envPresent(provider.auth.secretEnv);
      return { ...provider, secretPresent: present, configured: present || provider.configured };
    }
    return provider;
  });
}
