import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENAI_RESPONSES_DEFAULT_ORIGIN,
  OPENAI_RESPONSES_MAX_RESPONSE_BYTES,
  OpenAIResponsesAdapterError,
  OpenAIResponsesPreflightError,
  OpenAIResponsesWorker,
  preflightOpenAIResponses,
  resolveOpenAIResponsesConfig,
} from '../engine/openai-responses.js';

function response(value, { status = 200, headers = {} } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[name] ?? headers[name.toLowerCase()] ?? null; } },
    text: async () => body,
  };
}

function outputEnvelope(model, text, usage = null) {
  return {
    object: 'response',
    status: 'completed',
    model,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    ...(usage ? { usage } : {}),
  };
}

function validOutput(nonce, extra = {}) {
  return {
    task_nonce: nonce,
    status: 'succeeded',
    summary: 'bounded API-key result',
    findings: [{ kind: 'supported', claim: 'the remote response matched the exact configured model', evidence: ['response.model'], confidence: 0.8 }],
    risks: [],
    confidence: 0.8,
    decision: null,
    retrospective: null,
    memory_writes: [],
    delegation: null,
    ...extra,
  };
}

function strictWireOutput(value) {
  const output = { ...value };
  if (!Object.hasOwn(output, 'questions')) output.questions = null;
  else if (Array.isArray(output.questions)) {
    output.questions = output.questions.map((question) => Object.hasOwn(question, 'reason') ? question : { ...question, reason: null });
  }
  return output;
}

function task(nonce = 'nonce-1') {
  return { id: 'task-1', key: 'OPENAI', title: 'API task', kind: 'research', attempts: 1, nonce, brief: 'Produce a bounded result from supplied context only.' };
}

function context() {
  const writes = new Map();
  return {
    run: { id: 'run-1' },
    goal: { prompt: 'Keep this assignment bounded and evidence-based.' },
    dependencies: [],
    workspace: { write(path, value) { writes.set(path, value); return path; } },
    writes,
  };
}

function fakeTransport({ model = 'gpt-test', responseModel = model, output = null, usage = null, onRequest = null } = {}) {
  return async (url, init) => {
    onRequest?.(url, init);
    const request = JSON.parse(init.body);
    const text = request.text?.format?.name === 'aos_openai_responses_preflight'
      ? JSON.stringify({ ok: true })
      : JSON.stringify(strictWireOutput(output || validOutput('nonce-1')));
    return response(outputEnvelope(responseModel, text, usage));
  };
}

function workerWith(output, options = {}) {
  const calls = [];
  const transport = fakeTransport({ output, ...options, onRequest: (url, init) => calls.push({ url, init }) });
  const env = { AOS_TEST_OPENAI_KEY: options.secret || `sk-${'a'.repeat(32)}` };
  return {
    worker: new OpenAIResponsesWorker({
      enabled: true,
      model: options.model || 'gpt-test',
      apiKeyEnv: 'AOS_TEST_OPENAI_KEY',
      timeoutMs: options.timeoutMs || 500,
      maxResponseBytes: options.maxResponseBytes,
    }, { transport, env }),
    calls,
    secret: env.AOS_TEST_OPENAI_KEY,
  };
}

test('OpenAI Responses config is exact, explicit, and accepts only a named key environment variable', () => {
  const config = resolveOpenAIResponsesConfig({ enabled: true, model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' });
  assert.equal(config.origin, OPENAI_RESPONSES_DEFAULT_ORIGIN);
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.apiKeyEnv, 'AOS_TEST_OPENAI_KEY');
  assert.throws(() => resolveOpenAIResponsesConfig({ enabled: true }), /exact model name/);
  assert.throws(() => resolveOpenAIResponsesConfig({ model: 'gpt-test', apiKey: 'do-not-store' }), (error) => {
    assert.equal(error.code, 'adapter_config_invalid');
    assert.equal(error.message.includes('do-not-store'), false);
    return true;
  });
  assert.throws(() => resolveOpenAIResponsesConfig({ model: 'gpt-test', origin: 'http://api.openai.com' }), /HTTPS/);
  assert.throws(() => resolveOpenAIResponsesConfig({ model: 'gpt-test', origin: 'https://eu.api.openai.com' }), /allowCustomOrigin/);
  assert.throws(() => resolveOpenAIResponsesConfig({ model: 'gpt-test', origin: 'https://gateway.example.test', allowCustomOrigin: true }), /OpenAI API hostname/);
  assert.deepEqual(
    resolveOpenAIResponsesConfig({ model: 'gpt-test', origin: 'https://eu.api.openai.com', allowCustomOrigin: true }).origin,
    'https://eu.api.openai.com',
  );
});

test('OpenAI Responses preflight proves the pinned model without storing or returning the API key', async () => {
  const secret = `sk-${'p'.repeat(32)}`;
  const calls = [];
  const result = await preflightOpenAIResponses(
    { model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' },
    { env: { AOS_TEST_OPENAI_KEY: secret }, transport: fakeTransport({ onRequest: (url, init) => calls.push({ url, init }) }) },
  );
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-test');
  assert.equal(result.store, false);
  assert.equal(result.tools, false);
  assert.equal(result.sessionResume, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.redirect, 'error');
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, 'gpt-test');
  assert.equal(payload.store, false);
  assert.deepEqual(payload.tools, []);
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.text.format.strict, true);
  assert.equal(Object.hasOwn(payload, 'previous_response_id'), false);
  assert.equal(Object.hasOwn(payload, 'conversation'), false);
  await assert.rejects(
    preflightOpenAIResponses({ model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' }, { env: {}, transport: fakeTransport() }),
    (error) => error instanceof OpenAIResponsesPreflightError && error.code === 'adapter_auth_unavailable',
  );
});

test('exact OpenAI Responses result is normalized with API-response attestation, no tools, and mapped usage', async () => {
  const output = validOutput('nonce-1');
  const { worker, calls, secret } = workerWith(output, {
    usage: {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 19,
    },
  });
  const ctx = context();
  const result = await worker.execute(task(), ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result, output);
  assert.equal(result.runtime.provider, 'openai');
  assert.equal(result.runtime.verified, true);
  assert.equal(result.runtime.attestation, 'openai_api_response');
  assert.deepEqual(result.runtime.requested, { model: 'gpt-test' });
  assert.deepEqual(result.runtime.effective, { model: 'gpt-test', source: 'openai_responses_response', attestation: 'openai_api_response' });
  assert.deepEqual(result.runtime.usage, {
    input_tokens: 12,
    cached_input_tokens: 3,
    output_tokens: 7,
    reasoning_output_tokens: 2,
    total_tokens: 19,
  });
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[1].init.body);
  assert.equal(request.model, 'gpt-test');
  assert.equal(request.store, false);
  assert.deepEqual(request.tools, []);
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.properties.delegation.type, 'null');
  assert.ok(request.text.format.schema.required.includes('questions'));
  assert.deepEqual(request.text.format.schema.properties.questions.anyOf[0], { type: 'null' });
  assert.equal(Object.hasOwn(request, 'previous_response_id'), false);
  assert.equal(Object.hasOwn(request, 'conversation'), false);
  assert.match(request.instructions, /no tools/i);
  assert.ok(ctx.writes.has('artifact.json'));
  assert.ok(ctx.writes.has('attempt-1/runtime.json'));
  assert.equal(JSON.stringify([...ctx.writes.values()]).includes(secret), false);
});

test('model mismatch, malformed output, and oversized responses fail typed without fallback', async (t) => {
  await t.test('model mismatch', async () => {
    const { worker } = workerWith(validOutput('nonce-1'), { model: 'gpt-test', responseModel: 'other-model' });
    const result = await worker.execute(task(), context());
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_substitution_detected');
    assert.equal(result.runtime.verified, false);
  });

  await t.test('malformed assistant JSON', async () => {
    const transport = async (url, init) => {
      const request = JSON.parse(init.body);
      return response(outputEnvelope('gpt-test', request.text?.format?.name === 'aos_openai_responses_preflight' ? JSON.stringify({ ok: true }) : 'not-json'));
    };
    const worker = new OpenAIResponsesWorker({ model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' }, { transport, env: { AOS_TEST_OPENAI_KEY: `sk-${'q'.repeat(32)}` } });
    const result = await worker.execute(task(), context());
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_result_invalid');
  });

  await t.test('oversized bounded JSON', async () => {
    let calls = 0;
    const transport = async (url, init) => {
      calls += 1;
      if (calls === 1) return response(outputEnvelope('gpt-test', JSON.stringify({ ok: true })));
      return response('x'.repeat(OPENAI_RESPONSES_MAX_RESPONSE_BYTES + 1));
    };
    const worker = new OpenAIResponsesWorker({ model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' }, { transport, env: { AOS_TEST_OPENAI_KEY: `sk-${'r'.repeat(32)}` } });
    const result = await worker.execute(task(), context());
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'adapter_response_oversize');
  });
});

test('timeout and caller abort abort the injected OpenAI Responses transport', async (t) => {
  await t.test('timeout', async () => {
    let signal;
    let calls = 0;
    const transport = async (url, init) => {
      calls += 1;
      if (calls === 1) return response(outputEnvelope('gpt-test', JSON.stringify({ ok: true })));
      signal = init.signal;
      return new Promise(() => {});
    };
    const worker = new OpenAIResponsesWorker({ model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY', timeoutMs: 20 }, { transport, env: { AOS_TEST_OPENAI_KEY: `sk-${'s'.repeat(32)}` } });
    const result = await worker.execute(task(), context());
    assert.equal(result.code, 'adapter_timeout');
    assert.equal(result.runtime.timedOut, true);
    assert.equal(signal.aborted, true);
  });

  await t.test('caller abort', async () => {
    let signal;
    let calls = 0;
    const transport = async (url, init) => {
      calls += 1;
      if (calls === 1) return response(outputEnvelope('gpt-test', JSON.stringify({ ok: true })));
      signal = init.signal;
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const worker = new OpenAIResponsesWorker({ model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY', timeoutMs: 500 }, { transport, env: { AOS_TEST_OPENAI_KEY: `sk-${'t'.repeat(32)}` } });
    const promise = worker.execute(task(), { ...context(), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.code, 'adapter_aborted');
    assert.equal(result.runtime.cancelled, true);
    assert.equal(signal.aborted, true);
  });
});

test('transport errors redact API-key-shaped content from persistent runtime receipts', async () => {
  const secret = `sk-${'u'.repeat(32)}`;
  const worker = new OpenAIResponsesWorker(
    { model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY' },
    { env: { AOS_TEST_OPENAI_KEY: secret }, transport: async () => { throw new Error(`Authorization: Bearer ${secret}`); } },
  );
  const ctx = context();
  const result = await worker.execute(task(), ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.runtime.error.includes(secret), false);
  assert.equal(JSON.stringify([...ctx.writes.values()]).includes(secret), false);
  assert.equal(String(result.error).includes(secret), false);
  assert.ok(new OpenAIResponsesAdapterError('adapter_unavailable', 'offline', { retryable: true }) instanceof OpenAIResponsesAdapterError);
});
