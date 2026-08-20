import { performance } from 'node:perf_hooks';
import { STORYARK_CONNECTION_ID, STORYARK_CONTRACT_FINGERPRINT } from '../providers/storyark.mjs';
import {
  NANO_BANANA_CONTRACT_FINGERPRINT,
  NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION,
  NANO_BANANA_RAW_ROUTE_REVISION
} from '../providers/nano-banana.mjs';
import { sha256 } from '../security.mjs';
import { compositeSelectiveStoryboard, createSelectiveStoryboardEditMask } from './storyboard-composite.mjs';
import { normalizeProviderRawStoryboard } from './storyboard-output.mjs';

const POLL_DELAY_MS = 5_000;
const POLL_ERROR_BACKOFF_MS = 15_000;

function safeMessage(error) {
  const allowed = new Set([
    'auth_invalid', 'real_provider_blocked', 'provider_unavailable', 'rate_limited',
    'input_invalid', 'input_image_unreachable', 'network_timeout_retryable',
    'unknown_outcome', 'malformed_response', 'output_missing', 'output_fetch_failed',
    'output_too_large', 'unsafe_output_url', 'provider_tool_error', 'capability_missing',
    'capability_schema_drift', 'asset_integrity_mismatch',
    'storyboard_composite_plan_invalid', 'storyboard_composite_input_invalid',
    'storyboard_composite_geometry_mismatch',
    'storyboard_composite_output_invalid', 'storyboard_composite_mask_empty',
    'storyboard_composite_mask_too_broad', 'storyboard_composite_invariant_failed'
  ]);
  return allowed.has(error?.code)
    ? String(error.message || error.code).slice(0, 500)
    : 'The StoryArk task could not be completed safely.';
}

export class StoryboardWorker {
  constructor({ db, assetService, provider, providers = {}, concurrency = 1, pollMs = 500 }) {
    this.db = db;
    this.assetService = assetService;
    this.providers = { storyark: provider, ...providers };
    this.concurrency = Math.max(1, concurrency);
    this.pollMs = pollMs;
    this.running = false;
    this.active = new Set();
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.db.recoverInterruptedStoryboardRuns?.();
    this.schedule(0);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.active]);
  }

  schedule(delay = this.pollMs) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    this.timer.unref?.();
  }

  tick() {
    while (this.running && this.active.size < this.concurrency) {
      const run = this.db.claimNextProcessingStoryboard?.({ staleBefore: new Date(Date.now() - POLL_DELAY_MS).toISOString() })
        || this.db.claimNextQueuedStoryboard?.();
      if (!run) break;
      const promise = this.process(run)
        .catch(() => {})
        .finally(() => {
          this.active.delete(promise);
          this.schedule(0);
        });
      this.active.add(promise);
    }
    this.schedule();
  }

  async process(run) {
    const started = performance.now();
    const isPoll = run.status === 'processing';
    const renderProvider = run.request?.renderProvider === 'nano_banana_2' ? 'nano_banana_2' : 'storyark';
    const isNanoBanana = renderProvider === 'nano_banana_2';
    const routeRevision = run.request?.routeRevision || null;
    const isNanoRawRoute = isNanoBanana && routeRevision === NANO_BANANA_RAW_ROUTE_REVISION;
    const isNanoLegacyCompositeRoute = isNanoBanana
      && routeRevision === NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION;
    let providerCompleted = false;
    let resumableTaskId = run.provider_task_id || null;
    let nanoEditMask = null;
    try {
      const pinnedContract = isNanoBanana ? NANO_BANANA_CONTRACT_FINGERPRINT : STORYARK_CONTRACT_FINGERPRINT;
      if (run.provider_family !== 'miguo'
        || (isNanoBanana && run.provider_connection_id !== 'studio_relay_nano_banana_2')
        || (!isNanoBanana && run.provider_connection_id !== STORYARK_CONNECTION_ID)
        || run.contract_fingerprint !== pinnedContract) {
        throw Object.assign(new Error('This StoryArk run is pinned to an unsupported provider contract.'), {
          code: 'capability_schema_drift'
        });
      }
      if (isNanoBanana && !isNanoRawRoute && !isNanoLegacyCompositeRoute) {
        throw Object.assign(new Error('This Nano Banana 2 run is pinned to an unsupported delivery route.'), {
          code: 'capability_schema_drift'
        });
      }
      let result;
      if (isPoll) {
        if (isNanoBanana) {
          throw Object.assign(new Error('Nano Banana 2 does not expose a resumable polling task.'), { code: 'unknown_outcome' });
        }
        if (!run.provider_task_id) {
          throw Object.assign(new Error('StoryArk processing task has no provider task id.'), { code: 'malformed_response' });
        }
        result = await this.providers.storyark.getStoryboardTask(run.provider_task_id);
      } else {
        const source = this.db.getAsset(run.source_asset_version_id);
        const reference = this.db.getStoryboardReference(run.reference_asset_id);
        if (!source || !reference) {
          throw Object.assign(new Error('A storyboard input asset is missing.'), { code: 'input_image_unreachable' });
        }
        if (isNanoBanana) {
          const analysis = run.analysis_id ? this.db.getStoryboardAnalysis(run.analysis_id) : null;
          if (!analysis?.generationTarget || analysis.generation_source_asset_version_id !== source.id) {
            throw Object.assign(new Error('The frozen Nano Banana 2 selective-composite inputs are missing.'), {
              code: 'storyboard_composite_plan_invalid'
            });
          }
          const sourceBuffer = await this.assetService.read(source.blob_path);
          if (sha256(sourceBuffer) !== source.sha256) {
            throw Object.assign(new Error('The storyboard source failed its stored integrity check.'), {
              code: 'asset_integrity_mismatch'
            });
          }
          const editMask = await createSelectiveStoryboardEditMask({
            sourceBuffer,
            target: analysis.generationTarget
          });
          nanoEditMask = {
            ...editMask,
            sha256: sha256(editMask.buffer)
          };
          result = await this.providers.nanoBanana.renderStoryboard({
            sourceAsset: source,
            referenceAsset: reference,
            editMask: nanoEditMask.buffer,
            modificationNote: run.modification_note || '',
            idempotencyKey: run.idempotency_key
          });
        } else {
          result = await this.providers.storyark.submitStoryboard({
            projectId: run.project_id,
            storyboardAsset: source,
            referenceAsset: reference,
            imageSize: run.image_size,
            expectedResultCount: run.expected_result_count,
            removeBg: Boolean(run.remove_bg)
          });
        }
        providerCompleted = true;
      }

      resumableTaskId = result?.taskId || resumableTaskId;

      if (result.status === 'processing') {
        this.db.markStoryboardProcessing({
          runId: run.id,
          providerTaskId: result.taskId || run.provider_task_id,
          providerRequestId: result.providerRequestId || run.provider_request_id,
          costSource: 'unpriced'
        });
        return;
      }
      if (result.status === 'failed') {
        this.db.failStoryboardRun({
          runId: run.id,
          code: 'provider_tool_error',
          message: String(result.message || 'StoryArk reported that the task failed and its coins should be refunded.').slice(0, 500),
          providerTaskId: result.taskId || run.provider_task_id,
          providerRequestId: result.providerRequestId || run.provider_request_id,
          costSource: 'unpriced',
          durationMs: Math.round(performance.now() - started)
        });
        return;
      }
      const providerOutputs = isNanoBanana ? result.outputBuffers : result.outputUrls;
      if (result.status !== 'succeeded' || !Array.isArray(providerOutputs) || !providerOutputs.length) {
        throw Object.assign(new Error('StoryArk did not return a usable completed result.'), { code: 'output_missing' });
      }

      // Persist provider reconciliation identifiers before downloading temporary
      // signed URLs. A crash after provider acceptance can then resume by status
      // query instead of accidentally submitting a second paid generation.
      this.db.markStoryboardProcessing({
        runId: run.id,
        providerTaskId: result.taskId || run.provider_task_id,
        providerRequestId: result.providerRequestId || run.provider_request_id,
        costSource: 'unpriced'
      });
      resumableTaskId = result.taskId || run.provider_task_id || null;

      const panel = this.db.getPanel(run.panel_id);
      if (!panel) throw Object.assign(new Error('Panel not found.'), { code: 'panel_not_found' });
      const source = this.db.getAsset(run.source_asset_version_id);
      const reference = this.db.getStoryboardReference(run.reference_asset_id);
      const analysis = run.analysis_id ? this.db.getStoryboardAnalysis(run.analysis_id) : null;
      if (!source || !reference || (run.analysis_id && (!analysis?.generationTarget
        || analysis.generation_source_asset_version_id !== source.id))) {
        throw Object.assign(new Error('The frozen selective-composite inputs are missing.'), {
          code: 'storyboard_composite_plan_invalid'
        });
      }
      const targetUsesSelectiveComposite = [
        'storyark-full-page-selective-composite-v1',
        'storyboard-reference-instance-composite-v2'
      ].includes(analysis?.generationTarget?.strategy);
      const selectiveComposite = targetUsesSelectiveComposite
        && (!isNanoBanana || isNanoLegacyCompositeRoute);
      const sourceBuffer = selectiveComposite ? await this.assetService.read(source.blob_path) : null;
      if (sourceBuffer && sha256(sourceBuffer) !== source.sha256) {
        throw Object.assign(new Error('The storyboard source failed its stored integrity check.'), {
          code: 'asset_integrity_mismatch'
        });
      }
      const outputs = [];
      for (let index = 0; index < providerOutputs.length; index += 1) {
        const providerBuffer = isNanoBanana
          ? providerOutputs[index]
          : await this.providers.storyark.downloadOutput(providerOutputs[index]);
        const providerRaw = isNanoRawRoute ? await normalizeProviderRawStoryboard({
          providerBuffer,
          sourceWidth: source.width,
          sourceHeight: source.height
        }) : null;
        const composed = selectiveComposite ? await compositeSelectiveStoryboard({
          sourceBuffer,
          renderedBuffer: providerBuffer,
          target: analysis.generationTarget
        }) : null;
        const normalized = await this.assetService.normalizeUpload(
          providerRaw?.buffer || composed?.buffer || providerBuffer,
          {
          batchId: panel.batch_id,
          panelId: `storyboard-${run.id}-${index + 1}`,
          originalFilename: `storyark-${run.id}-${index + 1}.png`
          }
        );
        if ((selectiveComposite || isNanoRawRoute)
          && (normalized.width !== source.width || normalized.height !== source.height)) {
          throw Object.assign(
            new Error('The finished storyboard must keep the exact source canvas dimensions.'),
            { code: 'storyboard_composite_geometry_mismatch' }
          );
        }
        outputs.push({
          ordinal: index + 1,
          blobPath: normalized.relativePath,
          sha256: normalized.sha256,
          mimeType: normalized.mimeType,
          width: normalized.width,
          height: normalized.height,
          byteSize: normalized.byteSize,
          metadata: {
            ...normalized.metadata,
            providerFamily: 'miguo',
            providerConnectionId: isNanoBanana ? 'studio_relay_nano_banana_2' : 'storyark_v3',
            renderProvider,
            renderModel: isNanoBanana ? result.model : null,
            tool: isNanoBanana ? 'images/edits' : isPoll ? 'get_storyboard_task' : 'storyboard_inference',
            ...(providerRaw ? {
              deliveryMode: 'provider_raw_resize',
              postProcess: providerRaw.postProcess,
              routeRevision,
              sourceAssetVersionId: source.id,
              sourceSha256: source.sha256,
              referenceAssetId: reference.id,
              referenceSha256: reference.sha256,
              analysisId: analysis?.id || null,
              targetStrategy: analysis?.generationTarget?.strategy || null,
              maskSha256: nanoEditMask?.sha256 || null,
              maskRevision: nanoEditMask?.maskRevision || null,
              maskCoverage: nanoEditMask?.coverage ?? null,
              maskCoveredPixels: nanoEditMask?.coveredPixels ?? null,
              maskWidth: nanoEditMask?.width || null,
              maskHeight: nanoEditMask?.height || null,
              providerRawSha256: providerRaw.providerRawSha256,
              providerOriginalWidth: providerRaw.providerOriginalWidth,
              providerOriginalHeight: providerRaw.providerOriginalHeight,
              providerOriginalFormat: providerRaw.providerOriginalFormat,
              aspectRatioDelta: providerRaw.aspectRatioDelta,
              transform: providerRaw.transform,
              resizeFit: providerRaw.resizeFit,
              resizeKernel: providerRaw.resizeKernel,
              selectiveCompositeApplied: false,
              preservedOutsideMask: false,
              lineage: {
                routeRevision,
                sourceAssetVersionId: source.id,
                sourceSha256: source.sha256,
                referenceAssetId: reference.id,
                referenceSha256: reference.sha256,
                analysisId: analysis?.id || null,
                analysisInputFingerprint: analysis?.input_fingerprint || null,
                analysisPromptRevision: analysis?.prompt_revision || null,
                targetStrategy: analysis?.generationTarget?.strategy || null,
                maskSha256: nanoEditMask?.sha256 || null,
                maskRevision: nanoEditMask?.maskRevision || null,
                maskCoverage: nanoEditMask?.coverage ?? null,
                maskCoveredPixels: nanoEditMask?.coveredPixels ?? null,
                providerRawSha256: providerRaw.providerRawSha256
              }
            } : composed ? {
              postProcess: composed.compositeRevision,
              sourceAssetVersionId: source.id,
              sourceSha256: source.sha256,
              providerRenderedSha256: composed.renderedSha256,
              maskCoverage: composed.coverage,
              permissionCoverage: composed.permissionCoverage,
              maskCoveredPixels: composed.coveredPixels,
              changedPixels: composed.changedPixels,
              lineProtectedPixels: composed.lineProtectedPixels,
              providerEvidenceExpandedPixels: composed.providerEvidenceExpandedPixels,
              outsideMaskChangedPixels: composed.outsideMaskChangedPixels,
              appliedRegionOrder: composed.appliedRegions,
              selectiveCompositeApplied: true,
              preservedOutsideMask: true,
              targetStrategy: composed.targetStrategy,
              matchedCharacterInstanceCount: analysis.generationTarget.matchedCharacterInstanceCount || null,
              matchedElementCount: analysis.generationTarget.matchedElementCount
                || analysis.generationTarget.matchedRegionCount,
              matchedPartKindCounts: analysis.generationTarget.matchedPartKindCounts || null,
              incompleteMatchedInstanceCount: analysis.generationTarget.incompleteMatchedInstanceCount || 0,
              matchedRegionCount: analysis.generationTarget.matchedRegionCount,
              protectedRegionCount: analysis.generationTarget.protectedRegionCount
            } : { postProcess: 'legacy-direct-output' })
          }
        });
      }
      this.db.completeStoryboardRunWithOutputs({
        runId: run.id,
        outputs,
        providerTaskId: result.taskId || run.provider_task_id,
        providerRequestId: result.providerRequestId || run.provider_request_id,
        costSource: 'unpriced',
        durationMs: Math.round(performance.now() - started)
      });
    } catch (error) {
      const providerTaskId = error?.providerTaskId || resumableTaskId || run.provider_task_id || null;
      const providerRequestId = error?.providerRequestId || run.provider_request_id || null;
      const terminalPostProcess = String(error?.code || '').startsWith('storyboard_composite_')
        || error?.code === 'asset_integrity_mismatch';

      if (providerTaskId && terminalPostProcess) {
        this.db.failStoryboardRun({
          runId: run.id,
          code: error.code,
          message: safeMessage(error),
          providerTaskId,
          providerRequestId,
          costSource: 'unknown',
          durationMs: Math.round(performance.now() - started)
        });
        return;
      }

      // Once StoryArk has issued a task id, every status-query or local
      // post-processing failure is recoverable through that id. Poll errors are
      // deliberately non-terminal: only an explicit provider `failed` status
      // above may close a processing task.
      if (isPoll && providerTaskId) {
        this.db.markStoryboardPollingComplete({
          runId: run.id,
          providerTaskId,
          providerRequestId,
          costSource: run.cost_source || 'unpriced',
          pollAfterMs: POLL_ERROR_BACKOFF_MS
        });
        return;
      }
      if (providerTaskId && (providerCompleted || error?.providerAccepted === true || error?.billingOutcome === 'unknown')) {
        this.db.markStoryboardProcessing({
          runId: run.id,
          providerTaskId,
          providerRequestId,
          costSource: 'unpriced',
          nextPollAt: new Date(Date.now() + POLL_ERROR_BACKOFF_MS).toISOString()
        });
        return;
      }
      const unknown = (!isPoll && providerCompleted)
        || error?.providerAccepted === true
        || error?.billingOutcome === 'unknown'
        || ['unknown_outcome', 'output_missing', 'output_fetch_failed', 'output_too_large', 'malformed_response'].includes(error?.code);
      this.db.failStoryboardRun({
        runId: run.id,
        code: error?.code || 'internal_error',
        message: safeMessage(error),
        providerTaskId: error?.providerTaskId || run.provider_task_id,
        providerRequestId: error?.providerRequestId || run.provider_request_id,
        costSource: unknown ? 'unknown' : 'unpriced',
        durationMs: Math.round(performance.now() - started)
      });
    }
  }
}
