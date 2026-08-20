import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStageParameters, toolForStage } from '../src/domain.mjs';
import {
  fingerprintMiguoResultShape,
  MiguoProvider,
  MIGUO_FACTORY_CONNECTION_ID,
  MIGUO_FACTORY_CONTRACT_FINGERPRINT
} from '../src/providers/miguo.mjs';
import { sha256, stableJson } from '../src/security.mjs';
import {
  addPanelWithSource,
  createCandidate,
  createHarness,
  makePanelPng,
  processNext
} from './helpers.mjs';

const tools = [
  { name: 'line_art_beautify_v4', inputSchema: { type: 'object', required: ['image_url'] } },
  { name: 'coloring_v4', inputSchema: { type: 'object', required: ['input_image_url'] } },
  { name: 'shadowing_v7', inputSchema: { type: 'object', required: ['color_image_url'] } }
];

function response(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

async function fixtureUrlGuard(rawUrl, allowedHosts) {
  const url = new URL(rawUrl);
  assert.ok(allowedHosts.includes(url.hostname), `Unexpected fixture host: ${url.hostname}`);
  return url;
}

test('real-shaped outputPreviewImageUrls completes the light handoff from MiguoProvider through RunWorker', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('classic light handoff');
  const { panel, source } = await addPanelWithSource(harness, {
    batchId: batch.id,
    ordinal: 1,
    width: 320,
    height: 448,
    seed: 81
  });
  const inkCandidate = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 82
  });
  harness.db.promoteAsset(inkCandidate.id);
  const approvedInk = harness.db.getAsset(inkCandidate.id);
  const colorCandidate = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'color',
    inputs: [{ id: approvedInk.id, role: 'ink' }],
    width: source.width,
    height: source.height,
    seed: 83
  });
  harness.db.promoteAsset(colorCandidate.id);
  const approvedColor = harness.db.getAsset(colorCandidate.id);
  assert.equal(approvedInk.status, 'approved');
  assert.equal(approvedColor.status, 'approved');

  const uploadedColorUrl = 'https://outputs.example.com/frozen-color.png';
  const uploadedInkUrl = 'https://outputs.example.com/frozen-ink.png';
  const previewOutputUrl = 'https://outputs.example.com/complete-light-preview.png';
  const rawShadowUrl = 'https://outputs.example.com/raw-shadow-layer.png';
  const overlayUrl = 'https://outputs.example.com/shadow-overlay.png';
  const croppedUrl = 'https://outputs.example.com/cropped-shadow.png';
  const providerOutput = await makePanelPng({ width: source.width, height: source.height, seed: 84 });
  const toolResult = {
    _meta: { requestId: 'factory-light-request-1' },
    task_id: 'factory-light-task-1',
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        status: 2,
        colorImageUrl: uploadedColorUrl,
        lineArtImageUrl: uploadedInkUrl,
        outputPreviewImageUrls: [previewOutputUrl],
        outputShadowImageUrls: [rawShadowUrl],
        outputOverlayImageUrl: overlayUrl,
        outputCroppedShadowImages: [{ imageUrl: croppedUrl, x: 4, y: 6 }]
      })
    }]
  };
  const rpcMethods = [];
  const downloadedUrls = [];
  let uploadCalls = 0;

  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      assert.equal(init.method, 'POST');
      const uploadName = init.body.get('file').name;
      const uploadedUrl = uploadName === `${approvedColor.id}.png`
        ? uploadedColorUrl
        : uploadName === `${approvedInk.id}.png`
          ? uploadedInkUrl
          : null;
      assert.ok(uploadedUrl, `Unexpected upload fixture file: ${uploadName}`);
      uploadCalls += 1;
      return response({ data: { url: uploadedUrl } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadedUrls.push(url.href);
      assert.equal(url.href, previewOutputUrl, 'Only the complete preview may be ingested.');
      return new Response(providerOutput, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(providerOutput.length) }
      });
    }

    const payload = JSON.parse(init.body);
    rpcMethods.push(payload.method);
    if (payload.method === 'initialize') {
      return response({
        jsonrpc: '2.0',
        id: payload.id,
        result: { protocolVersion: '2025-06-18' }
      });
    }
    if (payload.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    }

    assert.equal(payload.method, 'tools/call');
    assert.equal(payload.params.name, 'shadowing_v7');
    assert.deepEqual(payload.params.arguments, {
      color_image_url: uploadedColorUrl,
      line_art_image_url: uploadedInkUrl,
      style: 'nvpin',
      color: 'nvpin_rule',
      light: 'top_left',
      shadow_strength: 0.5,
      channel: 'slow'
    });
    return response({
      jsonrpc: '2.0',
      id: payload.id,
      result: toolResult
    });
  };

  const provider = new MiguoProvider({
    config: {
      accountId: 'factory-light-handoff-fixture',
      apiToken: 'fixture-token-never-sent',
      mcpUrl: 'https://factory.miguocomics.com/api/mcp/v1',
      timeoutMs: 5_000,
      channel: 'slow',
      allowRealProvider: true,
      internalUseAcknowledged: true,
      outputHosts: ['outputs.example.com'],
      approvedToolSchemas: Object.fromEntries(
        tools.map((tool) => [tool.name, sha256(stableJson(tool.inputSchema))])
      )
    },
    assetService: harness.assetService,
    fetchImpl,
    urlGuard: fixtureUrlGuard
  });
  harness.worker.providers.miguo = provider;

  const frozenInputs = harness.db.getRequiredInputs(panel.id, 'light')
    .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  assert.deepEqual(frozenInputs, [
    { id: approvedColor.id, role: 'color', sha256: approvedColor.sha256 },
    { id: approvedInk.id, role: 'ink', sha256: approvedInk.sha256 }
  ]);
  const queued = harness.db.queueRun({
    panelId: panel.id,
    stage: 'light',
    provider: 'miguo',
    providerProfile: MIGUO_FACTORY_CONNECTION_ID,
    providerContractFingerprint: MIGUO_FACTORY_CONTRACT_FINGERPRINT,
    toolName: toolForStage('light'),
    params: defaultStageParameters('light'),
    idempotencyKey: 'classic-light-handoff:light:1',
    inputVersions: frozenInputs,
    pricingRevision: 'factory-p0-estimate-2026-08',
    estimatedCostPoints: 30,
    providerPhase: 'preflight'
  }).run;

  const completed = await processNext(harness, queued.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify({
    errorCode: completed.error_code,
    errorMessage: completed.error_message,
    providerPhase: completed.provider_phase
  }));
  assert.equal(completed.provider_profile, MIGUO_FACTORY_CONNECTION_ID);
  assert.equal(completed.provider_contract_fingerprint, MIGUO_FACTORY_CONTRACT_FINGERPRINT);
  assert.equal(completed.provider_request_id, 'factory-light-request-1');
  assert.equal(completed.provider_task_id, 'factory-light-task-1');
  assert.equal(completed.provider_result_shape_fingerprint, fingerprintMiguoResultShape(toolResult));
  assert.ok(completed.provider_result_observed_at);
  assert.equal(completed.provider_phase, 'completed');
  assert.equal(completed.cost_points, 30);
  assert.equal(completed.cost_source, 'estimate');
  assert.equal(completed.error_code, null);
  assert.deepEqual(completed.inputVersions, frozenInputs);

  const candidate = harness.db.getAsset(completed.output_asset_version_id);
  assert.ok(candidate);
  assert.equal(candidate.stage, 'light');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.parent_version_id, approvedColor.id);
  assert.equal(candidate.run_attempt_id, completed.id);
  assert.equal(candidate.width, approvedColor.width);
  assert.equal(candidate.height, approvedColor.height);
  assert.equal(harness.db.assetDependsOn(candidate.id, approvedColor.id, 'color'), true);
  assert.equal(harness.db.assetDependsOn(candidate.id, approvedInk.id, 'ink'), true);
  const frozenEdges = harness.db.db.prepare(`
    SELECT input_asset_version_id, role
    FROM derived_from_edges WHERE output_asset_version_id=?
    ORDER BY role, input_asset_version_id
  `).all(candidate.id).map((row) => ({ ...row }));
  assert.deepEqual(frozenEdges, [
    { input_asset_version_id: approvedColor.id, role: 'color' },
    { input_asset_version_id: approvedInk.id, role: 'ink' }
  ]);

  const beforePromotion = harness.db.getBatchDetails(batch.id);
  assert.equal(beforePromotion.panels[0].current.light, null);
  const promoted = harness.db.promoteAsset(candidate.id);
  assert.equal(promoted.changed, true);
  const afterPromotion = harness.db.getBatchDetails(batch.id);
  assert.equal(afterPromotion.panels[0].current.light.id, candidate.id);
  assert.equal(afterPromotion.panels[0].current.light.status, 'approved');
  assert.equal(afterPromotion.panels[0].current.light.run_attempt_id, completed.id);
  const persisted = await harness.assetService.read(afterPromotion.panels[0].current.light.blob_path);
  assert.equal(sha256(persisted), afterPromotion.panels[0].current.light.sha256);
  assert.deepEqual(await harness.assetService.metadata(afterPromotion.panels[0].current.light.blob_path), {
    width: approvedColor.width,
    height: approvedColor.height,
    format: 'png',
    mimeType: 'image/png'
  });

  assert.equal(uploadCalls, 2);
  assert.deepEqual(downloadedUrls, [previewOutputUrl]);
  assert.equal(rpcMethods.filter((method) => method === 'tools/call').length, 1);
});
