import { randomUUID } from 'node:crypto';

import { sha256 } from '../security.mjs';

const RETRYABLE_RECOVERY_CODES = new Set([
  'factory_read_failed', 'factory_history_unavailable', 'factory_task_pending',
  'factory_output_not_ready', 'factory_ledger_unavailable', 'factory_ledger_pending',
  'output_fetch_failed', 'recovery_response_too_large'
]);

const safeRecoveryMessage = (error) => {
  const code = typeof error?.code === 'string' ? error.code : 'automatic_recovery_failed';
  return `${code}: automatic read-only recovery could not finish this attempt.`.slice(0, 500);
};

const isRetryableRecovery = (error) => {
  if (typeof error?.retryableRecovery === 'boolean') return error.retryableRecovery;
  return RETRYABLE_RECOVERY_CODES.has(error?.code);
};

export class ClassicRecoveryWorker {
  constructor({ db, assetService, recoveryClient, pollMs = 1_000, leaseMs = 180_000, maxAttempts = 20 }) {
    this.db = db;
    this.assetService = assetService;
    this.recoveryClient = recoveryClient;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.leaseOwner = `classic-recovery:${randomUUID()}`;
    this.running = false;
    this.active = null;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.db.enqueuePendingClassicRecoveries();
    this.running = true;
    this.schedule(0);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled(this.active ? [this.active] : []);
  }

  schedule(delay = this.pollMs) {
    if (!this.running || this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    this.timer.unref?.();
  }

  tick() {
    if (!this.running || this.active) return this.schedule();
    const job = this.db.claimNextClassicRecovery({ leaseOwner: this.leaseOwner, leaseMs: this.leaseMs });
    if (!job) return this.schedule();
    const promise = this.process(job)
      .catch(() => {})
      .finally(() => {
        if (this.active === promise) this.active = null;
        this.schedule(0);
      });
    this.active = promise;
  }

  beginLeaseHeartbeat(runId) {
    let lost = null;
    let timer = null;
    const renew = () => {
      if (lost) throw lost;
      try {
        return this.db.renewClassicRecoveryLease({
          runId,
          leaseOwner: this.leaseOwner,
          leaseMs: this.leaseMs
        });
      } catch (error) {
        lost = error;
        if (timer) clearInterval(timer);
        timer = null;
        throw error;
      }
    };
    renew();
    timer = setInterval(() => {
      try { renew(); } catch { /* The next ownership check aborts all writes. */ }
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    return {
      ensureOwned: renew,
      stop: () => {
        if (timer) clearInterval(timer);
        timer = null;
      }
    };
  }

  async frozenInputs(run) {
    const inputs = [];
    for (const frozen of run.inputVersions) {
      const asset = this.db.getAsset(frozen.id);
      if (!asset || asset.sha256 !== frozen.sha256) {
        throw Object.assign(new Error('Frozen Studio input identity changed.'), { code: 'input_asset_mismatch' });
      }
      const bytes = await this.assetService.read(asset.blob_path);
      if (bytes.length !== asset.byte_size || sha256(bytes) !== asset.sha256) {
        throw Object.assign(new Error('Frozen Studio input failed its content integrity check.'), { code: 'asset_integrity_mismatch' });
      }
      inputs.push({ ...asset, role: frozen.role });
    }
    return inputs;
  }

  async process(job) {
    let heartbeat = null;
    try {
      heartbeat = this.beginLeaseHeartbeat(job.run_id);
      const run = this.db.getRun(job.run_id);
      if (!run) throw Object.assign(new Error('Run not found.'), { code: 'run_not_found' });
      if (['failed', 'succeeded'].includes(run.status) && run.cost_source !== 'unknown') {
        this.db.resolveClassicRecovery(run.id);
        return;
      }
      if (run.provider !== 'miguo' || !['failed', 'succeeded'].includes(run.status)
        || run.cost_source !== 'unknown') {
        throw Object.assign(new Error('Run is no longer eligible for automatic recovery.'), { code: 'run_not_recoverable' });
      }
      const panel = this.db.getPanel(run.panel_id);
      if (!panel) throw Object.assign(new Error('Panel not found.'), { code: 'panel_not_found' });
      const inputs = await this.frozenInputs(run);
      const primary = inputs[0];
      if (!primary) throw Object.assign(new Error('Frozen input set is empty.'), { code: 'input_asset_missing' });

      const recovered = await this.recoveryClient.recover({ run, inputs });
      heartbeat.ensureOwned();
      this.db.advanceClassicRecovery({
        runId: run.id,
        state: 'matched',
        leaseOwner: this.leaseOwner,
        matchedTaskId: recovered.providerTaskId
      });
      const outcome = recovered.outcome || 'succeeded';
      if (!['failed', 'succeeded'].includes(outcome)) {
        throw Object.assign(new Error('Factory recovery returned an unsupported terminal outcome.'), {
          code: 'factory_evidence_invalid'
        });
      }
      if (outcome === 'failed') {
        if (run.status !== 'failed') {
          throw Object.assign(new Error('Factory failure evidence conflicts with an existing successful Studio run.'), {
            code: 'factory_outcome_conflict'
          });
        }
        heartbeat.ensureOwned();
        this.db.reconcileClassicRunCost({
          runId: run.id,
          recoveryLeaseOwner: this.leaseOwner,
          idempotencyKey: `auto-recover-classic-failure:${run.id}:${recovered.providerTaskId}:v1`,
          providerTaskId: recovered.providerTaskId,
          costPoints: recovered.costPoints,
          costSource: recovered.costSource,
          note: 'Studio automatically reconciled the explicitly failed Factory task from read-only provider evidence.',
          evidenceReference: recovered.evidenceReference
        });
        this.db.resolveClassicRecovery(run.id);
        return;
      }
      if (run.status === 'succeeded') {
        heartbeat.ensureOwned();
        this.db.reconcileClassicRunCost({
          runId: run.id,
          recoveryLeaseOwner: this.leaseOwner,
          idempotencyKey: `auto-recover-classic-cost:${run.id}:${recovered.providerTaskId}:v1`,
          providerTaskId: recovered.providerTaskId,
          costPoints: recovered.costPoints,
          costSource: recovered.costSource,
          note: 'Studio automatically reconciled the accepted Factory task from read-only provider evidence.',
          evidenceReference: recovered.evidenceReference
        });
        this.db.resolveClassicRecovery(run.id);
        return;
      }
      this.db.advanceClassicRecovery({ runId: run.id, state: 'validating', leaseOwner: this.leaseOwner });
      const ingested = await this.assetService.ingestGeneratedBuffer(recovered.buffer, {
        batchId: panel.batch_id,
        panelId: panel.id,
        stage: run.stage,
        runId: run.id,
        expectedWidth: primary.width,
        expectedHeight: primary.height,
        providerMetadata: {
          provider: 'miguo',
          providerFamily: 'miguo',
          providerConnectionId: run.provider_profile,
          contractFingerprint: run.provider_contract_fingerprint,
          automaticallyRecoveredProviderOutput: true,
          providerTaskId: recovered.providerTaskId,
          providerTaskType: recovered.providerTaskType,
          providerTaskVersion: recovered.providerTaskVersion,
          providerOutputHost: recovered.outputHost,
          providerRawSha256: recovered.outputRawSha256
        }
      });
      heartbeat.ensureOwned();
      let candidate = this.db.findReusableCandidateForClassicRun(run.id, ingested.sha256);
      if (!candidate) {
        candidate = this.db.createAssetVersion({
          panelId: panel.id,
          stage: run.stage,
          parentVersionId: primary.id,
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
      }
      heartbeat.ensureOwned();
      this.db.advanceClassicRecovery({ runId: run.id, state: 'attaching', leaseOwner: this.leaseOwner });
      this.db.attachExistingOutputToClassicRun({
        runId: run.id,
        recoveryLeaseOwner: this.leaseOwner,
        outputAssetVersionId: candidate.id,
        idempotencyKey: `auto-recover-classic:${run.id}:${recovered.providerTaskId}:v1`,
        providerTaskId: recovered.providerTaskId,
        verifiedOutputHost: recovered.outputHost,
        verifiedOutputRawSha256: recovered.outputRawSha256,
        costPoints: recovered.costPoints,
        costSource: recovered.costSource,
        note: 'Studio automatically recovered the accepted Factory task with read-only evidence and no second generation call.',
        evidenceReference: recovered.evidenceReference
      });
      this.db.resolveClassicRecovery(run.id);
    } catch (error) {
      const retryable = isRetryableRecovery(error);
      const exhausted = Number(job.attempts || 0) >= this.maxAttempts;
      try {
        this.db.deferClassicRecovery({
          runId: job.run_id,
          code: error?.code || 'automatic_recovery_failed',
          message: safeRecoveryMessage(error),
          delayMs: retryable
            ? exhausted
              ? 300_000
              : Math.min(120_000, 5_000 * (2 ** Math.min(5, Math.max(0, Number(job.attempts || 1) - 1))))
            : 0,
          manualReview: !retryable,
          leaseOwner: this.leaseOwner
        });
      } catch {
        // Losing a lease is safe: another recovery worker owns the same unique
        // run job. Never fall back to another paid provider submission here.
      }
    } finally {
      heartbeat?.stop();
    }
  }
}
