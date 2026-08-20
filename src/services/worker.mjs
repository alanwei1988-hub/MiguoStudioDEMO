import { performance } from 'node:perf_hooks';

export class RunWorker {
  constructor({ db, assetService, providers, concurrency = 2, pollMs = 250 }) {
    this.db = db;
    this.assetService = assetService;
    this.providers = providers;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.running = false;
    this.active = new Set();
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.db.recoverInterruptedRuns();
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
      const run = this.db.claimNextQueued();
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
    let providerCompleted = false;
    try {
      const panel = this.db.getPanel(run.panel_id);
      if (!panel) throw Object.assign(new Error('Panel not found.'), { code: 'panel_not_found' });
      const inputs = run.inputVersions.map(({ id, role }) => {
        const asset = this.db.getAsset(id);
        if (!asset) throw Object.assign(new Error(`Input asset ${id} not found.`), { code: 'input_asset_missing' });
        return { ...asset, role };
      });
      const provider = this.providers[run.provider];
      if (!provider) throw Object.assign(new Error(`Provider ${run.provider} is not configured.`), { code: 'provider_not_configured' });
      const result = await provider.execute({
        run,
        inputs,
        onProviderEvidence: run.provider === 'miguo'
          ? async (evidence) => this.db.recordProviderEvidence({ runId: run.id, ...evidence })
          : null
      });
      providerCompleted = true;
      const primary = inputs[0];
      const ingested = await this.assetService.ingestGeneratedBuffer(result.buffer, {
        batchId: panel.batch_id,
        panelId: panel.id,
        stage: run.stage,
        runId: run.id,
        expectedWidth: primary.width,
        expectedHeight: primary.height,
        providerMetadata: result.metadata
      });
      const asset = this.db.createAssetVersion({
        panelId: panel.id,
        stage: run.stage,
        parentVersionId: primary.id,
        runAttemptId: run.id,
        blobPath: ingested.relativePath,
        sha256: ingested.sha256,
        mimeType: ingested.mimeType,
        width: ingested.width,
        height: ingested.height,
        byteSize: ingested.byteSize,
        status: 'candidate',
        metadata: ingested.metadata,
        inputEdges: inputs.map((input) => ({ id: input.id, role: input.role }))
      });
      this.db.completeRun({
        runId: run.id,
        outputAssetVersionId: asset.id,
        providerRequestId: result.providerRequestId,
        providerTaskId: result.providerTaskId,
        resultShapeFingerprint: result.resultShapeFingerprint,
        costPoints: result.costPoints,
        costSource: result.costSource,
        durationMs: Math.round(performance.now() - started)
      });
    } catch (error) {
      const uncertainRealOutcome = run.provider === 'miguo' && (
        providerCompleted
        || error?.billingOutcome === 'unknown'
        || error?.providerAccepted === true
      );
      this.db.failRun({
        runId: run.id,
        code: error.code || 'internal_error',
        message: safeErrorMessage(error),
        durationMs: Math.round(performance.now() - started),
        costSource: uncertainRealOutcome ? 'unknown' : 'estimate',
        providerRequestId: error?.providerRequestId || null,
        providerTaskId: error?.providerTaskId || null,
        resultShapeFingerprint: error?.resultShapeFingerprint || null,
        providerAccepted: uncertainRealOutcome
      });
    }
  }
}

function safeErrorMessage(error) {
  const allowed = new Set([
    'auth_invalid', 'real_provider_blocked', 'provider_unavailable', 'rate_limited',
    'input_invalid', 'input_image_unreachable', 'network_timeout_retryable',
    'unknown_outcome', 'malformed_response', 'output_missing', 'output_fetch_failed',
    'output_too_large', 'geometry_mismatch', 'unsafe_output_url', 'provider_tool_error',
    'provider_not_configured', 'input_asset_missing', 'panel_not_found', 'asset_integrity_mismatch',
    'capability_schema_drift'
  ]);
  return allowed.has(error.code) ? String(error.message).slice(0, 500) : 'The task failed inside the P0 worker.';
}
