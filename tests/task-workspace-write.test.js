import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AosEngine } from '../engine/engine.js';
import { executeCommand } from '../engine/cli.js';
import { createAosServer } from '../engine/http.js';
import { claimWorkspace } from '../engine/workers.js';
import {
  BUILTIN_TASK_WORKSPACE_WRITE_SOURCE,
  TASK_WORKSPACE_WRITE_TARGET_KIND,
} from '../engine/capabilities.js';
import {
  buildTaskWorkspaceWriteIdentity,
  TASK_WORKSPACE_WRITE_FILE,
  TASK_WORKSPACE_WRITE_JOURNAL_DIR,
  taskWorkspaceWriteBytes,
  TaskWorkspaceWriteAdapter,
} from '../engine/task-workspace-write.js';

function setup({ dataDir = mkdtempSync(join(tmpdir(), 'aos-task-workspace-write-')), clock = () => Date.now() } = {}) {
  const aos = new AosEngine({ dataDir, clock });
  aos.load();
  const projectId = aos.defaultProject().id;
  const capability = aos.capabilities.create({
    id: 'task-workspace-write',
    kind: 'tool',
    name: 'Task workspace write',
    description: 'Fixed engine-owned deterministic task-workspace write.',
    source: { ...BUILTIN_TASK_WORKSPACE_WRITE_SOURCE },
    permissions: ['filesystem_write'],
    test: { required: true, protocol: 'schema_check', description: 'Fixed write and rollback fixture passed.' },
  });
  aos.capabilities.recordTest(capability.id, capability.version, {
    requestId: 'task-workspace-write-test', status: 'passed', summary: 'Fixed write and rollback fixture passed.',
  });
  aos.capabilities.setPermission(capability.id, capability.version, 'grant', {
    scope: 'project', scopeId: projectId, permissions: ['filesystem_write'],
  });
  aos.settings.set('capabilities.enabled', [capability.reference], { scope: 'project', scopeId: projectId });
  const goal = aos.createGoal({
    projectId,
    prompt: 'Apply one engine-owned fixed workspace write.',
    plan: {
      title: 'Task workspace write fixture',
      tasks: [{
        id: 'write', title: 'Write fixed engine file', kind: 'implementation', worker: 'local', requiresApproval: true,
        capabilities: { tools: [capability.reference] }, capabilityExecution: { effect: 'task_workspace_write' }, sandbox: 'workspace_write',
      }],
      dependencies: [],
    },
  });
  const run = aos.startRun({ goalId: goal.id });
  const task = aos.state.tasks.find((item) => item.runId === run.id);
  const agent = aos.state.agents.find((item) => item.id === task.agentId);
  const workspace = claimWorkspace({ root: aos.store.workspacesDir, runId: run.id, taskId: task.id, agentId: agent.id, now: aos.now() });
  const identity = buildTaskWorkspaceWriteIdentity({
    projectId,
    runId: run.id,
    taskId: task.id,
    attempt: 1,
    capabilityReference: capability.reference,
    capabilityFingerprint: capability.fingerprint,
  });
  const adapter = new TaskWorkspaceWriteAdapter({ effects: aos.effects, clock });
  const args = {
    identity,
    workspaceRoot: aos.store.workspacesDir,
    workspaceDir: workspace.dir,
    journalRoot: join(aos.store.dataDir, TASK_WORKSPACE_WRITE_JOURNAL_DIR),
    expectedBytes: taskWorkspaceWriteBytes(identity),
    revalidate: () => aos.capabilities.resolve(capability.reference, {
      projectId, roleId: task.kind, workerId: task.agentId, runId: run.id,
    }),
  };
  return { aos, dataDir, projectId, capability, run, task, workspace, identity, adapter, args };
}

function approve(aos, identity, requestId = 'approve-write') {
  return aos.effects.approve({ ...identity, requestId, actor: 'operator' });
}

test('fixed adapter applies, redacts, replays idempotently, and rolls back exact prior bytes', () => {
  const { aos, identity, adapter, args, workspace } = setup();
  const prior = 'private-prior-bytes-must-not-enter-state';
  const target = join(workspace.dir, TASK_WORKSPACE_WRITE_FILE);
  writeFileSync(target, prior, 'utf8');
  const approval = approve(aos, identity);
  const applied = adapter.apply({ ...args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-write' });
  assert.equal(applied.status, 'succeeded');
  assert.equal(applied.targetKind, TASK_WORKSPACE_WRITE_TARGET_KIND);
  assert.equal(readFileSync(target, 'utf8'), args.expectedBytes.toString('utf8'));
  assert.equal(JSON.stringify(applied).includes(prior), false);
  assert.equal(JSON.stringify(applied).includes(TASK_WORKSPACE_WRITE_FILE), false);
  assert.equal(JSON.stringify({ state: aos.state, events: aos.store.readEventLog() }).includes(prior), false);

  const replay = adapter.apply({ ...args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-write' });
  assert.equal(replay.idempotent, true);
  const claim = aos.effects.get(applied.claimId);
  const rollback = adapter.rollback({
    claim,
    workspaceRoot: args.workspaceRoot,
    workspaceDir: args.workspaceDir,
    journalRoot: args.journalRoot,
    requestId: 'rollback-write',
    actor: 'operator',
    revalidate: args.revalidate,
  });
  assert.equal(rollback.rollback, true);
  assert.equal(readFileSync(target, 'utf8'), prior);
  const repeated = adapter.rollback({
    claim: aos.effects.get(applied.claimId),
    workspaceRoot: args.workspaceRoot,
    workspaceDir: args.workspaceDir,
    journalRoot: args.journalRoot,
    requestId: 'rollback-write',
    actor: 'operator',
    revalidate: args.revalidate,
  });
  assert.equal(repeated.idempotent, true);
  assert.throws(
    () => adapter.rollback({
      claim: aos.effects.get(applied.claimId), workspaceRoot: args.workspaceRoot, workspaceDir: args.workspaceDir,
      journalRoot: args.journalRoot, requestId: 'rollback-write', actor: 'other-operator', revalidate: args.revalidate,
    }),
    (error) => error.code === 'effect_rollback_request_conflict',
  );
});

test('engine lifecycle requires exact approval, performs the fixed write, and re-gates retries', async () => {
  const { aos, run, task, workspace, identity } = setup();
  assert.equal(task.status, 'awaiting_approval');
  assert.throws(
    () => aos.approveTask(task.id),
    (error) => error.code === 'workspace_write_exact_approval_required',
  );
  const approval = aos.approveTaskWorkspaceWrite(task.id, { requestId: 'engine-approve-write', actor: 'operator' });
  assert.equal(approval.attempt, 1);
  assert.equal(approval.inputFingerprint, identity.inputFingerprint);
  assert.equal(aos.state.effectApprovals.length, 1);
  assert.equal(aos.state.effectApprovals[0].identity.isolationFingerprint, approval.isolationFingerprint);
  assert.equal(aos.state.effectApprovals[0].identity.rollbackPlanFingerprint, approval.rollbackPlanFingerprint);

  const advanced = await aos.advanceRun(run.id, { untilIdle: true });
  assert.equal(advanced.run.status, 'completed');
  const completed = aos.getTask(task.id);
  assert.equal(completed.status, 'succeeded');
  const receipt = completed.output.result.workspaceWrite;
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.targetKind, TASK_WORKSPACE_WRITE_TARGET_KIND);
  assert.equal(JSON.stringify(receipt).includes(TASK_WORKSPACE_WRITE_FILE), false);
  assert.equal(readFileSync(join(workspace.dir, TASK_WORKSPACE_WRITE_FILE), 'utf8'), taskWorkspaceWriteBytes(identity).toString('utf8'));
  const claim = aos.effects.get(receipt.claimId);
  assert.equal(claim.status, 'succeeded');

  const rollback = aos.rollbackTaskWorkspaceWrite(claim.id, { requestId: 'engine-rollback-write', actor: 'operator' });
  assert.equal(rollback.rollback, true);
  assert.equal(existsSync(join(workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
  assert.throws(
    () => aos.rollbackTaskWorkspaceWrite(claim.id, { requestId: 'engine-rollback-write', actor: 'other-operator' }),
    (error) => error.code === 'effect_rollback_request_conflict',
  );

  // A pre-write target refusal is retryable, but it clears the old approval.
  // The next operator action must bind the actual upcoming attempt two.
  const retry = setup();
  retry.aos.approveTaskWorkspaceWrite(retry.task.id, { requestId: 'retry-approve-one', actor: 'operator' });
  const outside = join(retry.workspace.dir, 'outside.txt');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(outside, join(retry.workspace.dir, TASK_WORKSPACE_WRITE_FILE));
  await retry.aos.advanceRun(retry.run.id, { untilIdle: true });
  const gated = retry.aos.getTask(retry.task.id);
  assert.equal(gated.status, 'awaiting_approval');
  assert.equal(gated.workspaceWriteApproval, null);
  assert.equal(gated.attempts, 1);
  const retryApproval = retry.aos.approveTaskWorkspaceWrite(retry.task.id, { requestId: 'retry-approve-two', actor: 'operator' });
  assert.equal(retryApproval.attempt, 2);
});

test('HTTP and CLI expose only the exact workspace-write approval and rollback actions', async () => {
  const first = setup();
  const service = createAosServer({ engine: first.aos, host: '127.0.0.1', port: 0, operatorToken: false });
  await service.listen();
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const generic = await fetch(`${base}/api/v1/tasks/${first.task.id}/approve`, { method: 'POST' });
    assert.equal(generic.status, 409);
    assert.equal((await generic.json()).code, 'workspace_write_exact_approval_required');
    const approval = await fetch(`${base}/api/v1/tasks/${first.task.id}/workspace-write/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'http-approve-write', actor: 'operator' }),
    });
    assert.equal(approval.status, 200);
    assert.equal((await approval.json()).attempt, 1);
    await first.aos.advanceRun(first.run.id, { untilIdle: true });
    const receipt = first.aos.getTask(first.task.id).output.result.workspaceWrite;
    const cliRollback = await executeCommand(first.aos, `task workspace-write rollback ${receipt.claimId} --request-id cli-rollback-write --actor operator`);
    assert.equal(cliRollback.ok, true, cliRollback.lines.join(' '));
    assert.equal(JSON.parse(cliRollback.lines.join('\n')).rollback, true);
    assert.equal(existsSync(join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);

    const second = setup();
    const cliApproval = await executeCommand(second.aos, `task workspace-write approve ${second.task.id} --request-id cli-approve-write --actor operator`);
    assert.equal(cliApproval.ok, true, cliApproval.lines.join(' '));
    assert.equal(JSON.parse(cliApproval.lines.join('\n')).attempt, 1);
    await second.aos.advanceRun(second.run.id, { untilIdle: true });
    const secondReceipt = second.aos.getTask(second.task.id).output.result.workspaceWrite;
    const secondService = createAosServer({ engine: second.aos, host: '127.0.0.1', port: 0, operatorToken: false });
    await secondService.listen();
    try {
      const secondBase = `http://127.0.0.1:${secondService.server.address().port}`;
      const httpRollback = await fetch(`${secondBase}/api/v1/effects/${secondReceipt.claimId}/workspace-write/rollback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'http-rollback-write', actor: 'operator' }),
      });
      assert.equal(httpRollback.status, 200);
      assert.equal((await httpRollback.json()).rollback, true);
      assert.equal(existsSync(join(second.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
    } finally {
      await secondService.close();
    }
  } finally {
    await service.close();
  }
});

test('cross-engine contention and stale fencing refuse before any target mutation', () => {
  let now = Date.now();
  const clock = () => now;
  const first = setup({ clock });
  const approval = approve(first.aos, first.identity, 'approve-contention');
  first.aos.effects.claim({ ...first.identity, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-a', leaseMs: 1_000 });
  const second = new AosEngine({ dataDir: first.dataDir, clock });
  second.load();
  const secondAdapter = new TaskWorkspaceWriteAdapter({ effects: second.effects, clock });
  assert.throws(
    () => secondAdapter.apply({ ...first.args, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-b', revalidate: () => second.capabilities.resolve(first.capability.reference, {
      projectId: first.projectId, roleId: first.task.kind, workerId: first.task.agentId, runId: first.run.id,
    }) }),
    (error) => error.code === 'effect_claim_conflict',
  );
  assert.equal(existsSync(join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);

  now += 1_001;
  assert.equal(second.effects.recoverExpired(), 1);
  const recovered = second.effects.claim({ ...first.identity, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-b', leaseMs: 1_000 });
  assert.throws(
    () => first.adapter.apply({ ...first.args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-a' }),
    (error) => error.code === 'effect_claim_conflict',
  );
  assert.equal(recovered.fence, 2);
  assert.equal(existsSync(join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
});

test('a fence reclaimed during the final revalidation cannot reach the target', () => {
  let now = Date.now();
  const clock = () => now;
  const first = setup({ clock });
  const approval = approve(first.aos, first.identity, 'approve-last-fence');
  const second = new AosEngine({ dataDir: first.dataDir, clock });
  second.load();
  let calls = 0;
  assert.throws(
    () => first.adapter.apply({
      ...first.args,
      approvalId: approval.id,
      ownerId: 'engine-a',
      requestId: 'claim-last-fence',
      revalidate: () => {
        calls += 1;
        if (calls === 3) {
          now += 61_000;
          second.effects.recoverExpired();
          second.effects.claim({ ...first.identity, approvalId: approval.id, ownerId: 'engine-b', requestId: 'claim-last-fence-b' });
        }
        return first.args.revalidate();
      },
    }),
    (error) => error.code === 'effect_claim_owner_mismatch',
  );
  assert.equal(existsSync(join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
  assert.equal(second.effects.list({ taskId: first.task.id })[0].ownerId, 'engine-b');
});

test('post-byte crash reload recovery completes the original fenced attempt exactly once', () => {
  const first = setup();
  const approval = first.aos.approveTaskWorkspaceWrite(first.task.id, { requestId: 'approve-crash', actor: 'operator' });
  first.aos.transact(() => {
    const task = first.aos.getTask(first.task.id);
    task.status = 'running';
    task.attempts = 1;
    task.workspace = first.workspace.dir;
    const agent = first.aos.state.agents.find((item) => item.id === task.agentId);
    if (agent) {
      agent.status = 'active';
      agent.workspace = first.workspace.dir;
    }
  });
  assert.throws(
    () => first.adapter.apply({
      ...first.args,
      approvalId: approval.approvalId,
      ownerId: 'engine-a',
      requestId: 'claim-crash',
      afterMutation: () => { throw new Error('simulated crash after bytes'); },
    }),
    /simulated crash/,
  );
  const target = join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE);
  assert.equal(readFileSync(target, 'utf8'), first.args.expectedBytes.toString('utf8'));
  const before = first.aos.effects.list({ taskId: first.task.id })[0];
  assert.equal(before.status, 'claimed');

  const reloaded = new AosEngine({ dataDir: first.dataDir });
  reloaded.load();
  const recoveredTask = reloaded.getTask(first.task.id);
  assert.equal(recoveredTask.status, 'succeeded');
  assert.equal(recoveredTask.output.result.workspaceWrite.recovered, true);
  assert.equal(reloaded.effects.get(before.id).status, 'succeeded');
  assert.equal(reloaded.state.effectReceipts.filter((item) => item.claimId === before.id).length, 1);
});

test('a reclaimed fence reuses the immutable private journal and completes exact post-byte recovery', () => {
  let now = Date.now();
  const clock = () => now;
  const first = setup({ clock });
  const approval = approve(first.aos, first.identity, 'approve-reclaimed-journal');
  assert.throws(
    () => first.adapter.apply({
      ...first.args,
      approvalId: approval.id,
      ownerId: 'engine-a',
      requestId: 'claim-reclaimed-journal-a',
      afterMutation: () => { throw new Error('interrupt after fixed bytes'); },
    }),
    /interrupt after fixed bytes/,
  );
  const original = first.aos.effects.list({ taskId: first.task.id })[0];
  assert.equal(original.status, 'claimed');
  assert.equal(readFileSync(join(first.workspace.dir, TASK_WORKSPACE_WRITE_FILE), 'utf8'), first.args.expectedBytes.toString('utf8'));

  now += 61_000;
  const second = new AosEngine({ dataDir: first.dataDir, clock });
  second.load();
  const reclaimed = second.effects.claim({
    ...first.identity,
    approvalId: approval.id,
    ownerId: 'engine-b',
    requestId: 'claim-reclaimed-journal-b',
  });
  assert.equal(reclaimed.fence, 2);
  const secondAdapter = new TaskWorkspaceWriteAdapter({ effects: second.effects, clock });
  const completed = secondAdapter.apply({
    ...first.args,
    approvalId: approval.id,
    ownerId: 'engine-b',
    requestId: 'claim-reclaimed-journal-b',
    revalidate: () => second.capabilities.resolve(first.capability.reference, {
      projectId: first.projectId, roleId: first.task.kind, workerId: first.task.agentId, runId: first.run.id,
    }),
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(second.effects.get(original.id).status, 'succeeded');
  assert.equal(second.state.effectReceipts.find((item) => item.claimId === original.id).fence, 2);
});

test('expired restart reclaims and completes the same exact post-byte attempt before orphan requeue', () => {
  let now = Date.now();
  const clock = () => now;
  const first = setup({ clock });
  const approval = first.aos.approveTaskWorkspaceWrite(first.task.id, { requestId: 'approve-expired-restart', actor: 'operator' });
  first.aos.transact(() => {
    const task = first.aos.getTask(first.task.id);
    task.status = 'running';
    task.attempts = 1;
    task.workspace = first.workspace.dir;
    const agent = first.aos.state.agents.find((item) => item.id === task.agentId);
    if (agent) {
      agent.status = 'active';
      agent.workspace = first.workspace.dir;
    }
  });
  assert.throws(
    () => first.adapter.apply({
      ...first.args,
      approvalId: approval.approvalId,
      ownerId: 'engine-a',
      requestId: 'claim-expired-restart',
      afterMutation: () => { throw new Error('interrupt before receipt'); },
    }),
    /interrupt before receipt/,
  );
  const original = first.aos.effects.list({ taskId: first.task.id })[0];
  now += 61_000;
  const reloaded = new AosEngine({ dataDir: first.dataDir, clock });
  reloaded.load();
  const task = reloaded.getTask(first.task.id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.output.result.workspaceWrite.recovered, true);
  assert.equal(reloaded.effects.get(original.id).status, 'succeeded');
  assert.equal(reloaded.state.effectReceipts.filter((item) => item.claimId === original.id).length, 1);
  assert.equal(reloaded.state.effectReceipts.find((item) => item.claimId === original.id).fence, 2);
});

test('engine reconciles a post-byte failure or cancellation before terminalizing the task', async () => {
  const failed = setup();
  failed.aos.approveTaskWorkspaceWrite(failed.task.id, { requestId: 'approve-post-byte-failure', actor: 'operator' });
  const originalFailureApply = failed.aos.taskWorkspaceWrites.apply.bind(failed.aos.taskWorkspaceWrites);
  failed.aos.taskWorkspaceWrites.apply = (input) => originalFailureApply({
    ...input,
    afterMutation: () => { throw new Error('simulated post-byte failure'); },
  });
  await failed.aos.advanceRun(failed.run.id, { untilIdle: true });
  const failedTask = failed.aos.getTask(failed.task.id);
  const failedClaim = failed.aos.effects.list({ taskId: failed.task.id })[0];
  assert.equal(failedTask.status, 'awaiting_approval');
  assert.equal(failedTask.workspaceWriteApproval, null);
  assert.equal(failedClaim.status, 'succeeded');
  assert.equal(readFileSync(join(failed.workspace.dir, TASK_WORKSPACE_WRITE_FILE), 'utf8'), failed.args.expectedBytes.toString('utf8'));
  const failedRollback = failed.aos.rollbackTaskWorkspaceWrite(failedClaim.id, { requestId: 'rollback-post-byte-failure', actor: 'operator' });
  assert.equal(failedRollback.rollback, true);
  assert.equal(existsSync(join(failed.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);

  const cancelled = setup();
  cancelled.aos.approveTaskWorkspaceWrite(cancelled.task.id, { requestId: 'approve-post-byte-cancel', actor: 'operator' });
  const originalCancelApply = cancelled.aos.taskWorkspaceWrites.apply.bind(cancelled.aos.taskWorkspaceWrites);
  cancelled.aos.taskWorkspaceWrites.apply = (input) => originalCancelApply({
    ...input,
    afterMutation: () => cancelled.aos.cancelTask(cancelled.task.id),
  });
  await cancelled.aos.advanceRun(cancelled.run.id, { untilIdle: true });
  const cancelledTask = cancelled.aos.getTask(cancelled.task.id);
  const cancelledClaim = cancelled.aos.effects.list({ taskId: cancelled.task.id })[0];
  assert.equal(cancelledTask.status, 'cancelled');
  assert.equal(cancelledClaim.status, 'succeeded');
  assert.equal(readFileSync(join(cancelled.workspace.dir, TASK_WORKSPACE_WRITE_FILE), 'utf8'), cancelled.args.expectedBytes.toString('utf8'));
  const cancelledRollback = cancelled.aos.rollbackTaskWorkspaceWrite(cancelledClaim.id, { requestId: 'rollback-post-byte-cancel', actor: 'operator' });
  assert.equal(cancelledRollback.rollback, true);
  assert.equal(existsSync(join(cancelled.workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
});

test('rollback retains exact historical authority after revocation but refuses a running or newer attempt', async () => {
  const { aos, capability, run, task, workspace } = setup();
  aos.approveTaskWorkspaceWrite(task.id, { requestId: 'approve-revoked-rollback', actor: 'operator' });
  await aos.advanceRun(run.id, { untilIdle: true });
  const receipt = aos.getTask(task.id).output.result.workspaceWrite;
  const target = join(workspace.dir, TASK_WORKSPACE_WRITE_FILE);

  aos.transact(() => { aos.getTask(task.id).status = 'running'; });
  assert.throws(
    () => aos.rollbackTaskWorkspaceWrite(receipt.claimId, { requestId: 'rollback-running-attempt', actor: 'operator' }),
    (error) => error.code === 'workspace_write_rollback_attempt_changed',
  );
  assert.equal(existsSync(target), true);

  aos.transact(() => {
    const current = aos.getTask(task.id);
    current.status = 'succeeded';
    current.attempts = 2;
  });
  assert.throws(
    () => aos.rollbackTaskWorkspaceWrite(receipt.claimId, { requestId: 'rollback-newer-attempt', actor: 'operator' }),
    (error) => error.code === 'workspace_write_rollback_attempt_changed',
  );
  assert.equal(existsSync(target), true);

  aos.transact(() => { aos.getTask(task.id).attempts = 1; });
  aos.capabilities.setState(capability.id, capability.version, 'revoked', { reason: 'operator revoked future writes' });
  const rollback = aos.rollbackTaskWorkspaceWrite(receipt.claimId, { requestId: 'rollback-after-revoke', actor: 'operator' });
  assert.equal(rollback.rollback, true);
  assert.equal(existsSync(target), false);
});

test('rollback rejects an invalid request before restoring the fixed target', () => {
  const { aos, identity, adapter, args, workspace } = setup();
  const target = join(workspace.dir, TASK_WORKSPACE_WRITE_FILE);
  writeFileSync(target, 'bounded-private-prior', 'utf8');
  const approval = approve(aos, identity, 'approve-invalid-rollback');
  const applied = adapter.apply({ ...args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-invalid-rollback' });
  assert.throws(
    () => adapter.rollback({
      claim: aos.effects.get(applied.claimId),
      workspaceRoot: args.workspaceRoot,
      workspaceDir: args.workspaceDir,
      journalRoot: args.journalRoot,
      requestId: '',
      actor: 'operator',
      revalidate: args.revalidate,
    }),
    (error) => error.code === 'invalid_input',
  );
  assert.equal(readFileSync(target, 'utf8'), args.expectedBytes.toString('utf8'));
  assert.equal(aos.effects.get(applied.claimId).status, 'succeeded');
  assert.equal(aos.state.effectRollbackReceipts.length, 0);
});

test('private rollback journals authenticate raw prior bytes, not UTF-8 decoding', () => {
  const { aos, identity, adapter, args, workspace } = setup();
  const target = join(workspace.dir, TASK_WORKSPACE_WRITE_FILE);
  const prior = Buffer.from([0x80]);
  const replacement = Buffer.from([0x81]);
  assert.equal(prior.toString('utf8'), replacement.toString('utf8'));
  writeFileSync(target, prior);
  const approval = approve(aos, identity, 'approve-binary-journal');
  const applied = adapter.apply({ ...args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-binary-journal' });
  const journalPath = join(args.journalRoot, `${applied.claimId}.json`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.prior.bytesBase64 = replacement.toString('base64');
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, 'utf8');
  assert.throws(
    () => adapter.rollback({
      claim: aos.effects.get(applied.claimId),
      workspaceRoot: args.workspaceRoot,
      workspaceDir: args.workspaceDir,
      journalRoot: args.journalRoot,
      requestId: 'rollback-binary-journal',
      actor: 'operator',
      revalidate: args.revalidate,
    }),
    (error) => error.code === 'workspace_write_journal_invalid',
  );
  assert.equal(readFileSync(target).equals(args.expectedBytes), true);
  assert.equal(aos.effects.get(applied.claimId).status, 'succeeded');
});

test('cancellation before mutation records failure without touching the target', () => {
  const { aos, identity, adapter, args, workspace } = setup();
  const approval = approve(aos, identity, 'approve-cancel');
  const controller = new AbortController();
  let calls = 0;
  assert.throws(
    () => adapter.apply({
      ...args,
      approvalId: approval.id,
      ownerId: 'engine-a',
      requestId: 'claim-cancel',
      signal: controller.signal,
      revalidate: () => {
        calls += 1;
        if (calls === 2) controller.abort();
        return args.revalidate();
      },
    }),
    (error) => error.code === 'effect_cancelled',
  );
  assert.equal(existsSync(join(workspace.dir, TASK_WORKSPACE_WRITE_FILE)), false);
  const claim = aos.effects.list({ taskId: identity.taskId })[0];
  assert.equal(claim.status, 'failed');
});

test('symlink targets are rejected and never followed', () => {
  const { aos, identity, adapter, args, workspace } = setup();
  const outside = join(workspace.dir, 'outside.txt');
  writeFileSync(outside, 'outside', 'utf8');
  symlinkSync(outside, join(workspace.dir, TASK_WORKSPACE_WRITE_FILE));
  const approval = approve(aos, identity, 'approve-symlink');
  assert.throws(
    () => adapter.apply({ ...args, approvalId: approval.id, ownerId: 'engine-a', requestId: 'claim-symlink' }),
    (error) => error.code === 'workspace_write_target_invalid',
  );
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
  assert.equal(aos.effects.list({ taskId: identity.taskId })[0].status, 'failed');
});
