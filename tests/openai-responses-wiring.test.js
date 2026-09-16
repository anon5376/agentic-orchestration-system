import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executionFromEnv } from '../engine/cli.js';
import { AosEngine } from '../engine/engine.js';
import { OpenAIResponsesWorker } from '../engine/openai-responses.js';
import { assertOpenAIResponsesTaskAdmission, assertProviderDispatchable } from '../engine/provider-contracts.js';

function response(value) {
  return {
    status: 200,
    ok: true,
    headers: { get() { return null; } },
    text: async () => JSON.stringify(value),
  };
}

function outputEnvelope(model, text) {
  return {
    object: 'response',
    status: 'completed',
    model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
}

function preflightTransport(url, init) {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const request = JSON.parse(init.body);
  assert.equal(request.store, false);
  assert.deepEqual(request.tools, []);
  return response(outputEnvelope('gpt-test', JSON.stringify({ ok: true })));
}

test('OpenAI Responses environment wiring is explicit and never reads or persists an inline key value', () => {
  const secret = `sk-${'v'.repeat(32)}`;
  const execution = executionFromEnv({
    AOS_EXECUTION: 'openai',
    AOS_OPENAI_RESPONSES_MODEL: 'gpt-test',
    AOS_OPENAI_RESPONSES_API_KEY_ENV: 'AOS_TEST_OPENAI_KEY',
    AOS_TEST_OPENAI_KEY: secret,
  });
  assert.equal(execution.mode, 'mixed');
  assert.equal(execution.adapters.openai.enabled, true);
  assert.equal(execution.adapters.openai.model, 'gpt-test');
  assert.equal(execution.adapters.openai.apiKeyEnv, 'AOS_TEST_OPENAI_KEY');
  assert.equal(JSON.stringify(execution).includes(secret), false);
  const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-openai-default-plan-')), execution });
  engine.load();
  const goal = engine.createGoal({
    prompt: 'Inspect one bounded API adapter using supplied evidence. Success is a reviewable result. Scope excludes tools and external actions.',
  });
  assert.ok(goal.plan.tasks.filter((task) => task.kind !== 'adopt').every((task) => task.worker === 'openai'));
  assert.equal(goal.plan.tasks.find((task) => task.kind === 'adopt').worker, 'local');
  assert.throws(
    () => executionFromEnv({ AOS_EXECUTION: 'openai', AOS_OPENAI_RESPONSES_API_KEY_ENV: 'AOS_TEST_OPENAI_KEY' }),
    /exact model name/,
  );
});

test('operator plan patches admit the configured OpenAI harness and preserve its no-tools boundary', () => {
  const keyName = 'AOS_TEST_OPENAI_PATCH_KEY';
  const prior = process.env[keyName];
  process.env[keyName] = `sk-${'y'.repeat(32)}`;
  try {
    const engine = new AosEngine({
      dataDir: mkdtempSync(join(tmpdir(), 'aos-openai-patch-')),
      execution: {
        mode: 'mixed',
        adapters: {
          local: { enabled: true },
          openai: { enabled: true, model: 'gpt-test', apiKeyEnv: keyName },
        },
      },
    });
    engine.load();
    const goal = engine.createGoal({
      prompt: 'Inspect one bounded adapter. Success is a reviewable result. Scope excludes tools and external actions.',
      plan: { title: 'patch base', tasks: [{ id: 'base', title: 'Base', kind: 'research', worker: 'local' }], dependencies: [] },
    });
    const run = engine.startRun({ goalId: goal.id });
    const accepted = engine.plans.patch(run.id, {
      id: 'add-openai',
      baseVersion: 1,
      reason: 'add bounded API analysis',
      additions: {
        tasks: [{ id: 'api', title: 'API analysis', kind: 'research', worker: 'openai', model: 'gpt-test', sandbox: 'read_only', mayDelegate: false }],
        dependencies: [],
      },
    });
    assert.equal(accepted.plan.version, 2);
    assert.equal(accepted.plan.tasks.find((task) => task.id === 'api').worker, 'openai');
    assert.throws(() => engine.plans.patch(run.id, {
      id: 'reject-openai-tools',
      baseVersion: 2,
      reason: 'must remain bounded',
      additions: {
        tasks: [{ id: 'api-tools', title: 'Unsafe API analysis', kind: 'research', worker: 'openai', model: 'gpt-test', sandbox: 'read_only', mayDelegate: false, capabilities: { tools: ['shell'] } }],
        dependencies: [],
      },
    }), (error) => error.code === 'plan_openai_responses_capability_invalid');
    assert.equal(engine.getRun(run.id).plan.version, 2);
  } finally {
    if (prior === undefined) delete process.env[keyName];
    else process.env[keyName] = prior;
  }
});

test('OpenAI Responses provider contract stays unavailable until explicit API-key preflight and distinguishes Codex session auth', async () => {
  const secret = `sk-${'w'.repeat(32)}`;
  const prior = process.env.AOS_TEST_OPENAI_KEY;
  process.env.AOS_TEST_OPENAI_KEY = secret;
  try {
    const execution = {
      mode: 'mixed',
      adapters: {
        openai: { enabled: true, model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY', maxConcurrency: 2 },
      },
    };
    const engine = new AosEngine({ dataDir: mkdtempSync(join(tmpdir(), 'aos-openai-wiring-')), execution });
    engine.load();
    const worker = new OpenAIResponsesWorker(
      { model: 'gpt-test', apiKeyEnv: 'AOS_TEST_OPENAI_KEY', maxConcurrency: 2 },
      { transport: preflightTransport, env: process.env },
    );
    engine.workers.set('openai', worker);

    const before = engine.listProviders().find((provider) => provider.id === 'openai');
    assert.equal(before.adapterMounted, true);
    assert.equal(before.authType, 'api_key');
    assert.equal(before.secretEnv, 'AOS_TEST_OPENAI_KEY');
    assert.equal(before.session, null);
    assert.equal(before.contract.auth.boundary, 'process_environment');
    assert.equal(before.contract.runtime.requested.model, 'gpt-test');
    assert.equal(before.contract.runtime.requested.sandbox, 'remote_api_no_tools');
    assert.equal(before.contract.dispatch.runnable, false);
    assert.throws(() => assertProviderDispatchable(before), (error) => error.code === 'adapter_auth_unavailable');

    const receipt = await engine.preflightOpenAIResponses({ worker });
    assert.equal(receipt.model, 'gpt-test');
    const after = engine.listProviders().find((provider) => provider.id === 'openai');
    assert.equal(after.liveExecutionEnabled, true);
    assert.equal(after.readiness.status, 'available');
    assert.equal(after.contract.dispatch.runnable, true);
    assert.equal(after.contract.attestation.strength, 'api_response_observed');
    assert.equal(after.contract.attestation.externalIdentity, false);
    assert.equal(after.contract.transport.endpoint, '/v1/responses');
    assert.equal(after.contract.transport.redirects, 'disabled');
    assert.equal(after.contract.runtime.effective.model, 'gpt-test');
    assert.equal(after.contract.runtime.effective.store, false);
    assert.equal(after.contract.runtime.effective.tools, false);
    assert.equal(after.contract.runtime.effective.sessionResume, false);
    assert.doesNotThrow(() => assertProviderDispatchable(after));
    assert.equal(JSON.stringify({ execution: engine.execution, providers: engine.listProviders() }).includes(secret), false);
  } finally {
    if (prior === undefined) delete process.env.AOS_TEST_OPENAI_KEY;
    else process.env.AOS_TEST_OPENAI_KEY = prior;
  }
});

test('engine dispatches an OpenAI Responses task only after preflight and preserves the verified receipt', async () => {
  const keyName = 'AOS_TEST_OPENAI_DISPATCH_KEY';
  const secret = `sk-${'x'.repeat(32)}`;
  const prior = process.env[keyName];
  process.env[keyName] = secret;
  let calls = 0;
  try {
    const engine = new AosEngine({
      dataDir: mkdtempSync(join(tmpdir(), 'aos-openai-dispatch-')),
      execution: { mode: 'mixed', adapters: { openai: { enabled: true, model: 'gpt-test', apiKeyEnv: keyName } } },
    });
    engine.load();
    const transport = async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const request = JSON.parse(init.body);
      const preflight = request.text?.format?.name === 'aos_openai_responses_preflight';
      const nonce = (String(request.input).match(/AOS task nonce: ([^\n]+)/) || [])[1];
      return response(outputEnvelope('gpt-test', preflight
        ? JSON.stringify({ ok: true })
        : JSON.stringify({
          task_nonce: nonce,
          status: 'succeeded',
          questions: null,
          summary: 'engine-dispatched response',
          findings: [], risks: [], confidence: 0.8, decision: null, retrospective: null, memory_writes: [], delegation: null,
        })));
    };
    engine.workers.set('openai', new OpenAIResponsesWorker({ model: 'gpt-test', apiKeyEnv: keyName }, { transport, env: process.env }));
    const goal = engine.createGoal({
      prompt: 'Inspect one bounded API adapter. Success is one brief result without external actions.',
      plan: {
        title: 'OpenAI dispatch',
        tasks: [{ id: 'openai-task', title: 'OpenAI task', kind: 'research', worker: 'openai', sandbox: 'read_only', mayDelegate: false }],
        dependencies: [],
      },
    });
    const run = engine.startRun({ goalId: goal.id });
    await engine.advanceRun(run.id, { untilIdle: true });
    const tree = engine.getRunTree(run.id);
    const task = tree.tasks[0];
    assert.equal(tree.run.status, 'completed');
    assert.equal(task.status, 'succeeded');
    assert.equal(calls, 2);
    assert.equal(task.runtime[0].provider, 'openai');
    assert.equal(task.runtime[0].verified, true);
    assert.equal(task.runtime[0].usage, null);
    assert.equal(JSON.stringify(tree).includes(secret), false);
  } finally {
    if (prior === undefined) delete process.env[keyName];
    else process.env[keyName] = prior;
  }
});

test('OpenAI Responses task admission rejects tools, delegation, fallback, and task-supplied transport/session controls', () => {
  const base = { id: 'api-task', sandbox: 'read_only', mayDelegate: false, capabilities: {} };
  assert.doesNotThrow(() => assertOpenAIResponsesTaskAdmission(base));
  for (const [name, task] of Object.entries({
    delegation: { ...base, mayDelegate: true },
    capabilities: { ...base, capabilities: { mcp: ['mcp@1'] }, capabilityExecution: true },
    fallback: { ...base, fallback: ['codex'] },
    session: { ...base, previousResponseId: 'resp_1' },
    transport: { ...base, origin: 'https://other.example.test' },
    tools: { ...base, tools: ['computer'] },
  })) {
    assert.throws(() => assertOpenAIResponsesTaskAdmission(task), (error) => {
      assert.match(error.code, /^plan_openai_responses_/);
      return true;
    }, name);
  }
});
