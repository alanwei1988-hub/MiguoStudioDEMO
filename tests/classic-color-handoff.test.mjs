import assert from 'node:assert/strict';
import test from 'node:test';

import { toolForStage } from '../src/domain.mjs';
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

test('real-shaped compositedImageUrl completes the color handoff from MiguoProvider through RunWorker', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('classic color handoff');
  const { panel, source } = await addPanelWithSource(harness, {
    batchId: batch.id,
    ordinal: 1,
    width: 320,
    height: 448,
    seed: 71
  });
  const inkCandidate = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 72
  });
  harness.db.promoteAsset(inkCandidate.id);
  const approvedInk = harness.db.getAsset(inkCandidate.id);
  assert.equal(approvedInk.status, 'approved');

  const uploadedInputUrl = 'https://outputs.example.com/frozen-ink.png';
  const compositedOutputUrl = 'https://outputs.example.com/composited-color.png';
  const providerOutput = await makePanelPng({ width: source.width, height: source.height, seed: 73 });
  const toolResult = {
    _meta: { requestId: 'factory-color-request-1' },
    task_id: 'factory-color-task-1',
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        status: 2,
        inputImageUrl: uploadedInputUrl,
        compositedImageUrl: compositedOutputUrl
      })
    }]
  };
  const rpcMethods = [];
  let uploadCalls = 0;
  let outputDownloadCalls = 0;

  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      uploadCalls += 1;
      assert.equal(init.method, 'POST');
      return response({ data: { url: uploadedInputUrl } });
    }
    if (url.href === compositedOutputUrl) {
      outputDownloadCalls += 1;
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
    assert.equal(payload.params.name, 'coloring_v4');
    assert.deepEqual(payload.params.arguments, {
      input_image_url: uploadedInputUrl,
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
      accountId: 'factory-color-handoff-fixture',
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

  const frozenInputs = harness.db.getRequiredInputs(panel.id, 'color')
    .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  assert.deepEqual(frozenInputs, [{ id: approvedInk.id, role: 'ink', sha256: approvedInk.sha256 }]);
  const queued = harness.db.queueRun({
    panelId: panel.id,
    stage: 'color',
    provider: 'miguo',
    providerProfile: MIGUO_FACTORY_CONNECTION_ID,
    providerContractFingerprint: MIGUO_FACTORY_CONTRACT_FINGERPRINT,
    toolName: toolForStage('color'),
    params: {},
    idempotencyKey: 'classic-color-handoff:color:1',
    inputVersions: frozenInputs,
    pricingRevision: 'factory-p0-estimate-2026-08',
    estimatedCostPoints: 30,
    providerPhase: 'preflight'
  }).run;

  const completed = await processNext(harness, queued.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.provider_profile, MIGUO_FACTORY_CONNECTION_ID);
  assert.equal(completed.provider_contract_fingerprint, MIGUO_FACTORY_CONTRACT_FINGERPRINT);
  assert.equal(completed.provider_request_id, 'factory-color-request-1');
  assert.equal(completed.provider_task_id, 'factory-color-task-1');
  assert.equal(completed.provider_result_shape_fingerprint, fingerprintMiguoResultShape(toolResult));
  assert.ok(completed.provider_result_observed_at);
  assert.equal(completed.provider_phase, 'completed');
  assert.equal(completed.cost_points, 30);
  assert.equal(completed.cost_source, 'estimate');
  assert.equal(completed.error_code, null);
  assert.deepEqual(completed.inputVersions, frozenInputs);

  const candidate = harness.db.getAsset(completed.output_asset_version_id);
  assert.ok(candidate);
  assert.equal(candidate.stage, 'color');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.parent_version_id, approvedInk.id);
  assert.equal(candidate.run_attempt_id, completed.id);
  assert.equal(candidate.width, approvedInk.width);
  assert.equal(candidate.height, approvedInk.height);
  assert.equal(harness.db.assetDependsOn(candidate.id, approvedInk.id, 'ink'), true);
  const frozenEdges = harness.db.db.prepare(`
    SELECT input_asset_version_id, role
    FROM derived_from_edges WHERE output_asset_version_id=?
    ORDER BY role, input_asset_version_id
  `).all(candidate.id).map((row) => ({ ...row }));
  assert.deepEqual(frozenEdges, [{ input_asset_version_id: approvedInk.id, role: 'ink' }]);

  const beforePromotion = harness.db.getBatchDetails(batch.id);
  assert.equal(beforePromotion.panels[0].current.color, null);
  const promoted = harness.db.promoteAsset(candidate.id);
  assert.equal(promoted.changed, true);
  const afterPromotion = harness.db.getBatchDetails(batch.id);
  assert.equal(afterPromotion.panels[0].current.color.id, candidate.id);
  assert.equal(afterPromotion.panels[0].current.color.status, 'approved');
  assert.equal(afterPromotion.panels[0].current.color.run_attempt_id, completed.id);
  const persisted = await harness.assetService.read(afterPromotion.panels[0].current.color.blob_path);
  assert.equal(sha256(persisted), afterPromotion.panels[0].current.color.sha256);
  assert.deepEqual(await harness.assetService.metadata(afterPromotion.panels[0].current.color.blob_path), {
    width: approvedInk.width,
    height: approvedInk.height,
    format: 'png',
    mimeType: 'image/png'
  });

  assert.equal(uploadCalls, 1);
  assert.equal(outputDownloadCalls, 1);
  assert.equal(rpcMethods.filter((method) => method === 'tools/call').length, 1);
});
