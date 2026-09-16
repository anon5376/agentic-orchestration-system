import { createProviderContract } from './provider-contracts.js';

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
      note: 'Supported live auth is a Claude Code CLI account session. AOS does not store or print that session. The mounted adapter remains disabled until account-session preflight proves the restricted posture.',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      kind: 'local_http',
      auth: { type: 'none', secretEnv: null, session: null },
      liveAuthSupported: false,
      liveExecutionEnabled: false,
      configured: false,
      adapterMounted: false,
      secretPresent: false,
      note: 'Loopback-only local model adapter. It is mounted only for explicit mixed execution configuration and remains unavailable until local model preflight observes the configured model; no auth or token environment is accepted.',
    },
    {
      id: 'openai',
      name: 'OpenAI Responses (API key)',
      kind: 'api_key',
      auth: { type: 'api_key', secretEnv: 'OPENAI_API_KEY', session: null },
      liveAuthSupported: true,
      liveExecutionEnabled: false,
      configured: false,
      adapterMounted: false,
      secretPresent: false,
      note: 'Disabled-by-default direct OpenAI Responses API-key adapter. Its named environment variable is never stored or printed. This is not a Codex ChatGPT account session or generic OAuth adapter.',
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
      name: 'External harness (protocol)',
      kind: 'external_cli',
      auth: { type: 'external_cli_session', secretEnv: null, session: 'external-harness' },
      liveAuthSupported: true,
      liveExecutionEnabled: false,
      configured: false,
      secretPresent: false,
      note: 'Disabled-by-default fixed-argv external-harness protocol. It does not execute task-provided commands or implement provider OAuth.',
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

export function publicProviderView(provider, { execution = null } = {}) {
  const sourceReadiness = provider.readiness || {};
  const readiness = {
    status: typeof sourceReadiness.status === 'string'
      ? sourceReadiness.status
      : provider.liveExecutionEnabled ? 'available' : provider.configured ? 'configured' : 'not_live',
    checkedAt: typeof sourceReadiness.checkedAt === 'string' ? sourceReadiness.checkedAt : null,
    ...(typeof sourceReadiness.model === 'string' ? { model: sourceReadiness.model } : {}),
    ...(typeof sourceReadiness.effort === 'string' ? { effort: sourceReadiness.effort } : {}),
  };
  const contract = createProviderContract(provider, { execution });
  const sessionReference = contract.auth.reference?.kind === 'session_name' ? contract.auth.reference.name : null;
  const environmentReference = contract.auth.reference?.kind === 'environment_name' ? contract.auth.reference.name : null;
  const executionConfigured = adapterEnabled(execution, provider.id);
  const config = adapterConfig(execution, provider.id);
  const note = provider.id === 'local'
    ? `Offline deterministic worker. ${provider.liveExecutionEnabled ? 'Available to this engine process.' : 'Disabled by the selected execution mode.'}`
    : provider.id === 'codex'
      ? executionConfigured
        ? readiness.status === 'available'
          ? `Live preflight verified ${readiness.checkedAt || 'for this engine process'}: ChatGPT login, model ${config?.model || 'gpt-5.6-luna'}, effort ${config?.effort || 'max'}, read-only sandbox, at most ${config?.maxConcurrency || 4} concurrent workers.`
          : `Configured for ${config?.model || 'gpt-5.6-luna'}/${config?.effort || 'max'} in a read-only sandbox; availability is ${readiness.status.replace('_', ' ')} until live preflight succeeds.`
        : 'Codex live execution is disabled for this engine process.'
      : provider.id === 'claude'
          ? executionConfigured
          ? readiness.status === 'available'
            ? `Live preflight verified ${readiness.checkedAt || 'for this engine process'}: claude.ai account session, model ${config?.model || 'opus'}, effort ${config?.effort || 'max'}, restricted read-only tools, no permission prompts.`
            : `Configured for ${config?.model || 'opus'}/${config?.effort || 'max'} with restricted read-only tools; availability is ${readiness.status.replace('_', ' ')} until live preflight succeeds.`
          : 'Claude Code account login is catalogued, but no runnable adapter is configured.'
        : provider.id === 'ollama'
          ? executionConfigured
            ? readiness.status === 'available'
              ? `Loopback Ollama preflight observed configured model ${config?.model || readiness.model || 'unknown'} at ${config?.baseUrl || 'http://127.0.0.1:11434'}; local response attestation only, at most ${config?.maxConcurrency || 1} concurrent workers, no delegation or fallback.`
              : `Configured for local model ${config?.model || 'unknown'} at ${config?.baseUrl || 'http://127.0.0.1:11434'}; availability is ${readiness.status.replace('_', ' ')} until explicit Ollama preflight succeeds.`
            : 'Ollama is disabled; local model execution requires explicit mixed-mode configuration.'
        : provider.id === 'openai'
          ? executionConfigured
            ? readiness.status === 'available'
              ? `OpenAI Responses preflight observed configured model ${config?.model || readiness.model || 'unknown'} at ${config?.origin || 'https://api.openai.com'} with API-key environment reference ${environmentReference || 'OPENAI_API_KEY'}; store is disabled, tools and session resume are refused, and no ChatGPT account-session claim is made.`
              : `Configured for exact OpenAI Responses model ${config?.model || 'unknown'} using API-key environment reference ${environmentReference || 'OPENAI_API_KEY'}; availability is ${readiness.status.replace('_', ' ')} until explicit preflight succeeds.`
            : 'OpenAI Responses API-key execution is disabled; it is distinct from Codex ChatGPT account-session execution.'
        : provider.id === 'grok'
          ? 'Grok API-key configuration is detected without reading the value; no runnable adapter is mounted.'
          : provider.id === 'command'
            ? executionConfigured
              ? readiness.status === 'available'
                ? `External harness protocol preflight attested ${readiness.checkedAt || 'for this engine process'}: ${config?.provider || 'configured provider'}${config?.model ? `/${config.model}` : ''}, ${config?.authType || 'external_cli_session'} auth boundary, ${config?.sessionMode || 'none'} session mode, fixed argv, and host-process execution. This is self-reported protocol evidence, not native provider identity or OAuth.`
                : `External harness is configured for ${config?.provider || 'a provider'}${config?.model ? `/${config.model}` : ''}; availability is ${readiness.status.replace('_', ' ')} until fixed-protocol preflight succeeds.`
              : 'External harness is disabled. AOS will not execute task-provided commands; configure the fixed external-harness protocol explicitly.'
            : provider.id === 'api'
              ? 'Arbitrary HTTP OAuth is unsupported; this remains a typed boundary.'
              : 'Provider catalog entry; no public implementation note is available.';
  const view = {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    authType: provider.auth?.type || 'none',
    secretEnv: environmentReference,
    session: sessionReference,
    liveAuthSupported: Boolean(provider.liveAuthSupported),
    liveExecutionEnabled: Boolean(provider.liveExecutionEnabled),
    configured: Boolean(provider.configured),
    secretPresent: Boolean(provider.secretPresent),
    ...(provider.adapterMounted !== undefined ? { adapterMounted: Boolean(provider.adapterMounted) } : {}),
    readiness,
    note,
  };
  view.contract = contract;
  return view;
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
  const readiness = codexReadiness && codexReadiness.status
    ? { codex: codexReadiness }
    : codexReadiness || {};
  return providers.map((provider) => {
    const enabled = adapterEnabled(execution, provider.id);
    const config = adapterConfig(execution, provider.id);
    if (provider.id === 'codex' || provider.id === 'claude') {
      const providerReadiness = enabled ? readiness[provider.id] || { status: 'unverified', checkedAt: null } : { status: 'disabled', checkedAt: null };
      const available = providerReadiness.status === 'available';
      return {
        ...provider,
        liveExecutionEnabled: available,
        configured: enabled,
        readiness: providerReadiness,
      };
    }
    if (provider.id === 'ollama') {
      const providerReadiness = enabled
        ? readiness[provider.id] || { status: 'unverified', checkedAt: null }
        : { status: 'disabled', checkedAt: null };
      return {
        ...provider,
        adapterMounted: enabled,
        liveExecutionEnabled: enabled && providerReadiness.status === 'available',
        configured: enabled,
        readiness: providerReadiness,
      };
    }
    if (provider.id === 'openai') {
      const providerReadiness = enabled
        ? readiness.openai || { status: 'unverified', checkedAt: null }
        : { status: 'disabled', checkedAt: null };
      const apiKeyEnv = config?.apiKeyEnv || 'OPENAI_API_KEY';
      const secretPresent = enabled && envPresent(apiKeyEnv);
      return {
        ...provider,
        adapterMounted: enabled,
        auth: { type: 'api_key', secretEnv: apiKeyEnv, session: null },
        liveAuthSupported: true,
        liveExecutionEnabled: enabled && secretPresent && providerReadiness.status === 'available',
        configured: enabled && secretPresent,
        secretPresent,
        readiness: providerReadiness,
      };
    }
    if (provider.id === 'command') {
      const providerReadiness = enabled
        ? readiness.command || { status: 'unverified', checkedAt: null }
        : { status: 'disabled', checkedAt: null };
      const authType = config?.authType || 'external_cli_session';
      return {
        ...provider,
        name: 'External harness (protocol)',
        kind: 'external_cli',
        auth: authType === 'none'
          ? { type: 'none', secretEnv: null, session: null }
          : { type: 'external_cli_session', secretEnv: null, session: 'external-harness' },
        liveAuthSupported: true,
        liveExecutionEnabled: enabled && providerReadiness.status === 'available',
        configured: enabled,
        secretPresent: false,
        readiness: providerReadiness,
      };
    }
    if (execution?.mode === 'codex' && provider.liveExecutionEnabled) {
      return {
        ...provider,
        liveExecutionEnabled: false,
        readiness: { status: 'disabled', checkedAt: null },
        note: `${provider.note} Disabled while live Codex execution is configured; there is no fallback.`,
      };
    }
    if (execution?.mode === 'mixed' || execution?.mode === 'providers') {
      return {
        ...provider,
        liveExecutionEnabled: enabled,
        configured: enabled,
        readiness: enabled ? { status: 'available', checkedAt: null } : { status: 'disabled', checkedAt: null },
      };
    }
    return provider;
  });
}

function adapterConfig(execution, id) {
  if (!execution) return null;
  if (id === 'codex' && execution.codex) return execution.codex;
  if (id === 'claude' && execution.claude) return execution.claude;
  const value = execution.adapters?.[id] ?? execution.providers?.[id];
  if (!value || value === false || value.enabled === false) return null;
  return value.config && typeof value.config === 'object' ? value.config : value;
}

function adapterEnabled(execution, id) {
  if (!execution) return id === 'local';
  if (execution.mode === 'local') return id === 'local';
  if (execution.mode === 'codex') return id === 'codex';
  const value = execution.adapters?.[id] ?? execution.providers?.[id];
  return Boolean(value && value !== false && value.enabled !== false);
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
