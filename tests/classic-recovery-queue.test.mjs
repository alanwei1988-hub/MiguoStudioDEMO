import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { P0Database } from '../src/db.mjs';
import { addPanelWithSource, createHarness, queueStage } from './helpers.mjs';

const holdAcceptedRun = (db, runId, code = 'output_missing') => db.holdRunForRecovery({
  runId,
  code,
  message: 'Factory accepted the request but Studio does not yet have a verified output.',
  providerRequestId: `request-${runId}`,
  providerTaskId: `task-${runId}`,
  resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`
});

test('accepted failure and durable recovery enqueue are one atomic idempotent transaction', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('atomic automatic recovery');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: first.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'atomic-recovery-1'
  });
  harness.db.claimNextQueued();

  const held = holdAcceptedRun(harness.db, queued.id);
  assert.equal(held.run.status, 'failed');
  assert.equal(held.run.cost_source, 'unknown');
  assert.equal(held.run.provider_phase, 'accepted');
  assert.equal(held.recoveryJob.run_id, queued.id);
  assert.equal(held.recoveryJob.state, 'queued');
  assert.equal(held.recoveryJob.attempts, 0);

  const paidReplay = queueStage(harness, {
    panelId: first.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'atomic-recovery-1'
  });
  assert.equal(paidReplay.id, queued.id,
    'Provider lifecycle changes must not break exact idempotency replay under the recovery fuse.');

  const replay = harness.db.enqueueClassicRecovery(queued.id, { reason: 'different-replay-reason' });
  assert.equal(replay.id, held.recoveryJob.id);
  assert.equal(replay.reason_code, 'output_missing');
  assert.equal(harness.db.listClassicRecoveryJobs().length, 1);

  harness.db.reconcileClassicRunCost({
    runId: queued.id,
    idempotencyKey: 'atomic-recovery-cost-resolution-1',
    providerRequestId: `request-${queued.id}`,
    providerTaskId: `task-${queued.id}`,
    resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Factory ledger proves that this exact task charged zero points.',
    evidenceReference: `factory-ledger:task-${queued.id}`
  });
  harness.db.resolveClassicRecovery(queued.id);

  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const secondRun = queueStage(harness, {
    panelId: second.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'atomic-recovery-rollback-1'
  });
  harness.db.claimNextQueued();
  harness.db.db.exec(`
    CREATE TRIGGER force_classic_recovery_insert_failure
    BEFORE INSERT ON classic_recovery_jobs
    BEGIN
      SELECT RAISE(ABORT, 'forced recovery insert failure');
    END
  `);
  assert.throws(
    () => holdAcceptedRun(harness.db, secondRun.id),
    /forced recovery insert failure/
  );
  harness.db.db.exec('DROP TRIGGER force_classic_recovery_insert_failure');
  assert.equal(harness.db.getRun(secondRun.id).status, 'running',
    'The run failure update must roll back when its recovery enqueue cannot commit.');
  assert.equal(harness.db.getClassicRecoveryJob(secondRun.id), undefined);
});

test('BEGIN IMMEDIATE recovery leases prevent double claim and expired work survives restart', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('recovery leases');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'recovery-lease-1'
  });
  harness.db.claimNextQueued();
  holdAcceptedRun(harness.db, run.id);

  const reopened = new P0Database(path.join(harness.root, 'p0.sqlite'));
  try {
    const firstClaim = harness.db.claimNextClassicRecovery({ leaseOwner: 'worker-a', leaseMs: 60_000 });
    assert.equal(firstClaim.run_id, run.id);
    assert.equal(firstClaim.state, 'locating');
    assert.equal(firstClaim.attempts, 1);
    assert.equal(reopened.claimNextClassicRecovery({ leaseOwner: 'worker-b', leaseMs: 60_000 }), undefined,
      'A second connection must not claim an unexpired lease.');

    harness.db.db.prepare(`
      UPDATE classic_recovery_jobs SET lease_expires_at = ? WHERE run_id = ?
    `).run('2000-01-01T00:00:00.000Z', run.id);
    const restartedClaim = reopened.claimNextClassicRecovery({ leaseOwner: 'worker-b', leaseMs: 60_000 });
    assert.equal(restartedClaim.id, firstClaim.id);
    assert.equal(restartedClaim.attempts, 2);
    assert.equal(restartedClaim.lease_owner, 'worker-b');

    assert.throws(
      () => harness.db.advanceClassicRecovery({
        runId: run.id,
        state: 'matched',
        leaseOwner: 'worker-a',
        matchedTaskId: 'factory-task-a'
      }),
      (error) => error.code === 'recovery_lease_lost'
    );
    const matched = reopened.advanceClassicRecovery({
      runId: run.id,
      state: 'matched',
      leaseOwner: 'worker-b',
      matchedTaskId: 'factory-task-b'
    });
    assert.equal(matched.state, 'matched');
    assert.equal(matched.matched_task_id, 'factory-task-b');

    const waiting = reopened.deferClassicRecovery({
      runId: run.id,
      code: 'provider_task_pending',
      delayMs: 60_000,
      leaseOwner: 'worker-b'
    });
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.lease_owner, null);
    assert.equal(harness.db.claimNextClassicRecovery({ leaseOwner: 'worker-c', leaseMs: 60_000 }), undefined);

    reopened.db.prepare(`
      UPDATE classic_recovery_jobs SET next_attempt_at = ? WHERE run_id = ?
    `).run('2000-01-01T00:00:00.000Z', run.id);
    assert.equal(harness.db.claimNextClassicRecovery({ leaseOwner: 'worker-c', leaseMs: 60_000 }).run_id, run.id);
    const manual = harness.db.deferClassicRecovery({
      runId: run.id,
      code: 'history_match_ambiguous',
      manualReview: true,
      leaseOwner: 'worker-c'
    });
    assert.equal(manual.state, 'manual_review');
    assert.equal(manual.next_attempt_at, null);
    assert.equal(reopened.claimNextClassicRecovery({ leaseOwner: 'worker-d', leaseMs: 60_000 }), undefined);
    assert.equal(reopened.getClassicRecoverySummary().manualReviewCount, 1);
  } finally {
    reopened.close();
  }
});

test('unknown recovery cannot resolve until exact cost or output evidence is durable', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('recovery resolution invariant');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'recovery-resolution-1'
  });
  harness.db.claimNextQueued();
  holdAcceptedRun(harness.db, run.id);

  assert.throws(
    () => harness.db.resolveClassicRecovery(run.id),
    (error) => error.code === 'recovery_outcome_unresolved'
  );
  harness.db.reconcileClassicRunCost({
    runId: run.id,
    idempotencyKey: 'recovery-resolution-cost-1',
    providerRequestId: `request-${run.id}`,
    providerTaskId: `task-${run.id}`,
    resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Factory ledger proves that this exact task charged zero points.',
    evidenceReference: `factory-ledger:task-${run.id}`
  });
  const automaticallyResolved = harness.db.getClassicRecoveryJob(run.id);
  assert.equal(automaticallyResolved.state, 'resolved',
    'Persisting exact cost for a failed terminal run must release the global fuse atomically.');
  const resolved = harness.db.resolveClassicRecovery(run.id);
  assert.equal(resolved.state, 'resolved');
  assert.ok(resolved.resolved_at);
  assert.equal(harness.db.resolveClassicRecovery(run.id).resolved_at, resolved.resolved_at,
    'Resolution must be idempotent.');
  const summary = harness.db.getClassicRecoverySummary();
  assert.equal(summary.unresolvedCount, 0);
  assert.equal(summary.stateCounts.resolved, 1);
});

test('restart recovery automatically queues read-only recovery for interrupted real runs', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('restart automatic recovery');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'restart-auto-recovery-1'
  });
  harness.db.claimNextQueued();

  assert.equal(harness.db.recoverInterruptedRuns(), 1);
  const recovered = harness.db.getRun(run.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error_code, 'unknown_outcome');
  assert.equal(recovered.provider_phase, 'accepted');
  const job = harness.db.getClassicRecoveryJob(run.id);
  assert.equal(job.state, 'queued');
  assert.equal(job.reason_code, 'unknown_outcome');
});

test('startup backfill durably enqueues legacy accepted unknown runs exactly once', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('legacy automatic recovery backfill');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'legacy-recovery-backfill-1'
  });
  harness.db.db.prepare(`
    UPDATE run_attempts SET status = 'failed', provider_phase = 'accepted',
      cost_source = 'unknown', error_code = 'output_missing', finished_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), run.id);
  assert.equal(harness.db.getClassicRecoveryJob(run.id), undefined);

  assert.equal(harness.db.enqueuePendingClassicRecoveries(), 1);
  assert.equal(harness.db.enqueuePendingClassicRecoveries(), 0);
  assert.equal(harness.db.getClassicRecoveryJob(run.id).reason_code, 'output_missing');
  assert.equal(harness.db.listClassicRecoveryJobs().length, 1);
});

test('DB queue and claim paths enforce the global Miguo fuse while mock work remains available', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('transactional Miguo fuse');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const third = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 3 });

  const firstRun = queueStage(harness, {
    panelId: first.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'single-flight-miguo-1'
  });
  const secondRun = queueStage(harness, {
    panelId: second.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'single-flight-miguo-2'
  });
  const mockRun = queueStage(harness, {
    panelId: third.panel.id,
    stage: 'ink',
    provider: 'mock',
    idempotencyKey: 'single-flight-mock-1'
  });

  assert.equal(harness.db.claimNextQueued().id, firstRun.id);
  assert.equal(harness.db.claimNextQueued().id, mockRun.id,
    'A mock run may proceed while the one global paid Miguo slot is occupied.');
  harness.db.failRun({ runId: mockRun.id, code: 'fixture_failure', message: 'fixture failure' });
  assert.equal(harness.db.claimNextQueued(), undefined,
    'A second paid Miguo run must not be claimed concurrently.');

  harness.db.failRun({ runId: firstRun.id, code: 'provider_rejected', message: 'safe pre-accept failure' });
  assert.equal(harness.db.claimNextQueued().id, secondRun.id,
    'The next Miguo run becomes claimable only after the first leaves running state safely.');

  const fourth = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 4 });
  const fourthRun = queueStage(harness, {
    panelId: fourth.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'single-flight-miguo-queued-before-unknown'
  });
  holdAcceptedRun(harness.db, secondRun.id);
  assert.equal(harness.db.claimNextQueued(), undefined,
    'Already-queued paid work must stay frozen while automatic recovery is unresolved.');
  assert.equal(harness.db.getRun(fourthRun.id).status, 'queued');

  const replay = queueStage(harness, {
    panelId: fourth.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'single-flight-miguo-queued-before-unknown'
  });
  assert.equal(replay.id, fourthRun.id, 'Exact idempotency replay remains readable under the fuse.');

  const fifth = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 5 });
  const persistedBehindFuse = queueStage(harness, {
    panelId: fifth.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'single-flight-miguo-persisted-behind-fuse'
  });
  assert.equal(persistedBehindFuse.status, 'queued',
    'User intent remains durable while claim-time execution stays frozen.');
  const sixth = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 6 });
  const allowedMock = queueStage(harness, {
    panelId: sixth.panel.id,
    stage: 'ink',
    provider: 'mock',
    idempotencyKey: 'single-flight-mock-under-fuse'
  });
  assert.equal(harness.db.claimNextQueued().id, allowedMock.id);
});
