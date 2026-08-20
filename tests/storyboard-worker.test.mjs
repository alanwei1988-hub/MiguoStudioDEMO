import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { StoryboardWorker } from '../src/services/storyboard-worker.mjs';
import { STORYARK_CONTRACT_FINGERPRINT } from '../src/providers/storyark.mjs';
import {
  NANO_BANANA_CONTRACT_FINGERPRINT,
  NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION,
  NANO_BANANA_RAW_ROUTE_REVISION
} from '../src/providers/nano-banana.mjs';
import { sha256 } from '../src/security.mjs';
import { addPanelWithSource, createHarness, makePanelPng } from './helpers.mjs';

async function seedStoryboard(t) {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Story worker');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const referenceBuffer = await makePanelPng({ seed: 92 });
  const normalized = await harness.assetService.normalizeUpload(referenceBuffer, {
    batchId: batch.id, panelId: 'story-worker-reference', originalFilename: 'character.png'
  });
  const reference = harness.db.createStoryboardReference({
    batchId: batch.id, blobPath: normalized.relativePath, sha256: normalized.sha256,
    mimeType: normalized.mimeType, width: normalized.width, height: normalized.height,
    byteSize: normalized.byteSize, metadata: normalized.metadata
  });
  const queued = harness.db.queueStoryboardRun({
    panelId: panel.id,
    idempotencyKey: `story-worker-${Math.random()}`,
    contractFingerprint: STORYARK_CONTRACT_FINGERPRINT,
    projectId: 'project-1',
    sourceAssetVersionId: source.id,
    referenceAssetId: reference.id
  }).run;
  return { harness, batch, panel, source, reference, queued, outputBuffer: referenceBuffer };
}

async function seedNanoRun(t, { routeRevision, suffix }) {
  const fixture = await seedStoryboard(t);
  fixture.harness.db.cancelQueuedStoryboard(fixture.queued.id);
  const analysisRow = fixture.harness.db.queueStoryboardAnalysis({
    panelId: fixture.panel.id,
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    mode: 'single',
    modelName: 'gpt-5.6-terra',
    promptRevision: 'storyboard-selective-reference-color-v5',
    idempotencyKey: `nano-route-analysis-${suffix}`,
    inputFingerprint: `nano-route-fingerprint-${suffix}`
  }).analysis;
  fixture.harness.db.completeStoryboardAnalysis({
    analysisId: analysisRow.id,
    result: { schemaVersion: 'storyboard-analysis-v3', panels: [] }
  });
  const right = Math.round(fixture.source.width * 0.45);
  const bottom = Math.round(fixture.source.height * 0.45);
  const polygon = {
    normalized: [
      { x: 0.05, y: 0.05 }, { x: 0.45, y: 0.05 },
      { x: 0.45, y: 0.45 }, { x: 0.05, y: 0.45 }
    ],
    pixels: [
      { x: 16, y: 19 }, { x: right, y: 19 },
      { x: right, y: bottom }, { x: 16, y: bottom }
    ]
  };
  const analysis = fixture.harness.db.attachStoryboardAnalysisGenerationSource({
    analysisId: analysisRow.id,
    assetVersionId: fixture.source.id,
    target: {
      strategy: 'storyboard-reference-instance-composite-v2',
      sourceWidth: fixture.source.width,
      sourceHeight: fixture.source.height,
      matchedRegionCount: 1,
      protectedRegionCount: 0,
      regions: [{
        panelLocalId: 'panel-1', localId: 'character-1', kind: 'character', renderOrder: 1,
        polygons: [polygon]
      }],
      matchedInstances: [{ panelLocalId: 'panel-1', localId: 'character-1', polygons: [polygon] }],
      protectedRegions: []
    }
  });
  const run = fixture.harness.db.queueStoryboardRun({
    panelId: fixture.panel.id,
    idempotencyKey: `nano-route-run-${suffix}`,
    contractFingerprint: NANO_BANANA_CONTRACT_FINGERPRINT,
    projectId: 'studio:studio_relay_nano_banana_2',
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    analysisId: analysis.id,
    renderProvider: 'nano_banana_2',
    request: {
      renderProvider: 'nano_banana_2',
      renderModel: 'gemini-3.1-flash-image',
      routeRevision
    }
  }).run;
  return { ...fixture, analysis, run };
}

test('StoryArk worker persists a provider task id, polls it, and ingests signed outputs without resubmission', async (t) => {
  const fixture = await seedStoryboard(t);
  let submitCount = 0;
  let pollCount = 0;
  const provider = {
    async submitStoryboard() {
      submitCount += 1;
      return { status: 'processing', taskId: 'provider-task-1', outputUrls: [], providerRequestId: 'request-1' };
    },
    async getStoryboardTask(taskId) {
      pollCount += 1;
      assert.equal(taskId, 'provider-task-1');
      return { status: 'succeeded', taskId, outputUrls: ['https://fixture.invalid/output.png'], providerRequestId: 'request-1' };
    },
    async downloadOutput() { return fixture.outputBuffer; }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });
  const claimed = fixture.harness.db.claimNextQueuedStoryboard();
  await worker.process(claimed);
  let run = fixture.harness.db.getStoryboardRun(claimed.id);
  assert.equal(run.status, 'processing');
  assert.equal(run.provider_task_id, 'provider-task-1');

  await worker.process(run);
  run = fixture.harness.db.getStoryboardRun(claimed.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.outputs.length, 1);
  assert.equal(submitCount, 1);
  assert.equal(pollCount, 1);
  assert.equal((await fixture.harness.assetService.read(run.outputs[0].blob_path)).length > 0, true);
});

test('a download interruption after StoryArk acceptance remains resumable and never submits a second paid task', async (t) => {
  const fixture = await seedStoryboard(t);
  let submitCount = 0;
  let downloadCount = 0;
  const provider = {
    async submitStoryboard() {
      submitCount += 1;
      return {
        status: 'succeeded', taskId: 'provider-task-resume',
        outputUrls: ['https://fixture.invalid/output.png'], providerRequestId: 'request-resume'
      };
    },
    async getStoryboardTask(taskId) {
      return { status: 'succeeded', taskId, outputUrls: ['https://fixture.invalid/output.png'], providerRequestId: 'request-resume' };
    },
    async downloadOutput() {
      downloadCount += 1;
      if (downloadCount === 1) throw Object.assign(new Error('temporary'), { code: 'output_fetch_failed' });
      return fixture.outputBuffer;
    }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });
  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  let run = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(run.status, 'processing');
  assert.equal(run.provider_task_id, 'provider-task-resume');

  await worker.process(run);
  run = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(submitCount, 1);
  assert.equal(downloadCount, 2);
});

test('an interrupted StoryArk submission is frozen as unknown and is not automatically requeued', async (t) => {
  const fixture = await seedStoryboard(t);
  let calls = 0;
  const provider = {
    async submitStoryboard() {
      calls += 1;
      throw Object.assign(new Error('provider outcome unknown'), { code: 'unknown_outcome', billingOutcome: 'unknown' });
    }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });
  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  const run = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error_code, 'unknown_outcome');
  assert.equal(run.cost_source, 'unknown');
  assert.equal(calls, 1);
  assert.equal(fixture.harness.db.claimNextQueuedStoryboard(), undefined);
});

test('an accepted StoryArk submission with a recoverable task id never resubmits after result parsing fails', async (t) => {
  const fixture = await seedStoryboard(t);
  let submitCount = 0;
  let pollCount = 0;
  const provider = {
    async submitStoryboard() {
      submitCount += 1;
      throw Object.assign(new Error('bad output URL after acceptance'), {
        code: 'unsafe_output_url',
        providerAccepted: true,
        billingOutcome: 'unknown',
        providerTaskId: 'recoverable-task-after-submit',
        providerRequestId: 'recoverable-request-after-submit'
      });
    },
    async getStoryboardTask(taskId) {
      pollCount += 1;
      assert.equal(taskId, 'recoverable-task-after-submit');
      return {
        status: 'succeeded', taskId,
        outputUrls: ['https://fixture.invalid/output.png'],
        providerRequestId: 'recoverable-request-after-submit'
      };
    },
    async downloadOutput() { return fixture.outputBuffer; }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });

  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  let run = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(run.status, 'processing');
  assert.equal(run.provider_task_id, 'recoverable-task-after-submit');
  assert.equal(run.provider_request_id, 'recoverable-request-after-submit');

  await worker.process(run);
  run = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(submitCount, 1);
  assert.equal(pollCount, 1);
});

test('StoryArk poll errors stay processing with backoff until the provider explicitly reports failed', async (t) => {
  const fixture = await seedStoryboard(t);
  const errors = ['provider_unavailable', 'malformed_response', 'provider_tool_error'];
  let pollCount = 0;
  const provider = {
    async submitStoryboard() {
      return { status: 'processing', taskId: 'poll-error-task', outputUrls: [], providerRequestId: 'poll-error-request' };
    },
    async getStoryboardTask(taskId) {
      assert.equal(taskId, 'poll-error-task');
      const code = errors[pollCount];
      pollCount += 1;
      if (code) throw Object.assign(new Error(`fixture ${code}`), { code });
      return { status: 'failed', taskId, message: 'provider explicitly failed', providerRequestId: 'poll-error-request' };
    }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });

  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  for (const expectedCode of errors) {
    const before = Date.now();
    const processing = fixture.harness.db.getStoryboardRun(fixture.queued.id);
    assert.equal(processing.status, 'processing');
    await worker.process(processing);
    const after = fixture.harness.db.getStoryboardRun(fixture.queued.id);
    assert.equal(after.status, 'processing', `${expectedCode} must not terminate an accepted task`);
    assert.ok(Date.parse(after.next_poll_at) >= before + 10_000, 'poll failure should be backed off');
  }

  await worker.process(fixture.harness.db.getStoryboardRun(fixture.queued.id));
  const failed = fixture.harness.db.getStoryboardRun(fixture.queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'provider_tool_error');
  assert.equal(failed.cost_source, 'unpriced');
  assert.equal(pollCount, 4);
});

test('StoryArk worker composites a Terra-approved mask and preserves every outside pixel', async (t) => {
  const fixture = await seedStoryboard(t);
  fixture.harness.db.cancelQueuedStoryboard(fixture.queued.id);
  const analysisRow = fixture.harness.db.queueStoryboardAnalysis({
    panelId: fixture.panel.id,
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    mode: 'single',
    modelName: 'gpt-5.6-terra',
    promptRevision: 'storyboard-selective-reference-color-v5',
    idempotencyKey: 'selective-worker-analysis',
    inputFingerprint: 'selective-worker-fingerprint'
  }).analysis;
  fixture.harness.db.completeStoryboardAnalysis({
    analysisId: analysisRow.id,
    result: { schemaVersion: 'storyboard-analysis-v3', panels: [] }
  });
  const polygon = {
    normalized: [
      { x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.4, y: 0.4 }, { x: 0, y: 0.4 }
    ],
    pixels: [
      { x: 0, y: 0 }, { x: Math.round(fixture.source.width * 0.4), y: 0 },
      { x: Math.round(fixture.source.width * 0.4), y: Math.round(fixture.source.height * 0.4) },
      { x: 0, y: Math.round(fixture.source.height * 0.4) }
    ]
  };
  const analysis = fixture.harness.db.attachStoryboardAnalysisGenerationSource({
    analysisId: analysisRow.id,
    assetVersionId: fixture.source.id,
    target: {
      strategy: 'storyboard-reference-instance-composite-v2',
      sourceWidth: fixture.source.width,
      sourceHeight: fixture.source.height,
      matchedRegionCount: 1,
      protectedRegionCount: 0,
      regions: [{ panelLocalId: 'panel-1', localId: 'character-1', kind: 'character', renderOrder: 1, polygons: [polygon] }],
      matchedInstances: [{ panelLocalId: 'panel-1', localId: 'character-1', polygons: [polygon] }],
      protectedRegions: []
    }
  });
  const run = fixture.harness.db.queueStoryboardRun({
    panelId: fixture.panel.id,
    idempotencyKey: 'selective-worker-run',
    contractFingerprint: STORYARK_CONTRACT_FINGERPRINT,
    projectId: 'project-1',
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    analysisId: analysis.id
  }).run;
  const rendered = await sharp({
    create: {
      width: fixture.source.width,
      height: fixture.source.height,
      channels: 4,
      background: { r: 15, g: 140, b: 225, alpha: 1 }
    }
  }).png().toBuffer();
  let paidCalls = 0;
  const provider = {
    async submitStoryboard() {
      paidCalls += 1;
      return { status: 'succeeded', taskId: 'selective-task', outputUrls: ['https://fixture.invalid/result.png'] };
    },
    async downloadOutput() { return rendered; }
  };
  const worker = new StoryboardWorker({ db: fixture.harness.db, assetService: fixture.harness.assetService, provider });
  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  const completed = fixture.harness.db.getStoryboardRun(run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(paidCalls, 1);
  assert.equal(completed.outputs[0].metadata.postProcess, 'selective-reference-instance-chroma-lineart-v3');
  assert.equal(completed.outputs[0].metadata.preservedOutsideMask, true);

  const [sourceRaw, outputRaw] = await Promise.all([
    sharp(await fixture.harness.assetService.read(fixture.source.blob_path)).ensureAlpha().raw().toBuffer(),
    sharp(await fixture.harness.assetService.read(completed.outputs[0].blob_path)).ensureAlpha().raw().toBuffer()
  ]);
  const outsideOffset = ((fixture.source.height - 2) * fixture.source.width + (fixture.source.width - 2)) * 4;
  assert.deepEqual(
    [...outputRaw.subarray(outsideOffset, outsideOffset + 4)],
    [...sourceRaw.subarray(outsideOffset, outsideOffset + 4)],
    'an unmatched outside pixel must be identical to the original storyboard'
  );
});

test('Nano Banana 2 worker uses the Terra mask once and stores an exact-size full-page result', async (t) => {
  const fixture = await seedStoryboard(t);
  fixture.harness.db.cancelQueuedStoryboard(fixture.queued.id);
  const note = '校服用参考图的蓝色，其他区域不动';
  const analysisRow = fixture.harness.db.queueStoryboardAnalysis({
    panelId: fixture.panel.id,
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    mode: 'single',
    modelName: 'gpt-5.6-terra',
    promptRevision: 'storyboard-selective-reference-color-v5',
    modificationNote: note,
    idempotencyKey: 'nano-worker-analysis',
    inputFingerprint: 'nano-worker-analysis-fingerprint'
  }).analysis;
  fixture.harness.db.completeStoryboardAnalysis({
    analysisId: analysisRow.id,
    result: { schemaVersion: 'storyboard-analysis-v3', panels: [] }
  });
  const x = Math.round(fixture.source.width * 0.55);
  const y = Math.round(fixture.source.height * 0.55);
  const analysis = fixture.harness.db.attachStoryboardAnalysisGenerationSource({
    analysisId: analysisRow.id,
    assetVersionId: fixture.source.id,
    target: {
      strategy: 'storyboard-reference-instance-composite-v2',
      sourceWidth: fixture.source.width,
      sourceHeight: fixture.source.height,
      matchedRegionCount: 1,
      protectedRegionCount: 0,
      regions: [{
        panelLocalId: 'panel-1', localId: 'character-1', kind: 'character', renderOrder: 1,
        polygons: [{
          normalized: [{ x: 0.05, y: 0.05 }, { x: 0.55, y: 0.05 }, { x: 0.55, y: 0.55 }, { x: 0.05, y: 0.55 }],
          pixels: [{ x: 16, y: 19 }, { x, y: 19 }, { x, y }, { x: 16, y }]
        }]
      }],
      matchedInstances: [{
        panelLocalId: 'panel-1', localId: 'character-1',
        polygons: [{
          normalized: [{ x: 0.05, y: 0.05 }, { x: 0.55, y: 0.05 }, { x: 0.55, y: 0.55 }, { x: 0.05, y: 0.55 }],
          pixels: [{ x: 16, y: 19 }, { x, y: 19 }, { x, y }, { x: 16, y }]
        }]
      }],
      protectedRegions: []
    }
  });
  const run = fixture.harness.db.queueStoryboardRun({
    panelId: fixture.panel.id,
    idempotencyKey: 'nano-worker-run',
    contractFingerprint: NANO_BANANA_CONTRACT_FINGERPRINT,
    projectId: 'studio:studio_relay_nano_banana_2',
    sourceAssetVersionId: fixture.source.id,
    referenceAssetId: fixture.reference.id,
    analysisId: analysis.id,
    modificationNote: note,
    renderProvider: 'nano_banana_2',
    request: {
      renderProvider: 'nano_banana_2',
      renderModel: 'gemini-3.1-flash-image',
      routeRevision: NANO_BANANA_RAW_ROUTE_REVISION
    }
  }).run;
  const rendered = await sharp({
    create: {
      width: 640, height: 760, channels: 4,
      background: { r: 20, g: 110, b: 235, alpha: 1 }
    }
  }).png().toBuffer();
  let calls = 0;
  let submittedMaskSha256 = null;
  const nanoBanana = {
    async renderStoryboard(request) {
      calls += 1;
      assert.equal(request.modificationNote, note);
      assert.equal(Buffer.isBuffer(request.editMask), true);
      submittedMaskSha256 = sha256(request.editMask);
      return {
        status: 'succeeded', outputBuffers: [rendered],
        providerRequestId: 'nano-request-1', model: 'gemini-3.1-flash-image'
      };
    }
  };
  const worker = new StoryboardWorker({
    db: fixture.harness.db,
    assetService: fixture.harness.assetService,
    providers: { nanoBanana }
  });
  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  const completed = fixture.harness.db.getStoryboardRun(run.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify({
    code: completed.error_code,
    message: completed.error_message,
    costSource: completed.cost_source
  }));
  assert.equal(calls, 1);
  assert.equal(completed.provider_connection_id, 'studio_relay_nano_banana_2');
  assert.equal(completed.tool_name, 'images_edits');
  assert.equal(completed.outputs.length, 1);
  assert.equal(completed.outputs[0].width, fixture.source.width);
  assert.equal(completed.outputs[0].height, fixture.source.height);
  assert.equal(completed.outputs[0].metadata.renderProvider, 'nano_banana_2');
  assert.equal(completed.outputs[0].metadata.deliveryMode, 'provider_raw_resize');
  assert.equal(completed.outputs[0].metadata.postProcess, 'provider-raw-resize-v1');
  assert.equal(completed.outputs[0].metadata.providerOriginalWidth, 640);
  assert.equal(completed.outputs[0].metadata.providerOriginalHeight, 760);
  assert.equal(completed.outputs[0].metadata.providerOriginalFormat, 'png');
  assert.equal(completed.outputs[0].metadata.providerRawSha256, sha256(rendered));
  assert.equal(completed.outputs[0].metadata.maskSha256, submittedMaskSha256);
  assert.equal(completed.outputs[0].metadata.maskRevision, 'instance-permission-envelope-v3');
  assert.ok(completed.outputs[0].metadata.maskCoverage > 0);
  assert.ok(completed.outputs[0].metadata.maskCoveredPixels > 0);
  assert.equal(completed.outputs[0].metadata.maskWidth, fixture.source.width);
  assert.equal(completed.outputs[0].metadata.maskHeight, fixture.source.height);
  assert.equal(completed.outputs[0].metadata.resizeKernel, 'lanczos3');
  assert.equal(completed.outputs[0].metadata.selectiveCompositeApplied, false);
  assert.equal(completed.outputs[0].metadata.preservedOutsideMask, false);
  assert.equal(completed.outputs[0].metadata.lineage.routeRevision, NANO_BANANA_RAW_ROUTE_REVISION);
  assert.equal(completed.outputs[0].metadata.lineage.maskSha256, submittedMaskSha256);
  assert.equal(completed.outputs[0].metadata.lineage.maskRevision, 'instance-permission-envelope-v3');
  assert.equal(
    completed.outputs[0].metadata.lineage.maskCoverage,
    completed.outputs[0].metadata.maskCoverage
  );
  assert.equal(
    completed.outputs[0].metadata.lineage.maskCoveredPixels,
    completed.outputs[0].metadata.maskCoveredPixels
  );

  const outputPixel = await sharp(
    await fixture.harness.assetService.read(completed.outputs[0].blob_path)
  ).extract({
    left: fixture.source.width - 1,
    top: fixture.source.height - 1,
    width: 1,
    height: 1
  }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...outputPixel], [20, 110, 235], 'raw delivery must retain provider pixels outside the Terra mask');
});

test('a frozen legacy Nano Banana 2 route retains selective composition outside the Terra mask', async (t) => {
  const fixture = await seedNanoRun(t, {
    routeRevision: NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION,
    suffix: 'legacy'
  });
  const rendered = await sharp({
    create: {
      width: fixture.source.width,
      height: fixture.source.height,
      channels: 4,
      background: { r: 12, g: 130, b: 240, alpha: 1 }
    }
  }).png().toBuffer();
  let calls = 0;
  const worker = new StoryboardWorker({
    db: fixture.harness.db,
    assetService: fixture.harness.assetService,
    providers: {
      nanoBanana: {
        async renderStoryboard() {
          calls += 1;
          return {
            status: 'succeeded',
            outputBuffers: [rendered],
            providerRequestId: 'nano-legacy-request',
            model: 'gemini-3.1-flash-image'
          };
        }
      }
    }
  });

  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  const completed = fixture.harness.db.getStoryboardRun(fixture.run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(completed.outputs[0].metadata.selectiveCompositeApplied, true);
  assert.equal(completed.outputs[0].metadata.preservedOutsideMask, true);
  assert.equal(completed.outputs[0].metadata.deliveryMode, undefined);

  const [sourceRaw, outputRaw] = await Promise.all([
    sharp(await fixture.harness.assetService.read(fixture.source.blob_path)).ensureAlpha().raw().toBuffer(),
    sharp(await fixture.harness.assetService.read(completed.outputs[0].blob_path)).ensureAlpha().raw().toBuffer()
  ]);
  const outsideOffset = ((fixture.source.height - 2) * fixture.source.width + (fixture.source.width - 2)) * 4;
  assert.deepEqual(
    [...outputRaw.subarray(outsideOffset, outsideOffset + 4)],
    [...sourceRaw.subarray(outsideOffset, outsideOffset + 4)]
  );
});

test('an unknown Nano Banana 2 route fails before any provider request', async (t) => {
  const fixture = await seedNanoRun(t, {
    routeRevision: 'nano-banana-2-unknown-route',
    suffix: 'unknown'
  });
  let calls = 0;
  const worker = new StoryboardWorker({
    db: fixture.harness.db,
    assetService: fixture.harness.assetService,
    providers: {
      nanoBanana: {
        async renderStoryboard() {
          calls += 1;
          throw new Error('must not call provider');
        }
      }
    }
  });

  await worker.process(fixture.harness.db.claimNextQueuedStoryboard());
  const failed = fixture.harness.db.getStoryboardRun(fixture.run.id);
  assert.equal(calls, 0);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'capability_schema_drift');
  assert.equal(failed.cost_source, 'unpriced');
});
