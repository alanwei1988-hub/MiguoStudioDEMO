import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { P0Database } from '../src/db.mjs';
import { ClassicRecoveryWorker } from '../src/services/classic-recovery-worker.mjs';
import {
  addPanelWithSource, createCandidate, createHarness, makePanelPng, queueStage
} from './helpers.mjs';

const TASK_A = '019fff91-1111-7111-8111-111111111111';
const TASK_B = '019fff91-2222-7222-8222-222222222222';

function holdAccepted(db, runId, providerTaskId = TASK_A) {
  return db.holdRunForRecovery({
    runId,
    code: 'output_missing',
    message: 'Factory accepted the fixture task but the response omitted its output.',
    providerRequestId: 'factory-request-a',
    providerTaskId,
    resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`
  });
}

test('reconciliation rejects provider request or task identity drift before writing an audit event', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Provider identity hardening');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id });
  const run = queueStage(harness, {
    panelId: panel.id, stage: 'ink', provider: 'miguo', idempotencyKey: 'identity-hardening-run'
  });
  harness.db.claimNextQueued();
  holdAccepted(harness.db, run.id);

  const common = {
    runId: run.id,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Exact Factory ledger fixture confirms a zero point outcome.',
    evidenceReference: `factory-task:${TASK_A}:lineart-v4;ledger:type2:reason6`
  };
  assert.throws(() => harness.db.reconcileClassicRunCost({
    ...common,
    idempotencyKey: 'identity-conflict-request',
    providerRequestId: 'factory-request-b',
    providerTaskId: TASK_A
  }), (error) => error.code === 'provider_evidence_conflict');
  assert.throws(() => harness.db.reconcileClassicRunCost({
    ...common,
    idempotencyKey: 'identity-conflict-task',
    providerRequestId: 'factory-request-a',
    providerTaskId: TASK_B
  }), (error) => error.code === 'provider_evidence_conflict');

  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 0);
  assert.equal(harness.db.getRun(run.id).provider_task_id, TASK_A);
  assert.equal(harness.db.getRun(run.id).cost_source, 'unknown');
});

test('automatic attach atomically requires the current recovery lease and the persisted provider task identity', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Atomic attach ownership');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const run = queueStage(harness, {
    panelId: panel.id, stage: 'ink', provider: 'miguo', idempotencyKey: 'atomic-attach-run'
  });
  harness.db.claimNextQueued();
  holdAccepted(harness.db, run.id);
  const candidate = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ ...source, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 121,
    runId: run.id
  });
  harness.db.claimNextClassicRecovery({ leaseOwner: 'recovery-owner-a', leaseMs: 60_000 });
  const common = {
    runId: run.id,
    outputAssetVersionId: candidate.id,
    verifiedOutputHost: 'oss.miguocomics.com',
    verifiedOutputRawSha256: 'b'.repeat(64),
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Verified recovered output belongs to the exact Factory fixture task.',
    evidenceReference: `factory-task:${TASK_A}:lineart-v4;ledger:type2:reason6`
  };

  assert.throws(() => harness.db.attachExistingOutputToClassicRun({
    ...common,
    idempotencyKey: 'atomic-attach-wrong-owner',
    recoveryLeaseOwner: 'recovery-owner-b',
    providerTaskId: TASK_A
  }), (error) => error.code === 'recovery_lease_lost');
  assert.throws(() => harness.db.attachExistingOutputToClassicRun({
    ...common,
    idempotencyKey: 'atomic-attach-wrong-task',
    recoveryLeaseOwner: 'recovery-owner-a',
    providerTaskId: TASK_B
  }), (error) => error.code === 'provider_evidence_conflict');

  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 0);
  assert.equal(harness.db.getRun(run.id).status, 'failed');
  assert.equal(harness.db.getAsset(candidate.id).run_attempt_id, null);
});

test('heartbeat keeps a slow read-only recovery single-owned beyond its initial lease', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Recovery heartbeat');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const run = queueStage(harness, {
    panelId: panel.id, stage: 'ink', provider: 'miguo', idempotencyKey: 'heartbeat-run'
  });
  harness.db.claimNextQueued();
  holdAccepted(harness.db, run.id, null);
  const output = await makePanelPng({ width: source.width, height: source.height, seed: 122 });
  let recoveryReads = 0;
  const worker = new ClassicRecoveryWorker({
    db: harness.db,
    assetService: harness.assetService,
    leaseMs: 1_000,
    recoveryClient: {
      async recover() {
        recoveryReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        return {
          outcome: 'succeeded',
          buffer: output,
          providerTaskId: TASK_A,
          providerTaskType: 5,
          providerTaskVersion: 'v4',
          outputHost: 'oss.miguocomics.com',
          outputRawSha256: 'c'.repeat(64),
          evidenceReference: `factory-task:${TASK_A}:lineart-v4;ledger:type2:reason6`,
          costPoints: 0,
          costSource: 'no_charge_confirmed'
        };
      }
    }
  });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 1_000 });
  const processing = worker.process(job);
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  const competing = new P0Database(path.join(harness.root, 'p0.sqlite'));
  try {
    assert.equal(
      competing.claimNextClassicRecovery({ leaseOwner: 'competing-worker', leaseMs: 1_000 }),
      undefined,
      'The heartbeat must prevent a second process from reclaiming slow read-only work.'
    );
  } finally {
    competing.close();
  }
  await processing;

  const completed = harness.db.getRun(run.id);
  assert.equal(recoveryReads, 1);
  assert.equal(completed.status, 'succeeded');
  assert.equal(harness.db.getClassicRecoveryJob(run.id).state, 'resolved');
  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 1);
  assert.equal(harness.db.db.prepare(`
    SELECT COUNT(*) AS count FROM asset_versions WHERE run_attempt_id = ?
  `).get(run.id).count, 1);
});

test('retryable provider evidence remains in automatic waiting after the fast-attempt threshold', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Long-tail automatic recovery');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id });
  const run = queueStage(harness, {
    panelId: panel.id, stage: 'ink', provider: 'miguo', idempotencyKey: 'long-tail-recovery-run'
  });
  harness.db.claimNextQueued();
  holdAccepted(harness.db, run.id, null);

  const worker = new ClassicRecoveryWorker({
    db: harness.db,
    assetService: harness.assetService,
    maxAttempts: 1,
    recoveryClient: {
      async recover() {
        throw Object.assign(new Error('History has not published the task yet.'), {
          code: 'factory_task_pending', retryableRecovery: true
        });
      }
    }
  });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 60_000 });
  await worker.process(job);

  const waiting = harness.db.getClassicRecoveryJob(run.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.last_error_code, 'factory_task_pending');
  assert.ok(Date.parse(waiting.next_attempt_at) - Date.now() > 4 * 60_000,
    'Exhausted fast retries must fall back to a five-minute automatic cadence.');
  assert.equal(harness.db.getClassicRecoverySummary().manualReviewCount, 0);
});

test('explicitly non-retryable Factory evidence enters administrator review instead of waiting forever', async (t) => {
  for (const [index, code] of ['factory_read_failed', 'recovery_response_too_large'].entries()) {
    const harness = await createHarness(t);
    const batch = harness.db.createBatch(`Non-retryable recovery ${index}`);
    const { panel } = await addPanelWithSource(harness, { batchId: batch.id });
    const run = queueStage(harness, {
      panelId: panel.id,
      stage: 'ink',
      provider: 'miguo',
      idempotencyKey: `non-retryable-recovery-${index}`
    });
    harness.db.claimNextQueued();
    holdAccepted(harness.db, run.id, null);

    const worker = new ClassicRecoveryWorker({
      db: harness.db,
      assetService: harness.assetService,
      recoveryClient: {
        async recover() {
          throw Object.assign(new Error('Unsafe or non-retryable Factory evidence.'), {
            code,
            retryableRecovery: false
          });
        }
      }
    });
    const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 60_000 });
    await worker.process(job);

    const held = harness.db.getClassicRecoveryJob(run.id);
    assert.equal(held.state, 'manual_review');
    assert.equal(held.next_attempt_at, null);
    assert.equal(held.last_error_code, code);
  }
});
