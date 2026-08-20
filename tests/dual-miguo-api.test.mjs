import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { buildApp } from '../src/app.mjs';
import { config as baseConfig } from '../src/config.mjs';
import {
  STORYBOARD_ANALYSIS_PROMPT_REVISION,
  STORYBOARD_ANALYSIS_SCHEMA_VERSION,
  STORYBOARD_COVERAGE_PART_GROUPS
} from '../src/providers/studio-main-model.mjs';

async function harness(t, { storyarkEnabled = false, mainModelState = 'unconfigured', maxResultsPerBatch = 20 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-storyark-api-'));
  const runtimeConfig = {
    ...baseConfig,
    dataRoot: root,
    databasePath: path.join(root, 'p0.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    exportsRoot: path.join(root, 'exports'),
    storyark: {
      ...baseConfig.storyark,
      accountId: storyarkEnabled ? 'fixture-account' : '',
      apiToken: storyarkEnabled ? 'fixture-token-never-sent' : '',
      allowRealProvider: storyarkEnabled,
      internalUseAcknowledged: storyarkEnabled,
      maxResultsPerBatch
    },
    storyboard: { renderProvider: 'storyark', projectId: 'project-1' },
    mainModel: {
      ...baseConfig.mainModel,
      baseUrl: mainModelState === 'unconfigured' ? '' : 'https://main-model.invalid/v1',
      apiKey: mainModelState === 'unconfigured' ? '' : 'fixture-main-model-key-never-sent',
      enabled: mainModelState === 'ready'
    }
  };
  const app = await buildApp({ runtimeConfig, startWorker: false });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

async function seed(app) {
  const { db, assetService } = app.p0;
  const batch = db.createBatch('StoryArk API');
  const panel = db.addPanel({ batchId: batch.id, ordinal: 1, originalFilename: 'rough.png' });
  const image = await sharp({ create: { width: 320, height: 384, channels: 3, background: '#e8e1dc' } }).png().toBuffer();
  const normalized = await assetService.normalizeUpload(image, { batchId: batch.id, panelId: panel.id, originalFilename: 'rough.png' });
  const source = db.createAssetVersion({
    panelId: panel.id, stage: 'source', blobPath: normalized.relativePath, sha256: normalized.sha256,
    mimeType: normalized.mimeType, width: normalized.width, height: normalized.height,
    byteSize: normalized.byteSize, status: 'approved', metadata: normalized.metadata
  });
  const referenceNormalized = await assetService.normalizeUpload(image, {
    batchId: batch.id, panelId: 'storyboard-reference-fixture', originalFilename: 'character.png'
  });
  const reference = db.createStoryboardReference({
    batchId: batch.id, blobPath: referenceNormalized.relativePath, sha256: referenceNormalized.sha256,
    mimeType: referenceNormalized.mimeType, width: referenceNormalized.width, height: referenceNormalized.height,
    byteSize: referenceNormalized.byteSize, metadata: referenceNormalized.metadata
  });
  const analysis = await createCompletedAnalysis(app, { panel, source, reference });
  return { batch, panel, source, reference, analysis };
}

async function createCompletedAnalysis(app, { panel, source, reference }) {
  const polygon = [[
    { x: 0.2, y: 0.1 }, { x: 0.55, y: 0.1 },
    { x: 0.55, y: 0.9 }, { x: 0.2, y: 0.9 }
  ]];
  const elementSpec = {
    hair: ['hair', 'body_part'], face_neck_skin: ['skin', 'body_part'],
    arms_hands_skin: ['skin', 'body_part'], legs_skin: ['skin', 'body_part'],
    garment_top_sleeves: ['garment', 'worn_by'], garment_collar_neckwear: ['garment', 'worn_by'],
    garment_bottom: ['garment', 'worn_by'], socks_shoes: ['garment', 'worn_by'],
    hair_accessories: ['accessory', 'worn_by'], carried_bag: ['prop', 'carried_by']
  };
  const queued = app.p0.db.queueStoryboardAnalysis({
    panelId: panel.id,
    sourceAssetVersionId: source.id,
    referenceAssetId: reference.id,
    mode: 'single',
    modelName: 'gpt-5.6-terra',
    promptRevision: STORYBOARD_ANALYSIS_PROMPT_REVISION,
    idempotencyKey: `analysis:${panel.id}:${reference.id}`,
    inputFingerprint: `fixture:${source.sha256}:${reference.sha256}`
  });
  const completed = app.p0.db.completeStoryboardAnalysis({
    analysisId: queued.analysis.id,
    result: {
      schemaVersion: STORYBOARD_ANALYSIS_SCHEMA_VERSION,
      matchPolicy: 'exact_and_strong_lookalikes',
      summary: 'Fixture instance-aware selective-mask analysis.', overallConfidence: 1,
      requiresConfirmation: false, panels: [{
        localId: 'panel-1', bbox: { x: 0, y: 0, width: 1, height: 1 }, composition: '',
        characterInstances: [{
          localId: 'character-1', bbox: { x: 0.2, y: 0.1, width: 0.35, height: 0.8 },
          identityClass: 'exact_reference', identityConfidence: 1,
          identityCues: ['hair_design', 'costume_construction'], action: 'apply_reference',
          evidence: 'Reference character fixture.', maskPolygons: polygon,
          coverageChecklist: STORYBOARD_COVERAGE_PART_GROUPS.map((partGroup) => ({
            partGroup, status: 'masked', evidence: `Fixture ${partGroup} is visible.`,
            elementLocalIds: [`character-1-${partGroup}`]
          }))
        }],
        elements: STORYBOARD_COVERAGE_PART_GROUPS.map((partGroup, index) => ({
          localId: `character-1-${partGroup}`, kind: elementSpec[partGroup][0],
          bbox: { x: 0.2, y: 0.1, width: 0.35, height: 0.8 },
          evidence: `Reference-backed ${partGroup} fixture.`, referenceMatch: 'matched', confidence: 1,
          action: 'apply_reference', renderOrder: index + 1, maskPolygons: polygon,
          ownerCharacterLocalId: 'character-1', partGroup,
          relationship: elementSpec[partGroup][1], visibility: 'full'
        })),
        protectedRegions: [],
        coverageAudit: {
          acceptedInstanceCount: 1, completeAcceptedInstanceCount: 1,
          incompleteAcceptedInstanceLocalIds: [], notes: 'Fixture coverage is complete.'
        },
        risks: []
      }]
    }
  });
  return app.p0.storyboardPlanService.prepare(completed.id);
}

test('public config exposes only sanitized dual-MCP readiness and defaults both paid gates closed', async (t) => {
  const app = await harness(t);
  const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
  assert.equal(response.statusCode, 200);
  const config = response.json();
  assert.deepEqual(config.miguo.connections.factoryClassic.capabilities, ['lineart', 'color', 'shading']);
  assert.deepEqual(config.miguo.connections.storyarkV3.capabilities, ['projects', 'storyboard-inference', 'storyboard-status']);
  assert.equal(config.miguo.connections.factoryClassic.executionEnabled, false);
  assert.equal(config.miguo.connections.storyarkV3.executionEnabled, false);
  assert.equal(typeof config.storyboardGeneration.configured, 'boolean');
  assert.equal(typeof config.storyboardGeneration.enabled, 'boolean');
  assert.equal(config.mainModel.batchModel, undefined);
  assert.equal(config.mainModel.interactiveModel, undefined);
  assert.equal(config.imageModel.model, undefined);
  assert.doesNotMatch(response.body, /apiToken|accountId|x-api-token|fixture-token/i);
  assert.doesNotMatch(response.body, /gpt-5\.|gemini-|nano banana/i,
    'The creator health/config response must not expose model identifiers.');
});

test('a legacy StoryArk task clones its immutable source and reference into an editable reference batch', async (t) => {
  const app = await harness(t, { storyarkEnabled: true, mainModelState: 'ready' });
  const legacy = await seed(app);
  const target = app.p0.db.createBatch('Editable StoryArk batch', null, 'reference_creation');
  const response = await app.inject({
    method: 'POST', url: `/api/v1/panels/${legacy.panel.id}/storyboard-clone`,
    payload: { targetBatchId: target.id, referenceAssetId: legacy.reference.id }
  });
  assert.equal(response.statusCode, 201);
  const cloned = response.json();
  assert.equal(cloned.panel.batch_id, target.id);
  assert.equal(cloned.panel.current.source.sha256, legacy.source.sha256);
  assert.equal(cloned.panel.current.source.blob_path, legacy.source.blob_path);
  assert.equal(cloned.reference.batch_id, target.id);
  assert.equal(cloned.reference.panel_id, cloned.panel.id);
  assert.equal(cloned.reference.sha256, legacy.reference.sha256);
  assert.equal(app.p0.db.listStoryboardRunsForBatch(target.id).length, 0);
});

test('StoryArk run submission is blocked before any queue row while its paid safety gates are closed', async (t) => {
  const app = await harness(t);
  const { panel, reference } = await seed(app);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-closed' },
    payload: { projectId: 'project-1', referenceAssetId: reference.id, imageSize: '1K', expectedResultCount: 1, removeBg: false }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'real_provider_blocked');
  assert.equal(app.p0.db.findStoryboardRunByIdempotencyKey('storyark-closed'), undefined);
});

test('enabled StoryArk API freezes the fixed connection, contract, inputs and idempotency payload without network access', async (t) => {
  const app = await harness(t, { storyarkEnabled: true });
  const { panel, source, reference, analysis } = await seed(app);
  const payload = {
    projectId: 'project-1', referenceAssetId: reference.id, analysisId: analysis.id,
    imageSize: '2K', expectedResultCount: 2, removeBg: false
  };
  const first = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-fixed' }, payload
  });
  assert.equal(first.statusCode, 202);
  const run = first.json().run;
  assert.equal(run.provider_family, 'miguo');
  assert.equal(run.tool_name, 'storyboard_inference');
  assert.equal(run.provider_connection_id, undefined);
  assert.equal(run.contract_fingerprint, undefined);
  assert.equal(run.source_asset_version_id, source.id);
  assert.equal(run.reference_asset_id, reference.id);
  assert.equal(run.analysis_id, analysis.id);
  assert.equal(run.request.routeRevision, undefined);
  assert.equal(run.request.analysisId, analysis.id);
  const internalRun = app.p0.db.getStoryboardRun(run.id);
  assert.equal(internalRun.provider_connection_id, 'storyark_v3');
  assert.match(internalRun.contract_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(internalRun.request.routeRevision, 'storyark-v3-instance-chroma-composite-3');
  const replay = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-fixed' }, payload
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().run.id, run.id);
  const conflict = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-fixed' }, payload: { ...payload, imageSize: '4K' }
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_key_conflict');
});

test('StoryArk always requires a matching Terra analysis and prepared generation input', async (t) => {
  const app = await harness(t, { storyarkEnabled: true, mainModelState: 'ready' });
  const { panel, reference, analysis } = await seed(app);
  const payload = {
    projectId: 'project-1', referenceAssetId: reference.id,
    imageSize: '1K', expectedResultCount: 1, removeBg: false
  };
  const blocked = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-agent-required-missing' }, payload
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'storyboard_analysis_not_ready');
  assert.equal(app.p0.db.findStoryboardRunByIdempotencyKey('storyark-agent-required-missing'), undefined);

  const accepted = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-agent-required-ready' },
    payload: { ...payload, analysisId: analysis.id }
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().run.analysis_id, analysis.id);
  assert.equal(accepted.json().run.request.routeRevision, undefined);
  assert.equal(accepted.json().run.request.analysisModel, undefined);
  const internalRun = app.p0.db.getStoryboardRun(accepted.json().run.id);
  assert.equal(internalRun.request.routeRevision, 'storyark-v3-instance-chroma-composite-3');
  assert.equal(internalRun.request.analysisModel, 'gpt-5.6-terra');
  assert.ok(app.p0.db.getStoryboardAnalysis(analysis.id).confirmed_at);
});

test('disabled main model never opens a direct StoryArk bypass', async (t) => {
  const app = await harness(t, { storyarkEnabled: true, mainModelState: 'disabled' });
  const { panel, reference } = await seed(app);
  const blocked = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-agent-disabled-direct' },
    payload: {
      projectId: 'project-1', referenceAssetId: reference.id,
      imageSize: '1K', expectedResultCount: 1, removeBg: false
    }
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'storyboard_analysis_not_ready');
});

test('StoryArk output content verifies local integrity before serving', async (t) => {
  const app = await harness(t, { storyarkEnabled: true });
  const { db } = app.p0;
  const { panel, source, reference } = await seed(app);
  const queued = db.queueStoryboardRun({
    panelId: panel.id, idempotencyKey: 'output-integrity', contractFingerprint: 'f'.repeat(64),
    projectId: 'project-1', sourceAssetVersionId: source.id, referenceAssetId: reference.id
  }).run;
  db.claimNextQueuedStoryboard();
  db.completeStoryboardRunWithOutputs({
    runId: queued.id,
    outputs: [{
      blobPath: source.blob_path, sha256: '0'.repeat(64), mimeType: source.mime_type,
      width: source.width, height: source.height, byteSize: source.byte_size
    }]
  });
  const output = db.getStoryboardRun(queued.id).outputs[0];
  const response = await app.inject({ method: 'GET', url: `/api/v1/storyboard-outputs/${output.id}/content` });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'asset_integrity_mismatch');
});

test('StoryArk preserves exact replay, rejects a second run for the same panel, and queues other panels independently', async (t) => {
  const app = await harness(t, { storyarkEnabled: true });
  const first = await seed(app);
  const second = await seed(app);
  const payload = {
    projectId: 'project-1', referenceAssetId: first.reference.id, analysisId: first.analysis.id,
    imageSize: '1K', expectedResultCount: 1, removeBg: false
  };
  const accepted = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-active-first' }, payload
  });
  assert.equal(accepted.statusCode, 202);

  const replay = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-active-first' }, payload
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().run.id, accepted.json().run.id);

  const samePanel = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-same-panel-second-key' }, payload
  });
  assert.equal(samePanel.statusCode, 409);
  assert.equal(samePanel.json().error.code, 'panel_storyboard_run_active');
  assert.equal(app.p0.db.findStoryboardRunByIdempotencyKey('storyark-same-panel-second-key'), undefined);

  const independentlyQueued = await app.inject({
    method: 'POST', url: `/api/v1/panels/${second.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-active-second' },
    payload: { ...payload, referenceAssetId: second.reference.id, analysisId: second.analysis.id }
  });
  assert.equal(independentlyQueued.statusCode, 202);
  assert.equal(independentlyQueued.json().run.status, 'queued');
  assert.notEqual(independentlyQueued.json().run.id, accepted.json().run.id);
  assert.equal(app.p0.db.findStoryboardRunByIdempotencyKey('storyark-global-active-second').status, 'queued');
  assert.equal(app.p0.db.getStoryboardRunSafetySummary().activeRunCount, 2);
});

test('StoryArk unknown-cost hold blocks new paid work across batches but not exact replay', async (t) => {
  const app = await harness(t, { storyarkEnabled: true });
  const { db } = app.p0;
  const first = await seed(app);
  const second = await seed(app);
  const payload = {
    projectId: 'project-1', referenceAssetId: first.reference.id, analysisId: first.analysis.id,
    imageSize: '1K', expectedResultCount: 1, removeBg: false
  };
  const accepted = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-unknown-first' }, payload
  });
  assert.equal(accepted.statusCode, 202);
  db.failStoryboardRun({
    runId: accepted.json().run.id, code: 'unknown_outcome', message: 'safe fixture', costSource: 'unknown'
  });

  const replay = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-unknown-first' }, payload
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().run.id, accepted.json().run.id);

  const held = await app.inject({
    method: 'POST', url: `/api/v1/panels/${second.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-global-unknown-second' },
    payload: { ...payload, referenceAssetId: second.reference.id, analysisId: second.analysis.id }
  });
  assert.equal(held.statusCode, 409);
  assert.equal(held.json().error.code, 'cost_reconciliation_required');
  assert.equal(held.json().error.details.unknownAttemptCount, 1);
  assert.equal(db.findStoryboardRunByIdempotencyKey('storyark-global-unknown-second'), undefined);
});

test('StoryArk retains the per-batch requested-result cap after a prior task is terminal', async (t) => {
  const app = await harness(t, { storyarkEnabled: true, maxResultsPerBatch: 4 });
  const { db } = app.p0;
  const first = await seed(app);
  const second = db.addPanel({ batchId: first.batch.id, ordinal: 2, originalFilename: 'rough-2.png' });
  db.createAssetVersion({
    panelId: second.id, stage: 'source', blobPath: first.source.blob_path, sha256: first.source.sha256,
    mimeType: first.source.mime_type, width: first.source.width, height: first.source.height,
    byteSize: first.source.byte_size, status: 'approved', metadata: first.source.metadata
  });
  const secondSource = db.getCurrentAsset(second.id, 'source');
  const secondAnalysis = await createCompletedAnalysis(app, { panel: second, source: secondSource, reference: first.reference });
  const payload = { projectId: 'project-1', referenceAssetId: first.reference.id, analysisId: first.analysis.id, imageSize: '1K', expectedResultCount: 4, removeBg: false };
  const accepted = await app.inject({
    method: 'POST', url: `/api/v1/panels/${first.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-cap-first' }, payload
  });
  assert.equal(accepted.statusCode, 202);
  db.failStoryboardRun({
    runId: accepted.json().run.id, code: 'provider_tool_error', message: 'safe fixture', costSource: 'unpriced'
  });
  const limited = await app.inject({
    method: 'POST', url: `/api/v1/panels/${second.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-cap-second' },
    payload: { ...payload, analysisId: secondAnalysis.id, expectedResultCount: 1 }
  });
  assert.equal(limited.statusCode, 409);
  assert.equal(limited.json().error.code, 'storyboard_result_limit_reached');
  assert.equal(db.findStoryboardRunByIdempotencyKey('storyark-cap-second'), undefined,
    'The atomic quota rejection must not persist a partial storyboard run.');
});
