import { appendFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let request;
try {
  request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  process.stdout.write(JSON.stringify({ protocol: 'aos-external-harness-v1', type: 'error', error: 'invalid request' }));
  process.exit(2);
}

const modeArg = process.argv.find((value) => value.startsWith('--fixture-mode='));
const mode = modeArg ? modeArg.slice('--fixture-mode='.length) : process.env.EXTERNAL_HARNESS_FIXTURE_MODE || 'success';
if (process.env.EXTERNAL_HARNESS_FIXTURE_LOG) {
  appendFileSync(process.env.EXTERNAL_HARNESS_FIXTURE_LOG, `${JSON.stringify({ request, argv: process.argv.slice(2) })}\n`);
}

// Keep the fixture deliberately boring: it is a deterministic stdin/stdout
// peer for the adapter tests, not an implementation of an external provider.
const common = {
  protocol: request.protocol,
  provider: request.provider,
  model: request.model,
  sandbox: request.sandbox,
  authType: request.authType,
  sessionMode: request.sessionMode,
};

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (mode === 'oversize') {
  process.stdout.write('x'.repeat(4_096));
} else if (mode === 'invalid-json') {
  process.stdout.write('not-json\n');
} else if (mode === 'nonzero') {
  process.stderr.write('fixture rejected the request\n');
  process.exitCode = 7;
} else if (mode === 'sleep' && request.type === 'execute') {
  setTimeout(() => reply({
    ...common,
    type: request.type === 'preflight' ? 'preflight' : 'result',
    nonce: request.nonce,
    ...(request.type === 'preflight'
      ? { ready: true, attestation: 'external_harness_protocol' }
      : { status: 'succeeded', summary: 'late result', sessionId: request.sessionMode === 'ephemeral' ? 'fixture-session-late' : undefined, output: { status: 'succeeded', summary: 'late result' } }),
  }), 2_000);
} else if (request.type === 'preflight') {
  const response = {
    ...common,
    type: 'preflight',
    nonce: request.nonce,
    ready: true,
    attestation: 'external_harness_protocol',
  };
  if (mode === 'preflight-bad-nonce') response.nonce = 'fixture-wrong-nonce';
  if (mode === 'preflight-bad-model') response.model = 'fixture-substituted-model';
  if (mode === 'preflight-bad-protocol') response.protocol = 'other-protocol';
  if (mode === 'preflight-bad-auth') response.authType = 'external_cli_session';
  reply(response);
} else {
  const token = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';
  const output = mode === 'token'
    ? {
      status: 'succeeded',
      summary: `Bearer ${token}`,
      findings: [{ claim: `apiKey=${token}`, evidence: ['fixture'] }],
    }
    : mode === 'delegation'
      ? { status: 'succeeded', summary: 'delegation should be refused', delegation: { tasks: [{ id: 'child' }] } }
      : { status: 'succeeded', summary: 'bounded external result', findings: [{ claim: 'fixture claim', evidence: ['fixture'] }] };
  const response = {
    ...common,
    type: 'result',
    nonce: request.nonce,
    status: 'succeeded',
    summary: output.summary,
    output,
    ...(request.sessionMode === 'ephemeral' ? { sessionId: 'fixture-session-opaque-001' } : {}),
  };
  if (mode === 'bad-nonce') response.nonce = 'fixture-wrong-nonce';
  if (mode === 'bad-model') response.model = 'fixture-substituted-model';
  if (mode === 'bad-provider') response.provider = 'fixture-substituted-provider';
  if (mode === 'bad-sandbox') response.sandbox = 'network';
  if (mode === 'bad-auth') response.authType = 'external_cli_session';
  if (mode === 'none-session') response.sessionId = 'fixture-session-forbidden';
  reply(response);
}
