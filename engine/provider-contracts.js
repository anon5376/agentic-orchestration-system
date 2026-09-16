import { CODEX_EFFORT_ALLOWLIST, CODEX_MODEL_ALLOWLIST } from './codex.js';
import { CLAUDE_EFFORT_ALLOWLIST, CLAUDE_MODEL_ALLOWLIST, CLAUDE_SANDBOX } from './claude.js';
import { EXTERNAL_HARNESS_ATTESTATION, EXTERNAL_HARNESS_PROTOCOL, EXTERNAL_HARNESS_SANDBOX } from './external-harness.js';
import { AosError } from './schema.js';

export const PROVIDER_CONTRACT_SCHEMA_VERSION = 1;

const MOUNTED_ADAPTERS = new Set(['local', 'codex', 'claude', 'ollama', 'openai', 'command']);

const AUTH_BOUNDARIES = Object.freeze({
  local: Object.freeze({ type: 'none', boundary: 'none', reference: null }),
  codex: Object.freeze({ type: 'cli_session', boundary: 'external_cli_session', reference: Object.freeze({ kind: 'session_name', name: 'codex-cli' }) }),
  claude: Object.freeze({ type: 'cli_session', boundary: 'external_cli_session', reference: Object.freeze({ kind: 'session_name', name: 'claude-cli' }) }),
  ollama: Object.freeze({ type: 'none', boundary: 'none', reference: null }),
  openai: Object.freeze({ type: 'api_key', boundary: 'process_environment', reference: Object.freeze({ kind: 'environment_name', name: 'OPENAI_API_KEY' }) }),
  grok: Object.freeze({ type: 'api_key', boundary: 'process_environment', reference: Object.freeze({ kind: 'environment_name', name: 'XAI_API_KEY' }) }),
  command: Object.freeze({ type: 'external_cli_session', boundary: 'external_cli_session', reference: Object.freeze({ kind: 'session_name', name: 'external-harness' }) }),
  api: Object.freeze({ type: 'unsupported_oauth', boundary: 'unsupported', reference: null }),
});

export const PROVIDER_FAILURES = Object.freeze([
  Object.freeze({ code: 'adapter_not_registered', retryable: false }),
  Object.freeze({ code: 'adapter_not_mounted', retryable: false }),
  Object.freeze({ code: 'adapter_disabled', retryable: false }),
  Object.freeze({ code: 'adapter_auth_unavailable', retryable: false }),
  Object.freeze({ code: 'adapter_unavailable', retryable: true }),
  Object.freeze({ code: 'adapter_model_unsupported', retryable: false }),
  Object.freeze({ code: 'adapter_sandbox_unsupported', retryable: false }),
  Object.freeze({ code: 'adapter_quota_exhausted', retryable: true }),
  Object.freeze({ code: 'adapter_cancellation_unsupported', retryable: false }),
  Object.freeze({ code: 'adapter_timeout', retryable: true }),
  Object.freeze({ code: 'adapter_transport_failed', retryable: true }),
  Object.freeze({ code: 'adapter_provider_rejected', retryable: false }),
  Object.freeze({ code: 'adapter_result_invalid', retryable: true }),
  Object.freeze({ code: 'adapter_attestation_failed', retryable: false }),
  Object.freeze({ code: 'adapter_substitution_detected', retryable: false }),
]);

export function assertOllamaTaskAdmission(planned = {}, effective = planned, { presetRole = null } = {}) {
  const task = effective && typeof effective === 'object' ? effective : {};
  const source = planned && typeof planned === 'object' ? planned : task;
  const taskId = source.id || task.id || '(unknown)';
  const sandbox = task.sandbox ?? task.config?.effective?.filesystem?.sandbox ?? null;
  if (sandbox != null && !['read_only', 'read-only', 'loopback-only'].includes(String(sandbox))) {
    throw new AosError('plan_ollama_sandbox_invalid', 'Plan task ' + taskId + ' selects Ollama with incompatible sandbox ' + sandbox, { statusCode: 409, details: { taskId, sandbox, expected: ['read_only'] } });
  }
  const delegation = task.delegation || task.config?.effective?.delegation || {};
  const delegates = task.mayDelegate === true
    || delegation.unlimited === true
    || delegation.maxChildren === null
    || delegation.maxDepth === null
    || (Number.isInteger(delegation.maxChildren) && delegation.maxChildren > 0)
    || (Number.isInteger(delegation.maxDepth) && delegation.maxDepth > 0);
  if (delegates) {
    throw new AosError('plan_ollama_delegation_invalid', 'Plan task ' + taskId + ' selects Ollama but is delegating; Ollama is limited to non-delegating bulk work', { statusCode: 409, details: { taskId, mayDelegate: task.mayDelegate ?? false, delegation } });
  }
  const bulk = task.kind === 'bulk'
    || task.role === 'bulk-worker'
    || presetRole === 'bulk-worker'
    || task.presetId === 'low-cost-bulk-worker'
    || task.templateId === 'default-bulk'
    || source.templateId === 'default-bulk';
  if (!bulk) {
    throw new AosError('plan_ollama_role_invalid', 'Plan task ' + taskId + ' selects Ollama outside the non-delegating bulk role/template', { statusCode: 409, details: { taskId, role: presetRole || task.role || task.kind || null, expected: 'bulk-worker/low-cost-bulk-worker' } });
  }
  return true;
}

// A configured wrapper has no AOS-owned shell interpolation, capability mount,
// delegation path, session resume, or filesystem/network isolation. Make those
// limits explicit before a workspace can be claimed.
export function assertExternalHarnessTaskAdmission(planned = {}, effective = planned) {
  const task = effective && typeof effective === 'object' ? effective : {};
  const source = planned && typeof planned === 'object' ? planned : task;
  const taskId = source.id || task.id || '(unknown)';
  const config = task.config?.effective || task.config || {};
  const sandbox = task.sandbox ?? config.filesystem?.sandbox ?? null;
  if (sandbox !== EXTERNAL_HARNESS_SANDBOX) {
    throw new AosError('plan_external_harness_sandbox_invalid', `Plan task ${taskId} selects the external harness but does not explicitly accept ${EXTERNAL_HARNESS_SANDBOX}`, {
      statusCode: 409,
      details: { taskId, sandbox, expected: EXTERNAL_HARNESS_SANDBOX },
    });
  }
  if (source.command != null || task.command != null || source.taskCommand != null || task.taskCommand != null) {
    throw new AosError('plan_external_harness_legacy_command', `Plan task ${taskId} contains a task-provided command; configure the adapter instead`, { statusCode: 409, details: { taskId } });
  }
  if (source.sessionId != null || task.sessionId != null || source.resumeSession != null || task.resumeSession != null) {
    throw new AosError('plan_external_harness_session_unsupported', `Plan task ${taskId} attempts to supply or resume an external harness session`, { statusCode: 409, details: { taskId } });
  }
  const delegation = task.delegation || config.delegation || {};
  const delegates = task.mayDelegate === true
    || delegation.unlimited === true
    || delegation.maxChildren === null
    || delegation.maxDepth === null
    || (Number.isInteger(delegation.maxChildren) && delegation.maxChildren > 0)
    || (Number.isInteger(delegation.maxDepth) && delegation.maxDepth > 0);
  if (delegates) {
    throw new AosError('plan_external_harness_delegation_invalid', `Plan task ${taskId} selects the external harness but delegates work`, { statusCode: 409, details: { taskId, delegation } });
  }
  const capabilities = task.capabilities || config.capabilities || {};
  const mounted = Object.values(capabilities).some((value) => Array.isArray(value) && value.length > 0);
  if (mounted || task.capabilityExecution || config.capabilityExecution) {
    throw new AosError('plan_external_harness_capability_invalid', `Plan task ${taskId} selects the external harness with a capability mount`, { statusCode: 409, details: { taskId } });
  }
  const fallback = task.fallback ?? config.harness?.fallback ?? task.harness?.fallback ?? [];
  if (Array.isArray(fallback) && fallback.length) {
    throw new AosError('plan_external_harness_fallback_invalid', `Plan task ${taskId} selects the external harness with a fallback`, { statusCode: 409, details: { taskId } });
  }
  return true;
}

// Direct Responses execution is intentionally smaller than the generic worker
// result surface: a task cannot select transport/auth/model controls, tools,
// delegation, fallback, or a prior response/session.
export function assertOpenAIResponsesTaskAdmission(planned = {}, effective = planned) {
  const task = effective && typeof effective === 'object' ? effective : {};
  const source = planned && typeof planned === 'object' ? planned : task;
  const taskId = source.id || task.id || '(unknown)';
  const config = task.config?.effective || task.config || {};
  const harness = config.harness || {};
  const sandbox = task.sandbox ?? config.filesystem?.sandbox ?? null;
  if (sandbox != null && !['read_only', 'read-only', 'remote_api_no_tools'].includes(String(sandbox))) {
    throw new AosError('plan_openai_responses_sandbox_invalid', `Plan task ${taskId} selects OpenAI Responses with incompatible sandbox ${sandbox}`, {
      statusCode: 409,
      details: { taskId, sandbox, expected: ['read_only', 'remote_api_no_tools'] },
    });
  }
  const delegation = task.delegation || config.delegation || {};
  const delegates = task.mayDelegate === true
    || delegation.unlimited === true
    || delegation.maxChildren === null
    || delegation.maxDepth === null
    || (Number.isInteger(delegation.maxChildren) && delegation.maxChildren > 0)
    || (Number.isInteger(delegation.maxDepth) && delegation.maxDepth > 0);
  if (delegates) {
    throw new AosError('plan_openai_responses_delegation_invalid', `Plan task ${taskId} selects OpenAI Responses but delegates work`, { statusCode: 409, details: { taskId, delegation } });
  }
  const capabilities = task.capabilities || config.capabilities || {};
  const mounted = Object.values(capabilities).some((value) => Array.isArray(value) ? value.length > 0 : value != null);
  if (mounted || task.capabilityExecution || config.capabilityExecution) {
    throw new AosError('plan_openai_responses_capability_invalid', `Plan task ${taskId} selects OpenAI Responses with a capability mount`, { statusCode: 409, details: { taskId } });
  }
  const fallback = task.fallback ?? harness.fallback ?? task.harness?.fallback ?? [];
  if ((Array.isArray(fallback) && fallback.length) || (!Array.isArray(fallback) && fallback != null)) {
    throw new AosError('plan_openai_responses_fallback_invalid', `Plan task ${taskId} selects OpenAI Responses with a fallback`, { statusCode: 409, details: { taskId } });
  }
  const controls = { ...task, ...config, ...harness };
  for (const key of ['apiKey', 'api_key', 'apiKeyEnv', 'authorization', 'headers', 'origin', 'baseUrl', 'baseURL', 'endpoint', 'url', 'tools', 'toolChoice', 'previousResponseId', 'conversation', 'sessionId', 'resumeSession', 'threadId']) {
    if (controls[key] != null) {
      throw new AosError('plan_openai_responses_control_invalid', `Plan task ${taskId} supplies unsupported OpenAI Responses control ${key}`, { statusCode: 409, details: { taskId, key } });
    }
  }
  return true;
}

function implementationFor(provider) {
  const id = provider.id;
  // Explicitly configured adapters are mounted only after their narrow
  // configuration is present. Static catalog entries never become runnable.
  const mounted = MOUNTED_ADAPTERS.has(id)
    && (!['ollama', 'openai'].includes(id) ? true : provider.adapterMounted !== false && (provider.adapterMounted === true || provider.configured === true));
  return {
    status: mounted ? 'mounted' : 'typed_boundary',
    mounted,
    source: mounted ? 'engine_worker_registry' : 'provider_catalog_only',
  };
}

export function isProviderMounted(id) {
  return MOUNTED_ADAPTERS.has(id);
}

function authContract(provider, execution) {
  const config = executionConfig(execution, provider.id);
  const expected = provider.id === 'command' && config?.authType === 'none'
    ? { type: 'none', boundary: 'none', reference: null }
    : provider.id === 'openai'
      ? { type: 'api_key', boundary: 'process_environment', reference: { kind: 'environment_name', name: config?.apiKeyEnv || 'OPENAI_API_KEY' } }
      : AUTH_BOUNDARIES[provider.id] || { type: 'unsupported', boundary: 'unsupported', reference: null };
  const reportedType = provider.auth?.type || provider.authType || 'none';
  const consistent = reportedType === expected.type;
  return {
    type: expected.type,
    boundary: expected.boundary,
    reference: expected.reference ? { ...expected.reference } : null,
    consistent,
    verified: consistent && (expected.type === 'none'
      ? Boolean(provider.configured)
      : provider.readiness?.status === 'available'),
  };
}

function runtimeContract(provider, execution) {
  const config = executionConfig(execution, provider.id);
  if (!config || !['codex', 'claude', 'ollama', 'openai', 'command'].includes(provider.id)) return { requested: null, effective: null };
  const requested = provider.id === 'claude'
    ? { model: config.model, effort: config.effort, sandbox: CLAUDE_SANDBOX }
    : provider.id === 'ollama'
      ? { model: config.model, sandbox: 'loopback-only' }
      : provider.id === 'openai'
        ? { model: config.model, sandbox: 'remote_api_no_tools', store: false, tools: false, sessionResume: false }
      : provider.id === 'command'
        ? { model: config.model, sandbox: EXTERNAL_HARNESS_SANDBOX, authType: config.authType, sessionMode: config.sessionMode, protocol: EXTERNAL_HARNESS_PROTOCOL }
        : { model: config.model, effort: config.effort, sandbox: 'read-only' };
  const effective = provider.readiness?.status === 'available'
    ? {
      model: provider.readiness.model || config.model,
      ...(!['ollama', 'openai'].includes(provider.id) ? { effort: provider.readiness.effort || config.effort } : {}),
      sandbox: provider.readiness.sandbox || requested.sandbox,
      ...(provider.id === 'openai' ? { store: false, tools: false, sessionResume: false } : {}),
      ...(provider.id === 'command' ? {
        authType: provider.readiness.authType || config.authType,
        sessionMode: provider.readiness.sessionMode || config.sessionMode,
        protocol: EXTERNAL_HARNESS_PROTOCOL,
      } : {}),
    }
    : null;
  return { requested, effective };
}

function executionConfig(execution, providerId) {
  if (!execution) return null;
  if (providerId === 'codex' && execution.codex) return execution.codex;
  if (providerId === 'claude' && execution.claude) return execution.claude;
  const entry = execution.adapters?.[providerId] || execution.providers?.[providerId];
  if (!entry || entry === false || entry.enabled === false) return null;
  return entry.config && typeof entry.config === 'object' ? entry.config : entry;
}

function sandboxContract(id) {
  if (id === 'codex') return { mode: 'read-only', required: true, enforced: true, enforcedBy: 'codex_cli' };
  if (id === 'claude') return { mode: CLAUDE_SANDBOX, required: true, enforced: true, enforcedBy: 'claude_cli_restricted' };
  if (id === 'ollama') return { mode: 'loopback-only', required: true, enforced: true, enforcedBy: 'ollama_url_validation' };
  if (id === 'openai') return { mode: 'remote_api_no_tools', required: true, enforced: true, enforcedBy: 'fixed_responses_request' };
  if (id === 'local') return { mode: 'task-workspace', required: true, enforced: true, enforcedBy: 'aos_path_boundary' };
  if (id === 'command') return { mode: EXTERNAL_HARNESS_SANDBOX, required: true, enforced: true, enforcedBy: 'fixed_argv_process_group', isolation: false };
  return { mode: 'unknown', required: true, enforced: false, enforcedBy: null };
}

function cancellationContract(id) {
  if (id === 'codex') {
    return {
      level: 'process_tree',
      required: true,
      request: 'abort_signal',
      confirmation: 'process_exit',
    };
  }
  if (id === 'command') return { level: 'process_tree', required: true, request: 'abort_signal', confirmation: 'process_exit' };
  if (id === 'local') {
    return { level: 'in_process', required: false, request: 'none', confirmation: 'function_return' };
  }
  if (id === 'claude') {
    return { level: 'process_tree', required: true, request: 'abort_signal', confirmation: 'process_exit' };
  }
  if (id === 'ollama') {
    return { level: 'request', required: true, request: 'abort_signal', confirmation: 'request_settled' };
  }
  if (id === 'openai') return { level: 'request', required: true, request: 'abort_signal', confirmation: 'request_settled' };
  return { level: 'unsupported', required: true, request: 'none', confirmation: 'none' };
}

function attestationContract(id, provider) {
  if (id === 'codex') {
    return {
      strength: 'verified_runtime_receipt',
      required: true,
      verified: provider.readiness?.status === 'available',
      binds: ['provider', 'auth_path', 'model', 'effort', 'sandbox', 'thread', 'usage', 'timestamps'],
    };
  }
  if (id === 'local') {
    return { strength: 'engine_local', required: false, verified: true, binds: ['provider', 'task', 'timestamps'] };
  }
  if (id === 'claude') {
    return {
      strength: 'verified_runtime_receipt',
      required: true,
      verified: provider.readiness?.status === 'available',
      binds: ['provider', 'auth_path', 'model', 'effort', 'restricted_posture', 'session', 'usage', 'timestamps'],
    };
  }
  if (id === 'ollama') {
    return {
      strength: 'local_response_observed',
      required: true,
      verified: provider.readiness?.status === 'available',
      binds: ['provider', 'loopback_base_url', 'model', 'usage', 'timestamps'],
      externalIdentity: false,
    };
  }
  if (id === 'openai') {
    return {
      strength: 'api_response_observed',
      required: true,
      verified: provider.readiness?.status === 'available',
      externalIdentity: false,
      binds: ['provider', 'api_key_environment_name', 'https_origin', 'model', 'store', 'tools', 'session_resume', 'usage', 'timestamps'],
    };
  }
  if (id === 'command') return {
    strength: 'self_reported_protocol',
    required: true,
    verified: provider.readiness?.status === 'available',
    externalIdentity: false,
    binds: ['protocol', 'provider', 'model', 'sandbox', 'auth_path', 'session_mode', 'nonce', 'exit_code', 'timestamps'],
  };
  return { strength: 'none', required: true, verified: false, binds: [] };
}

function catalogContract(provider) {
  if (provider.id === 'codex') {
    return {
      provenance: 'adapter_allowlist',
      revision: 'codex-v1',
      checkedAt: provider.readiness?.checkedAt || null,
      models: [...CODEX_MODEL_ALLOWLIST],
      efforts: [...CODEX_EFFORT_ALLOWLIST],
    };
  }
  if (provider.id === 'claude') {
    return {
      provenance: 'adapter_allowlist',
      revision: 'claude-v1',
      checkedAt: provider.readiness?.checkedAt || null,
      models: [...CLAUDE_MODEL_ALLOWLIST],
      efforts: [...CLAUDE_EFFORT_ALLOWLIST],
    };
  }
  if (provider.id === 'ollama') {
    return {
      provenance: 'ollama_local_model_list',
      revision: 'ollama-v1',
      checkedAt: provider.readiness?.checkedAt || null,
      models: provider.readiness?.model ? [provider.readiness.model] : null,
      efforts: null,
    };
  }
  if (provider.id === 'openai') {
    return {
      provenance: 'operator_configured_exact',
      revision: 'openai-responses-v1',
      checkedAt: provider.readiness?.checkedAt || null,
      models: provider.readiness?.model ? [provider.readiness.model] : null,
      efforts: null,
    };
  }
  if (provider.id === 'command') {
    return {
      provenance: 'configured_external_harness',
      revision: EXTERNAL_HARNESS_PROTOCOL,
      checkedAt: provider.readiness?.checkedAt || null,
      models: provider.readiness?.model == null ? null : [provider.readiness.model],
      efforts: null,
    };
  }
  return {
    provenance: 'not_published',
    revision: null,
    checkedAt: null,
    models: null,
    efforts: null,
  };
}

function quotaContract(provider, execution) {
  if (provider.id === 'codex' && executionConfig(execution, 'codex')) {
    const config = executionConfig(execution, 'codex');
    return {
      signal: 'configured_limit',
      maxConcurrency: config.maxConcurrency,
      remaining: null,
      checkedAt: provider.readiness?.checkedAt || null,
    };
  }
  if (provider.id === 'claude') {
    const config = executionConfig(execution, 'claude');
    if (config) return {
      signal: 'configured_limit',
      maxConcurrency: config.maxConcurrency ?? null,
      remaining: null,
      checkedAt: provider.readiness?.checkedAt || null,
      };
  }
  if (provider.id === 'ollama') {
    const config = executionConfig(execution, 'ollama');
    if (config) return {
      signal: 'configured_limit',
      maxConcurrency: config.maxConcurrency ?? null,
      remaining: null,
      checkedAt: provider.readiness?.checkedAt || null,
    };
  }
  if (provider.id === 'openai') {
    const config = executionConfig(execution, 'openai');
    if (config) return {
      signal: 'configured_limit',
      maxConcurrency: config.maxConcurrency ?? null,
      remaining: null,
      checkedAt: provider.readiness?.checkedAt || null,
    };
  }
  if (provider.id === 'command') {
    const config = executionConfig(execution, 'command');
    if (config) return {
      signal: 'configured_limit',
      maxConcurrency: config.maxConcurrency ?? null,
      remaining: null,
      checkedAt: provider.readiness?.checkedAt || null,
    };
  }
  return { signal: 'unknown', maxConcurrency: null, remaining: null, checkedAt: null };
}

export function createProviderContract(provider, { execution = null } = {}) {
  const implementation = implementationFor(provider);
  const auth = authContract(provider, execution);
  const runtime = runtimeContract(provider, execution);
  const sandbox = sandboxContract(provider.id);
  const cancellation = cancellationContract(provider.id);
  const attestation = attestationContract(provider.id, provider);
  const quota = quotaContract(provider, execution);
  const transport = provider.id === 'ollama'
    ? {
      kind: 'http',
      scope: 'loopback',
      baseUrl: executionConfig(execution, 'ollama')?.baseUrl || null,
      redirects: 'disabled',
    }
    : provider.id === 'command'
      ? { kind: 'stdio', scope: 'same_host', protocol: EXTERNAL_HARNESS_PROTOCOL, shell: false }
      : provider.id === 'openai'
        ? { kind: 'https', scope: 'pinned_origin', origin: executionConfig(execution, 'openai')?.origin || null, redirects: 'disabled', endpoint: '/v1/responses' }
      : null;
  const limitations = provider.id === 'ollama'
    ? [
      'local response attestation is self-reported by the loopback daemon, not external identity verification',
      'only the explicitly configured model is allowed',
      'non-delegating bulk role only',
      'no fallback or model substitution',
      'no auth, token, plugin, tool, or remote transport',
    ]
    : provider.id === 'command'
      ? [
        'operator-owned wrapper protocol only; this is not a native provider integration or OAuth implementation',
        'host_process means no filesystem or network isolation is claimed',
        'fixed executable and argv only; task-provided commands, fallback, delegation, capability mounts, and resume are refused',
        'provider/model/session evidence is self-reported protocol attestation, not external identity verification',
      ]
      : provider.id === 'openai'
        ? [
          'direct OpenAI API-key execution is distinct from a Codex ChatGPT account session and is not generic OAuth',
          'only the explicitly configured model and pinned HTTPS origin are allowed',
          'store is false; tools, capability mounts, delegation, fallback, and response/session resume are refused',
          'the receipt observes an API response and exact model, not an external account identity claim',
        ]
      : [];
  const readiness = provider.readiness?.status
    || (provider.liveExecutionEnabled ? 'available' : provider.configured ? 'configured' : 'not_live');
  const runtimeBound = !runtime.requested || Boolean(runtime.effective
    && Object.entries(runtime.requested).every(([key, value]) => runtime.effective[key] === value));
  const guaranteesMet = auth.verified
    && runtimeBound
    && (!sandbox.required || sandbox.enforced)
    && (!cancellation.required || cancellation.level !== 'unsupported')
    && (!attestation.required || attestation.verified)
    && quota.signal !== 'exhausted';
  const runnable = guaranteesMet
    && implementation.mounted
    && Boolean(provider.configured)
    && Boolean(provider.liveExecutionEnabled)
    && readiness === 'available';
  const dispatchStatus = !implementation.mounted
    ? 'not_mounted'
    : !provider.configured
      ? 'not_configured'
      : !auth.consistent || !auth.verified
        ? 'auth_unverified'
        : !provider.liveExecutionEnabled
          ? 'disabled'
          : readiness !== 'available'
            ? readiness
            : !runtimeBound
              ? 'runtime_mismatch'
              : sandbox.required && !sandbox.enforced
                ? 'sandbox_unsupported'
                : cancellation.required && cancellation.level === 'unsupported'
                  ? 'cancellation_unsupported'
                  : attestation.required && !attestation.verified
                    ? 'attestation_failed'
                    : quota.signal === 'exhausted'
                      ? 'quota_exhausted'
                      : 'available';
  return {
    schemaVersion: PROVIDER_CONTRACT_SCHEMA_VERSION,
    adapter: { id: provider.id, implementation },
    catalog: catalogContract(provider),
    auth,
    runtime,
    sandbox,
    cancellation,
    attestation,
    quota,
    ...(transport ? { transport } : {}),
    ...(limitations.length ? { limitations } : {}),
    capabilities: { discovery: 'not_implemented', mounted: [] },
    failures: PROVIDER_FAILURES.map((failure) => ({ ...failure })),
    dispatch: {
      runnable,
      status: dispatchStatus,
    },
  };
}

export function assertProviderDispatchable(provider, { workerId = null } = {}) {
  if (!provider) {
    throw new AosError('adapter_not_registered', `No provider contract is registered for ${workerId || 'this worker'}`, { statusCode: 409 });
  }
  const contract = provider.contract;
  if (!contract || contract.schemaVersion !== PROVIDER_CONTRACT_SCHEMA_VERSION) {
    throw new AosError('adapter_not_registered', `Provider ${provider.id} has no supported dispatch contract`, { statusCode: 409 });
  }
  if (!contract.adapter.implementation.mounted) {
    throw new AosError('adapter_not_mounted', `Provider ${provider.id} is a typed boundary; no worker adapter is mounted`, { statusCode: 409 });
  }
  if (!provider.configured) {
    throw new AosError('adapter_auth_unavailable', `Provider ${provider.id} is not configured`, { statusCode: 409 });
  }
  if (!contract.auth.consistent || !contract.auth.verified) {
    throw new AosError('adapter_auth_unavailable', `Provider ${provider.id} has not proved its declared auth boundary`, { statusCode: 409 });
  }
  if (!provider.liveExecutionEnabled) {
    throw new AosError('adapter_disabled', `Provider ${provider.id} is disabled for this engine process`, { statusCode: 409 });
  }
  if (provider.readiness?.status !== 'available' || !contract.dispatch.runnable) {
    const requested = contract.runtime.requested;
    const effective = contract.runtime.effective;
    if (requested && effective && Object.entries(requested).some(([key, value]) => effective[key] !== value)) {
      throw new AosError('adapter_substitution_detected', `Provider ${provider.id} effective runtime does not match the requested runtime`, { statusCode: 409 });
    }
    if (contract.sandbox.required && !contract.sandbox.enforced) {
      throw new AosError('adapter_sandbox_unsupported', `Provider ${provider.id} does not enforce its required sandbox`, { statusCode: 409 });
    }
    if (contract.cancellation.required && contract.cancellation.level === 'unsupported') {
      throw new AosError('adapter_cancellation_unsupported', `Provider ${provider.id} does not support required cancellation`, { statusCode: 409 });
    }
    if (contract.attestation.required && !contract.attestation.verified) {
      throw new AosError('adapter_attestation_failed', `Provider ${provider.id} has not produced the required dispatch attestation`, { statusCode: 409 });
    }
    if (contract.quota.signal === 'exhausted') {
      throw new AosError('adapter_quota_exhausted', `Provider ${provider.id} reports exhausted quota`, { statusCode: 409 });
    }
    throw new AosError('adapter_unavailable', `Provider ${provider.id} has not proved runtime readiness`, { statusCode: 409 });
  }
  return contract;
}
