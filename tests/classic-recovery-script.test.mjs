import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { recoverClassicTask } from '../scripts/recover-classic-task.mjs';
import {
  addPanelWithSource, createCandidate, createHarness, makePanelPng, queueStage
} from './helpers.mjs';

test('classic recovery reads exact evidence and OSS assets, verifies input identity, and attaches without tools/call', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('read-only classic task recovery');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const ink = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 112
  });
  harness.db.promoteAsset(ink.id);
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'color',
    provider: 'miguo',
    idempotencyKey: 'classic-recovery-target-run'
  });
  harness.db.failRun({
    runId: run.id,
    code: 'output_missing',
    message: 'The legacy parser missed OutputImageUrls.',
    costSource: 'unknown',
    providerAccepted: true
  });

  const taskId = '019ffe66-f0d9-7d54-823d-2191eae1c7d2';
  const providerInput = await harness.assetService.read(ink.blob_path);
  const providerOutput = await makePanelPng({ width: ink.width, height: ink.height, seed: 113 });
  const inputUrl = 'https://oss.miguocomics.com/input.png?signed=input-secret';
  const outputUrl = 'https://oss.miguocomics.com/output.png?signed=output-secret';
  const requests = [];
  let factoryTaskType = 5;
  const jsonResponse = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    requests.push({ href: url.href, method: init.method, headers: init.headers || {} });
    if (url.pathname === `/api/task-history/v1/detail/${taskId}`) {
      return jsonResponse({
        code: 0,
        data: {
          taskId,
          type: factoryTaskType,
          version: 'v4',
          inferenceChannel: 1,
          meta: JSON.stringify({
            status: 2,
            progress: 100,
            inputImageUrl: inputUrl,
            compositedImageUrl: outputUrl,
            taskType: 0
          })
        }
      });
    }
    if (url.pathname === '/api/coins/v1/transactions/1') {
      assert.equal(url.search, '?pageSize=50&type=2');
      return jsonResponse({ data: { items: [{
        correlationId: taskId, amount: 0, type: 2, reason: 6, createAt: '2026-08-14T03:53:01Z'
      }] } });
    }
    if (url.href === inputUrl) return new Response(providerInput, { status: 200 });
    if (url.href === outputUrl) return new Response(providerOutput, { status: 200 });
    throw new Error(`Unexpected fixture URL ${url.origin}${url.pathname}`);
  };
  const runtimeConfig = {
    dataRoot: harness.root,
    databasePath: path.join(harness.root, 'p0.sqlite'),
    assetsRoot: harness.assetsRoot,
    exportsRoot: harness.exportsRoot,
    miguo: {
      accountId: 'fixture-account',
      apiToken: 'fixture-token',
      allowRealProvider: false,
      internalUseAcknowledged: false
    }
  };
  const recoveryOptions = {
    runtimeConfig,
    runId: run.id,
    taskId,
    fetchImpl,
    urlGuard: async (rawUrl, hosts) => {
      const url = new URL(rawUrl);
      assert.deepEqual(hosts, ['oss.miguocomics.com']);
      assert.equal(url.hostname, 'oss.miguocomics.com');
      return url;
    }
  };

  await assert.rejects(recoverClassicTask(recoveryOptions), (error) => (
    error.code === 'factory_task_mismatch'
  ), 'The authoritative outer Factory task type must still fail closed when it is not Coloring.');
  assert.equal(requests.length, 2, 'A task-type mismatch may read detail and ledger only.');
  assert.equal(requests.filter(({ href }) => href.startsWith('https://oss.miguocomics.com/')).length, 0,
    'A mismatched outer task type must be rejected before any provider asset download.');
  assert.equal(harness.db.getRun(run.id).status, 'failed');
  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 0);

  requests.length = 0;
  factoryTaskType = 2;
  const result = await recoverClassicTask({
    ...recoveryOptions,
    apply: true,
    confirmRunId: run.id
  });

  assert.equal(result.applied, true);
  assert.equal(result.confirmedCostPoints, 0);
  assert.equal(result.outputHost, 'oss.miguocomics.com');
  assert.equal(requests.length, 4);
  assert.equal(requests.filter(({ href }) => href.includes('/api/mcp/')).length, 0,
    'Recovery must never invoke MCP tools/call.');
  assert.equal(requests.filter(({ href }) => href.startsWith('https://factory.miguocomics.com/api/')).length, 2);
  assert.equal(requests.filter(({ href }) => href.startsWith('https://oss.miguocomics.com/')).length, 2);
  const recovered = harness.db.getRun(run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.provider_request_id, null);
  assert.equal(recovered.provider_task_id, taskId);
  assert.equal(recovered.cost_points, 0);
  assert.equal(recovered.cost_source, 'no_charge_confirmed');
  const output = harness.db.getAsset(recovered.output_asset_version_id);
  assert.equal(output.sha256, result.outputAssetSha256);
  assert.equal(output.metadata.providerOutputHost, 'oss.miguocomics.com');
  assert.equal(output.metadata.providerRawSha256, result.outputRawSha256);
  assert.doesNotMatch(JSON.stringify(output.metadata), /signed=|input-secret|output-secret/);
  const [event] = harness.db.listRunReconciliationEvents(run.id);
  assert.equal(event.output_host, 'oss.miguocomics.com');
  assert.equal(event.output_raw_sha256, result.outputRawSha256);
  assert.equal(event.output_asset_sha256, output.sha256);
  assert.equal(event.output_width, ink.width);
  assert.equal(event.output_height, ink.height);
  assert.equal(event.provider_request_id, null);
  assert.equal(event.provider_task_id, taskId);
  assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE panel_id = ?')
    .get(panel.id).count, 1, 'Recovery attaches an existing task and never creates another attempt.');
});

test('classic recovery audits and attaches an existing Factory type-5 lineart v4 output without regeneration', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('read-only lineart task recovery');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'classic-lineart-recovery-target-run'
  });
  harness.db.failRun({
    runId: run.id,
    code: 'output_missing',
    message: 'The legacy parser missed outputImageUrl.',
    costSource: 'unknown',
    providerAccepted: true
  });

  const taskId = '019ffe9e-765f-7849-8132-c1f524dbb99e';
  const providerInput = await harness.assetService.read(source.blob_path);
  const providerOutput = await makePanelPng({ width: source.width, height: source.height, seed: 131 });
  const inputUrl = 'https://oss.miguocomics.com/lineart-input.png?signed=input-secret';
  const outputUrl = 'https://oss.miguocomics.com/lineart-output.png?signed=output-secret';
  const facialUrl = 'https://oss.miguocomics.com/lineart-facial.png?signed=facial-secret';
  const requests = [];
  const jsonResponse = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    requests.push({ href: url.href, method: init.method, headers: init.headers || {} });
    if (url.pathname === `/api/task-history/v1/detail/${taskId}`) {
      return jsonResponse({
        code: 0,
        data: {
          taskId,
          type: 5,
          version: 'v4',
          inferenceChannel: 'slow',
          meta: JSON.stringify({
            status: 2,
            progress: 100,
            taskType: 5,
            inputImageUrl: inputUrl,
            outputImageUrl: outputUrl,
            outputFacialImageUrl: facialUrl
          })
        }
      });
    }
    if (url.pathname === '/api/coins/v1/transactions/1') {
      assert.equal(url.search, '?pageSize=50&type=2');
      return jsonResponse({ data: { items: [{
        correlationId: taskId, amount: 0, type: 2, reason: 6, createAt: '2026-08-14T04:48:00Z'
      }] } });
    }
    if (url.href === inputUrl) return new Response(providerInput, { status: 200 });
    if (url.href === outputUrl) return new Response(providerOutput, { status: 200 });
    throw new Error(`Unexpected fixture URL ${url.origin}${url.pathname}`);
  };
  const runtimeConfig = {
    dataRoot: harness.root,
    databasePath: path.join(harness.root, 'p0.sqlite'),
    assetsRoot: harness.assetsRoot,
    exportsRoot: harness.exportsRoot,
    miguo: {
      accountId: 'fixture-account',
      apiToken: 'fixture-token',
      allowRealProvider: false,
      internalUseAcknowledged: false
    }
  };
  const recoveryOptions = {
    runtimeConfig,
    runId: run.id,
    taskId,
    fetchImpl,
    urlGuard: async (rawUrl, hosts) => {
      const url = new URL(rawUrl);
      assert.deepEqual(hosts, ['oss.miguocomics.com']);
      assert.equal(url.hostname, 'oss.miguocomics.com');
      return url;
    }
  };

  const dryRun = await recoverClassicTask(recoveryOptions);
  assert.equal(dryRun.applied, false, 'Recovery must be dry-run by default.');
  assert.equal(dryRun.stage, 'ink');
  assert.equal(dryRun.toolName, 'line_art_beautify_v4');
  assert.equal(dryRun.taskType, 5);
  assert.equal(dryRun.taskVersion, 'v4');
  assert.equal(dryRun.taskStatus, 2);
  assert.equal(dryRun.confirmedCostPoints, 0);
  assert.equal(harness.db.getRun(run.id).status, 'failed');
  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 0);

  const result = await recoverClassicTask({
    ...recoveryOptions,
    apply: true,
    confirmRunId: run.id
  });
  assert.equal(result.applied, true);
  assert.equal(result.taskType, 5);
  assert.equal(result.outputHost, 'oss.miguocomics.com');
  assert.equal(requests.length, 8, 'Dry-run and apply each use exactly two evidence GETs and two OSS GETs.');
  assert.equal(requests.filter(({ href }) => href.includes('/api/mcp/')).length, 0,
    'Lineart recovery must never invoke MCP tools/call.');
  assert.equal(requests.filter(({ href }) => href === facialUrl).length, 0,
    'The optional facial split is not the main lineart output and must not be attached.');

  const recovered = harness.db.getRun(run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.stage, 'ink');
  assert.equal(recovered.tool_name, 'line_art_beautify_v4');
  assert.equal(recovered.provider_request_id, null);
  assert.equal(recovered.provider_task_id, taskId);
  assert.equal(recovered.cost_points, 0);
  assert.equal(recovered.cost_source, 'no_charge_confirmed');
  const output = harness.db.getAsset(recovered.output_asset_version_id);
  assert.equal(output.panel_id, panel.id);
  assert.equal(output.stage, 'ink');
  assert.equal(output.width, source.width);
  assert.equal(output.height, source.height);
  assert.equal(output.metadata.providerTaskType, 5);
  assert.equal(output.metadata.providerTaskVersion, 'v4');
  assert.equal(output.metadata.providerOutputHost, 'oss.miguocomics.com');
  assert.equal(output.metadata.providerRawSha256, result.outputRawSha256);
  assert.doesNotMatch(JSON.stringify(output.metadata), /signed=|input-secret|output-secret|facial-secret/);
  assert.equal(harness.db.assetDependsOn(output.id, source.id, 'source'), true,
    'Recovered lineart must retain the exact source provenance edge.');
  const [event] = harness.db.listRunReconciliationEvents(run.id);
  assert.equal(event.action, 'attach_existing_output');
  assert.equal(event.provider_task_id, taskId);
  assert.equal(event.output_asset_version_id, output.id);
  assert.equal(event.output_asset_sha256, output.sha256);
  assert.equal(event.output_raw_sha256, result.outputRawSha256);
  assert.equal(event.output_host, 'oss.miguocomics.com');
  assert.equal(event.reconciled_cost_points, 0);
  assert.equal(event.reconciled_cost_source, 'no_charge_confirmed');
  assert.match(event.evidence_reference, /lineart-v4;ledger:type2:reason6$/);
  assert.equal(harness.db.db.prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE panel_id = ?')
    .get(panel.id).count, 1, 'Recovery attaches the existing lineart task without another attempt.');
});

test('classic recovery fails closed when Factory task input bytes do not match the frozen Studio input', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('classic input mismatch');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const ink = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 121
  });
  harness.db.promoteAsset(ink.id);
  const run = queueStage(harness, {
    panelId: panel.id,
    stage: 'color',
    provider: 'miguo',
    idempotencyKey: 'classic-recovery-input-mismatch'
  });
  harness.db.failRun({
    runId: run.id,
    code: 'output_missing',
    message: 'fixture',
    costSource: 'unknown',
    providerAccepted: true
  });
  const taskId = '019ffe66-f0d9-7d54-823d-2191eae1c7d3';
  const wrongInput = await makePanelPng({ width: ink.width, height: ink.height, seed: 122 });
  const output = await makePanelPng({ width: ink.width, height: ink.height, seed: 123 });
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.startsWith('/api/task-history/v1/detail/')) return new Response(JSON.stringify({
      code: 0,
      data: {
        taskId, type: 2, version: 'v4', inferenceChannel: 'slow',
        meta: {
          status: 2,
          inputImageUrl: 'https://oss.miguocomics.com/wrong-input.png',
          compositedImageUrl: 'https://oss.miguocomics.com/output.png'
        }
      }
    }));
    if (url.pathname === '/api/coins/v1/transactions/1') return new Response(JSON.stringify({
      data: { items: [{ correlationId: taskId, amount: 0, type: 2, reason: 6 }] }
    }));
    if (url.pathname === '/wrong-input.png') return new Response(wrongInput);
    if (url.pathname === '/output.png') return new Response(output);
    throw new Error('Unexpected fixture request.');
  };
  const runtimeConfig = {
    dataRoot: harness.root,
    databasePath: path.join(harness.root, 'p0.sqlite'),
    assetsRoot: harness.assetsRoot,
    exportsRoot: harness.exportsRoot,
    miguo: {
      accountId: 'fixture-account', apiToken: 'fixture-token',
      allowRealProvider: false, internalUseAcknowledged: false
    }
  };
  await assert.rejects(recoverClassicTask({
    runtimeConfig,
    runId: run.id,
    taskId,
    apply: true,
    confirmRunId: run.id,
    fetchImpl,
    urlGuard: async (rawUrl) => new URL(rawUrl)
  }), (error) => error.code === 'factory_input_mismatch');
  const unchanged = harness.db.getRun(run.id);
  assert.equal(unchanged.status, 'failed');
  assert.equal(unchanged.cost_source, 'unknown');
  assert.equal(harness.db.listRunReconciliationEvents(run.id).length, 0);
});
