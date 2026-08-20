import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp } from '../src/app.mjs';
import {
  addPanelWithSource,
  createCandidate,
  createHarness,
  makePanelPng,
  processNext,
  queueStage
} from './helpers.mjs';
import { RunWorker } from '../src/services/worker.mjs';
import { toolForStage } from '../src/domain.mjs';

function runtimeConfig(root) {
  const dataRoot = path.join(root, 'app-data');
  return {
    host: '127.0.0.1',
    port: 0,
    dataRoot,
    databasePath: path.join(dataRoot, 'p0.sqlite'),
    assetsRoot: path.join(dataRoot, 'assets'),
    exportsRoot: path.join(dataRoot, 'exports'),
    defaultProvider: 'mock',
    workerConcurrency: 1,
    maxUploadFiles: 50,
    maxUploadBytes: 2 * 1024 * 1024,
    faultMode: 'none',
    miguo: {
      accountId: '',
      apiToken: '',
      mcpUrl: 'https://factory.miguocomics.com/api/mcp/v1',
      channel: 'slow',
      timeoutMs: 10_000,
      allowRealProvider: false,
      internalUseAcknowledged: false
    }
  };
}

test('a retryable network failure consumes one retry and then succeeds', async (t) => {
  const harness = await createHarness(t, { faultMode: 'network_once' });
  const batch = harness.db.createBatch('network retry acceptance');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });

  const first = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    idempotencyKey: 'network:ink:attempt-1'
  });
  const failed = await processNext(harness, first.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'network_timeout_retryable');

  const retried = harness.db.retryRun(first.id, 'network:ink:attempt-2');
  assert.equal(retried.deduplicated, false);
  const replayedRetry = harness.db.retryRun(first.id, 'network:ink:attempt-2');
  assert.equal(replayedRetry.deduplicated, true, 'The retry key must replay before the attempt cap is checked.');
  assert.equal(replayedRetry.run.id, retried.run.id);
  const succeeded = await processNext(harness, retried.run.id);
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(harness.db.countAttemptsForInputs(panel.id, 'ink', first.inputVersions), 2);
});

test('mock generations remain repeatable because they do not consume paid-provider safety allowance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-api-test-'));
  const config = runtimeConfig(root);
  await fs.mkdir(config.dataRoot, { recursive: true });
  const app = await buildApp({ runtimeConfig: config, startWorker: false });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const batch = app.p0.db.createBatch('two-attempt API acceptance');
  const panelId = 'panel-attempt-cap';
  app.p0.db.addPanel({ id: panelId, batchId: batch.id, ordinal: 1, originalFilename: 'panel.png' });
  const sourceBuffer = await makePanelPng({ width: 320, height: 384, seed: 41 });
  const normalized = await app.p0.assetService.normalizeUpload(sourceBuffer, {
    batchId: batch.id,
    panelId,
    originalFilename: 'panel.png'
  });
  app.p0.db.createAssetVersion({
    panelId,
    stage: 'source',
    blobPath: normalized.relativePath,
    sha256: normalized.sha256,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    byteSize: normalized.byteSize,
    status: 'approved',
    metadata: normalized.metadata
  });

  const queue = (key) => app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panelId}/runs/ink`,
    headers: { 'idempotency-key': key },
    payload: { provider: 'mock', params: {} }
  });

  const first = await queue('attempt-cap-1');
  assert.equal(first.statusCode, 202);
  const replay = await queue('attempt-cap-1');
  assert.equal(replay.statusCode, 200, 'An idempotent replay must not consume an attempt.');
  assert.equal(replay.json().run.id, first.json().run.id);
  const firstClaimed = app.p0.db.claimNextQueued();
  assert.equal(firstClaimed.id, first.json().run.id);
  app.p0.db.failRun({ runId: firstClaimed.id, code: 'fixture_failure', message: 'fixture failure' });

  const second = await queue('attempt-cap-2');
  assert.equal(second.statusCode, 202);
  const secondClaimed = app.p0.db.claimNextQueued();
  assert.equal(secondClaimed.id, second.json().run.id);
  app.p0.db.failRun({ runId: secondClaimed.id, code: 'fixture_failure', message: 'fixture failure' });

  const third = await queue('attempt-cap-3');
  assert.equal(third.statusCode, 202, third.body);
  const thirdClaimed = app.p0.db.claimNextQueued();
  assert.equal(thirdClaimed.id, third.json().run.id);
  app.p0.db.failRun({ runId: thirdClaimed.id, code: 'fixture_failure', message: 'fixture failure' });
  assert.equal(app.p0.db.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE panel_id = ?').get(panelId).count, 3);
});

test('mock attempts do not consume the real-provider attempt allowance for the same input snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-provider-cap-test-'));
  const config = runtimeConfig(root);
  config.miguo = {
    ...config.miguo,
    accountId: 'fixture-account',
    apiToken: 'fixture-token',
    allowRealProvider: true,
    internalUseAcknowledged: true,
    outputHosts: ['factory.miguocomics.com']
  };
  await fs.mkdir(config.dataRoot, { recursive: true });
  const app = await buildApp({ runtimeConfig: config, startWorker: false });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const batch = app.p0.db.createBatch('provider-specific attempt allowance');
  const panelId = 'panel-provider-attempt-cap';
  app.p0.db.addPanel({ id: panelId, batchId: batch.id, ordinal: 1, originalFilename: 'panel.png' });
  const sourceBuffer = await makePanelPng({ width: 320, height: 384, seed: 42 });
  const normalized = await app.p0.assetService.normalizeUpload(sourceBuffer, {
    batchId: batch.id,
    panelId,
    originalFilename: 'panel.png'
  });
  app.p0.db.createAssetVersion({
    panelId,
    stage: 'source',
    blobPath: normalized.relativePath,
    sha256: normalized.sha256,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    byteSize: normalized.byteSize,
    status: 'approved',
    metadata: normalized.metadata
  });

  const queue = (provider, key) => app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panelId}/runs/ink`,
    headers: { 'idempotency-key': key },
    payload: { provider, params: {} }
  });
  const failNext = () => {
    const claimed = app.p0.db.claimNextQueued();
    assert.ok(claimed);
    app.p0.db.failRun({ runId: claimed.id, code: 'fixture_failure', message: 'fixture failure' });
  };

  assert.equal((await queue('mock', 'provider-cap-mock-1')).statusCode, 202);
  failNext();
  assert.equal((await queue('mock', 'provider-cap-mock-2')).statusCode, 202);
  failNext();
  assert.equal((await queue('mock', 'provider-cap-mock-3')).statusCode, 202,
    'Mock work must remain repeatable because it cannot consume provider points.');
  failNext();

  assert.equal((await queue('miguo', 'provider-cap-real-1')).statusCode, 202,
    'Two mock attempts must not prevent the first paid-provider attempt.');
  failNext();
  assert.equal((await queue('miguo', 'provider-cap-real-2')).statusCode, 202);
  failNext();
  const thirdReal = await queue('miguo', 'provider-cap-real-3');
  assert.equal(thirdReal.statusCode, 409);
  assert.equal(thirdReal.json().error.code, 'attempt_limit_reached');

  const inputVersions = app.p0.db.getRequiredInputs(panelId, 'ink')
    .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  assert.equal(app.p0.db.countAttemptsForInputs(panelId, 'ink', inputVersions, 'mock'), 3);
  assert.equal(app.p0.db.countAttemptsForInputs(panelId, 'ink', inputVersions, 'miguo'), 2);
  assert.equal(app.p0.db.countAttemptsForInputs(panelId, 'ink', inputVersions), 5);
});

test('the database transaction enforces provider-scoped attempt buckets after idempotency replay', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('transactional provider cap');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const inputVersions = [{ id: source.id, role: 'source', sha256: source.sha256 }];
  const spec = (provider, idempotencyKey) => ({
    panelId: panel.id,
    stage: 'ink',
    provider,
    toolName: toolForStage('ink'),
    params: {},
    idempotencyKey,
    inputVersions
  });
  const queueAndFail = (provider, idempotencyKey) => {
    const queued = harness.db.queueRun(spec(provider, idempotencyKey));
    harness.db.failRun({ runId: queued.run.id, code: 'fixture_failure', message: 'fixture failure' });
    return queued;
  };

  queueAndFail('mock', 'db-cap-mock-1');
  const secondMock = queueAndFail('mock', 'db-cap-mock-2');
  const replay = harness.db.queueRun(spec('mock', 'db-cap-mock-2'));
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.run.id, secondMock.run.id);
  queueAndFail('mock', 'db-cap-mock-3');

  queueAndFail('miguo', 'db-cap-miguo-1');
  queueAndFail('miguo', 'db-cap-miguo-2');
  assert.throws(
    () => harness.db.queueRun(spec('miguo', 'db-cap-miguo-3')),
    (error) => error.code === 'attempt_limit_reached'
  );
  assert.equal(harness.db.countAttemptsForInputs(panel.id, 'ink', inputVersions, 'mock'), 3);
  assert.equal(harness.db.countAttemptsForInputs(panel.id, 'ink', inputVersions, 'miguo'), 2);
  assert.equal(harness.db.countAttemptsForInputs(panel.id, 'ink', inputVersions), 5);
});

test('an interrupted real-provider run with no persisted output becomes unknown and is never blindly retried', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('unknown outcome acceptance');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'unknown:miguo:ink:1'
  });
  const claimed = harness.db.claimNextQueued();
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.status, 'running');

  assert.equal(harness.db.recoverInterruptedRuns(), 1);
  const recovered = harness.db.getRun(queued.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error_code, 'unknown_outcome');
  assert.equal(recovered.recovered_count, 1);
  assert.throws(
    () => harness.db.retryRun(queued.id, 'unknown:miguo:ink:2'),
    (error) => error.code === 'unknown_outcome'
  );
  assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE panel_id = ?').get(panel.id).count, 1);
});

test('restart recovery attaches an already-ingested output instead of invoking the provider again', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('ingested output recovery');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'recovery:miguo:ink:1'
  });
  const claimed = harness.db.claimNextQueued();
  assert.equal(claimed.id, queued.id);

  const persisted = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 72,
    runId: claimed.id
  });
  harness.db.db.prepare('UPDATE asset_versions SET run_attempt_id = ? WHERE id = ?').run(claimed.id, persisted.id);

  assert.equal(harness.db.recoverInterruptedRuns(), 1);
  const recovered = harness.db.getRun(claimed.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.output_asset_version_id, persisted.id);
  assert.equal(recovered.error_code, 'recovered_after_ingest');
  assert.equal(recovered.recovered_count, 1);
  assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE id = ?').get(claimed.id).count, 1);
});

test('a local ingest failure after Factory completion freezes unknown cost and blocks retry', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('post-provider ingest failure');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'post-provider-ingest:1'
  });
  let providerCalls = 0;
  const worker = new RunWorker({
    db: harness.db,
    assetService: {
      async ingestGeneratedBuffer() {
        throw Object.assign(new Error('local image normalization failed'), { code: 'geometry_mismatch' });
      }
    },
    providers: {
      miguo: {
        async execute() {
          providerCalls += 1;
          return {
            buffer: Buffer.from('accepted-provider-output'),
            providerRequestId: 'factory-request-1',
            costPoints: 20,
            costSource: 'estimate',
            metadata: { provider: 'miguo' }
          };
        }
      }
    }
  });

  const claimed = harness.db.claimNextQueued();
  assert.equal(claimed.id, queued.id);
  await worker.process(claimed);
  const failed = harness.db.getRun(queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'geometry_mismatch');
  assert.equal(failed.cost_source, 'unknown');
  assert.equal(providerCalls, 1);
  assert.throws(
    () => harness.db.retryRun(queued.id, 'post-provider-ingest:2'),
    (error) => error.code === 'unknown_outcome'
  );
});

test('Factory evidence is persisted before output parsing and output_missing remains non-retryable after cost reconciliation', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('provider evidence boundary');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'provider-evidence-boundary-1'
  });
  const fingerprint = `mcp-result-shape-v2:${'a'.repeat(64)}`;
  const worker = new RunWorker({
    db: harness.db,
    assetService: harness.assetService,
    providers: {
      miguo: {
        async execute({ onProviderEvidence }) {
          const evidence = {
            providerRequestId: 'factory-request-evidence-1',
            providerTaskId: 'factory-task-evidence-1',
            resultShapeFingerprint: fingerprint
          };
          await onProviderEvidence(evidence);
          throw Object.assign(new Error('Miguo result did not contain an output image URL.'), {
            code: 'output_missing',
            providerAccepted: true,
            billingOutcome: 'unknown',
            ...evidence
          });
        }
      }
    }
  });

  const claimed = harness.db.claimNextQueued();
  await worker.process(claimed);
  const failed = harness.db.getRun(queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'output_missing');
  assert.equal(failed.cost_source, 'unknown');
  assert.equal(failed.provider_phase, 'accepted');
  assert.equal(failed.provider_request_id, 'factory-request-evidence-1');
  assert.equal(failed.provider_task_id, 'factory-task-evidence-1');
  assert.equal(failed.provider_result_shape_fingerprint, fingerprint);
  assert.ok(failed.provider_result_observed_at);

  const reconciliation = harness.db.reconcileClassicRunCost({
    runId: failed.id,
    idempotencyKey: 'reconcile-output-missing-cost-1',
    providerRequestId: 'factory-request-evidence-1',
    providerTaskId: 'factory-task-evidence-1',
    resultShapeFingerprint: fingerprint,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Factory ledger confirmed this task deducted no points.',
    evidenceReference: 'factory-ledger:factory-task-evidence-1'
  });
  assert.equal(reconciliation.run.status, 'failed');
  assert.equal(reconciliation.run.cost_points, 0);
  assert.equal(reconciliation.run.cost_source, 'no_charge_confirmed');
  assert.equal(reconciliation.event.action, 'resolve_cost_only');
  assert.equal(reconciliation.deduplicated, false);
  const replay = harness.db.reconcileClassicRunCost({
    runId: failed.id,
    idempotencyKey: 'reconcile-output-missing-cost-1',
    providerRequestId: 'factory-request-evidence-1',
    providerTaskId: 'factory-task-evidence-1',
    resultShapeFingerprint: fingerprint,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Factory ledger confirmed this task deducted no points.',
    evidenceReference: 'factory-ledger:factory-task-evidence-1'
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.event.id, reconciliation.event.id);
  assert.throws(
    () => harness.db.retryRun(failed.id, 'output-missing-must-never-retry'),
    (error) => error.code === 'run_not_retryable'
  );
  assert.throws(
    () => harness.db.db.prepare('UPDATE run_reconciliation_events SET note = ? WHERE id = ?')
      .run('tampered evidence', reconciliation.event.id),
    /append-only/
  );
  assert.throws(
    () => harness.db.db.prepare('DELETE FROM run_reconciliation_events WHERE id = ?')
      .run(reconciliation.event.id),
    /append-only/
  );
});

test('audited recovery attaches only a same-stage candidate with the exact frozen input provenance', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('existing output reconciliation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const queued = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'attach-existing-output-run-1'
  });
  harness.db.failRun({
    runId: queued.id,
    code: 'output_missing',
    message: 'Provider accepted the task but the old parser missed its result.',
    costSource: 'unknown',
    providerRequestId: '019ffe66-f0d9-7d54-823d-2191eae1c7d2',
    providerTaskId: '019ffe66-f0d9-7d54-823d-2191eae1c7d2',
    resultShapeFingerprint: `mcp-result-shape-v1:${'b'.repeat(64)}`,
    providerAccepted: true
  });
  const candidate = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 98
  });
  const recovered = harness.db.attachExistingOutputToClassicRun({
    runId: queued.id,
    outputAssetVersionId: candidate.id,
    idempotencyKey: 'attach-existing-provider-output-1',
    providerRequestId: '019ffe66-f0d9-7d54-823d-2191eae1c7d2',
    providerTaskId: '019ffe66-f0d9-7d54-823d-2191eae1c7d2',
    resultShapeFingerprint: `mcp-result-shape-v1:${'b'.repeat(64)}`,
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Recovered the completed Factory task without another generation call.',
    evidenceReference: 'factory-task:019ffe66-f0d9-7d54-823d-2191eae1c7d2'
  });
  assert.equal(recovered.run.status, 'succeeded');
  assert.equal(recovered.run.output_asset_version_id, candidate.id);
  assert.equal(recovered.run.cost_source, 'no_charge_confirmed');
  assert.equal(harness.db.getAsset(candidate.id).run_attempt_id, queued.id);
  assert.equal(recovered.event.action, 'attach_existing_output');
  assert.equal(recovered.event.output_asset_version_id, candidate.id);

  const secondRun = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'attach-existing-output-run-2'
  });
  harness.db.failRun({
    runId: secondRun.id,
    code: 'output_missing',
    message: 'fixture',
    costSource: 'unknown',
    providerAccepted: true
  });
  const wrongProvenance = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [],
    width: source.width,
    height: source.height,
    seed: 99
  });
  assert.throws(() => harness.db.attachExistingOutputToClassicRun({
    runId: secondRun.id,
    outputAssetVersionId: wrongProvenance.id,
    idempotencyKey: 'reject-wrong-provider-output-1',
    providerTaskId: 'factory-task-wrong-provenance',
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'This candidate deliberately has no frozen input provenance.',
    evidenceReference: 'fixture:wrong-provenance'
  }), (error) => error.code === 'reconciliation_output_mismatch');
  assert.equal(harness.db.getRun(secondRun.id).status, 'failed');
  assert.equal(harness.db.listRunReconciliationEvents(secondRun.id).length, 0,
    'A rejected attachment must leave no audit event or partial state change.');
});
