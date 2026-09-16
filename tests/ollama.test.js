import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_MAX_RESPONSE_BYTES,
  OllamaAdapterError,
  OllamaPreflightError,
  OllamaWorker,
  preflightOllama,
  resolveOllamaConfig,
} from '../engine/ollama.js';

function response(value, { status = 200, headers = {} } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[name] ?? headers[name.toLowerCase()] ?? null; } },
    text: async () => body,
  };
}

function validOutput(nonce, extra = {}) {
  return {
    task_nonce: nonce,
    status: 'succeeded',
    summary: 'bounded local result',
    findings: [{ kind: 'supported', claim: 'the local response was bounded', evidence: ['prompt'], confidence: 0.8 }],
    risks: [],
    confidence: 0.8,
    decision: null,
    retrospective: null,
    memory_writes: [],
    delegation: null,
    ...extra,
  };
}

function task(nonce = 'nonce-1') {
  return { id: 'task-1', key: 'OLLAMA', title: 'Local task', kind: 'research', attempts: 1, nonce, brief: 'Read the bounded local assignment.' };
}

function context() {
  const writes = new Map();
  return {
    run: { id: 'run-1' },
    goal: { prompt: 'Keep this assignment local and bounded.' },
    dependencies: [],
    workspace: {
      write(path, value) { writes.set(path, value); return path; },
    },
    writes,
  };
}

function fakeTransport({ model = 'llama3.2', responseModel = model, output = null, usage = null, tags = [model], onRequest = null } = {}) {
  return async (url, init) => {
    onRequest?.(url, init);
    if (url.endsWith('/api/tags')) return response({ models: tags.map((name) => ({ name })) });
    const payload = output || validOutput('nonce-1');
    return response({
      model: responseModel,
      message: { role: 'assistant', content: JSON.stringify(payload) },
      ...(usage ? usage : {}),
    });
  };
}

function workerWith(output, options = {}) {
  const calls = [];
  const transport = fakeTransport({ output, ...options, onRequest: (url, init) => calls.push({ url, init }) });
  return { worker: new OllamaWorker({ enabled: true, model: options.model || 'llama3.2', timeoutMs: options.timeoutMs || 500, maxResponseBytes: options.maxResponseBytes }, { transport }), calls };
}

test('Ollama config is explicit, exact-model, bounded, and loopback-origin only', () => {
  const config = resolveOllamaConfig({ enabled: true, model: 'llama3.2' });
  assert.equal(config.enabled, true);
  assert.equal(config.baseUrl, OLLAMA_DEFAULT_BASE_URL);
  assert.equal(config.model, 'llama3.2');
  assert.throws(() => resolveOllamaConfig({ enabled: true }), /exact model name/);
  assert.throws(() => resolveOllamaConfig({ enabled: true, model: 'llama3.2', maxConcurrency: 5 }), /maxConcurrency/);
  assert.throws(() => resolveOllamaConfig({ enabled: true, model: 'llama3.2', timeoutMs: Infinity }), /timeoutMs/);
  for (const baseUrl of [
    'https://127.0.0.1:11434',
    'http://localhost:11434',
    'http://127.0.0.2:11434',
    'http://example.test:11434',
    'http://127.0.0.1:11434/api',
    'http://127.0.0.1:11434/?token=secret',
    'http://user:pass@127.0.0.1:11434',
    'http://2130706433:11434',
  ]) assert.throws(() => resolveOllamaConfig({ enabled: true, model: 'llama3.2', baseUrl }), /baseUrl/);
  assert.throws(() => resolveOllamaConfig({ enabled: true, model: 'llama3.2', apiKey: 'do-not-leak' }), (error) => {
    assert.equal(error.code, 'adapter_config_invalid');
    assert.equal(error.message.includes('do-not-leak'), false);
    return true;
  });
});

test('preflight uses GET /api/tags and refuses an absent exact model', async () => {
  const calls = [];
  await assert.rejects(
    preflightOllama(
      { enabled: true, model: 'llama3.2:7b' },
      { transport: fakeTransport({ model: 'llama3.2', tags: ['llama3.2'] , onRequest: (url, init) => calls.push({ url, init }) }) },
    ),
    (error) => {
      assert.ok(error instanceof OllamaPreflightError);
      assert.equal(error.code, 'adapter_model_unsupported');
      assert.equal(error.message.includes('llama3.2:7b'), true);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
});

test('exact Ollama response is normalized with local-response attestation and no tools', async () => {
  const output = validOutput('nonce-1');
  const { worker, calls } = workerWith(output, {
    usage: { prompt_eval_count: 12, eval_count: 7, total_duration: 99 },
  });
  const ctx = context();
  const result = await worker.execute(task(), ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result, output);
  assert.equal(result.runtime.provider, 'ollama');
  assert.equal(result.runtime.verified, false);
  assert.equal(result.runtime.attestation, 'local_response');
  assert.deepEqual(result.runtime.requested, { model: 'llama3.2' });
  assert.deepEqual(result.runtime.effective, { model: 'llama3.2', source: 'ollama_response_model', attestation: 'local_response' });
  assert.deepEqual(result.runtime.usage, { input_tokens: 12, output_tokens: 7, total_duration_ns: 99 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/chat');
  const request = JSON.parse(calls[1].init.body);
  assert.equal(request.model, 'llama3.2');
  assert.equal(request.stream, false);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[1].role, 'user');
  assert.match(request.messages[1].content, /AOS task nonce: nonce-1/);
  assert.equal(Object.hasOwn(request, 'tools'), false);
  assert.equal(request.format.properties.delegation.type, 'null');
  assert.ok(ctx.writes.has('artifact.json'));
  assert.ok(ctx.writes.has('attempt-1/runtime.json'));
});

test('model mismatch, malformed JSON, and oversized responses fail typed without fallback', async (t) => {
  await t.test('model mismatch', async () => {
    const { worker } = workerWith(validOutput('nonce-1'), { model: 'llama3.2', responseModel: 'other-model' });
    const result = await worker.execute(task(), context());
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_substitution_detected');
    assert.equal(result.runtime.verified, false);
  });

  await t.test('malformed message content', async () => {
    const transport = async (url) => url.endsWith('/api/tags')
      ? response({ models: [{ name: 'llama3.2' }] })
      : response({ model: 'llama3.2', message: { content: 'not-json' } });
    const worker = new OllamaWorker({ enabled: true, model: 'llama3.2' }, { transport });
    const result = await worker.execute(task(), context());
    assert.equal(result.code, 'adapter_result_invalid');
    assert.equal(result.status, 'failed');
  });

  await t.test('oversized bounded JSON', async () => {
    const transport = async (url) => url.endsWith('/api/tags')
      ? response({ models: [{ name: 'llama3.2' }] })
      : response('x'.repeat(OLLAMA_MAX_RESPONSE_BYTES + 1));
    const worker = new OllamaWorker({ enabled: true, model: 'llama3.2' }, { transport });
    const result = await worker.execute(task(), context());
    assert.equal(result.code, 'adapter_response_oversize');
    assert.equal(result.status, 'failed');
  });
});

test('timeout and caller abort abort the injected transport', async (t) => {
  await t.test('timeout', async () => {
    let signal;
    const transport = async (url, init) => {
      if (url.endsWith('/api/tags')) return response({ models: [{ name: 'llama3.2' }] });
      signal = init.signal;
      return new Promise(() => {});
    };
    const worker = new OllamaWorker({ enabled: true, model: 'llama3.2', timeoutMs: 20 }, { transport });
    const result = await worker.execute(task(), context());
    assert.equal(result.code, 'adapter_timeout');
    assert.equal(result.runtime.timedOut, true);
    assert.equal(signal.aborted, true);
  });

  await t.test('caller abort', async () => {
    let signal;
    const transport = async (url, init) => {
      if (url.endsWith('/api/tags')) return response({ models: [{ name: 'llama3.2' }] });
      signal = init.signal;
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const worker = new OllamaWorker({ enabled: true, model: 'llama3.2', timeoutMs: 500 }, { transport });
    const promise = worker.execute(task(), { ...context(), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.code, 'adapter_aborted');
    assert.equal(result.runtime.cancelled, true);
    assert.equal(signal.aborted, true);
  });
});

test('secret-like content is not persisted and transport errors are redacted', async () => {
  const jwt = `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`;
  const errorTransport = async () => { throw new Error(`Authorization: Bearer ${'z'.repeat(32)} ${jwt}`); };
  const errorWorker = new OllamaWorker({ enabled: true, model: 'llama3.2', timeoutMs: 100 }, { transport: errorTransport });
  const errorResult = await errorWorker.execute(task(), context());
  assert.equal(errorResult.code, 'adapter_unavailable');
  assert.equal(errorResult.runtime.error.includes(jwt), false);
  assert.equal(errorResult.runtime.error.includes('z'.repeat(32)), false);

  const secretOutput = validOutput('nonce-1', { memory_writes: [{ apiKey: 'do-not-persist' }] });
  const ctx = context();
  const { worker } = workerWith(secretOutput);
  const result = await worker.execute(task(), ctx);
  assert.equal(result.code, 'adapter_secret_content');
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify([...ctx.writes.values()]).includes('do-not-persist'), false);
  assert.ok(ctx.writes.has('attempt-1/runtime.json'));
});

test('injected failures remain typed', async () => {
  const error = new OllamaAdapterError('adapter_unavailable', 'offline', { retryable: true });
  assert.equal(error.code, 'adapter_unavailable');
  assert.equal(error.retryable, true);
});
