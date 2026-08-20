import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { buildApp } from '../src/app.mjs';
import { config as baseConfig } from '../src/config.mjs';
import { toolForStage } from '../src/domain.mjs';

async function createAppHarness(t, { realEnabled = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-api-'));
  const runtimeConfig = {
    ...baseConfig,
    dataRoot: root,
    databasePath: path.join(root, 'p0.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    exportsRoot: path.join(root, 'exports'),
    maxUploadFiles: 50,
    maxUploadBytes: 20 * 1024 * 1024,
    maxPointsPerBatch: 2_880,
    miguo: {
      ...baseConfig.miguo,
      accountId: realEnabled ? 'test-account' : '',
      apiToken: realEnabled ? 'test-token-that-is-never-sent' : '',
      allowRealProvider: realEnabled,
      internalUseAcknowledged: realEnabled
    }
  };
  const app = await buildApp({ runtimeConfig, startWorker: false });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

async function seedPanel(app, { batchName = 'API safety', ordinal = 1 } = {}) {
  const { db, assetService } = app.p0;
  const batch = db.createBatch(batchName);
  const panel = db.addPanel({ batchId: batch.id, ordinal, originalFilename: 'panel.png' });
  const buffer = await sharp({ create: { width: 256, height: 320, channels: 3, background: '#efe8dc' } })
    .png().toBuffer();
  const normalized = await assetService.normalizeUpload(buffer, {
    batchId: batch.id,
    panelId: panel.id,
    originalFilename: 'panel.png'
  });
  const source = db.createAssetVersion({
    panelId: panel.id,
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
  return { batch, panel, source };
}

function storyboardReferenceMultipart({ image, panelId, filename = 'character-reference.png' }) {
  const boundary = '----miguo-reference-workflow-test';
  const chunks = [];
  if (panelId !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="panelId"\r\n\r\n${panelId}\r\n`
    ));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + 'Content-Type: image/png\r\n\r\n'
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

function panelBatchMultipart(files) {
  const boundary = '----miguo-comic-batch-upload-test';
  const chunks = [];
  files.forEach(({ image, filename }) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n`
        + 'Content-Type: image/png\r\n\r\n'
      ),
      image,
      Buffer.from('\r\n')
    );
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

test('batch API separates comic and reference workflows while preserving the comic default', async (t) => {
  const app = await createAppHarness(t);
  const comic = await app.inject({
    method: 'POST', url: '/api/v1/batches', payload: { name: 'Comic default' }
  });
  assert.equal(comic.statusCode, 201, comic.body);
  assert.equal(comic.json().workflow_type, 'comic_pipeline');

  const reference = await app.inject({
    method: 'POST', url: '/api/v1/batches',
    payload: { name: 'Reference creation', workflowType: 'reference_creation' }
  });
  assert.equal(reference.statusCode, 201, reference.body);
  assert.equal(reference.json().workflow_type, 'reference_creation');

  const filtered = await app.inject({
    method: 'GET', url: '/api/v1/batches?workflowType=reference_creation'
  });
  assert.equal(filtered.statusCode, 200, filtered.body);
  assert.deepEqual(filtered.json().batches.map((batch) => batch.id), [reference.json().id]);

  const details = await app.inject({
    method: 'GET', url: `/api/v1/batches/${reference.json().id}`
  });
  assert.equal(details.statusCode, 200, details.body);
  assert.equal(details.json().workflow_type, 'reference_creation');
  assert.deepEqual(details.json().storyboardReferences, []);
  const missingReferences = await app.inject({
    method: 'GET', url: '/api/v1/batches/missing-batch/storyboard-references'
  });
  assert.equal(missingReferences.statusCode, 404);
  assert.equal(missingReferences.json().error.code, 'batch_not_found');

  const invalidCreate = await app.inject({
    method: 'POST', url: '/api/v1/batches',
    payload: { name: 'Unknown workflow', workflowType: 'storyboard' }
  });
  assert.equal(invalidCreate.statusCode, 422);
  assert.equal(invalidCreate.json().error.code, 'invalid_workflow_type');
  const invalidFilter = await app.inject({
    method: 'GET', url: '/api/v1/batches?workflowType=storyboard'
  });
  assert.equal(invalidFilter.statusCode, 422);
  assert.equal(invalidFilter.json().error.code, 'invalid_workflow_type');
});

test('comic batch upload consumes every selected multipart file and creates one ordered column per image', async (t) => {
  const app = await createAppHarness(t);
  const createdBatch = await app.inject({
    method: 'POST', url: '/api/v1/batches', payload: { name: 'Three selected drafts' }
  });
  assert.equal(createdBatch.statusCode, 201, createdBatch.body);
  const batchId = createdBatch.json().id;
  const colors = ['#d9edf7', '#f7e5d9', '#e5f7d9'];
  const files = await Promise.all(colors.map(async (background, index) => ({
    filename: `selected-${index + 1}.png`,
    image: await sharp({ create: { width: 256, height: 320, channels: 3, background } }).png().toBuffer()
  })));
  const multipart = panelBatchMultipart(files);

  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batchId}/panels`,
    headers: multipart.headers,
    payload: multipart.payload
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  assert.equal(uploaded.json().created.length, 3);

  const details = await app.inject({ method: 'GET', url: `/api/v1/batches/${batchId}` });
  assert.equal(details.statusCode, 200, details.body);
  assert.deepEqual(details.json().panels.map((panel) => panel.original_filename),
    files.map((file) => file.filename));
  assert.deepEqual(details.json().panels.map((panel) => panel.ordinal), [1, 2, 3]);
  assert.equal(new Set(details.json().panels.map((panel) => panel.current.source.id)).size, 3);
});

test('StoryArk reference upload persists its panel mapping for refresh and run recovery', async (t) => {
  const app = await createAppHarness(t);
  const { db } = app.p0;
  const { batch, panel, source } = await seedPanel(app, { batchName: 'Reference columns' });
  const image = await sharp({
    create: { width: 256, height: 320, channels: 3, background: '#c6b8aa' }
  }).png().toBuffer();
  const multipart = storyboardReferenceMultipart({ image, panelId: panel.id });
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batch.id}/storyboard-references`,
    headers: multipart.headers,
    payload: multipart.payload
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const reference = uploaded.json().reference;
  assert.equal(reference.panel_id, panel.id);

  const queued = db.queueStoryboardRun({
    panelId: panel.id,
    idempotencyKey: 'reference-panel-refresh-map',
    contractFingerprint: 'reference-panel-map-contract',
    projectId: 'project-reference-map',
    imageSize: '1K',
    expectedResultCount: 1,
    removeBg: false,
    sourceAssetVersionId: source.id,
    referenceAssetId: reference.id,
    request: { routeRevision: 'reference-panel-map-test' }
  }).run;
  const details = await app.inject({
    method: 'GET', url: `/api/v1/batches/${batch.id}`
  });
  assert.equal(details.statusCode, 200, details.body);
  assert.equal(details.json().storyboardReferences[0].panel_id, panel.id);
  assert.equal(details.json().storyboardRuns[0].panel_id, panel.id);
  assert.equal(details.json().storyboardRuns[0].reference_asset_id, reference.id);
  assert.equal(details.json().storyboardRuns[0].id, queued.id);

  db.claimNextQueuedStoryboard();
  db.completeStoryboardRunWithOutputs({
    runId: queued.id,
    outputs: [{
      blobPath: source.blob_path,
      sha256: source.sha256,
      mimeType: source.mime_type,
      width: source.width,
      height: source.height,
      byteSize: source.byte_size,
      metadata: {
        deliveryMode: 'provider_raw_resize',
        renderProvider: 'nano_banana_2',
        renderModel: 'gemini-3.1-flash-image',
        providerRawSha256: '1'.repeat(64),
        sourceSha256: '2'.repeat(64),
        referenceSha256: '3'.repeat(64),
        maskSha256: '4'.repeat(64),
        lineage: {
          providerRawSha256: '1'.repeat(64),
          sourceSha256: '2'.repeat(64),
          referenceSha256: '3'.repeat(64),
          maskSha256: '4'.repeat(64),
          analysisInputFingerprint: 'internal-analysis-fingerprint'
        }
      }
    }]
  });
  const completedDetails = await app.inject({
    method: 'GET', url: `/api/v1/batches/${batch.id}`
  });
  assert.equal(completedDetails.statusCode, 200, completedDetails.body);
  const creatorOutput = completedDetails.json().storyboardRuns[0].outputs[0];
  assert.equal(completedDetails.json().panels[0].selected_storyboard_output_id, creatorOutput.id,
    'The newest completed generation must be the server-owned adopted version.');
  assert.equal(creatorOutput.metadata.deliveryMode, 'provider_raw_resize');
  assert.equal(creatorOutput.metadata.renderModel, undefined);
  assert.equal(creatorOutput.metadata.renderProvider, undefined);
  assert.equal(creatorOutput.sha256, undefined);
  assert.equal(creatorOutput.blob_path, undefined);
  assert.equal(creatorOutput.metadata.providerRawSha256, undefined);
  assert.equal(creatorOutput.metadata.sourceSha256, undefined);
  assert.equal(creatorOutput.metadata.referenceSha256, undefined);
  assert.equal(creatorOutput.metadata.maskSha256, undefined);
  assert.equal(creatorOutput.metadata.lineage.providerRawSha256, undefined);
  assert.equal(creatorOutput.metadata.lineage.analysisInputFingerprint, undefined);
  assert.doesNotMatch(completedDetails.body, /11111111|22222222|33333333|44444444|internal-analysis-fingerprint/);

  const selected = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/storyboard-output-selection`,
    payload: { outputId: creatorOutput.id }
  });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().changed, false);
  assert.equal(selected.json().selectedOutputId, creatorOutput.id);
  assert.equal(selected.json().output.sha256, undefined);
  assert.equal(selected.json().output.blob_path, undefined);

  const foreign = await seedPanel(app, { batchName: 'Foreign reference column' });
  const mismatchedMultipart = storyboardReferenceMultipart({ image, panelId: foreign.panel.id });
  const mismatch = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batch.id}/storyboard-references`,
    headers: mismatchedMultipart.headers,
    payload: mismatchedMultipart.payload
  });
  assert.equal(mismatch.statusCode, 409, mismatch.body);
  assert.equal(mismatch.json().error.code, 'storyboard_reference_batch_mismatch');

  const legacyMultipart = storyboardReferenceMultipart({ image });
  const legacy = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${foreign.batch.id}/storyboard-references`,
    headers: legacyMultipart.headers,
    payload: legacyMultipart.payload
  });
  assert.equal(legacy.statusCode, 201, legacy.body);
  assert.equal(legacy.json().reference.panel_id, null);
});

test('API blocks real runs while the double safety gate is closed and never exposes credentials', async (t) => {
  const app = await createAppHarness(t);
  const { panel } = await seedPanel(app);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'closed-gate' },
    payload: { provider: 'miguo', params: {} }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'real_provider_blocked');
  const configResponse = await app.inject({ method: 'GET', url: '/api/v1/config' });
  assert.equal(configResponse.statusCode, 200);
  assert.equal(configResponse.json().miguo.configured, false);
  assert.doesNotMatch(configResponse.body, /apiToken|accountId|x-api-token/i);
});

test('retry refuses unknown real cost even when gates are open', async (t) => {
  const app = await createAppHarness(t, { realEnabled: true });
  const { db } = app.p0;
  const { panel, source } = await seedPanel(app);
  const queued = db.queueRun({
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    toolName: toolForStage('ink'),
    params: {},
    idempotencyKey: 'unknown-real',
    inputVersions: [{ id: source.id, role: 'source', sha256: source.sha256 }]
  }).run;
  db.failRun({ runId: queued.id, code: 'output_fetch_failed', message: 'safe', costSource: 'unknown' });
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${queued.id}/retry`,
    headers: { 'idempotency-key': 'unknown-real-retry' }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'unknown_outcome');
  assert.equal(db.findRunByIdempotencyKey('unknown-real-retry'), undefined);
});

test('an unknown classic Miguo cost durably queues intent but blocks paid execution in every batch', async (t) => {
  const app = await createAppHarness(t, { realEnabled: true });
  const { db } = app.p0;
  const first = await seedPanel(app, { batchName: 'Unknown cost origin' });
  const second = await seedPanel(app, { batchName: 'Different paid batch' });
  const unknown = db.queueRun({
    panelId: first.panel.id,
    stage: 'ink',
    provider: 'miguo',
    toolName: toolForStage('ink'),
    params: {},
    idempotencyKey: 'global-unknown-origin',
    inputVersions: [{ id: first.source.id, role: 'source', sha256: first.source.sha256 }]
  }).run;
  db.failRun({
    runId: unknown.id,
    code: 'unknown_outcome',
    message: 'Provider outcome requires reconciliation.',
    costSource: 'unknown'
  });

  assert.deepEqual(db.getClassicRunSafetySummary(), { unknownCostRunCount: 1 });
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${second.panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'blocked-across-batches' },
    payload: { provider: 'miguo', params: {} }
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().run.status, 'queued');
  const persisted = db.findRunByIdempotencyKey('blocked-across-batches');
  assert.equal(persisted.status, 'queued');
  assert.equal(db.claimNextQueued(), undefined,
    'The authoritative claim-time fuse must not execute queued paid intent before recovery resolves.');

  db.reconcileClassicRunCost({
    runId: unknown.id,
    idempotencyKey: 'global-unknown-origin-cost-resolution',
    costPoints: 0,
    costSource: 'no_charge_confirmed',
    note: 'Fixture confirms that the accepted origin task charged zero points.',
    evidenceReference: 'fixture-ledger:global-unknown-origin'
  });
  assert.equal(db.claimNextQueued().id, persisted.id,
    'The queued creator intent must become executable automatically after recovery resolves.');
});

test('creator APIs expose display state but hide provider and accounting evidence', async (t) => {
  const app = await createAppHarness(t, { realEnabled: true });
  const { db } = app.p0;
  const { batch, panel, source } = await seedPanel(app, { batchName: 'Creator-safe projection' });
  db.db.prepare('UPDATE asset_versions SET metadata_json = ? WHERE id = ?').run(JSON.stringify({
    provider: 'miguo',
    providerTaskId: 'hidden-provider-task',
    nested: { provider_request_id: 'hidden-provider-request' }
  }), source.id);
  const queued = db.queueRun({
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    providerProfile: 'factory_classic',
    providerContractFingerprint: 'fixture-contract',
    toolName: toolForStage('ink'),
    params: { channel: 'slow' },
    idempotencyKey: 'creator-safe-held-run',
    inputVersions: [{ id: source.id, role: 'source', sha256: source.sha256 }],
    estimatedCostPoints: 30
  }).run;
  db.failRun({
    runId: queued.id,
    code: 'output_missing',
    message: 'Raw parser evidence must remain operational only.',
    providerRequestId: 'hidden-provider-request',
    providerTaskId: 'hidden-provider-task',
    resultShapeFingerprint: `mcp-result-shape-v2:${'a'.repeat(64)}`,
    costSource: 'unknown',
    providerAccepted: true
  });

  const runResponse = await app.inject({ method: 'GET', url: `/api/v1/runs/${queued.id}` });
  assert.equal(runResponse.statusCode, 200, runResponse.body);
  assert.equal(runResponse.json().status, 'failed');
  assert.equal(runResponse.json().displayState, 'recovering');
  assert.match(runResponse.json().displayMessage, /后台.*自动显示/);
  assert.equal(runResponse.json().canRetry, false);
  assert.doesNotMatch(runResponse.body,
    /provider_task_id|provider_request_id|provider_result_shape|cost_source|cost_points|estimated_cost_points|output_missing|Raw parser evidence/i);

  const batchResponse = await app.inject({ method: 'GET', url: `/api/v1/batches/${batch.id}` });
  assert.equal(batchResponse.statusCode, 200, batchResponse.body);
  assert.equal(batchResponse.json().panels[0].runs[0].displayState, 'recovering');
  assert.equal(batchResponse.json().panels[0].current.source.metadata.provider, 'miguo');
  assert.equal(batchResponse.json().panels[0].current.source.metadata.providerTaskId, undefined);
  assert.equal(batchResponse.json().panels[0].current.source.metadata.nested.provider_request_id, undefined);
  assert.equal(batchResponse.json().totals.cost_points, undefined);
  assert.equal(batchResponse.json().totals.unknown_cost_attempts, undefined);
  assert.doesNotMatch(batchResponse.body,
    /hidden-provider-task|hidden-provider-request|provider_task_id|provider_request_id|cost_source|unknown_cost_attempts|output_missing/i);
});

test('real Factory runs reject fast channel while mock runs may retain it', async (t) => {
  const app = await createAppHarness(t, { realEnabled: true });
  const { db } = app.p0;
  const { panel } = await seedPanel(app, { batchName: 'Slow-only Factory contract' });
  const real = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'real-fast-rejected' },
    payload: { provider: 'miguo', params: { channel: 'fast' } }
  });
  assert.equal(real.statusCode, 422, real.body);
  assert.equal(real.json().error.code, 'invalid_channel');
  assert.equal(db.findRunByIdempotencyKey('real-fast-rejected'), undefined);

  const mock = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'mock-fast-allowed' },
    payload: { provider: 'mock', params: { channel: 'fast' } }
  });
  assert.equal(mock.statusCode, 202, mock.body);
  assert.equal(mock.json().run.params.channel, 'fast');
  assert.equal(mock.json().run.displayState, 'queued');
});

test('retry refuses an obsolete upstream snapshot', async (t) => {
  const app = await createAppHarness(t);
  const { db } = app.p0;
  const { panel, source } = await seedPanel(app);
  const makeAsset = (stage, parent, edge) => db.createAssetVersion({
    panelId: panel.id,
    stage,
    parentVersionId: parent.id,
    blobPath: source.blob_path,
    sha256: source.sha256,
    mimeType: source.mime_type,
    width: source.width,
    height: source.height,
    byteSize: source.byte_size,
    inputEdges: [{ id: edge.id, role: edge.stage }]
  });
  const inkA = makeAsset('ink', source, { id: source.id, stage: 'source' });
  db.promoteAsset(inkA.id);
  const run = db.queueRun({
    panelId: panel.id,
    stage: 'color',
    provider: 'mock',
    toolName: toolForStage('color'),
    params: {},
    idempotencyKey: 'color-on-a',
    inputVersions: [{ id: inkA.id, role: 'ink', sha256: inkA.sha256 }]
  }).run;
  db.failRun({ runId: run.id, code: 'network_timeout_retryable', message: 'safe' });
  const inkB = makeAsset('ink', source, { id: source.id, stage: 'source' });
  db.promoteAsset(inkB.id);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${run.id}/retry`,
    headers: { 'idempotency-key': 'color-on-a-retry' }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'input_snapshot_changed');
});

test('atomic batch queue rolls back every new row when any item conflicts', async (t) => {
  const app = await createAppHarness(t);
  const { db } = app.p0;
  const { panel, source } = await seedPanel(app);
  const base = {
    panelId: panel.id,
    stage: 'ink',
    provider: 'mock',
    toolName: toolForStage('ink'),
    params: {},
    inputVersions: [{ id: source.id, role: 'source', sha256: source.sha256 }]
  };
  assert.throws(
    () => db.queueRunsAtomic([
      { ...base, idempotencyKey: 'atomic-first' },
      { ...base, idempotencyKey: 'atomic-conflict' }
    ]),
    (error) => error.code === 'active_run_exists'
  );
  assert.equal(db.findRunByIdempotencyKey('atomic-first'), undefined);
  assert.equal(db.findRunByIdempotencyKey('atomic-conflict'), undefined);
});

test('atomic panel import leaves no partial database rows when one panel fails', async (t) => {
  const app = await createAppHarness(t);
  const { db } = app.p0;
  const fixture = await seedPanel(app, { batchName: 'source fixture' });
  const batch = db.createBatch('atomic import target');
  const source = {
    blobPath: fixture.source.blob_path,
    sha256: fixture.source.sha256,
    mimeType: fixture.source.mime_type,
    width: fixture.source.width,
    height: fixture.source.height,
    byteSize: fixture.source.byte_size,
    metadata: fixture.source.metadata
  };
  assert.throws(() => db.addPanelsWithSourcesAtomic([
    { panelId: 'atomic-panel-1', batchId: batch.id, ordinal: 1, originalFilename: 'one.png', source },
    { panelId: 'atomic-panel-2', batchId: batch.id, ordinal: 1, originalFilename: 'two.png', source }
  ]));
  const count = db.db.prepare('SELECT COUNT(*) AS count FROM panels WHERE batch_id = ?').get(batch.id).count;
  assert.equal(count, 0);
});

test('idempotency key rejects a changed provider or parameter payload', async (t) => {
  const app = await createAppHarness(t);
  const { panel } = await seedPanel(app);
  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'fixed-operation' },
    payload: { provider: 'mock', params: { strength: 0.1 } }
  });
  assert.equal(first.statusCode, 202);
  const changed = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'fixed-operation' },
    payload: { provider: 'mock', params: { strength: 0.9 } }
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'idempotency_key_conflict');
});

test('single-file workbench can use P0 through the file origin without exposing secrets', async (t) => {
  const app = await createAppHarness(t);
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/v1/health',
    headers: {
      origin: 'null',
      'access-control-request-method': 'GET'
    }
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'null');
  assert.match(preflight.headers['access-control-allow-headers'], /Idempotency-Key/i);

  const health = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: 'null' } });
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers['access-control-allow-origin'], 'null');
  assert.doesNotMatch(health.body, /apiToken|accountId|x-api-token|test-token/i);
});

test('workbench feedback survives in run parameters and panel order is persisted', async (t) => {
  const app = await createAppHarness(t);
  const { db } = app.p0;
  const { batch, panel } = await seedPanel(app, { batchName: 'Workbench integration' });
  const second = db.addPanel({ batchId: batch.id, ordinal: 2, originalFilename: 'second.png' });

  const queued = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: { 'idempotency-key': 'workbench-feedback' },
    payload: {
      provider: 'mock',
      params: { prompt: '眼睛线条更轻', reviewNote: '眼睛线条更轻' }
    }
  });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().run.params.reviewNote, '眼睛线条更轻');

  const reordered = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batch.id}/panels/reorder`,
    payload: { panelIds: [second.id, panel.id] }
  });
  assert.equal(reordered.statusCode, 200);
  assert.deepEqual(reordered.json().panels.map((item) => item.id), [second.id, panel.id]);
});
