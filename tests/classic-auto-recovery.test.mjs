import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunWorker } from '../src/services/worker.mjs';
import { ClassicRecoveryWorker } from '../src/services/classic-recovery-worker.mjs';
import {
  addPanelWithSource, createHarness, generateAndPromote, makePanelPng, queueStage
} from './helpers.mjs';

test('an accepted classic result is recovered in the background without a second paid call', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Automatic recovery');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, width: 320, height: 384 });
  await generateAndPromote(harness, { panelId: panel.id, stage: 'ink', idempotencyKey: 'auto-recovery-ink' });
  await generateAndPromote(harness, { panelId: panel.id, stage: 'color', idempotencyKey: 'auto-recovery-color' });

  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'light',
    provider: 'miguo',
    idempotencyKey: 'auto-recovery-light',
    params: { channel: 'slow', style: 'nvpin', color: 'nvpin_rule', light: 'top_left', shadow_strength: 0.5 }
  });
  let paidCalls = 0;
  const paidProvider = {
    async execute({ onProviderEvidence }) {
      paidCalls += 1;
      await onProviderEvidence?.({
        providerRequestId: null,
        providerTaskId: null,
        resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`
      });
      throw Object.assign(new Error('The accepted response did not expose a finished preview.'), {
        code: 'output_missing', providerAccepted: true, billingOutcome: 'unknown',
        resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`
      });
    }
  };
  const paidWorker = new RunWorker({
    db: harness.db,
    assetService: harness.assetService,
    providers: { miguo: paidProvider },
    concurrency: 1
  });
  const claimed = harness.db.claimNextQueued();
  assert.equal(claimed.id, queued.id);
  await paidWorker.process(claimed);
  assert.equal(paidCalls, 1);
  const held = harness.db.getRun(queued.id);
  assert.equal(held.status, 'failed');
  assert.equal(held.cost_source, 'unknown');
  assert.equal(harness.db.getClassicRecoveryJob(queued.id).state, 'queued');

  const preview = await makePanelPng({ width: source.width, height: source.height, seed: 91 });
  let recoveryReads = 0;
  const recoveryClient = {
    async recover({ run, inputs }) {
      recoveryReads += 1;
      assert.equal(run.id, queued.id);
      assert.deepEqual(inputs.map(({ role }) => role), ['color', 'ink']);
      return {
        buffer: preview,
        providerTaskId: '019fff5c-3717-7663-afdb-b8b763b980c0',
        providerTaskType: 3,
        providerTaskVersion: 'v7',
        outputHost: 'oss.miguocomics.com',
        outputRawSha256: 'b'.repeat(64),
        evidenceReference: 'factory-task:019fff5c-3717-7663-afdb-b8b763b980c0:shadow-v7-preview;ledger:type2:reason6',
        costPoints: 0,
        costSource: 'no_charge_confirmed'
      };
    }
  };
  const recoveryWorker = new ClassicRecoveryWorker({
    db: harness.db,
    assetService: harness.assetService,
    recoveryClient,
    pollMs: 5
  });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: recoveryWorker.leaseOwner, leaseMs: 60_000 });
  assert.equal(job.run_id, queued.id);
  await recoveryWorker.process(job);

  assert.equal(paidCalls, 1, 'automatic recovery must never submit another paid tools/call');
  assert.equal(recoveryReads, 1);
  const completed = harness.db.getRun(queued.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.provider_task_id, '019fff5c-3717-7663-afdb-b8b763b980c0');
  assert.equal(completed.cost_points, 0);
  assert.equal(completed.cost_source, 'no_charge_confirmed');
  const output = harness.db.getAsset(completed.output_asset_version_id);
  assert.equal(output.stage, 'light');
  assert.equal(output.status, 'candidate');
  const edges = harness.db.db.prepare(`
    SELECT role FROM derived_from_edges WHERE output_asset_version_id = ? ORDER BY role
  `).all(output.id);
  assert.deepEqual(edges.map(({ role }) => role).sort(), ['color', 'ink']);
  assert.equal(harness.db.getClassicRecoveryJob(queued.id).state, 'resolved');
  assert.equal(harness.db.listRunReconciliationEvents(queued.id).length, 1);
  harness.db.promoteAsset(output.id);
  assert.equal(harness.db.getPanelSnapshot(panel.id).current.light.id, output.id);
});

test('a succeeded run with unknown cost is reconciled in the background without replacing its output', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Automatic cost recovery');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, width: 320, height: 384 });
  const generated = await generateAndPromote(harness, {
    panelId: panel.id, stage: 'ink', idempotencyKey: 'auto-cost-existing-output'
  });
  harness.db.db.prepare(`
    UPDATE run_attempts SET provider='miguo', provider_profile='factory_classic',
      provider_phase='completed', cost_points=0, cost_source='unknown'
    WHERE id=?
  `).run(generated.run.id);
  assert.equal(harness.db.enqueuePendingClassicRecoveries(), 1);

  const recoveryClient = {
    async recover() {
      return {
        buffer: Buffer.from('read-only-evidence'),
        providerTaskId: '019fff5c-3717-7663-afdb-b8b763b980c1',
        providerTaskType: 5,
        providerTaskVersion: 'v4',
        outputHost: 'oss.miguocomics.com',
        outputRawSha256: 'c'.repeat(64),
        evidenceReference: 'factory-task:019fff5c-3717-7663-afdb-b8b763b980c1:lineart-v4;ledger:type2:reason6',
        costPoints: 0,
        costSource: 'no_charge_confirmed'
      };
    }
  };
  const worker = new ClassicRecoveryWorker({ db: harness.db, assetService: harness.assetService, recoveryClient });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 60_000 });
  await worker.process(job);

  const reconciled = harness.db.getRun(generated.run.id);
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(reconciled.output_asset_version_id, generated.run.output_asset_version_id);
  assert.equal(reconciled.cost_source, 'no_charge_confirmed');
  assert.equal(harness.db.getClassicRecoveryJob(generated.run.id).state, 'resolved');
  const events = harness.db.listRunReconciliationEvents(generated.run.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'resolve_cost_only');
});

test('an explicit Factory failure is ledger-reconciled without creating or attaching an asset', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Automatic terminal failure recovery');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, width: 320, height: 384 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'auto-recovery-terminal-failure'
  });
  assert.equal(harness.db.claimNextQueued().id, queued.id);
  harness.db.holdRunForRecovery({
    runId: queued.id,
    code: 'output_missing',
    message: 'Factory accepted the request but Studio could not verify an output.',
    resultShapeFingerprint: `mcp-result-shape-v2:${'d'.repeat(64)}`
  });

  const assetCountBefore = harness.db.db.prepare('SELECT COUNT(*) AS count FROM asset_versions').get().count;
  let recoveryReads = 0;
  let ingestCalls = 0;
  const recoveryClient = {
    async recover({ run, inputs }) {
      recoveryReads += 1;
      assert.equal(run.id, queued.id);
      assert.deepEqual(inputs.map(({ role }) => role), ['source']);
      return {
        outcome: 'failed',
        providerTaskId: '019fff5c-3717-7663-afdb-b8b763b980c2',
        providerTaskType: 5,
        providerTaskVersion: 'v4',
        evidenceReference: 'factory-task:019fff5c-3717-7663-afdb-b8b763b980c2:lineart-v4:failed;ledger:type2:reason6',
        costPoints: 30,
        costSource: 'provider_statement'
      };
    }
  };
  const assetService = {
    read: (...args) => harness.assetService.read(...args),
    async ingestGeneratedBuffer() {
      ingestCalls += 1;
      throw new Error('Explicit Factory failures must never reach asset ingestion.');
    }
  };
  const worker = new ClassicRecoveryWorker({ db: harness.db, assetService, recoveryClient });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 60_000 });
  await worker.process(job);

  assert.equal(recoveryReads, 1);
  assert.equal(ingestCalls, 0);
  const failed = harness.db.getRun(queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'output_missing');
  assert.equal(failed.output_asset_version_id, null);
  assert.equal(failed.provider_task_id, '019fff5c-3717-7663-afdb-b8b763b980c2');
  assert.equal(failed.cost_points, 30);
  assert.equal(failed.cost_source, 'provider_statement');
  assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS count FROM asset_versions').get().count, assetCountBefore);
  assert.equal(harness.db.getClassicRecoveryJob(queued.id).state, 'resolved');
  const events = harness.db.listRunReconciliationEvents(queued.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'resolve_cost_only');
  assert.equal(events[0].prior_status, 'failed');
});

test('terminal exact-cost recovery jobs resolve without another Factory read', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Terminal recovery fast path');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const failedRun = queueStage(harness, {
    panelId: first.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'terminal-fast-path-failed'
  });
  assert.equal(harness.db.claimNextQueued().id, failedRun.id);
  harness.db.holdRunForRecovery({
    runId: failedRun.id,
    code: 'output_missing',
    message: 'Fixture accepted failure.',
    resultShapeFingerprint: `mcp-result-shape-v2:${'e'.repeat(64)}`
  });
  harness.db.db.prepare(`
    UPDATE run_attempts SET cost_points=0, cost_source='no_charge_confirmed' WHERE id=?
  `).run(failedRun.id);

  let recoveryReads = 0;
  const worker = new ClassicRecoveryWorker({
    db: harness.db,
    assetService: harness.assetService,
    recoveryClient: { async recover() { recoveryReads += 1; throw new Error('must not read'); } }
  });
  const job = harness.db.claimNextClassicRecovery({ leaseOwner: worker.leaseOwner, leaseMs: 60_000 });
  await worker.process(job);

  assert.equal(recoveryReads, 0);
  assert.equal(harness.db.getClassicRecoveryJob(failedRun.id).state, 'resolved');
  assert.equal(harness.db.getRun(failedRun.id).status, 'failed');

  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const succeeded = await generateAndPromote(harness, {
    panelId: second.panel.id,
    stage: 'ink',
    idempotencyKey: 'terminal-fast-path-succeeded'
  });
  harness.db.db.prepare(`
    UPDATE run_attempts SET provider='miguo', provider_profile='factory_classic',
      provider_phase='completed', cost_points=0, cost_source='unknown'
    WHERE id=?
  `).run(succeeded.run.id);
  assert.equal(harness.db.enqueuePendingClassicRecoveries(), 1);
  harness.db.db.prepare(`
    UPDATE run_attempts SET cost_points=0, cost_source='no_charge_confirmed' WHERE id=?
  `).run(succeeded.run.id);

  const succeededJob = harness.db.claimNextClassicRecovery({
    leaseOwner: worker.leaseOwner,
    leaseMs: 60_000
  });
  await worker.process(succeededJob);

  assert.equal(recoveryReads, 0);
  assert.equal(harness.db.getClassicRecoveryJob(succeeded.run.id).state, 'resolved');
  assert.equal(harness.db.getRun(succeeded.run.id).status, 'succeeded');
});
