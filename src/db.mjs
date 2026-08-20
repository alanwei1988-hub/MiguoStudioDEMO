import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { CURRENT_COLUMN, assertStage, downstreamStages, requiredInputStages } from './domain.mjs';

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? {});
const parseJson = (value, fallback = {}) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const WORKFLOW_TYPES = new Set(['comic_pipeline', 'reference_creation']);
const NON_RETRYABLE_RUN_ERRORS = new Set(['output_missing']);
const RECONCILED_COST_SOURCES = new Set([
  'provider_statement', 'provider_support', 'no_charge_confirmed'
]);
const CLASSIC_RECOVERY_STATES = new Set([
  'queued', 'locating', 'matched', 'polling', 'downloading', 'validating',
  'attaching', 'waiting', 'manual_review', 'resolved'
]);
const CLASSIC_RECOVERY_CLAIMABLE_STATES = new Set([
  'queued', 'locating', 'matched', 'polling', 'downloading', 'validating',
  'attaching', 'waiting'
]);
const FACTORY_OUTPUT_HOSTS = new Set(['factory.miguocomics.com', 'oss.miguocomics.com']);
const dbError = (message, code, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};
const workflowType = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!WORKFLOW_TYPES.has(normalized)) {
    throw dbError(
      'workflowType must be comic_pipeline or reference_creation.',
      'invalid_workflow_type',
      422
    );
  }
  return normalized;
};

const boundedText = (value, field, { minimum = 1, maximum = 500 } = {}) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw dbError(`${field} must be ${minimum}-${maximum} safe characters.`, 'invalid_reconciliation_evidence', 422);
  }
  return normalized;
};

const optionalProviderId = (value, field) => {
  if (value == null || value === '') return null;
  const normalized = boundedText(value, field, { minimum: 1, maximum: 200 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(normalized)) {
    throw dbError(`${field} has an invalid format.`, 'invalid_reconciliation_evidence', 422);
  }
  return normalized;
};

const reconciliationCost = (costPoints, costSource) => {
  const points = Number(costPoints);
  if (!Number.isFinite(points) || points < 0 || points > 1_000_000) {
    throw dbError('costPoints must be a finite non-negative number.', 'invalid_reconciliation_cost', 422);
  }
  if (!RECONCILED_COST_SOURCES.has(costSource)) {
    throw dbError('costSource must identify provider evidence or a confirmed no-charge outcome.', 'invalid_reconciliation_cost', 422);
  }
  if (costSource === 'no_charge_confirmed' && points !== 0) {
    throw dbError('A confirmed no-charge reconciliation must record zero points.', 'invalid_reconciliation_cost', 422);
  }
  return { costPoints: points, costSource };
};

const reconciliationRequestFingerprint = (value) => createHash('sha256')
  .update(json(value))
  .digest('hex');

const boundedInteger = (value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw dbError(`${field} must be an integer between ${minimum} and ${maximum}.`, 'invalid_recovery_request', 422);
  }
  return normalized;
};

const classicRecoveryState = (value, { claimableOnly = false } = {}) => {
  const states = claimableOnly ? CLASSIC_RECOVERY_CLAIMABLE_STATES : CLASSIC_RECOVERY_STATES;
  if (!states.has(value)) {
    throw dbError('Invalid classic recovery state.', 'invalid_recovery_state', 422);
  }
  return value;
};

const isoAfter = (milliseconds) => new Date(Date.now() + milliseconds).toISOString();

export class P0Database {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organization_memberships (
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','scheduler','member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(organization_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        workflow_type TEXT NOT NULL DEFAULT 'comic_pipeline'
          CHECK(workflow_type IN ('comic_pipeline','reference_creation')),
        owner_user_id TEXT REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS panels (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        original_filename TEXT NOT NULL,
        current_source_version_id TEXT,
        current_ink_version_id TEXT,
        current_color_version_id TEXT,
        current_light_version_id TEXT,
        selected_storyboard_output_id TEXT REFERENCES storyboard_outputs(id),
        deadline_at TEXT,
        deadline_updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        deadline_updated_at TEXT,
        submission_status TEXT NOT NULL DEFAULT 'draft' CHECK(submission_status IN ('draft','submitted')),
        submitted_at TEXT,
        submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        submitted_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        submitted_storyboard_output_id TEXT REFERENCES storyboard_outputs(id),
        submitted_asset_version_id TEXT REFERENCES asset_versions(id),
        deleted_at TEXT,
        deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS asset_versions (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('source','ink','color','light')),
        parent_version_id TEXT REFERENCES asset_versions(id),
        run_attempt_id TEXT,
        blob_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate','approved','superseded','stale')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS derived_from_edges (
        output_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
        input_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
        role TEXT NOT NULL,
        PRIMARY KEY(output_asset_version_id, input_asset_version_id, role)
      );

      CREATE TABLE IF NOT EXISTS run_attempts (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('ink','color','light')),
        provider TEXT NOT NULL,
        provider_profile TEXT,
        provider_contract_fingerprint TEXT,
        tool_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
        params_json TEXT NOT NULL DEFAULT '{}',
        input_versions_json TEXT NOT NULL DEFAULT '[]',
        output_asset_version_id TEXT REFERENCES asset_versions(id),
        provider_request_id TEXT,
        provider_task_id TEXT,
        provider_result_shape_fingerprint TEXT,
        provider_result_observed_at TEXT,
        cost_points REAL NOT NULL DEFAULT 0,
        cost_source TEXT NOT NULL DEFAULT 'estimate',
        pricing_revision TEXT,
        estimated_cost_points INTEGER NOT NULL DEFAULT 0,
        provider_phase TEXT NOT NULL DEFAULT 'preflight',
        duration_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        recovered_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS classic_recovery_jobs (
        id TEXT NOT NULL UNIQUE,
        run_id TEXT PRIMARY KEY REFERENCES run_attempts(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'queued'
          CHECK(state IN (
            'queued','locating','matched','polling','downloading','validating',
            'attaching','waiting','manual_review','resolved'
          )),
        reason_code TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        matched_task_id TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
        previous_asset_version_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('promote','restore')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_reconciliation_events (
        id TEXT PRIMARY KEY,
        run_attempt_id TEXT NOT NULL REFERENCES run_attempts(id),
        actor_user_id TEXT REFERENCES users(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('resolve_cost_only','attach_existing_output')),
        prior_status TEXT NOT NULL,
        prior_error_code TEXT,
        prior_cost_points REAL NOT NULL,
        prior_cost_source TEXT NOT NULL,
        output_asset_version_id TEXT REFERENCES asset_versions(id),
        output_asset_sha256 TEXT,
        output_raw_sha256 TEXT,
        output_host TEXT,
        output_width INTEGER,
        output_height INTEGER,
        provider_request_id TEXT,
        provider_task_id TEXT,
        result_shape_fingerprint TEXT,
        reconciled_cost_points REAL NOT NULL,
        reconciled_cost_source TEXT NOT NULL,
        note TEXT NOT NULL,
        evidence_reference TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS layout_exports (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        manifest_hash TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        pages_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(batch_id, manifest_hash)
      );

      CREATE TABLE IF NOT EXISTS storyboard_reference_assets (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        panel_id TEXT REFERENCES panels(id) ON DELETE SET NULL,
        uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        blob_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        version_number INTEGER,
        deleted_at TEXT,
        deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS storyboard_analyses (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        source_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
        reference_asset_id TEXT NOT NULL REFERENCES storyboard_reference_assets(id),
        mode TEXT NOT NULL CHECK(mode IN ('batch','single')),
        model_name TEXT NOT NULL,
        prompt_revision TEXT NOT NULL,
        modification_note TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        input_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        result_json TEXT,
        provider_response_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        generation_source_asset_version_id TEXT REFERENCES asset_versions(id),
        generation_target_json TEXT,
        error_code TEXT,
        error_message TEXT,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS storyboard_runs (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        provider_family TEXT NOT NULL DEFAULT 'miguo' CHECK(provider_family = 'miguo'),
        provider_connection_id TEXT NOT NULL DEFAULT 'storyark_v3'
          CHECK(provider_connection_id IN ('storyark_v3','studio_relay_nano_banana_2')),
        tool_name TEXT NOT NULL DEFAULT 'storyboard_inference'
          CHECK(tool_name IN ('storyboard_inference','images_edits')),
        contract_fingerprint TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','processing','succeeded','failed','cancelled')),
        project_id TEXT NOT NULL,
        image_size TEXT NOT NULL CHECK(image_size IN ('1K','2K','4K')),
        expected_result_count INTEGER NOT NULL CHECK(expected_result_count BETWEEN 1 AND 4),
        remove_bg INTEGER NOT NULL DEFAULT 0 CHECK(remove_bg IN (0,1)),
        source_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
        reference_asset_id TEXT NOT NULL REFERENCES storyboard_reference_assets(id),
        analysis_id TEXT REFERENCES storyboard_analyses(id),
        modification_note TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL DEFAULT '{}',
        provider_task_id TEXT,
        provider_request_id TEXT,
        cost_points REAL NOT NULL DEFAULT 0,
        cost_source TEXT NOT NULL DEFAULT 'unpriced',
        duration_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        recovered_count INTEGER NOT NULL DEFAULT 0,
        last_polled_at TEXT,
        next_poll_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS storyboard_outputs (
        id TEXT PRIMARY KEY,
        storyboard_run_id TEXT NOT NULL REFERENCES storyboard_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
        blob_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(storyboard_run_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS storyboard_output_selections (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        output_id TEXT NOT NULL REFERENCES storyboard_outputs(id),
        previous_output_id TEXT REFERENCES storyboard_outputs(id),
        selected_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT NOT NULL CHECK(reason IN ('generation_completed','user_selected')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS panel_submission_events (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        storyboard_output_id TEXT NOT NULL REFERENCES storyboard_outputs(id),
        submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        deadline_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS panel_asset_submission_events (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
        submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        deadline_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_panels_batch ON panels(batch_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_assets_panel_stage ON asset_versions(panel_id, stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON run_attempts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_panel_stage ON run_attempts(panel_id, stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_classic_recovery_due
        ON classic_recovery_jobs(state, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_classic_recovery_lease
        ON classic_recovery_jobs(lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_run_reconciliation_events_run
        ON run_reconciliation_events(run_attempt_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active
        ON run_attempts(panel_id, stage) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
        ON organization_memberships(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_storyboard_references_batch
        ON storyboard_reference_assets(batch_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_storyboard_analyses_panel
        ON storyboard_analyses(panel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_storyboard_analyses_status
        ON storyboard_analyses(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_storyboard_runs_status
        ON storyboard_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_storyboard_runs_panel
        ON storyboard_runs(panel_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_runs_one_active
        ON storyboard_runs(panel_id) WHERE status IN ('queued','running','processing');
      CREATE INDEX IF NOT EXISTS idx_storyboard_outputs_run
        ON storyboard_outputs(storyboard_run_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_storyboard_output_selections_panel
        ON storyboard_output_selections(panel_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS run_reconciliation_events_no_update
      BEFORE UPDATE ON run_reconciliation_events
      BEGIN
        SELECT RAISE(ABORT, 'run reconciliation events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS run_reconciliation_events_no_delete
      BEFORE DELETE ON run_reconciliation_events
      BEGIN
        SELECT RAISE(ABORT, 'run reconciliation events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS storyboard_output_selections_no_update
      BEFORE UPDATE ON storyboard_output_selections
      BEGIN
        SELECT RAISE(ABORT, 'storyboard output selections are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS storyboard_output_selections_no_delete
      BEFORE DELETE ON storyboard_output_selections
      BEGIN
        SELECT RAISE(ABORT, 'storyboard output selections are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS panel_submission_events_no_update
      BEFORE UPDATE ON panel_submission_events
      BEGIN
        SELECT RAISE(ABORT, 'panel submission events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS panel_submission_events_no_delete
      BEFORE DELETE ON panel_submission_events
      BEGIN
        SELECT RAISE(ABORT, 'panel submission events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS panel_asset_submission_events_no_update
      BEFORE UPDATE ON panel_asset_submission_events
      BEGIN
        SELECT RAISE(ABORT, 'panel asset submission events are append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS panel_asset_submission_events_no_delete
      BEFORE DELETE ON panel_asset_submission_events
      BEGIN
        SELECT RAISE(ABORT, 'panel asset submission events are append-only');
      END;
    `);
    const batchColumns = this.db.prepare('PRAGMA table_info(batches)').all();
    if (!batchColumns.some((column) => column.name === 'owner_user_id')) {
      this.db.exec('ALTER TABLE batches ADD COLUMN owner_user_id TEXT REFERENCES users(id)');
    }
    if (!batchColumns.some((column) => column.name === 'workflow_type')) {
      this.db.exec(`
        ALTER TABLE batches ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'comic_pipeline'
          CHECK(workflow_type IN ('comic_pipeline','reference_creation'))
      `);
    }
    const panelColumns = this.db.prepare('PRAGMA table_info(panels)').all();
    if (!panelColumns.some((column) => column.name === 'selected_storyboard_output_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN selected_storyboard_output_id TEXT REFERENCES storyboard_outputs(id)');
    }
    if (!panelColumns.some((column) => column.name === 'deadline_at')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN deadline_at TEXT');
    }
    if (!panelColumns.some((column) => column.name === 'deadline_updated_by_user_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN deadline_updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }
    if (!panelColumns.some((column) => column.name === 'deadline_updated_at')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN deadline_updated_at TEXT');
    }
    if (!panelColumns.some((column) => column.name === 'submission_status')) {
      this.db.exec("ALTER TABLE panels ADD COLUMN submission_status TEXT NOT NULL DEFAULT 'draft' CHECK(submission_status IN ('draft','submitted'))");
    }
    if (!panelColumns.some((column) => column.name === 'submitted_at')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN submitted_at TEXT');
    }
    if (!panelColumns.some((column) => column.name === 'submitted_by_user_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN submitted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }
    if (!panelColumns.some((column) => column.name === 'submitted_organization_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN submitted_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL');
    }
    if (!panelColumns.some((column) => column.name === 'submitted_storyboard_output_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN submitted_storyboard_output_id TEXT REFERENCES storyboard_outputs(id)');
    }
    if (!panelColumns.some((column) => column.name === 'submitted_asset_version_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN submitted_asset_version_id TEXT REFERENCES asset_versions(id)');
    }
    if (!panelColumns.some((column) => column.name === 'deleted_at')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN deleted_at TEXT');
    }
    if (!panelColumns.some((column) => column.name === 'deleted_by_user_id')) {
      this.db.exec('ALTER TABLE panels ADD COLUMN deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }
    const storyboardOutputColumns = this.db.prepare('PRAGMA table_info(storyboard_outputs)').all();
    if (!storyboardOutputColumns.some((column) => column.name === 'version_number')) {
      this.db.exec('ALTER TABLE storyboard_outputs ADD COLUMN version_number INTEGER');
    }
    if (!storyboardOutputColumns.some((column) => column.name === 'deleted_at')) {
      this.db.exec('ALTER TABLE storyboard_outputs ADD COLUMN deleted_at TEXT');
    }
    if (!storyboardOutputColumns.some((column) => column.name === 'deleted_by_user_id')) {
      this.db.exec('ALTER TABLE storyboard_outputs ADD COLUMN deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    }
    const legacyStoryboardOutputs = this.db.prepare(`
      SELECT o.id, r.panel_id
      FROM storyboard_outputs o
      JOIN storyboard_runs r ON r.id = o.storyboard_run_id
      WHERE o.version_number IS NULL
      ORDER BY r.panel_id, COALESCE(r.finished_at, r.created_at), r.created_at, o.ordinal, o.id
    `).all();
    if (legacyStoryboardOutputs.length) {
      const maxima = new Map(this.db.prepare(`
        SELECT r.panel_id, COALESCE(MAX(o.version_number), 0) AS maximum
        FROM storyboard_outputs o
        JOIN storyboard_runs r ON r.id = o.storyboard_run_id
        GROUP BY r.panel_id
      `).all().map((row) => [row.panel_id, Number(row.maximum || 0)]));
      const assignVersion = this.db.prepare('UPDATE storyboard_outputs SET version_number = ? WHERE id = ? AND version_number IS NULL');
      this.transaction(() => {
        for (const output of legacyStoryboardOutputs) {
          const versionNumber = (maxima.get(output.panel_id) || 0) + 1;
          maxima.set(output.panel_id, versionNumber);
          assignVersion.run(versionNumber, output.id);
        }
      });
    }
    this.db.exec(`
      UPDATE panels
         SET selected_storyboard_output_id = (
           SELECT o.id
             FROM storyboard_outputs o
             JOIN storyboard_runs r ON r.id = o.storyboard_run_id
            WHERE r.panel_id = panels.id AND r.status = 'succeeded'
            ORDER BY r.created_at DESC, o.ordinal ASC
            LIMIT 1
         )
       WHERE selected_storyboard_output_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM storyboard_outputs o
             JOIN storyboard_runs r ON r.id = o.storyboard_run_id
            WHERE r.panel_id = panels.id AND r.status = 'succeeded'
         )
    `);
    this.db.exec(`
      UPDATE batches SET workflow_type = 'comic_pipeline'
      WHERE workflow_type IS NULL OR workflow_type NOT IN ('comic_pipeline','reference_creation')
    `);
    const runAttemptColumns = this.db.prepare('PRAGMA table_info(run_attempts)').all();
    if (!runAttemptColumns.some((column) => column.name === 'provider_profile')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN provider_profile TEXT');
    }
    const storyboardRunColumns = this.db.prepare('PRAGMA table_info(storyboard_runs)').all();
    if (!storyboardRunColumns.some((column) => column.name === 'analysis_id')) {
      this.db.exec('ALTER TABLE storyboard_runs ADD COLUMN analysis_id TEXT REFERENCES storyboard_analyses(id)');
    }
    const storyboardAnalysisColumns = this.db.prepare('PRAGMA table_info(storyboard_analyses)').all();
    if (!storyboardAnalysisColumns.some((column) => column.name === 'generation_source_asset_version_id')) {
      this.db.exec('ALTER TABLE storyboard_analyses ADD COLUMN generation_source_asset_version_id TEXT REFERENCES asset_versions(id)');
    }
    if (!storyboardAnalysisColumns.some((column) => column.name === 'generation_target_json')) {
      this.db.exec('ALTER TABLE storyboard_analyses ADD COLUMN generation_target_json TEXT');
    }
    if (!storyboardAnalysisColumns.some((column) => column.name === 'modification_note')) {
      this.db.exec("ALTER TABLE storyboard_analyses ADD COLUMN modification_note TEXT NOT NULL DEFAULT ''");
    }
    if (!storyboardRunColumns.some((column) => column.name === 'modification_note')) {
      this.db.exec("ALTER TABLE storyboard_runs ADD COLUMN modification_note TEXT NOT NULL DEFAULT ''");
    }
    const storyboardRunDefinition = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'storyboard_runs'
    `).get()?.sql || '';
    if (storyboardRunDefinition.includes("CHECK(provider_connection_id = 'storyark_v3')")) {
      this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE storyboard_runs_v2 (
            id TEXT PRIMARY KEY,
            panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
            provider_family TEXT NOT NULL DEFAULT 'miguo' CHECK(provider_family = 'miguo'),
            provider_connection_id TEXT NOT NULL DEFAULT 'storyark_v3'
              CHECK(provider_connection_id IN ('storyark_v3','studio_relay_nano_banana_2')),
            tool_name TEXT NOT NULL DEFAULT 'storyboard_inference'
              CHECK(tool_name IN ('storyboard_inference','images_edits')),
            contract_fingerprint TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('queued','running','processing','succeeded','failed','cancelled')),
            project_id TEXT NOT NULL,
            image_size TEXT NOT NULL CHECK(image_size IN ('1K','2K','4K')),
            expected_result_count INTEGER NOT NULL CHECK(expected_result_count BETWEEN 1 AND 4),
            remove_bg INTEGER NOT NULL DEFAULT 0 CHECK(remove_bg IN (0,1)),
            source_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
            reference_asset_id TEXT NOT NULL REFERENCES storyboard_reference_assets(id),
            analysis_id TEXT REFERENCES storyboard_analyses(id),
            modification_note TEXT NOT NULL DEFAULT '',
            request_json TEXT NOT NULL DEFAULT '{}',
            provider_task_id TEXT,
            provider_request_id TEXT,
            cost_points REAL NOT NULL DEFAULT 0,
            cost_source TEXT NOT NULL DEFAULT 'unpriced',
            duration_ms INTEGER,
            error_code TEXT,
            error_message TEXT,
            recovered_count INTEGER NOT NULL DEFAULT 0,
            last_polled_at TEXT,
            next_poll_at TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
          );
          INSERT INTO storyboard_runs_v2 (
            id, panel_id, provider_family, provider_connection_id, tool_name,
            contract_fingerprint, idempotency_key, status, project_id, image_size,
            expected_result_count, remove_bg, source_asset_version_id, reference_asset_id,
            analysis_id, modification_note, request_json, provider_task_id, provider_request_id,
            cost_points, cost_source, duration_ms, error_code, error_message, recovered_count,
            last_polled_at, next_poll_at, created_at, started_at, finished_at
          )
          SELECT
            id, panel_id, COALESCE(provider_family, 'miguo'),
            COALESCE(provider_connection_id, 'storyark_v3'),
            COALESCE(tool_name, 'storyboard_inference'),
            contract_fingerprint, idempotency_key, status, project_id, image_size,
            expected_result_count, remove_bg, source_asset_version_id, reference_asset_id,
            analysis_id, COALESCE(modification_note, ''), COALESCE(request_json, '{}'),
            provider_task_id, provider_request_id, COALESCE(cost_points, 0),
            COALESCE(cost_source, 'unpriced'), duration_ms, error_code, error_message,
            COALESCE(recovered_count, 0), last_polled_at, next_poll_at,
            created_at, started_at, finished_at
          FROM storyboard_runs;
          DROP TABLE storyboard_runs;
          ALTER TABLE storyboard_runs_v2 RENAME TO storyboard_runs;
          COMMIT;
        `);
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
      const violations = this.db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error('The storyboard renderer migration failed its foreign-key integrity check.');
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_storyboard_runs_status
          ON storyboard_runs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_storyboard_runs_panel
          ON storyboard_runs(panel_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_runs_one_active
          ON storyboard_runs(panel_id) WHERE status IN ('queued','running','processing');
      `);
    }
    if (!runAttemptColumns.some((column) => column.name === 'provider_contract_fingerprint')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN provider_contract_fingerprint TEXT');
    }
    if (!runAttemptColumns.some((column) => column.name === 'pricing_revision')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN pricing_revision TEXT');
    }
    if (!runAttemptColumns.some((column) => column.name === 'estimated_cost_points')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN estimated_cost_points INTEGER NOT NULL DEFAULT 0');
    }
    if (!runAttemptColumns.some((column) => column.name === 'provider_phase')) {
      this.db.exec("ALTER TABLE run_attempts ADD COLUMN provider_phase TEXT NOT NULL DEFAULT 'preflight'");
    }
    if (!runAttemptColumns.some((column) => column.name === 'provider_task_id')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN provider_task_id TEXT');
    }
    if (!runAttemptColumns.some((column) => column.name === 'provider_result_shape_fingerprint')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN provider_result_shape_fingerprint TEXT');
    }
    if (!runAttemptColumns.some((column) => column.name === 'provider_result_observed_at')) {
      this.db.exec('ALTER TABLE run_attempts ADD COLUMN provider_result_observed_at TEXT');
    }
    this.db.exec(`
      UPDATE run_attempts SET provider_profile = CASE
        WHEN provider = 'miguo' THEN 'factory_classic'
        WHEN provider = 'mock' THEN 'mock'
        ELSE provider
      END WHERE provider_profile IS NULL;
      UPDATE run_attempts SET provider_phase = 'preflight' WHERE provider_phase IS NULL;
    `);
    if (!storyboardRunColumns.some((column) => column.name === 'last_polled_at')) {
      this.db.exec('ALTER TABLE storyboard_runs ADD COLUMN last_polled_at TEXT');
    }
    if (!storyboardRunColumns.some((column) => column.name === 'next_poll_at')) {
      this.db.exec('ALTER TABLE storyboard_runs ADD COLUMN next_poll_at TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_batches_owner ON batches(owner_user_id, created_at DESC)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_batches_workflow_owner ON batches(workflow_type, owner_user_id, created_at DESC)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_storyboard_runs_poll ON storyboard_runs(status, next_poll_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_panels_submission_org ON panels(submitted_organization_id, submission_status, submitted_at DESC)');
    const usersWithoutOrganization = this.db.prepare(`
      SELECT u.id, u.display_name FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id
      WHERE m.user_id IS NULL
    `).all();
    for (const user of usersWithoutOrganization) {
      this.ensurePersonalOrganization(user.id, user.display_name);
    }
  }

  close() { this.db.close(); }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  countUsers() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").get().count);
  }

  createUser({ email, displayName, passwordHash, passwordSalt, role = 'member' }) {
    const id = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO users (id, email, display_name, password_hash, password_salt, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, email, displayName, passwordHash, passwordSalt, role, timestamp, timestamp);
      this.ensurePersonalOrganization(id, displayName);
    });
    return this.getUser(id);
  }

  ensurePersonalOrganization(userId, displayName = '用户') {
    const existing = this.getOrganizationForUser(userId);
    if (existing) return existing;
    const organizationId = randomUUID();
    const timestamp = now();
    const name = `${String(displayName || '用户').trim().slice(0, 80) || '用户'}的工作室`;
    this.db.prepare(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).run(organizationId, name, timestamp, timestamp);
    this.db.prepare(`
      INSERT INTO organization_memberships (
        organization_id, user_id, role, status, joined_at, updated_at
      ) VALUES (?, ?, 'owner', 'active', ?, ?)
    `).run(organizationId, userId, timestamp, timestamp);
    return this.getOrganizationForUser(userId);
  }

  getOrganizationForUser(userId) {
    return this.db.prepare(`
      SELECT o.id, o.name, m.role AS membership_role, m.status AS membership_status
      FROM organization_memberships m
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? AND m.status = 'active' AND o.status = 'active'
    `).get(userId);
  }

  listOrganizations() {
    return this.db.prepare(`
      SELECT o.id, o.name, o.status, o.created_at, o.updated_at,
        COUNT(CASE WHEN m.status = 'active' THEN 1 END) AS member_count
      FROM organizations o
      LEFT JOIN organization_memberships m ON m.organization_id = o.id
      GROUP BY o.id ORDER BY o.created_at DESC
    `).all();
  }

  getAdminDashboardSnapshot() {
    const users = this.db.prepare(`
      SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
        o.id AS organization_id, o.name AS organization_name, m.role AS organization_role
      FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      LEFT JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      ORDER BY COALESCE(u.last_login_at, u.created_at) DESC
    `).all();
    const classicRuns = this.db.prepare(`
      SELECT r.id, r.status, r.stage, r.provider, r.cost_points, r.cost_source,
        r.estimated_cost_points, r.created_at, r.started_at, r.finished_at,
        b.owner_user_id, b.name AS batch_name
      FROM run_attempts r
      JOIN panels p ON p.id = r.panel_id
      JOIN batches b ON b.id = p.batch_id
      ORDER BY r.created_at DESC
    `).all();
    const storyboardRuns = this.db.prepare(`
      SELECT r.id, r.status, r.provider_connection_id, r.cost_points, r.cost_source,
        r.created_at, r.started_at, r.finished_at, b.owner_user_id, b.name AS batch_name
      FROM storyboard_runs r
      JOIN panels p ON p.id = r.panel_id
      JOIN batches b ON b.id = p.batch_id
      ORDER BY r.created_at DESC
    `).all();
    const analysis = this.db.prepare(`
      SELECT status, model_name, input_tokens, output_tokens, total_tokens,
        requested_by_user_id, created_at, finished_at
      FROM storyboard_analyses ORDER BY created_at DESC
    `).all();
    const submissions = this.db.prepare(`
      SELECT submitted_organization_id AS organization_id, COUNT(*) AS count,
        MAX(submitted_at) AS last_submitted_at
      FROM panels
      WHERE submission_status = 'submitted' AND submitted_organization_id IS NOT NULL
      GROUP BY submitted_organization_id
    `).all();
    return {
      organizations: this.listOrganizations(),
      users,
      classicRuns,
      storyboardRuns,
      analysis,
      submissions
    };
  }

  createOrganization(name) {
    const normalized = String(name || '').trim();
    if (!normalized || normalized.length > 120) throw dbError('Organization name is required.', 'organization_name_invalid', 422);
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, normalized, timestamp, timestamp);
    return this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
  }

  assignUserToOrganization({ userId, organizationId, role = 'member' }) {
    if (!['owner', 'scheduler', 'member'].includes(role)) throw dbError('Invalid organization role.', 'organization_role_invalid', 422);
    const user = this.getUser(userId);
    const organization = this.db.prepare("SELECT * FROM organizations WHERE id = ? AND status = 'active'").get(organizationId);
    if (!user || !organization) throw dbError('Organization or user not found.', 'resource_not_found', 404);
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM organization_memberships WHERE user_id = ?').run(userId);
      this.db.prepare(`
        INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(organizationId, userId, role, timestamp, timestamp);
    });
    return this.getOrganizationForUser(userId);
  }

  getUser(id) {
    return this.db.prepare(`
      SELECT u.*, o.id AS organization_id, o.name AS organization_name,
        m.role AS organization_role
      FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      LEFT JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE u.id = ?
    `).get(id);
  }

  findUserByEmail(email) {
    return this.db.prepare(`
      SELECT u.*, o.id AS organization_id, o.name AS organization_name,
        m.role AS organization_role
      FROM users u
      LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      LEFT JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE u.email = ? COLLATE NOCASE
    `).get(email);
  }

  recordUserLogin(id) {
    const timestamp = now();
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, id);
  }

  upsertAdmin({ email, displayName, passwordHash, passwordSalt }) {
    const existing = this.findUserByEmail(email);
    const timestamp = now();
    if (existing) {
      this.db.prepare(`
        UPDATE users SET display_name = ?, password_hash = ?, password_salt = ?, role = 'admin',
          status = 'active', updated_at = ? WHERE id = ?
      `).run(displayName, passwordHash, passwordSalt, timestamp, existing.id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      return this.getUser(existing.id);
    }
    return this.createUser({ email, displayName, passwordHash, passwordSalt, role: 'admin' });
  }

  createSession({ id, userId, tokenHash, csrfToken, expiresAt }) {
    const timestamp = now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(timestamp);
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, csrfToken, timestamp, expiresAt, timestamp);
  }

  getSessionByTokenHash(tokenHash) {
    const timestamp = now();
    const session = this.db.prepare(`
      SELECT s.id AS session_id, s.token_hash, s.csrf_token, s.expires_at,
        u.id, u.email, u.display_name, u.role, u.status,
        o.id AS organization_id, o.name AS organization_name,
        m.role AS organization_role
      FROM sessions s JOIN users u ON u.id = s.user_id
      LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.status = 'active'
      LEFT JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'
    `).get(tokenHash, timestamp);
    if (session) this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(timestamp, session.session_id);
    return session;
  }

  deleteSessionByTokenHash(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  createBatch(name, ownerUserId = null, requestedWorkflowType = 'comic_pipeline') {
    const id = randomUUID();
    const timestamp = now();
    const normalizedWorkflowType = workflowType(requestedWorkflowType);
    this.db.prepare(`
      INSERT INTO batches (id, name, workflow_type, owner_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name.trim() || `P0 批次 ${timestamp.slice(0, 10)}`,
      normalizedWorkflowType,
      ownerUserId,
      timestamp,
      timestamp
    );
    return this.getBatchRecord(id);
  }

  getBatchRecord(id) {
    return this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  }

  listBatches({ ownerUserId = null, includeAll = true, workflowType: requestedWorkflowType = null } = {}) {
    const clauses = [];
    const parameters = [];
    if (!includeAll) {
      clauses.push('b.owner_user_id = ?');
      parameters.push(ownerUserId);
    }
    if (requestedWorkflowType != null) {
      clauses.push('b.workflow_type = ?');
      parameters.push(workflowType(requestedWorkflowType));
    }
    const statement = `
      SELECT b.*,
        COUNT(DISTINCT CASE WHEN p.deleted_at IS NULL THEN p.id END) AS panel_count,
        COALESCE(SUM(CASE WHEN r.status <> 'cancelled' THEN r.cost_points ELSE 0 END), 0) AS cost_points,
        SUM(CASE WHEN r.status IN ('queued','running') THEN 1 ELSE 0 END) AS active_runs,
        SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        SUM(CASE WHEN r.cost_source = 'unknown' THEN 1 ELSE 0 END) AS unknown_cost_attempts
      FROM batches b
      LEFT JOIN panels p ON p.batch_id = b.id
      LEFT JOIN run_attempts r ON r.panel_id = p.id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `;
    return this.db.prepare(statement).all(...parameters);
  }

  addPanel({ id = randomUUID(), batchId, ordinal, originalFilename }) {
    if (!this.getBatchRecord(batchId)) throw new Error('Batch not found.');
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO panels (id, batch_id, ordinal, original_filename, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, batchId, ordinal, originalFilename, timestamp, timestamp);
    return this.getPanel(id);
  }

  addPanelsWithSourcesAtomic(items) {
    if (!Array.isArray(items) || !items.length) return [];
    return this.transaction(() => {
      const created = [];
      for (const item of items) {
        const { panelId = randomUUID(), batchId, ordinal, originalFilename, source } = item;
        if (!this.getBatchRecord(batchId)) {
          const error = new Error('Batch not found.');
          error.code = 'batch_not_found';
          error.statusCode = 404;
          throw error;
        }
        const timestamp = now();
        this.db.prepare(`
          INSERT INTO panels (id, batch_id, ordinal, original_filename, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(panelId, batchId, ordinal, originalFilename, timestamp, timestamp);
        const assetId = randomUUID();
        this.db.prepare(`
          INSERT INTO asset_versions (
            id, panel_id, stage, parent_version_id, run_attempt_id, blob_path, sha256,
            mime_type, width, height, byte_size, status, metadata_json, created_at
          ) VALUES (?, ?, 'source', NULL, NULL, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
        `).run(
          assetId,
          panelId,
          source.blobPath,
          source.sha256,
          source.mimeType,
          source.width,
          source.height,
          source.byteSize,
          json(source.metadata),
          timestamp
        );
        this.db.prepare(`
          UPDATE panels SET current_source_version_id = ?, updated_at = ? WHERE id = ?
        `).run(assetId, timestamp, panelId);
        created.push({ panelId, assetId });
      }
      return created.map(({ panelId, assetId }) => ({
        panel: this.getPanelSnapshot(panelId),
        source: this.getAsset(assetId)
      }));
    });
  }

  getPanel(id) {
    return this.db.prepare('SELECT * FROM panels WHERE id = ?').get(id);
  }

  reorderPanels(batchId, panelIds) {
    const current = this.db.prepare(`
      SELECT id FROM panels WHERE batch_id = ? AND deleted_at IS NULL ORDER BY ordinal
    `).all(batchId).map((row) => row.id);
    if (current.length !== panelIds.length || new Set(panelIds).size !== panelIds.length
      || panelIds.some((id) => !current.includes(id))) {
      const error = new Error('The reorder list must contain every panel in this batch exactly once.');
      error.code = 'invalid_panel_order';
      error.statusCode = 422;
      throw error;
    }
    this.transaction(() => {
      const temporaryOffset = current.length + 10_000;
      this.db.prepare('UPDATE panels SET ordinal = ordinal + ?, updated_at = ? WHERE batch_id = ? AND deleted_at IS NULL')
        .run(temporaryOffset, now(), batchId);
      const statement = this.db.prepare('UPDATE panels SET ordinal = ?, updated_at = ? WHERE id = ? AND batch_id = ?');
      panelIds.forEach((panelId, index) => statement.run(index + 1, now(), panelId, batchId));
    });
    return this.getBatchDetails(batchId);
  }

  softDeleteStoryboardPanel({ panelId, deletedByUserId = null }) {
    return this.transaction(() => {
      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) {
        return { changed: false, panelId, deletedAt: panel.deleted_at };
      }
      const batch = this.getBatchRecord(panel.batch_id);
      const activeRun = batch?.workflow_type === 'reference_creation'
        ? this.db.prepare(`
          SELECT id FROM storyboard_runs
          WHERE panel_id = ? AND status IN ('queued','running','processing') LIMIT 1
        `).get(panelId)
        : this.db.prepare(`
          SELECT id FROM run_attempts
          WHERE panel_id = ? AND status IN ('queued','running') LIMIT 1
        `).get(panelId);
      if (activeRun) {
        throw dbError('Wait for the active task to finish before removing this column.', 'panel_storyboard_run_active', 409);
      }
      const activeAnalysis = batch?.workflow_type === 'reference_creation'
        ? this.db.prepare(`
          SELECT id FROM storyboard_analyses WHERE panel_id = ? AND status = 'running' LIMIT 1
        `).get(panelId)
        : null;
      if (activeAnalysis) {
        throw dbError('Wait for the active storyboard analysis to finish before removing this column.', 'storyboard_panel_analysis_active', 409);
      }
      const timestamp = now();
      const minimumOrdinal = Number(this.db.prepare(`
        SELECT COALESCE(MIN(ordinal), 0) AS ordinal FROM panels WHERE batch_id = ?
      `).get(panel.batch_id)?.ordinal || 0);
      const deletedOrdinal = Math.min(0, minimumOrdinal) - 1;
      this.db.prepare(`
        UPDATE panels SET deleted_at = ?, deleted_by_user_id = ?, ordinal = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(timestamp, deletedByUserId, deletedOrdinal, timestamp, panelId);
      return {
        changed: true,
        panelId,
        deletedAt: timestamp,
        submissionRetained: panel.submission_status === 'submitted'
      };
    });
  }

  createAssetVersion({
    panelId, stage, parentVersionId = null, runAttemptId = null, blobPath, sha256,
    mimeType, width, height, byteSize, status = 'candidate', metadata = {}, inputEdges = []
  }) {
    assertStage(stage);
    const id = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO asset_versions (
          id, panel_id, stage, parent_version_id, run_attempt_id, blob_path, sha256,
          mime_type, width, height, byte_size, status, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, panelId, stage, parentVersionId, runAttemptId, blobPath, sha256,
        mimeType, width, height, byteSize, status, json(metadata), timestamp);
      const edgeStatement = this.db.prepare(`
        INSERT OR IGNORE INTO derived_from_edges (output_asset_version_id, input_asset_version_id, role)
        VALUES (?, ?, ?)
      `);
      for (const edge of inputEdges) edgeStatement.run(id, edge.id, edge.role);
      if (status === 'approved') {
        const column = CURRENT_COLUMN[stage];
        this.db.prepare(`UPDATE panels SET ${column} = ?, updated_at = ? WHERE id = ?`).run(id, timestamp, panelId);
      }
    });
    return this.getAsset(id);
  }

  getAsset(id) {
    const asset = this.db.prepare('SELECT * FROM asset_versions WHERE id = ?').get(id);
    if (!asset) return undefined;
    return { ...asset, metadata: parseJson(asset.metadata_json) };
  }

  getCurrentAsset(panelId, stage) {
    assertStage(stage);
    const column = CURRENT_COLUMN[stage];
    const row = this.db.prepare(`
      SELECT a.* FROM panels p LEFT JOIN asset_versions a ON a.id = p.${column} WHERE p.id = ?
    `).get(panelId);
    if (!row?.id) return undefined;
    return { ...row, metadata: parseJson(row.metadata_json) };
  }

  getRequiredInputs(panelId, stage) {
    assertStage(stage, { generatableOnly: true });
    return requiredInputStages(stage).map((inputStage) => {
      const asset = this.getCurrentAsset(panelId, inputStage);
      if (!asset || asset.status !== 'approved') {
        const error = new Error(`Stage ${stage} requires an approved ${inputStage} version.`);
        error.code = 'missing_approved_input';
        error.statusCode = 409;
        throw error;
      }
      return { ...asset, role: inputStage };
    });
  }

  assetDependsOn(outputId, inputId, role) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM derived_from_edges
      WHERE output_asset_version_id = ? AND input_asset_version_id = ? AND role = ?
    `).get(outputId, inputId, role));
  }

  recomputeCurrentStatuses(panelId) {
    const panel = this.getPanel(panelId);
    if (!panel) return;
    const current = {
      source: panel.current_source_version_id,
      ink: panel.current_ink_version_id,
      color: panel.current_color_version_id,
      light: panel.current_light_version_id
    };
    if (current.source) this.db.prepare("UPDATE asset_versions SET status = 'approved' WHERE id = ?").run(current.source);
    const isCurrent = {
      ink: Boolean(current.ink && current.source && this.assetDependsOn(current.ink, current.source, 'source')),
      color: Boolean(current.color && current.ink && this.assetDependsOn(current.color, current.ink, 'ink')),
      light: Boolean(current.light && current.color && current.ink
        && this.assetDependsOn(current.light, current.color, 'color')
        && this.assetDependsOn(current.light, current.ink, 'ink'))
    };
    if (!isCurrent.ink) isCurrent.color = false;
    if (!isCurrent.color) isCurrent.light = false;
    for (const stage of ['ink', 'color', 'light']) {
      if (current[stage]) {
        this.db.prepare('UPDATE asset_versions SET status = ? WHERE id = ?')
          .run(isCurrent[stage] ? 'approved' : 'stale', current[stage]);
      }
    }
  }

  getPanelSnapshot(id) {
    const panel = this.getPanel(id);
    if (!panel) return undefined;
    const versions = this.db.prepare('SELECT * FROM asset_versions WHERE panel_id = ? ORDER BY created_at DESC').all(id)
      .map((asset) => ({ ...asset, metadata: parseJson(asset.metadata_json) }));
    const runs = this.db.prepare('SELECT * FROM run_attempts WHERE panel_id = ? ORDER BY created_at DESC').all(id)
      .map(this.serializeRun);
    const current = Object.fromEntries(['source', 'ink', 'color', 'light'].map((stage) => [stage, this.getCurrentAsset(id, stage) || null]));
    return { ...panel, current, versions, runs };
  }

  setPanelDeadlines({ batchId, updates, actorUserId }) {
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > 100) {
      throw dbError('Provide 1-100 deadline updates.', 'deadline_updates_invalid', 422);
    }
    const unique = new Set();
    const normalized = updates.map((entry) => {
      const panelId = typeof entry?.panelId === 'string' ? entry.panelId.trim() : '';
      if (!panelId || unique.has(panelId)) throw dbError('Panel deadline updates must be unique.', 'deadline_updates_invalid', 422);
      unique.add(panelId);
      let deadlineAt = null;
      if (entry.deadlineAt != null && entry.deadlineAt !== '') {
        const parsed = new Date(entry.deadlineAt);
        if (!Number.isFinite(parsed.getTime())) throw dbError('Deadline must be a valid ISO date.', 'deadline_invalid', 422);
        deadlineAt = parsed.toISOString();
      }
      return { panelId, deadlineAt };
    });
    const timestamp = now();
    this.transaction(() => {
      const owned = this.db.prepare('SELECT id FROM panels WHERE id = ? AND batch_id = ? AND deleted_at IS NULL');
      const update = this.db.prepare(`
        UPDATE panels SET deadline_at = ?, deadline_updated_by_user_id = ?, deadline_updated_at = ?, updated_at = ?
        WHERE id = ? AND batch_id = ?
      `);
      for (const entry of normalized) {
        if (!owned.get(entry.panelId, batchId)) throw dbError('Panel does not belong to this batch.', 'deadline_panel_mismatch', 409);
        update.run(entry.deadlineAt, actorUserId, timestamp, timestamp, entry.panelId, batchId);
      }
    });
    return normalized.map((entry) => this.getPanelSnapshot(entry.panelId));
  }

  submitStoryboardPanel({ panelId, actorUserId, assetVersionId = null }) {
    const timestamp = now();
    return this.transaction(() => {
      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) throw dbError('This storyboard column has been removed.', 'storyboard_panel_deleted', 409);
      const batch = this.db.prepare('SELECT owner_user_id, workflow_type FROM batches WHERE id = ?').get(panel.batch_id);
      const organization = this.getOrganizationForUser(batch?.owner_user_id || actorUserId);
      if (!organization) throw dbError('The batch owner needs an active organization membership.', 'organization_membership_required', 409);
      if (batch.workflow_type === 'comic_pipeline') {
        const assetId = assetVersionId || panel.current_light_version_id;
        if (!assetId) throw dbError('Select a completed comic stage before submission.', 'comic_submission_asset_required', 409);
        const asset = this.db.prepare(`
          SELECT id, stage FROM asset_versions
          WHERE id = ? AND panel_id = ? AND stage IN ('source','ink','color','light') AND status = 'approved'
        `).get(assetId, panelId);
        const currentAssetId = asset ? panel[CURRENT_COLUMN[asset.stage]] : null;
        if (!asset || currentAssetId !== asset.id) {
          throw dbError('The selected current comic asset is not submit-ready.', 'comic_submission_asset_not_ready', 409);
        }
        if (panel.submission_status === 'submitted'
          && panel.submitted_organization_id === organization.id
          && panel.submitted_asset_version_id === assetId) return this.getPanelSnapshot(panelId);
        this.db.prepare(`
          UPDATE panels SET submission_status = 'submitted', submitted_at = ?, submitted_by_user_id = ?,
            submitted_organization_id = ?, submitted_storyboard_output_id = NULL,
            submitted_asset_version_id = ?, updated_at = ? WHERE id = ?
        `).run(timestamp, actorUserId, organization.id, assetId, timestamp, panelId);
        this.db.prepare(`
          INSERT INTO panel_asset_submission_events (
            id, panel_id, organization_id, asset_version_id, submitted_by_user_id, deadline_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), panelId, organization.id, assetId, actorUserId, panel.deadline_at, timestamp);
      } else {
        const outputId = panel.selected_storyboard_output_id;
        if (!outputId) throw dbError('Select a completed storyboard output before submission.', 'storyboard_output_required', 409);
        const output = this.db.prepare(`
          SELECT o.id FROM storyboard_outputs o
          JOIN storyboard_runs r ON r.id = o.storyboard_run_id
          WHERE o.id = ? AND r.panel_id = ? AND r.status = 'succeeded' AND o.deleted_at IS NULL
        `).get(outputId, panelId);
        if (!output) throw dbError('The selected storyboard output is not submit-ready.', 'storyboard_output_not_ready', 409);
        if (panel.submission_status === 'submitted'
          && panel.submitted_organization_id === organization.id
          && panel.submitted_storyboard_output_id === outputId) return this.getPanelSnapshot(panelId);
        this.db.prepare(`
          UPDATE panels SET submission_status = 'submitted', submitted_at = ?, submitted_by_user_id = ?,
            submitted_organization_id = ?, submitted_storyboard_output_id = ?,
            submitted_asset_version_id = NULL, updated_at = ? WHERE id = ?
        `).run(timestamp, actorUserId, organization.id, outputId, timestamp, panelId);
        this.db.prepare(`
          INSERT INTO panel_submission_events (
            id, panel_id, organization_id, storyboard_output_id, submitted_by_user_id, deadline_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), panelId, organization.id, outputId, actorUserId, panel.deadline_at, timestamp);
      }
      return this.getPanelSnapshot(panelId);
    });
  }

  listOrganizationSubmissions(userId) {
    const organization = this.getOrganizationForUser(userId);
    if (!organization) return [];
    const storyboard = this.db.prepare(`
      SELECT p.id, p.batch_id, p.ordinal, p.original_filename, p.deadline_at,
        p.submission_status, p.submitted_at, p.submitted_storyboard_output_id,
        NULL AS submitted_asset_version_id, 'storyboard' AS submission_kind,
        b.name AS batch_name,
        u.display_name AS submitted_by_name,
        o.width AS output_width, o.height AS output_height, o.mime_type AS output_mime_type
      FROM panels p
      JOIN batches b ON b.id = p.batch_id
      JOIN storyboard_outputs o ON o.id = p.submitted_storyboard_output_id
      LEFT JOIN users u ON u.id = p.submitted_by_user_id
      WHERE p.submission_status = 'submitted' AND p.submitted_organization_id = ?
      ORDER BY COALESCE(p.deadline_at, '9999-12-31T23:59:59.999Z'), p.submitted_at DESC
    `).all(organization.id);
    const comic = this.db.prepare(`
      SELECT p.id, p.batch_id, p.ordinal, p.original_filename, p.deadline_at,
        p.submission_status, p.submitted_at, NULL AS submitted_storyboard_output_id,
        p.submitted_asset_version_id, 'comic' AS submission_kind,
        b.name AS batch_name,
        u.display_name AS submitted_by_name,
        a.width AS output_width, a.height AS output_height, a.mime_type AS output_mime_type
      FROM panels p
      JOIN batches b ON b.id = p.batch_id
      JOIN asset_versions a ON a.id = p.submitted_asset_version_id
      LEFT JOIN users u ON u.id = p.submitted_by_user_id
      WHERE p.submission_status = 'submitted' AND p.submitted_organization_id = ?
      ORDER BY COALESCE(p.deadline_at, '9999-12-31T23:59:59.999Z'), p.submitted_at DESC
    `).all(organization.id);
    return [...storyboard, ...comic].sort((left, right) => {
      const leftDeadline = left.deadline_at || '9999-12-31T23:59:59.999Z';
      const rightDeadline = right.deadline_at || '9999-12-31T23:59:59.999Z';
      return leftDeadline.localeCompare(rightDeadline) || String(right.submitted_at).localeCompare(String(left.submitted_at));
    });
  }

  canUserReadSubmittedOutput(userId, outputId) {
    const organization = this.getOrganizationForUser(userId);
    if (!organization) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM panels
      WHERE submission_status = 'submitted' AND submitted_organization_id = ?
        AND submitted_storyboard_output_id = ?
    `).get(organization.id, outputId));
  }

  canUserReadSubmittedAsset(userId, assetId) {
    const organization = this.getOrganizationForUser(userId);
    if (!organization) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM panels
      WHERE submission_status = 'submitted' AND submitted_organization_id = ?
        AND submitted_asset_version_id = ?
    `).get(organization.id, assetId));
  }

  getBatchDetails(id) {
    const batch = this.getBatchRecord(id);
    if (!batch) return undefined;
    const panels = this.db.prepare(`
      SELECT id FROM panels WHERE batch_id = ? AND deleted_at IS NULL ORDER BY ordinal
    `).all(id)
      .map((row) => this.getPanelSnapshot(row.id));
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS run_count,
        COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN cost_points ELSE 0 END), 0) AS cost_points,
        COALESCE(SUM(CASE WHEN status = 'succeeded' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active_runs,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS unknown_cost_attempts
      FROM run_attempts WHERE panel_id IN (SELECT id FROM panels WHERE batch_id = ?)
    `).get(id);
    const exports = this.db.prepare('SELECT * FROM layout_exports WHERE batch_id = ? ORDER BY created_at DESC').all(id)
      .map((entry) => {
        const pages = parseJson(entry.pages_json, []);
        const exportedLightIds = pages.flatMap((page) => page.slots || []).map((slot) => slot.assetVersionId);
        const currentLightIds = panels.map((panel) => panel.current.light?.id).filter(Boolean);
        const allCurrentLightsApproved = panels.every((panel) => panel.current.light?.status === 'approved');
        const isOutdated = !allCurrentLightsApproved
          || currentLightIds.length !== panels.length
          || exportedLightIds.length !== currentLightIds.length
          || exportedLightIds.some((assetId, index) => assetId !== currentLightIds[index]);
        return { ...entry, pages, isOutdated };
      });
    const storyboardRuns = this.listStoryboardRuns({ batchId: id });
    const storyboardReferences = this.listStoryboardReferences({ batchId: id });
    const storyboardAnalyses = this.listStoryboardAnalyses({ batchId: id });
    return { ...batch, panels, totals, exports, storyboardRuns, storyboardReferences, storyboardAnalyses };
  }

  serializeStoryboardReference = (reference) => {
    if (!reference) return undefined;
    const { metadata_json: metadataJson, ...record } = reference;
    return { ...record, metadata: parseJson(metadataJson) };
  };

  serializeStoryboardOutput = (output) => {
    if (!output) return undefined;
    const { metadata_json: metadataJson, ...record } = output;
    return { ...record, metadata: parseJson(metadataJson) };
  };

  serializeStoryboardRun = (run, { includeOutputs = true } = {}) => {
    if (!run) return undefined;
    const { request_json: requestJson, ...record } = run;
    const serialized = {
      ...record,
      remove_bg: Boolean(record.remove_bg),
      request: parseJson(requestJson)
    };
    if (includeOutputs) {
      serialized.outputs = this.db.prepare(`
        SELECT * FROM storyboard_outputs
        WHERE storyboard_run_id = ? AND deleted_at IS NULL ORDER BY ordinal
      `).all(run.id).map(this.serializeStoryboardOutput);
    }
    return serialized;
  };

  createStoryboardReference({
    id = randomUUID(), batchId, panelId = null, uploadedByUserId = null, blobPath, sha256,
    mimeType, width, height, byteSize, metadata = {}
  }) {
    const batch = this.getBatchRecord(batchId);
    if (!batch) throw dbError('Batch not found.', 'batch_not_found', 404);
    if (panelId) {
      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) throw dbError('This storyboard column has been removed.', 'storyboard_panel_deleted', 409);
      if (panel.batch_id !== batchId) {
        throw dbError('The reference panel does not belong to this batch.', 'storyboard_reference_batch_mismatch', 409);
      }
    }
    this.db.prepare(`
      INSERT INTO storyboard_reference_assets (
        id, batch_id, panel_id, uploaded_by_user_id, blob_path, sha256, mime_type,
        width, height, byte_size, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, batchId, panelId, uploadedByUserId, blobPath, sha256, mimeType,
      width, height, byteSize, json(metadata), now());
    return this.getStoryboardReference(id);
  }

  getStoryboardReference(id) {
    return this.serializeStoryboardReference(
      this.db.prepare('SELECT * FROM storyboard_reference_assets WHERE id = ?').get(id)
    );
  }

  listStoryboardReferences({ batchId = null, panelId = null } = {}) {
    const clauses = [];
    const parameters = [];
    if (batchId) {
      clauses.push('batch_id = ?');
      parameters.push(batchId);
    }
    if (panelId) {
      clauses.push('panel_id = ?');
      parameters.push(panelId);
    }
    const statement = `
      SELECT * FROM storyboard_reference_assets
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
    `;
    return this.db.prepare(statement).all(...parameters).map(this.serializeStoryboardReference);
  }

  cloneStoryboardTask({ sourcePanelId, sourceReferenceId, targetBatchId, requestedByUserId = null }) {
    return this.transaction(() => {
      const sourcePanel = this.getPanel(sourcePanelId);
      if (!sourcePanel) throw dbError('Source panel not found.', 'panel_not_found', 404);
      const targetBatch = this.getBatchRecord(targetBatchId);
      if (!targetBatch || targetBatch.workflow_type !== 'reference_creation') {
        throw dbError('The target must be a storyboard creation batch.', 'storyboard_clone_target_invalid', 409);
      }
      const source = this.getCurrentAsset(sourcePanelId, 'source');
      if (!source || source.status !== 'approved') {
        throw dbError('The legacy task has no approved storyboard source.', 'missing_approved_input', 409);
      }
      const reference = this.getStoryboardReference(sourceReferenceId);
      if (!reference || reference.batch_id !== sourcePanel.batch_id) {
        throw dbError('The legacy reference does not belong to the source task.', 'storyboard_reference_batch_mismatch', 409);
      }
      const ordinal = Number(this.db.prepare(
        'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM panels WHERE batch_id = ? AND deleted_at IS NULL'
      ).get(targetBatchId).ordinal);
      const timestamp = now();
      const panelId = randomUUID();
      const sourceAssetId = randomUUID();
      const referenceId = randomUUID();
      this.db.prepare(`
        INSERT INTO panels (id, batch_id, ordinal, original_filename, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(panelId, targetBatchId, ordinal, sourcePanel.original_filename, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO asset_versions (
          id, panel_id, stage, parent_version_id, run_attempt_id, blob_path, sha256,
          mime_type, width, height, byte_size, status, metadata_json, created_at
        ) VALUES (?, ?, 'source', NULL, NULL, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `).run(
        sourceAssetId, panelId, source.blob_path, source.sha256, source.mime_type,
        source.width, source.height, source.byte_size,
        json({ ...source.metadata, clonedFromPanelId: sourcePanelId, clonedFromAssetId: source.id }),
        timestamp
      );
      this.db.prepare('UPDATE panels SET current_source_version_id = ? WHERE id = ?')
        .run(sourceAssetId, panelId);
      this.db.prepare(`
        INSERT INTO storyboard_reference_assets (
          id, batch_id, panel_id, uploaded_by_user_id, blob_path, sha256, mime_type,
          width, height, byte_size, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        referenceId, targetBatchId, panelId, requestedByUserId,
        reference.blob_path, reference.sha256, reference.mime_type,
        reference.width, reference.height, reference.byte_size,
        json({ ...reference.metadata, clonedFromReferenceId: reference.id }), timestamp
      );
      return {
        panel: this.getPanelSnapshot(panelId),
        reference: this.getStoryboardReference(referenceId)
      };
    });
  }

  serializeStoryboardAnalysis = (analysis) => {
    if (!analysis) return undefined;
    const {
      result_json: resultJson,
      generation_target_json: generationTargetJson,
      provider_response_id: _providerResponseId,
      ...record
    } = analysis;
    return {
      ...record,
      result: parseJson(resultJson, null),
      generationTarget: parseJson(generationTargetJson, null)
    };
  };

  queueStoryboardAnalysis({
    panelId, sourceAssetVersionId, referenceAssetId, mode, modelName, promptRevision,
    idempotencyKey, inputFingerprint, modificationNote = '', requestedByUserId = null
  }) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM storyboard_analyses WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        const sameRequest = existing.panel_id === panelId
          && existing.source_asset_version_id === sourceAssetVersionId
          && existing.reference_asset_id === referenceAssetId
          && existing.mode === mode
          && existing.model_name === modelName
          && existing.prompt_revision === promptRevision
          && existing.modification_note === modificationNote
          && existing.input_fingerprint === inputFingerprint;
        if (!sameRequest) {
          throw dbError(
            'This idempotency key is already bound to a different storyboard analysis.',
            'idempotency_key_conflict',
            409
          );
        }
        return { analysis: this.serializeStoryboardAnalysis(existing), deduplicated: true };
      }
      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) throw dbError('This storyboard column has been removed.', 'storyboard_panel_deleted', 409);
      const source = this.getAsset(sourceAssetVersionId);
      if (!source || source.panel_id !== panelId || source.stage !== 'source' || source.status !== 'approved') {
        throw dbError('The analysis source must be the current approved storyboard input.', 'storyboard_source_mismatch', 409);
      }
      const reference = this.getStoryboardReference(referenceAssetId);
      if (!reference) throw dbError('Storyboard reference asset not found.', 'storyboard_reference_not_found', 404);
      if (reference.batch_id !== panel.batch_id) {
        throw dbError('The analysis reference must belong to the same batch.', 'storyboard_reference_batch_mismatch', 409);
      }
      if (!['batch', 'single'].includes(mode)) {
        throw dbError('Analysis mode must be batch or single.', 'main_model_mode_invalid', 422);
      }
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO storyboard_analyses (
          id, panel_id, source_asset_version_id, reference_asset_id, mode, model_name,
          prompt_revision, modification_note, idempotency_key, input_fingerprint, status,
          requested_by_user_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        id, panelId, sourceAssetVersionId, referenceAssetId, mode, modelName,
        promptRevision, modificationNote, idempotencyKey, inputFingerprint, requestedByUserId, now()
      );
      return { analysis: this.getStoryboardAnalysis(id), deduplicated: false };
    });
  }

  completeStoryboardAnalysis({ analysisId, result, responseId = null, usage = {} }) {
    const changed = this.db.prepare(`
      UPDATE storyboard_analyses SET status = 'succeeded', result_json = ?,
        provider_response_id = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
        error_code = NULL, error_message = NULL, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      json(result), responseId,
      Number(usage.inputTokens || 0), Number(usage.outputTokens || 0), Number(usage.totalTokens || 0),
      now(), analysisId
    );
    if (!changed.changes) throw dbError('Storyboard analysis is not running.', 'storyboard_analysis_not_running', 409);
    return this.getStoryboardAnalysis(analysisId);
  }

  failStoryboardAnalysis({ analysisId, code, message, responseId = null, usage = {} }) {
    const changed = this.db.prepare(`
      UPDATE storyboard_analyses SET status = 'failed', error_code = ?, error_message = ?,
        provider_response_id = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      code, String(message || code).slice(0, 500), responseId,
      Number(usage.inputTokens || 0), Number(usage.outputTokens || 0), Number(usage.totalTokens || 0),
      now(), analysisId
    );
    if (!changed.changes && !this.getStoryboardAnalysis(analysisId)) {
      throw dbError('Storyboard analysis not found.', 'storyboard_analysis_not_found', 404);
    }
    return this.getStoryboardAnalysis(analysisId);
  }

  getStoryboardAnalysis(id) {
    return this.serializeStoryboardAnalysis(
      this.db.prepare('SELECT * FROM storyboard_analyses WHERE id = ?').get(id)
    );
  }

  findStoryboardAnalysisByIdempotencyKey(idempotencyKey) {
    return this.serializeStoryboardAnalysis(
      this.db.prepare('SELECT * FROM storyboard_analyses WHERE idempotency_key = ?').get(idempotencyKey)
    );
  }

  findReusableStoryboardAnalysis({ inputFingerprint, mode, modelName, promptRevision }) {
    return this.serializeStoryboardAnalysis(this.db.prepare(`
      SELECT *
        FROM storyboard_analyses
       WHERE input_fingerprint = ?
         AND mode = ?
         AND model_name = ?
         AND prompt_revision = ?
         AND status = 'succeeded'
         AND result_json IS NOT NULL
       ORDER BY finished_at DESC, created_at DESC, id DESC
       LIMIT 1
    `).get(inputFingerprint, mode, modelName, promptRevision));
  }

  listStoryboardAnalyses({ batchId = null, panelId = null } = {}) {
    const clauses = [];
    const parameters = [];
    let joins = '';
    if (batchId) {
      joins = 'JOIN panels p ON p.id = a.panel_id';
      clauses.push('p.batch_id = ? AND p.deleted_at IS NULL');
      parameters.push(batchId);
    }
    if (panelId) {
      clauses.push('a.panel_id = ?');
      parameters.push(panelId);
    }
    const statement = `
      SELECT a.* FROM storyboard_analyses a ${joins}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC, a.id DESC
    `;
    return this.db.prepare(statement).all(...parameters).map(this.serializeStoryboardAnalysis);
  }

  confirmStoryboardAnalysis({ analysisId, userId = null }) {
    const analysis = this.getStoryboardAnalysis(analysisId);
    if (!analysis) throw dbError('Storyboard analysis not found.', 'storyboard_analysis_not_found', 404);
    if (analysis.status !== 'succeeded') {
      throw dbError('Only a completed storyboard analysis can be confirmed.', 'storyboard_analysis_not_ready', 409);
    }
    this.db.prepare(`
      UPDATE storyboard_analyses SET confirmed_by_user_id = ?, confirmed_at = COALESCE(confirmed_at, ?)
      WHERE id = ?
    `).run(userId, now(), analysisId);
    return this.getStoryboardAnalysis(analysisId);
  }

  attachStoryboardAnalysisGenerationSource({ analysisId, assetVersionId, target }) {
    return this.transaction(() => {
      const analysis = this.getStoryboardAnalysis(analysisId);
      if (!analysis) throw dbError('Storyboard analysis not found.', 'storyboard_analysis_not_found', 404);
      if (analysis.status !== 'succeeded' || analysis.mode !== 'single') {
        throw dbError('Only a completed single-item analysis can prepare a generation input.', 'storyboard_analysis_not_ready', 409);
      }
      if (analysis.generation_source_asset_version_id) {
        if (analysis.generation_source_asset_version_id !== assetVersionId) {
          throw dbError('The analysis already has a different immutable generation input.', 'storyboard_analysis_generation_conflict', 409);
        }
        return analysis;
      }
      const asset = this.getAsset(assetVersionId);
      if (!asset || asset.panel_id !== analysis.panel_id || asset.stage !== 'source'
        || ![analysis.source_asset_version_id, null].includes(asset.parent_version_id)
        || (asset.id !== analysis.source_asset_version_id && asset.parent_version_id !== analysis.source_asset_version_id)) {
        throw dbError('The prepared generation input does not derive from the analyzed storyboard.', 'storyboard_analysis_generation_mismatch', 409);
      }
      this.db.prepare(`
        UPDATE storyboard_analyses
        SET generation_source_asset_version_id = ?, generation_target_json = ?
        WHERE id = ? AND generation_source_asset_version_id IS NULL
      `).run(assetVersionId, json(target), analysisId);
      return this.getStoryboardAnalysis(analysisId);
    });
  }

  recoverInterruptedStoryboardAnalyses() {
    return this.db.prepare(`
      UPDATE storyboard_analyses SET status = 'failed', error_code = 'main_model_result_unknown',
        error_message = 'The server restarted before the analysis response was safely persisted.', finished_at = ?
      WHERE status = 'running'
    `).run(now()).changes;
  }

  queueStoryboardRun({
    panelId,
    idempotencyKey,
    contractFingerprint,
    projectId,
    imageSize = '1K',
    expectedResultCount = 1,
    removeBg = false,
    sourceAssetVersionId,
    referenceAssetId,
    analysisId = null,
    modificationNote = '',
    renderProvider = 'storyark',
    maxResultsPerBatch = null,
    request = {}
  }) {
    return this.transaction(() => {
      if (!['storyark', 'nano_banana_2'].includes(renderProvider)) {
        throw dbError('The storyboard render provider is unsupported.', 'storyboard_render_provider_invalid', 422);
      }
      const providerConnectionId = renderProvider === 'nano_banana_2'
        ? 'studio_relay_nano_banana_2'
        : 'storyark_v3';
      const toolName = renderProvider === 'nano_banana_2' ? 'images_edits' : 'storyboard_inference';
      const serializedRequest = json(request);
      const existing = this.db.prepare('SELECT * FROM storyboard_runs WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        const sameRequest = existing.panel_id === panelId
          && existing.provider_family === 'miguo'
          && existing.provider_connection_id === providerConnectionId
          && existing.tool_name === toolName
          && existing.contract_fingerprint === contractFingerprint
          && existing.project_id === projectId
          && existing.image_size === imageSize
          && existing.expected_result_count === expectedResultCount
          && existing.remove_bg === (removeBg ? 1 : 0)
          && existing.source_asset_version_id === sourceAssetVersionId
          && existing.reference_asset_id === referenceAssetId
          && existing.analysis_id === analysisId
          && existing.modification_note === modificationNote
          && existing.request_json === serializedRequest;
        if (!sameRequest) {
          throw dbError(
            'This idempotency key is already bound to a different StoryArk operation.',
            'idempotency_key_conflict',
            409
          );
        }
        return { run: this.serializeStoryboardRun(existing), deduplicated: true };
      }

      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) throw dbError('This storyboard column has been removed.', 'storyboard_panel_deleted', 409);
      const source = this.getAsset(sourceAssetVersionId);
      if (!source) throw dbError('Source asset version not found.', 'asset_not_found', 404);
      if (source.panel_id !== panelId || source.stage !== 'source') {
        throw dbError(
          'The StoryArk source must be a source-stage asset from the target panel.',
          'storyboard_source_mismatch',
          409
        );
      }
      const reference = this.getStoryboardReference(referenceAssetId);
      if (!reference) throw dbError('Storyboard reference asset not found.', 'storyboard_reference_not_found', 404);
      if (reference.batch_id !== panel.batch_id) {
        throw dbError(
          'The StoryArk reference must belong to the same batch as the target panel.',
          'storyboard_reference_batch_mismatch',
          409
        );
      }
      if (analysisId) {
        const analysis = this.getStoryboardAnalysis(analysisId);
        const sourceAnalysisId = source.parent_version_id || source.id;
        if (!analysis || analysis.status !== 'succeeded' || analysis.mode !== 'single'
          || analysis.panel_id !== panelId || analysis.source_asset_version_id !== sourceAnalysisId
          || analysis.reference_asset_id !== referenceAssetId
          || analysis.modification_note !== modificationNote
          || analysis.generation_source_asset_version_id !== sourceAssetVersionId
          || analysis.generationTarget?.strategy !== 'storyboard-reference-instance-composite-v2') {
          throw dbError(
            'The StoryArk run requires a completed single-item analysis for these exact inputs.',
            'storyboard_analysis_mismatch',
            409
          );
        }
      }
      if (!contractFingerprint || !String(contractFingerprint).trim()) {
        throw dbError('A StoryArk contract fingerprint is required.', 'contract_fingerprint_required', 422);
      }
      if (!projectId || !String(projectId).trim()) {
        throw dbError('A StoryArk project is required.', 'storyboard_project_required', 422);
      }

      // Each panel is an independent task lane. BEGIN IMMEDIATE serializes the
      // panel-active and batch-quota checks with the INSERT, while the partial
      // unique index remains the final same-panel duplicate guard.
      const active = this.db.prepare(`
        SELECT id FROM storyboard_runs
        WHERE panel_id = ? AND status IN ('queued','running','processing') LIMIT 1
      `).get(panelId);
      if (active) {
        throw dbError(
          'This storyboard panel already has a queued or processing task.',
          'panel_storyboard_run_active',
          409
        );
      }

      if (maxResultsPerBatch != null) {
        const limit = Number(maxResultsPerBatch);
        if (!Number.isInteger(limit) || limit < 1) {
          throw dbError('The storyboard result limit is invalid.', 'storyboard_result_limit_invalid', 500);
        }
        const used = Number(this.db.prepare(`
          SELECT COALESCE(SUM(r.expected_result_count), 0) AS requested_results
          FROM storyboard_runs r
          JOIN panels p ON p.id = r.panel_id
          WHERE p.batch_id = ? AND r.status <> 'cancelled'
        `).get(panel.batch_id)?.requested_results || 0);
        if (used + expectedResultCount > limit) {
          throw dbError(
            `This batch is limited to ${limit} requested result images.`,
            'storyboard_result_limit_reached',
            409
          );
        }
      }

      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO storyboard_runs (
          id, panel_id, provider_family, provider_connection_id, tool_name,
          contract_fingerprint, idempotency_key, status, project_id, image_size,
          expected_result_count, remove_bg, source_asset_version_id, reference_asset_id,
          analysis_id, modification_note, request_json, created_at
        ) VALUES (?, ?, 'miguo', ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        panelId,
        providerConnectionId,
        toolName,
        contractFingerprint,
        idempotencyKey,
        projectId,
        imageSize,
        expectedResultCount,
        removeBg ? 1 : 0,
        sourceAssetVersionId,
        referenceAssetId,
        analysisId,
        modificationNote,
        serializedRequest,
        now()
      );
      return { run: this.getStoryboardRun(id), deduplicated: false };
    });
  }

  claimNextQueuedStoryboard() {
    return this.transaction(() => {
      // Queued columns are independent, but paid provider calls remain
      // strictly serial. A global unknown-cost hold also freezes every queued
      // item before the next provider call can start.
      const paidHold = this.db.prepare(`
        SELECT id FROM storyboard_runs
        WHERE (cost_source = 'unknown' AND status <> 'cancelled')
           OR status IN ('running','processing')
        LIMIT 1
      `).get();
      if (paidHold) return undefined;
      const row = this.db.prepare(`
        SELECT id FROM storyboard_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
      `).get();
      if (!row) return undefined;
      const changed = this.db.prepare(`
        UPDATE storyboard_runs
        SET status = 'running', started_at = ?, error_code = NULL, error_message = NULL
        WHERE id = ? AND status = 'queued'
      `).run(now(), row.id);
      return changed.changes ? this.getStoryboardRun(row.id) : undefined;
    });
  }

  markStoryboardProcessing({
    runId, providerTaskId = null, providerRequestId = null,
    costPoints = 0, costSource = 'unpriced',
    nextPollAt = new Date(Date.now() + 5_000).toISOString()
  }) {
    const run = this.getStoryboardRun(runId);
    if (!run) throw dbError('StoryArk run not found.', 'storyboard_run_not_found', 404);
    if (!['running', 'processing'].includes(run.status)) {
      throw dbError('Only a running StoryArk run can enter processing.', 'storyboard_run_not_processing', 409);
    }
    this.db.prepare(`
      UPDATE storyboard_runs SET status = 'processing',
        provider_task_id = COALESCE(?, provider_task_id),
        provider_request_id = COALESCE(?, provider_request_id),
        cost_points = ?, cost_source = ?, next_poll_at = ?,
        error_code = NULL, error_message = NULL
      WHERE id = ?
    `).run(providerTaskId, providerRequestId, costPoints, costSource, nextPollAt, runId);
    return this.getStoryboardRun(runId);
  }

  claimNextProcessingStoryboard({ pollIntervalMs = 5_000, staleBefore = null } = {}) {
    const claimedAt = now();
    const staleThreshold = staleBefore || new Date(Date.now() - pollIntervalMs).toISOString();
    const leasedUntil = new Date(Date.now() + pollIntervalMs).toISOString();
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM storyboard_runs
        WHERE status = 'processing'
          AND (next_poll_at IS NULL OR next_poll_at <= ?)
          AND (last_polled_at IS NULL OR last_polled_at <= ?)
        ORDER BY COALESCE(next_poll_at, created_at), created_at, id
        LIMIT 1
      `).get(claimedAt, staleThreshold);
      if (!row) return undefined;
      const changed = this.db.prepare(`
        UPDATE storyboard_runs SET last_polled_at = ?, next_poll_at = ?
        WHERE id = ? AND status = 'processing'
          AND (next_poll_at IS NULL OR next_poll_at <= ?)
          AND (last_polled_at IS NULL OR last_polled_at <= ?)
      `).run(claimedAt, leasedUntil, row.id, claimedAt, staleThreshold);
      return changed.changes ? this.getStoryboardRun(row.id) : undefined;
    });
  }

  getNextProcessingStoryboard() {
    return this.claimNextProcessingStoryboard();
  }

  markStoryboardPollingComplete({
    runId, providerTaskId = null, providerRequestId = null,
    costPoints = null, costSource = null, pollAfterMs = 5_000, nextPollAt = null
  }) {
    const next = nextPollAt || new Date(Date.now() + pollAfterMs).toISOString();
    const result = this.db.prepare(`
      UPDATE storyboard_runs SET
        provider_task_id = COALESCE(?, provider_task_id),
        provider_request_id = COALESCE(?, provider_request_id),
        cost_points = COALESCE(?, cost_points),
        cost_source = COALESCE(?, cost_source),
        next_poll_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ? AND status = 'processing'
    `).run(providerTaskId, providerRequestId, costPoints, costSource, next, runId);
    if (!result.changes && !this.getStoryboardRun(runId)) {
      throw dbError('StoryArk run not found.', 'storyboard_run_not_found', 404);
    }
    return this.getStoryboardRun(runId);
  }

  completeStoryboardRunWithOutputs({
    runId,
    outputs,
    providerTaskId = null,
    providerRequestId = null,
    costPoints = 0,
    costSource = 'unpriced',
    durationMs = null
  }) {
    if (!Array.isArray(outputs) || outputs.length === 0) {
      throw dbError('At least one local StoryArk output is required.', 'storyboard_outputs_required', 422);
    }
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM storyboard_runs WHERE id = ?').get(runId);
      if (!run) throw dbError('StoryArk run not found.', 'storyboard_run_not_found', 404);
      if (run.status === 'succeeded') return this.getStoryboardRun(runId);
      if (!['running', 'processing'].includes(run.status)) {
        throw dbError('Only a running or processing StoryArk run can complete.', 'storyboard_run_not_completable', 409);
      }
      if (outputs.length !== run.expected_result_count) {
        throw dbError(
          `StoryArk returned ${outputs.length} output(s), but ${run.expected_result_count} were expected.`,
          'storyboard_output_count_mismatch',
          422
        );
      }
      const timestamp = now();
      const maximumVersion = Number(this.db.prepare(`
        SELECT COALESCE(MAX(o.version_number), 0) AS maximum
        FROM storyboard_outputs o
        JOIN storyboard_runs r ON r.id = o.storyboard_run_id
        WHERE r.panel_id = ?
      `).get(run.panel_id)?.maximum || 0);
      const insert = this.db.prepare(`
        INSERT INTO storyboard_outputs (
          id, storyboard_run_id, ordinal, blob_path, sha256, mime_type,
          width, height, byte_size, version_number, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const persistedOutputs = outputs.map((output, index) => ({
        ...output,
        id: output.id || randomUUID(),
        ordinal: output.ordinal ?? index + 1,
        versionNumber: maximumVersion + index + 1
      }));
      persistedOutputs.forEach((output) => {
        insert.run(
          output.id,
          runId,
          output.ordinal,
          output.blobPath ?? output.blob_path,
          output.sha256,
          output.mimeType ?? output.mime_type,
          output.width,
          output.height,
          output.byteSize ?? output.byte_size,
          output.versionNumber,
          json(output.metadata),
          timestamp
        );
      });
      this.db.prepare(`
        UPDATE storyboard_runs SET status = 'succeeded',
          provider_task_id = COALESCE(?, provider_task_id),
          provider_request_id = COALESCE(?, provider_request_id),
          cost_points = ?, cost_source = ?, duration_ms = ?, finished_at = ?,
          next_poll_at = NULL,
          error_code = NULL, error_message = NULL
        WHERE id = ?
      `).run(providerTaskId, providerRequestId, costPoints, costSource, durationMs, timestamp, runId);
      const selectedOutput = [...persistedOutputs].sort((left, right) => left.ordinal - right.ordinal)[0];
      const panel = this.db.prepare('SELECT selected_storyboard_output_id FROM panels WHERE id = ?').get(run.panel_id);
      if (selectedOutput && panel?.selected_storyboard_output_id !== selectedOutput.id) {
        this.db.prepare(`
          UPDATE panels SET selected_storyboard_output_id = ?, updated_at = ? WHERE id = ?
        `).run(selectedOutput.id, timestamp, run.panel_id);
        this.db.prepare(`
          INSERT INTO storyboard_output_selections (
            id, panel_id, output_id, previous_output_id, selected_by_user_id, reason, created_at
          ) VALUES (?, ?, ?, ?, NULL, 'generation_completed', ?)
        `).run(randomUUID(), run.panel_id, selectedOutput.id, panel?.selected_storyboard_output_id || null, timestamp);
      }
      return this.getStoryboardRun(runId);
    });
  }

  failStoryboardRun({
    runId, code, message, providerTaskId = null, providerRequestId = null,
    durationMs = null, costPoints = 0, costSource = 'unpriced'
  }) {
    const run = this.getStoryboardRun(runId);
    if (!run) throw dbError('StoryArk run not found.', 'storyboard_run_not_found', 404);
    if (['succeeded', 'cancelled'].includes(run.status)) {
      throw dbError('This StoryArk run is already terminal.', 'storyboard_run_terminal', 409);
    }
    this.db.prepare(`
      UPDATE storyboard_runs SET status = 'failed', error_code = ?, error_message = ?,
        provider_task_id = COALESCE(?, provider_task_id),
        provider_request_id = COALESCE(?, provider_request_id),
        duration_ms = ?, cost_points = ?, cost_source = ?, next_poll_at = NULL, finished_at = ?
      WHERE id = ?
    `).run(code, message, providerTaskId, providerRequestId, durationMs, costPoints, costSource, now(), runId);
    return this.getStoryboardRun(runId);
  }

  getStoryboardRun(id) {
    return this.serializeStoryboardRun(
      this.db.prepare('SELECT * FROM storyboard_runs WHERE id = ?').get(id)
    );
  }

  findStoryboardRunByIdempotencyKey(idempotencyKey) {
    return this.serializeStoryboardRun(
      this.db.prepare('SELECT * FROM storyboard_runs WHERE idempotency_key = ?').get(idempotencyKey)
    );
  }

  listStoryboardRuns({ batchId = null, panelId = null, status = null } = {}) {
    const clauses = [];
    const parameters = [];
    let joins = '';
    if (batchId) {
      joins = 'JOIN panels p ON p.id = r.panel_id';
      clauses.push('p.batch_id = ? AND p.deleted_at IS NULL');
      parameters.push(batchId);
    }
    if (panelId) {
      clauses.push('r.panel_id = ?');
      parameters.push(panelId);
    }
    if (status) {
      clauses.push('r.status = ?');
      parameters.push(status);
    }
    const statement = `
      SELECT r.* FROM storyboard_runs r ${joins}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC, r.id DESC
    `;
    return this.db.prepare(statement).all(...parameters).map((run) => this.serializeStoryboardRun(run));
  }

  listStoryboardRunsForBatch(batchId) {
    return this.listStoryboardRuns({ batchId });
  }

  getStoryboardOutput(id, { includeDeleted = false } = {}) {
    return this.serializeStoryboardOutput(
      this.db.prepare(`
        SELECT * FROM storyboard_outputs WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}
      `).get(id)
    );
  }

  selectStoryboardOutput({ panelId, outputId, selectedByUserId = null }) {
    return this.transaction(() => {
      const panel = this.getPanel(panelId);
      if (!panel) throw dbError('Panel not found.', 'panel_not_found', 404);
      if (panel.deleted_at) throw dbError('This storyboard column has been removed.', 'storyboard_panel_deleted', 409);
      const candidate = this.db.prepare(`
        SELECT o.*, r.panel_id AS owner_panel_id, r.status AS run_status
          FROM storyboard_outputs o
          JOIN storyboard_runs r ON r.id = o.storyboard_run_id
         WHERE o.id = ? AND o.deleted_at IS NULL
      `).get(outputId);
      if (!candidate) throw dbError('Storyboard output not found.', 'storyboard_output_not_found', 404);
      if (candidate.owner_panel_id !== panelId) {
        throw dbError('The storyboard output belongs to another panel.', 'storyboard_output_panel_mismatch', 409);
      }
      if (candidate.run_status !== 'succeeded') {
        throw dbError('Only a completed storyboard output can be selected.', 'storyboard_output_not_selectable', 409);
      }
      if (panel.selected_storyboard_output_id === outputId) {
        return {
          changed: false,
          panelId,
          selectedOutputId: outputId,
          output: this.getStoryboardOutput(outputId)
        };
      }
      const timestamp = now();
      this.db.prepare(`
        UPDATE panels SET selected_storyboard_output_id = ?, updated_at = ? WHERE id = ?
      `).run(outputId, timestamp, panelId);
      this.db.prepare(`
        INSERT INTO storyboard_output_selections (
          id, panel_id, output_id, previous_output_id, selected_by_user_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, 'user_selected', ?)
      `).run(randomUUID(), panelId, outputId, panel.selected_storyboard_output_id || null, selectedByUserId, timestamp);
      return {
        changed: true,
        panelId,
        selectedOutputId: outputId,
        output: this.getStoryboardOutput(outputId)
      };
    });
  }

  softDeleteStoryboardOutput({ outputId, deletedByUserId = null }) {
    return this.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT o.*, r.panel_id, p.selected_storyboard_output_id, p.submitted_storyboard_output_id
        FROM storyboard_outputs o
        JOIN storyboard_runs r ON r.id = o.storyboard_run_id
        JOIN panels p ON p.id = r.panel_id
        WHERE o.id = ?
      `).get(outputId);
      if (!candidate) throw dbError('Storyboard output not found.', 'storyboard_output_not_found', 404);
      if (candidate.deleted_at) {
        return { changed: false, outputId, panelId: candidate.panel_id, deletedAt: candidate.deleted_at };
      }
      if (candidate.selected_storyboard_output_id === outputId) {
        throw dbError('Select another version before deleting the current version.', 'storyboard_output_selected', 409);
      }
      if (candidate.submitted_storyboard_output_id === outputId) {
        throw dbError('A submitted version cannot be deleted.', 'storyboard_output_submitted', 409);
      }
      const timestamp = now();
      this.db.prepare(`
        UPDATE storyboard_outputs SET deleted_at = ?, deleted_by_user_id = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(timestamp, deletedByUserId, outputId);
      return {
        changed: true,
        outputId,
        panelId: candidate.panel_id,
        versionNumber: candidate.version_number,
        deletedAt: timestamp
      };
    });
  }

  getStoryboardRunSafetySummary() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total_run_count,
        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS unknown_cost_run_count,
        SUM(CASE WHEN status IN ('queued','running','processing') THEN 1 ELSE 0 END) AS active_run_count
      FROM storyboard_runs
    `).get();
    return {
      totalRunCount: Number(row?.total_run_count || 0),
      unknownCostRunCount: Number(row?.unknown_cost_run_count || 0),
      activeRunCount: Number(row?.active_run_count || 0)
    };
  }

  cancelQueuedStoryboard(runId) {
    const result = this.db.prepare(`
      UPDATE storyboard_runs SET status = 'cancelled', finished_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now(), runId);
    return { cancelled: Boolean(result.changes), run: this.getStoryboardRun(runId) };
  }

  recoverInterruptedStoryboardRuns() {
    const interrupted = this.db.prepare(`
      SELECT * FROM storyboard_runs WHERE status IN ('running','processing') ORDER BY created_at
    `).all();
    let recovered = 0;
    this.transaction(() => {
      for (const run of interrupted) {
        const outputCount = Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM storyboard_outputs WHERE storyboard_run_id = ?
        `).get(run.id).count);
        if (outputCount > 0) {
          this.db.prepare(`
            UPDATE storyboard_runs SET status = 'succeeded', recovered_count = recovered_count + 1,
              finished_at = COALESCE(finished_at, ?),
              error_code = 'recovered_after_ingest',
              error_message = 'Recovered already-ingested StoryArk output(s).'
            WHERE id = ?
          `).run(now(), run.id);
          recovered += 1;
        } else if (run.status === 'running') {
          this.db.prepare(`
            UPDATE storyboard_runs SET status = 'failed', recovered_count = recovered_count + 1,
              cost_source = 'unknown', error_code = 'unknown_outcome',
              error_message = 'Worker stopped during StoryArk submission; automatic retry was blocked to avoid duplicate coin charges.',
              finished_at = ? WHERE id = ?
          `).run(now(), run.id);
          recovered += 1;
        }
      }
    });
    return recovered;
  }

  queueRun(spec) {
    return this.queueRunsAtomic([spec])[0];
  }

  queueRunsAtomic(specs) {
    if (!Array.isArray(specs) || !specs.length) return [];
    return this.transaction(() => specs.map((spec) => {
      const {
        panelId,
        stage,
        provider,
        toolName,
        params,
        idempotencyKey,
        inputVersions,
        providerContractFingerprint = null,
        pricingRevision = null,
        estimatedCostPoints = 0,
        providerPhase = 'preflight'
      } = spec;
      const providerProfile = spec.providerProfile
        ?? (provider === 'miguo' ? 'factory_classic' : provider === 'mock' ? 'mock' : provider);
      assertStage(stage, { generatableOnly: true });
      if (providerPhase !== 'preflight') {
        throw dbError('New runs must start in the preflight provider phase.', 'invalid_provider_phase', 422);
      }
      const existing = this.db.prepare('SELECT * FROM run_attempts WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        const sameRequest = existing.panel_id === panelId
          && existing.stage === stage
          && existing.provider === provider
          && existing.provider_profile === providerProfile
          && existing.provider_contract_fingerprint === providerContractFingerprint
          && existing.tool_name === toolName
          && existing.params_json === json(params)
          && existing.input_versions_json === json(inputVersions)
          && existing.pricing_revision === pricingRevision
          && existing.estimated_cost_points === estimatedCostPoints;
        if (!sameRequest) {
          const error = new Error('This idempotency key is already bound to a different operation.');
          error.code = 'idempotency_key_conflict';
          error.statusCode = 409;
          throw error;
        }
        return { run: this.serializeRun(existing), deduplicated: true };
      }
      if (!this.getPanel(panelId)) {
        const error = new Error('Panel not found.');
        error.code = 'panel_not_found';
        error.statusCode = 404;
        throw error;
      }
      if (provider === 'miguo' && this.countAttemptsForInputs(panelId, stage, inputVersions, provider) >= 2) {
        const error = new Error('The current input has reached the paid-provider generation safety limit.');
        error.code = 'attempt_limit_reached';
        error.statusCode = 409;
        throw error;
      }
      const active = this.getActiveRun(panelId, stage);
      if (active) {
        const error = new Error('This panel already has an active run for the same stage.');
        error.code = 'active_run_exists';
        error.statusCode = 409;
        throw error;
      }
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO run_attempts (
          id, panel_id, stage, provider, provider_profile, provider_contract_fingerprint,
          tool_name, idempotency_key, status, params_json, input_versions_json,
          pricing_revision, estimated_cost_points, provider_phase, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        panelId,
        stage,
        provider,
        providerProfile,
        providerContractFingerprint,
        toolName,
        idempotencyKey,
        json(params),
        json(inputVersions),
        pricingRevision,
        estimatedCostPoints,
        providerPhase,
        now()
      );
      return { run: this.getRun(id), deduplicated: false };
    }));
  }

  claimNextQueued() {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT candidate.* FROM run_attempts candidate
        WHERE candidate.status = 'queued'
          AND (
            candidate.provider <> 'miguo'
            OR (
              NOT EXISTS (
                SELECT 1 FROM run_attempts active
                WHERE active.provider = 'miguo' AND active.status = 'running'
              )
              AND NOT EXISTS (
                SELECT 1 FROM run_attempts unknown
                WHERE unknown.provider = 'miguo' AND unknown.cost_source = 'unknown'
                  AND unknown.status <> 'cancelled'
              )
              AND NOT EXISTS (
                SELECT 1 FROM classic_recovery_jobs recovery
                WHERE recovery.state <> 'resolved'
              )
            )
          )
        ORDER BY candidate.created_at, candidate.id LIMIT 1
      `).get();
      if (!row) return undefined;
      const timestamp = now();
      const changed = this.db.prepare("UPDATE run_attempts SET status = 'running', started_at = ?, error_code = NULL, error_message = NULL WHERE id = ? AND status = 'queued'")
        .run(timestamp, row.id);
      if (!changed.changes) return undefined;
      return this.getRun(row.id);
    });
  }

  getActiveRun(panelId, stage) {
    const run = this.db.prepare("SELECT * FROM run_attempts WHERE panel_id = ? AND stage = ? AND status IN ('queued','running') LIMIT 1")
      .get(panelId, stage);
    return run ? this.serializeRun(run) : undefined;
  }

  recoverInterruptedRuns() {
    const interrupted = this.db.prepare("SELECT * FROM run_attempts WHERE status = 'running'").all();
    let recovered = 0;
    this.transaction(() => {
      for (const run of interrupted) {
        const output = this.db.prepare('SELECT id FROM asset_versions WHERE run_attempt_id = ? ORDER BY created_at DESC LIMIT 1').get(run.id);
        if (output) {
          this.db.prepare(`
            UPDATE run_attempts SET status = 'succeeded', output_asset_version_id = ?,
              recovered_count = recovered_count + 1, finished_at = ?,
              cost_source = CASE WHEN provider = 'mock' THEN 'mock' ELSE 'unknown' END,
              provider_phase = CASE WHEN provider = 'mock' THEN provider_phase ELSE 'completed' END,
              error_code = 'recovered_after_ingest', error_message = 'Recovered an already-ingested output.'
            WHERE id = ?
          `).run(output.id, now(), run.id);
          if (run.provider === 'miguo') {
            this.enqueueClassicRecoveryInTransaction(run.id, { reason: 'recovered_after_ingest' });
          }
        } else if (run.provider === 'mock') {
          this.db.prepare(`
            UPDATE run_attempts SET status = 'queued', recovered_count = recovered_count + 1,
              error_code = 'worker_restarted', error_message = 'Safe mock retry after worker restart.'
            WHERE id = ?
          `).run(run.id);
        } else {
          this.db.prepare(`
            UPDATE run_attempts SET status = 'failed', recovered_count = recovered_count + 1,
              cost_source = 'unknown', provider_phase = 'accepted',
              error_code = 'unknown_outcome',
              error_message = 'Worker stopped during a real provider call; automatic retry was blocked to avoid duplicate charges.',
              finished_at = ? WHERE id = ?
          `).run(now(), run.id);
          this.enqueueClassicRecoveryInTransaction(run.id, { reason: 'unknown_outcome' });
        }
        recovered += 1;
      }
    });
    return recovered;
  }

  getRun(id) {
    const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(id);
    return run ? this.serializeRun(run) : undefined;
  }

  findRunByIdempotencyKey(idempotencyKey) {
    const run = this.db.prepare('SELECT * FROM run_attempts WHERE idempotency_key = ?').get(idempotencyKey);
    return run ? this.serializeRun(run) : undefined;
  }

  serializeRun = (run) => ({
    ...run,
    params: parseJson(run.params_json),
    inputVersions: parseJson(run.input_versions_json, [])
  });

  serializeClassicRecoveryJob = (job) => (job ? {
    ...job,
    attempts: Number(job.attempts || 0)
  } : undefined);

  getClassicRecoveryJob(runId) {
    const job = this.db.prepare('SELECT * FROM classic_recovery_jobs WHERE run_id = ?').get(runId);
    return this.serializeClassicRecoveryJob(job);
  }

  listClassicRecoveryJobs() {
    return this.db.prepare(`
      SELECT * FROM classic_recovery_jobs
      ORDER BY CASE state WHEN 'manual_review' THEN 0 WHEN 'resolved' THEN 2 ELSE 1 END,
        created_at, id
    `).all().map(this.serializeClassicRecoveryJob);
  }

  getClassicRecoverySummary() {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM classic_recovery_jobs GROUP BY state
    `).all();
    const stateCounts = Object.fromEntries([...CLASSIC_RECOVERY_STATES].map((state) => [state, 0]));
    for (const row of rows) stateCounts[row.state] = Number(row.count || 0);
    const timestamp = now();
    const claimable = this.db.prepare(`
      SELECT COUNT(*) AS count FROM classic_recovery_jobs
      WHERE state IN ('queued','locating','matched','polling','downloading','validating','attaching','waiting')
        AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).get(timestamp, timestamp);
    const activeLeases = this.db.prepare(`
      SELECT COUNT(*) AS count FROM classic_recovery_jobs
      WHERE state NOT IN ('manual_review','resolved')
        AND lease_owner IS NOT NULL AND lease_expires_at > ?
    `).get(timestamp);
    const totalCount = Object.values(stateCounts).reduce((total, count) => total + count, 0);
    return {
      totalCount,
      unresolvedCount: totalCount - stateCounts.resolved,
      claimableCount: Number(claimable?.count || 0),
      activeLeaseCount: Number(activeLeases?.count || 0),
      manualReviewCount: stateCounts.manual_review,
      stateCounts
    };
  }

  hasUnresolvedClassicRecoveryInTransaction() {
    return Boolean(this.db.prepare(`
      SELECT 1 AS blocked
      WHERE EXISTS (
        SELECT 1 FROM run_attempts
        WHERE provider = 'miguo' AND cost_source = 'unknown' AND status <> 'cancelled'
      ) OR EXISTS (
        SELECT 1 FROM classic_recovery_jobs WHERE state <> 'resolved'
      )
    `).get()?.blocked);
  }

  enqueuePendingClassicRecoveries() {
    return this.transaction(() => {
      const pending = this.db.prepare(`
        SELECT run.id, run.error_code
        FROM run_attempts run
        LEFT JOIN classic_recovery_jobs recovery ON recovery.run_id = run.id
        WHERE run.provider = 'miguo' AND run.status IN ('failed','succeeded')
          AND run.cost_source = 'unknown' AND run.provider_phase IN ('accepted','completed')
          AND recovery.run_id IS NULL
        ORDER BY run.created_at, run.id
      `).all();
      for (const run of pending) {
        this.enqueueClassicRecoveryInTransaction(run.id, {
          reason: run.error_code || 'provider_outcome_unknown'
        });
      }
      return pending.length;
    });
  }

  enqueueClassicRecoveryInTransaction(runId, { reason = null } = {}) {
    const existing = this.db.prepare('SELECT * FROM classic_recovery_jobs WHERE run_id = ?').get(runId);
    if (existing) return this.serializeClassicRecoveryJob(existing);
    const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
    if (!run) throw dbError('Run not found.', 'run_not_found', 404);
    if (run.provider !== 'miguo' || !['failed', 'succeeded'].includes(run.status)
      || run.cost_source !== 'unknown' || !['accepted', 'completed'].includes(run.provider_phase)) {
      throw dbError(
        'Only an accepted Miguo run with an unknown outcome can enter automatic recovery.',
        'run_not_recoverable',
        409
      );
    }
    const reasonCode = boundedText(
      reason || run.error_code || 'provider_outcome_unknown',
      'reason',
      { minimum: 1, maximum: 100 }
    );
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO classic_recovery_jobs (
        id, run_id, state, reason_code, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'queued', ?, 0, ?, ?, ?)
    `).run(randomUUID(), runId, reasonCode, timestamp, timestamp, timestamp);
    return this.getClassicRecoveryJob(runId);
  }

  enqueueClassicRecovery(runId, options = {}) {
    return this.transaction(() => this.enqueueClassicRecoveryInTransaction(runId, options));
  }

  claimNextClassicRecovery({ leaseOwner, leaseMs = 60_000 }) {
    const owner = boundedText(leaseOwner, 'leaseOwner', { minimum: 1, maximum: 100 });
    const duration = boundedInteger(leaseMs, 'leaseMs', { minimum: 1_000, maximum: 3_600_000 });
    return this.transaction(() => {
      const timestamp = now();
      const row = this.db.prepare(`
        SELECT * FROM classic_recovery_jobs
        WHERE state IN ('queued','locating','matched','polling','downloading','validating','attaching','waiting')
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY next_attempt_at, created_at, id LIMIT 1
      `).get(timestamp, timestamp);
      if (!row) return undefined;
      const changed = this.db.prepare(`
        UPDATE classic_recovery_jobs SET
          state = CASE WHEN state IN ('queued','waiting') THEN 'locating' ELSE state END,
          attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE run_id = ?
          AND state IN ('queued','locating','matched','polling','downloading','validating','attaching','waiting')
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
          AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).run(owner, isoAfter(duration), timestamp, row.run_id, timestamp, timestamp);
      if (!changed.changes) return undefined;
      return this.getClassicRecoveryJob(row.run_id);
    });
  }

  renewClassicRecoveryLease({ runId, leaseOwner, leaseMs = 60_000 }) {
    const owner = boundedText(leaseOwner, 'leaseOwner', { minimum: 1, maximum: 100 });
    const duration = boundedInteger(leaseMs, 'leaseMs', { minimum: 1_000, maximum: 3_600_000 });
    return this.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE classic_recovery_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE run_id = ? AND lease_owner = ?
          AND state IN ('queued','locating','matched','polling','downloading','validating','attaching','waiting')
      `).run(isoAfter(duration), now(), runId, owner);
      if (!changed.changes) {
        throw dbError('The classic recovery lease belongs to another worker or is no longer active.', 'recovery_lease_lost', 409);
      }
      return this.getClassicRecoveryJob(runId);
    });
  }

  assertClassicRecoveryLeaseInTransaction(runId, leaseOwner) {
    if (leaseOwner == null) return;
    const owner = boundedText(leaseOwner, 'recoveryLeaseOwner', { minimum: 1, maximum: 100 });
    const timestamp = now();
    const job = this.db.prepare(`
      SELECT 1 AS owned FROM classic_recovery_jobs
      WHERE run_id = ? AND lease_owner = ? AND lease_expires_at > ?
        AND state NOT IN ('manual_review','resolved')
    `).get(runId, owner, timestamp);
    if (!job?.owned) {
      throw dbError('The classic recovery lease is missing, expired, or belongs to another worker.', 'recovery_lease_lost', 409);
    }
  }

  advanceClassicRecovery({ runId, state, leaseOwner, matchedTaskId = null }) {
    const nextState = classicRecoveryState(state, { claimableOnly: true });
    if (['queued', 'waiting'].includes(nextState)) {
      throw dbError('Use deferClassicRecovery to return a recovery job to the queue.', 'invalid_recovery_state', 422);
    }
    const owner = boundedText(leaseOwner, 'leaseOwner', { minimum: 1, maximum: 100 });
    const taskId = optionalProviderId(matchedTaskId, 'matchedTaskId');
    return this.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE classic_recovery_jobs SET state = ?,
          matched_task_id = COALESCE(matched_task_id, ?), updated_at = ?
        WHERE run_id = ? AND lease_owner = ?
          AND lease_expires_at > ? AND state NOT IN ('manual_review','resolved')
      `).run(nextState, taskId, now(), runId, owner, now());
      if (!changed.changes) {
        throw dbError('The classic recovery lease is missing or expired.', 'recovery_lease_lost', 409);
      }
      const job = this.getClassicRecoveryJob(runId);
      if (taskId && job.matched_task_id !== taskId) {
        throw dbError('The recovery job is already bound to another provider task.', 'recovery_task_conflict', 409);
      }
      return job;
    });
  }

  deferClassicRecovery({
    runId, code, delayMs = 0, manualReview = false, leaseOwner = null, message = null
  }) {
    const errorCode = boundedText(code, 'code', { minimum: 1, maximum: 100 });
    const delay = boundedInteger(delayMs, 'delayMs', { minimum: 0, maximum: 604_800_000 });
    const owner = leaseOwner == null ? null
      : boundedText(leaseOwner, 'leaseOwner', { minimum: 1, maximum: 100 });
    const errorMessage = message == null ? null
      : boundedText(message, 'message', { minimum: 1, maximum: 500 });
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM classic_recovery_jobs WHERE run_id = ?').get(runId);
      if (!job) throw dbError('Classic recovery job not found.', 'recovery_job_not_found', 404);
      if (job.state === 'resolved') {
        throw dbError('A resolved recovery job cannot be deferred.', 'recovery_job_resolved', 409);
      }
      if (owner && job.lease_owner !== owner) {
        throw dbError('The classic recovery lease belongs to another worker.', 'recovery_lease_lost', 409);
      }
      const timestamp = now();
      this.db.prepare(`
        UPDATE classic_recovery_jobs SET state = ?, next_attempt_at = ?,
          lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE run_id = ?
      `).run(
        manualReview ? 'manual_review' : 'waiting',
        manualReview ? null : isoAfter(delay),
        errorCode,
        errorMessage,
        timestamp,
        runId
      );
      return this.getClassicRecoveryJob(runId);
    });
  }

  resolveClassicRecoveryInTransaction(runId) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE classic_recovery_jobs SET state = 'resolved', next_attempt_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ?, resolved_at = COALESCE(resolved_at, ?)
      WHERE run_id = ? AND state <> 'resolved'
    `).run(timestamp, timestamp, runId);
    return this.getClassicRecoveryJob(runId);
  }

  resolveClassicRecovery(runId) {
    return this.transaction(() => {
      const job = this.db.prepare('SELECT * FROM classic_recovery_jobs WHERE run_id = ?').get(runId);
      if (!job) throw dbError('Classic recovery job not found.', 'recovery_job_not_found', 404);
      const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
      if (!run || !['failed', 'succeeded'].includes(run.status) || run.cost_source === 'unknown') {
        throw dbError(
          'Recovery cannot resolve until a terminal output decision and exact provider cost outcome are recorded.',
          'recovery_outcome_unresolved',
          409
        );
      }
      return this.resolveClassicRecoveryInTransaction(runId);
    });
  }

  recordProviderEvidence({
    runId, providerRequestId = null, providerTaskId = null,
    resultShapeFingerprint = null, observedAt = now()
  }) {
    const requestId = optionalProviderId(providerRequestId, 'providerRequestId');
    const taskId = optionalProviderId(providerTaskId, 'providerTaskId');
    const fingerprint = resultShapeFingerprint == null ? null
      : boundedText(resultShapeFingerprint, 'resultShapeFingerprint', { minimum: 16, maximum: 160 });
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
      if (!run) throw dbError('Run not found.', 'run_not_found', 404);
      if (run.provider !== 'miguo') {
        throw dbError('Provider evidence can only be recorded for a real Miguo run.', 'provider_evidence_not_allowed', 409);
      }
      if (run.status !== 'running') {
        throw dbError('Provider evidence can only be recorded while the run is active.', 'provider_evidence_not_recordable', 409);
      }
      const conflicts = [
        ['provider request ID', run.provider_request_id, requestId],
        ['provider task ID', run.provider_task_id, taskId],
        ['result shape fingerprint', run.provider_result_shape_fingerprint, fingerprint]
      ].filter(([, existing, incoming]) => existing && incoming && existing !== incoming);
      if (conflicts.length) {
        throw dbError(`Conflicting ${conflicts[0][0]} evidence was rejected.`, 'provider_evidence_conflict', 409);
      }
      this.db.prepare(`
        UPDATE run_attempts SET
          provider_request_id = COALESCE(provider_request_id, ?),
          provider_task_id = COALESCE(provider_task_id, ?),
          provider_result_shape_fingerprint = COALESCE(provider_result_shape_fingerprint, ?),
          provider_result_observed_at = COALESCE(provider_result_observed_at, ?),
          provider_phase = 'accepted'
        WHERE id = ? AND status = 'running'
      `).run(requestId, taskId, fingerprint, observedAt, runId);
      return this.getRun(runId);
    });
  }

  completeRun({
    runId, outputAssetVersionId, providerRequestId = null, providerTaskId = null,
    resultShapeFingerprint = null, costPoints = 0, costSource = 'estimate', durationMs
  }) {
    this.db.prepare(`
      UPDATE run_attempts SET status = 'succeeded', output_asset_version_id = ?,
        provider_request_id = COALESCE(?, provider_request_id),
        provider_task_id = COALESCE(?, provider_task_id),
        provider_result_shape_fingerprint = COALESCE(?, provider_result_shape_fingerprint),
        provider_result_observed_at = CASE
          WHEN COALESCE(?, ?, ?, provider_request_id, provider_task_id, provider_result_shape_fingerprint) IS NOT NULL
            THEN COALESCE(provider_result_observed_at, ?)
          ELSE provider_result_observed_at
        END,
        provider_phase = 'completed', cost_points = ?, cost_source = ?, duration_ms = ?,
        finished_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ?
    `).run(
      outputAssetVersionId, providerRequestId, providerTaskId, resultShapeFingerprint,
      providerRequestId, providerTaskId, resultShapeFingerprint, now(),
      costPoints, costSource, durationMs, now(), runId
    );
    return this.getRun(runId);
  }

  holdRunForRecovery({
    runId, code, message, durationMs = null, costPoints = 0,
    providerRequestId = null, providerTaskId = null, resultShapeFingerprint = null
  }) {
    const requestId = optionalProviderId(providerRequestId, 'providerRequestId');
    const taskId = optionalProviderId(providerTaskId, 'providerTaskId');
    const fingerprint = resultShapeFingerprint == null ? null
      : boundedText(resultShapeFingerprint, 'resultShapeFingerprint', { minimum: 16, maximum: 160 });
    const points = Number(costPoints);
    if (!Number.isFinite(points) || points < 0 || points > 1_000_000) {
      throw dbError('costPoints must be a finite non-negative number.', 'invalid_recovery_request', 422);
    }
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
      if (!run) throw dbError('Run not found.', 'run_not_found', 404);
      if (run.provider !== 'miguo' || !['queued', 'running', 'failed'].includes(run.status)) {
        throw dbError('Only a queued, active or already-held Miguo run can enter recovery.', 'run_not_recoverable', 409);
      }
      if (run.status === 'failed' && run.cost_source !== 'unknown') {
        throw dbError('A reconciled failed run cannot be returned to unknown recovery.', 'run_not_recoverable', 409);
      }
      const conflicts = [
        ['provider request ID', run.provider_request_id, requestId],
        ['provider task ID', run.provider_task_id, taskId],
        ['result shape fingerprint', run.provider_result_shape_fingerprint, fingerprint]
      ].filter(([, existing, incoming]) => existing && incoming && existing !== incoming);
      if (conflicts.length) {
        throw dbError(`Conflicting ${conflicts[0][0]} evidence was rejected.`, 'provider_evidence_conflict', 409);
      }
      const timestamp = now();
      this.db.prepare(`
        UPDATE run_attempts SET status = 'failed', error_code = ?, error_message = ?, duration_ms = ?,
          provider_request_id = COALESCE(provider_request_id, ?),
          provider_task_id = COALESCE(provider_task_id, ?),
          provider_result_shape_fingerprint = COALESCE(provider_result_shape_fingerprint, ?),
          provider_result_observed_at = COALESCE(provider_result_observed_at, ?),
          provider_phase = 'accepted', cost_points = ?, cost_source = 'unknown', finished_at = ?
        WHERE id = ? AND status IN ('queued','running','failed')
      `).run(
        code, message, durationMs, requestId, taskId, fingerprint,
        timestamp, points, timestamp, runId
      );
      const recoveryJob = this.enqueueClassicRecoveryInTransaction(runId, { reason: code });
      return { run: this.getRun(runId), recoveryJob };
    });
  }

  failRun({
    runId, code, message, durationMs = null, costPoints = 0, costSource = 'estimate',
    providerRequestId = null, providerTaskId = null, resultShapeFingerprint = null,
    providerAccepted = false
  }) {
    const existing = this.db.prepare('SELECT provider FROM run_attempts WHERE id = ?').get(runId);
    if (existing?.provider === 'miguo' && (providerAccepted || costSource === 'unknown')) {
      return this.holdRunForRecovery({
        runId, code, message, durationMs, costPoints,
        providerRequestId, providerTaskId, resultShapeFingerprint
      }).run;
    }
    this.db.prepare(`
      UPDATE run_attempts SET status = 'failed', error_code = ?, error_message = ?, duration_ms = ?,
        provider_request_id = COALESCE(?, provider_request_id),
        provider_task_id = COALESCE(?, provider_task_id),
        provider_result_shape_fingerprint = COALESCE(?, provider_result_shape_fingerprint),
        provider_result_observed_at = CASE WHEN ? THEN COALESCE(provider_result_observed_at, ?) ELSE provider_result_observed_at END,
        provider_phase = CASE WHEN ? THEN 'accepted' ELSE provider_phase END,
        cost_points = ?, cost_source = ?, finished_at = ?
      WHERE id = ?
    `).run(
      code, message, durationMs, providerRequestId, providerTaskId, resultShapeFingerprint,
      providerAccepted ? 1 : 0, now(), providerAccepted ? 1 : 0,
      costPoints, costSource, now(), runId
    );
    return this.getRun(runId);
  }

  promoteAsset(assetId) {
    const asset = this.getAsset(assetId);
    if (!asset) {
      const error = new Error('Asset version not found.');
      error.code = 'asset_not_found';
      error.statusCode = 404;
      throw error;
    }
    const panel = this.getPanel(asset.panel_id);
    const column = CURRENT_COLUMN[asset.stage];
    const previousId = panel[column] || null;
    if (previousId === assetId) return { ...this.getPanelSnapshot(asset.panel_id), changed: false };
    const currentSource = panel.current_source_version_id;
    const currentInk = panel.current_ink_version_id;
    const currentColor = panel.current_color_version_id;
    const promotable = asset.stage === 'source'
      || (asset.stage === 'ink' && currentSource && this.assetDependsOn(asset.id, currentSource, 'source'))
      || (asset.stage === 'color' && currentInk && this.assetDependsOn(asset.id, currentInk, 'ink'))
      || (asset.stage === 'light' && currentColor && currentInk
        && this.assetDependsOn(asset.id, currentColor, 'color')
        && this.assetDependsOn(asset.id, currentInk, 'ink'));
    if (!promotable) {
      const error = new Error('This candidate was generated from a different upstream selection. Restore its upstream first or generate a new candidate.');
      error.code = 'candidate_not_promotable';
      error.statusCode = 409;
      throw error;
    }
    const everSelected = Boolean(this.db.prepare('SELECT 1 FROM approvals WHERE asset_version_id = ? LIMIT 1').get(assetId));
    const action = everSelected ? 'restore' : 'promote';
    const timestamp = now();
    return this.transaction(() => {
      if (previousId && previousId !== assetId) {
        this.db.prepare("UPDATE asset_versions SET status = 'superseded' WHERE id = ? AND status = 'approved'").run(previousId);
      }
      this.db.prepare("UPDATE asset_versions SET status = 'approved' WHERE id = ?").run(assetId);
      this.db.prepare(`UPDATE panels SET ${column} = ?, updated_at = ? WHERE id = ?`).run(assetId, timestamp, asset.panel_id);

      this.db.prepare(`
        INSERT INTO approvals (id, panel_id, stage, asset_version_id, previous_asset_version_id, action, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), asset.panel_id, asset.stage, assetId, previousId, action, timestamp);
      this.recomputeCurrentStatuses(asset.panel_id);
      return { ...this.getPanelSnapshot(asset.panel_id), changed: true };
    });
  }

  countAttemptsForInputs(panelId, stage, inputVersions, provider = null) {
    const providerFilter = provider == null ? '' : ' AND provider = ?';
    const params = [panelId, stage, json(inputVersions)];
    if (provider != null) params.push(provider);
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM run_attempts
      WHERE panel_id = ? AND stage = ? AND input_versions_json = ? AND status <> 'cancelled'
      ${providerFilter}
    `).get(...params).count;
  }

  getClassicRunSafetySummary() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS unknown_cost_run_count
      FROM run_attempts
      WHERE provider = 'miguo' AND cost_source = 'unknown' AND status <> 'cancelled'
    `).get();
    return {
      unknownCostRunCount: Number(row?.unknown_cost_run_count || 0)
    };
  }

  listRunReconciliationEvents(runId) {
    return this.db.prepare(`
      SELECT * FROM run_reconciliation_events
      WHERE run_attempt_id = ? ORDER BY created_at, id
    `).all(runId);
  }

  findReusableCandidateForClassicRun(runId, assetSha256) {
    const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
    if (!run || run.provider !== 'miguo') return undefined;
    const expectedEdges = parseJson(run.input_versions_json, [])
      .map(({ id, role }) => `${role}:${id}`).sort();
    const candidates = this.db.prepare(`
      SELECT * FROM asset_versions
      WHERE panel_id = ? AND stage = ? AND sha256 = ? AND status = 'candidate'
        AND (run_attempt_id IS NULL OR run_attempt_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM run_attempts attached
          WHERE attached.output_asset_version_id = asset_versions.id AND attached.id <> ?
        )
      ORDER BY created_at, id
    `).all(run.panel_id, run.stage, assetSha256, run.id, run.id);
    return candidates.map((candidate) => {
      const edges = this.db.prepare(`
        SELECT input_asset_version_id AS id, role FROM derived_from_edges
        WHERE output_asset_version_id = ? ORDER BY role, input_asset_version_id
      `).all(candidate.id).map(({ id, role }) => `${role}:${id}`).sort();
      return { candidate, edges };
    }).find(({ edges }) => json(edges) === json(expectedEdges))?.candidate;
  }

  reconciliationReplay({
    idempotencyKey, runId, requestFingerprint
  }) {
    const existing = this.db.prepare(`
      SELECT * FROM run_reconciliation_events WHERE idempotency_key = ?
    `).get(idempotencyKey);
    if (!existing) return null;
    const same = existing.run_attempt_id === runId
      && existing.request_fingerprint === requestFingerprint;
    if (!same) {
      throw dbError(
        'This reconciliation idempotency key is already bound to different evidence.',
        'idempotency_key_conflict',
        409
      );
    }
    return { run: this.getRun(runId), event: existing, deduplicated: true };
  }

  insertRunReconciliationEvent({
    run, actorUserId = null, idempotencyKey, requestFingerprint, action, outputAssetVersionId = null,
    outputAssetSha256 = null, outputRawSha256 = null, outputHost = null,
    outputWidth = null, outputHeight = null,
    providerRequestId, providerTaskId, resultShapeFingerprint,
    costPoints, costSource, note, evidenceReference
  }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO run_reconciliation_events (
        id, run_attempt_id, actor_user_id, idempotency_key, request_fingerprint, action,
        prior_status, prior_error_code, prior_cost_points, prior_cost_source,
        output_asset_version_id, output_asset_sha256, output_raw_sha256,
        output_host, output_width, output_height, provider_request_id, provider_task_id,
        result_shape_fingerprint, reconciled_cost_points, reconciled_cost_source,
        note, evidence_reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, run.id, actorUserId, idempotencyKey, requestFingerprint, action,
      run.status, run.error_code, run.cost_points, run.cost_source,
      outputAssetVersionId, outputAssetSha256, outputRawSha256,
      outputHost, outputWidth, outputHeight, providerRequestId, providerTaskId,
      resultShapeFingerprint, costPoints, costSource,
      note, evidenceReference, now()
    );
    return this.db.prepare('SELECT * FROM run_reconciliation_events WHERE id = ?').get(id);
  }

  normalizeRunReconciliation({
    idempotencyKey, providerRequestId = null, providerTaskId = null,
    resultShapeFingerprint = null, costPoints, costSource, note, evidenceReference
  }) {
    const key = boundedText(idempotencyKey, 'idempotencyKey', { minimum: 8, maximum: 200 });
    const requestId = optionalProviderId(providerRequestId, 'providerRequestId');
    const taskId = optionalProviderId(providerTaskId, 'providerTaskId');
    let fingerprint = null;
    if (resultShapeFingerprint != null && resultShapeFingerprint !== '') {
      fingerprint = boundedText(resultShapeFingerprint, 'resultShapeFingerprint', { minimum: 84, maximum: 84 });
      if (!/^mcp-result-shape-v(?:1|2):[0-9a-f]{64}$/.test(fingerprint)) {
        throw dbError('resultShapeFingerprint has an invalid format.', 'invalid_reconciliation_evidence', 422);
      }
    }
    const reconciledCost = reconciliationCost(costPoints, costSource);
    return {
      idempotencyKey: key,
      providerRequestId: requestId,
      providerTaskId: taskId,
      resultShapeFingerprint: fingerprint,
      ...reconciledCost,
      note: boundedText(note, 'note', { minimum: 8, maximum: 500 }),
      evidenceReference: boundedText(evidenceReference, 'evidenceReference', { minimum: 3, maximum: 300 })
    };
  }

  assertRunProviderIdentity(run, { providerRequestId = null, providerTaskId = null }) {
    const conflicts = [
      ['provider request ID', run.provider_request_id, providerRequestId],
      ['provider task ID', run.provider_task_id, providerTaskId]
    ].filter(([, existing, incoming]) => existing && incoming && existing !== incoming);
    if (conflicts.length) {
      throw dbError(`Conflicting ${conflicts[0][0]} evidence was rejected.`, 'provider_evidence_conflict', 409);
    }
  }

  reconcileClassicRunCost({ runId, actorUserId = null, recoveryLeaseOwner = null, ...evidence }) {
    const normalized = this.normalizeRunReconciliation(evidence);
    const requestFingerprint = reconciliationRequestFingerprint({
      action: 'resolve_cost_only', outputAssetVersionId: null, ...normalized
    });
    return this.transaction(() => {
      const replay = this.reconciliationReplay({
        idempotencyKey: normalized.idempotencyKey, runId, requestFingerprint
      });
      if (replay) {
        if (['failed', 'succeeded'].includes(replay.run?.status)
          && replay.run?.cost_source !== 'unknown') {
          this.resolveClassicRecoveryInTransaction(runId);
        }
        return replay;
      }
      const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
      if (!run) throw dbError('Run not found.', 'run_not_found', 404);
      if (run.provider !== 'miguo' || !['failed', 'succeeded'].includes(run.status)
        || run.cost_source !== 'unknown') {
        throw dbError(
          'Only a completed or held real Miguo run with unknown cost can be reconciled.',
          'run_not_reconcilable',
          409
        );
      }
      this.assertClassicRecoveryLeaseInTransaction(runId, recoveryLeaseOwner);
      this.assertRunProviderIdentity(run, normalized);
      const providerRequestId = normalized.providerRequestId || run.provider_request_id || null;
      const providerTaskId = normalized.providerTaskId || run.provider_task_id || null;
      const resultShapeFingerprint = normalized.resultShapeFingerprint
        || run.provider_result_shape_fingerprint || null;
      const event = this.insertRunReconciliationEvent({
        run,
        actorUserId,
        requestFingerprint,
        action: 'resolve_cost_only',
        outputAssetVersionId: null,
        ...normalized,
        providerRequestId,
        providerTaskId,
        resultShapeFingerprint
      });
      this.db.prepare(`
        UPDATE run_attempts SET
          provider_request_id = COALESCE(provider_request_id, ?),
          provider_task_id = COALESCE(provider_task_id, ?),
          provider_result_shape_fingerprint = COALESCE(provider_result_shape_fingerprint, ?),
          cost_points = ?, cost_source = ?
        WHERE id = ? AND status IN ('failed','succeeded') AND cost_source = 'unknown'
      `).run(
        providerRequestId, providerTaskId, resultShapeFingerprint,
        normalized.costPoints, normalized.costSource, runId
      );
      this.resolveClassicRecoveryInTransaction(runId);
      return { run: this.getRun(runId), event, deduplicated: false };
    });
  }

  attachExistingOutputToClassicRun({
    runId, outputAssetVersionId, actorUserId = null,
    verifiedOutputHost = null, verifiedOutputRawSha256 = null,
    recoveryLeaseOwner = null, ...evidence
  }) {
    const outputId = boundedText(outputAssetVersionId, 'outputAssetVersionId', { minimum: 1, maximum: 200 });
    const normalized = this.normalizeRunReconciliation(evidence);
    const verifiedHost = verifiedOutputHost == null ? null
      : boundedText(verifiedOutputHost, 'verifiedOutputHost', { minimum: 1, maximum: 253 });
    const verifiedRawSha256 = verifiedOutputRawSha256 == null ? null
      : boundedText(verifiedOutputRawSha256, 'verifiedOutputRawSha256', { minimum: 64, maximum: 64 });
    if (verifiedHost && !FACTORY_OUTPUT_HOSTS.has(verifiedHost)) {
      throw dbError('The verified output host is not approved for Factory.', 'reconciliation_output_mismatch', 409);
    }
    if (verifiedRawSha256 && !/^[0-9a-f]{64}$/.test(verifiedRawSha256)) {
      throw dbError('The verified raw output hash is invalid.', 'reconciliation_output_mismatch', 409);
    }
    const requestFingerprint = reconciliationRequestFingerprint({
      action: 'attach_existing_output', outputAssetVersionId: outputId,
      verifiedOutputHost: verifiedHost, verifiedOutputRawSha256: verifiedRawSha256,
      ...normalized
    });
    return this.transaction(() => {
      const replay = this.reconciliationReplay({
        idempotencyKey: normalized.idempotencyKey, runId, requestFingerprint
      });
      if (replay) {
        if (replay.run?.status === 'succeeded') this.resolveClassicRecoveryInTransaction(runId);
        return replay;
      }
      const run = this.db.prepare('SELECT * FROM run_attempts WHERE id = ?').get(runId);
      if (!run) throw dbError('Run not found.', 'run_not_found', 404);
      if (run.provider !== 'miguo' || run.status !== 'failed'
        || !['output_missing', 'unknown_outcome', 'malformed_response', 'output_fetch_failed',
          'output_too_large', 'geometry_mismatch'].includes(run.error_code)) {
        throw dbError('This run cannot accept a reconciled existing output.', 'run_not_reconcilable', 409);
      }
      this.assertClassicRecoveryLeaseInTransaction(runId, recoveryLeaseOwner);
      this.assertRunProviderIdentity(run, normalized);
      if (run.cost_source !== 'unknown'
        && (Number(run.cost_points) !== normalized.costPoints || run.cost_source !== normalized.costSource)) {
        throw dbError(
          'The supplied cost evidence conflicts with the previously reconciled run cost.',
          'reconciliation_cost_conflict',
          409
        );
      }
      const asset = this.db.prepare('SELECT * FROM asset_versions WHERE id = ?').get(outputId);
      if (!asset || asset.panel_id !== run.panel_id || asset.stage !== run.stage || asset.status !== 'candidate') {
        throw dbError(
          'The existing output must be a candidate from the same panel and stage.',
          'reconciliation_output_mismatch',
          409
        );
      }
      if (asset.run_attempt_id && asset.run_attempt_id !== run.id) {
        throw dbError('The existing output belongs to another run.', 'reconciliation_output_mismatch', 409);
      }
      const alreadyAttached = this.db.prepare(`
        SELECT id FROM run_attempts WHERE output_asset_version_id = ? AND id <> ? LIMIT 1
      `).get(outputId, run.id);
      if (alreadyAttached) {
        throw dbError('The existing output is already attached to another run.', 'reconciliation_output_mismatch', 409);
      }
      const expectedEdges = parseJson(run.input_versions_json, [])
        .map(({ id, role }) => `${role}:${id}`).sort();
      const actualEdges = this.db.prepare(`
        SELECT input_asset_version_id AS id, role FROM derived_from_edges
        WHERE output_asset_version_id = ? ORDER BY role, input_asset_version_id
      `).all(outputId).map(({ id, role }) => `${role}:${id}`).sort();
      if (json(actualEdges) !== json(expectedEdges)) {
        throw dbError(
          'The existing output provenance does not match the run input snapshot.',
          'reconciliation_output_mismatch',
          409
        );
      }
      const providerRequestId = normalized.providerRequestId || run.provider_request_id || null;
      const providerTaskId = normalized.providerTaskId || run.provider_task_id || null;
      const resultShapeFingerprint = normalized.resultShapeFingerprint
        || run.provider_result_shape_fingerprint || null;
      const assetMetadata = parseJson(asset.metadata_json);
      const outputHost = verifiedHost || assetMetadata.providerOutputHost || null;
      const outputRawSha256 = verifiedRawSha256 || assetMetadata.providerRawSha256 || null;
      if (verifiedHost && assetMetadata.providerOutputHost && verifiedHost !== assetMetadata.providerOutputHost) {
        throw dbError('Verified output host conflicts with asset metadata.', 'reconciliation_output_mismatch', 409);
      }
      if (verifiedRawSha256 && assetMetadata.providerRawSha256
        && verifiedRawSha256 !== assetMetadata.providerRawSha256) {
        throw dbError('Verified output hash conflicts with asset metadata.', 'reconciliation_output_mismatch', 409);
      }
      if (outputHost && !FACTORY_OUTPUT_HOSTS.has(outputHost)) {
        throw dbError('The recovered output host is not approved for Factory.', 'reconciliation_output_mismatch', 409);
      }
      if (outputRawSha256 && !/^[0-9a-f]{64}$/.test(outputRawSha256)) {
        throw dbError('The recovered raw output hash is invalid.', 'reconciliation_output_mismatch', 409);
      }
      const event = this.insertRunReconciliationEvent({
        run,
        actorUserId,
        requestFingerprint,
        action: 'attach_existing_output',
        outputAssetVersionId: outputId,
        outputAssetSha256: asset.sha256,
        outputRawSha256,
        outputHost,
        outputWidth: asset.width,
        outputHeight: asset.height,
        ...normalized,
        providerRequestId,
        providerTaskId,
        resultShapeFingerprint
      });
      this.db.prepare('UPDATE asset_versions SET run_attempt_id = ? WHERE id = ?').run(run.id, outputId);
      this.db.prepare(`
        UPDATE run_attempts SET status = 'succeeded', output_asset_version_id = ?,
          provider_request_id = COALESCE(provider_request_id, ?),
          provider_task_id = COALESCE(provider_task_id, ?),
          provider_result_shape_fingerprint = COALESCE(provider_result_shape_fingerprint, ?),
          provider_phase = 'completed', cost_points = ?, cost_source = ?,
          error_code = NULL, error_message = NULL, finished_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(
        outputId, providerRequestId, providerTaskId, resultShapeFingerprint,
        normalized.costPoints, normalized.costSource, now(), runId
      );
      this.resolveClassicRecoveryInTransaction(runId);
      return { run: this.getRun(runId), event, deduplicated: false };
    });
  }

  retryRun(runId, idempotencyKey) {
    const original = this.getRun(runId);
    if (!original) {
      const error = new Error('Run not found.');
      error.code = 'run_not_found';
      error.statusCode = 404;
      throw error;
    }
    if (original.status !== 'failed') {
      const error = new Error('Only failed runs can be retried.');
      error.code = 'run_not_retryable';
      error.statusCode = 409;
      throw error;
    }
    if (original.error_code === 'unknown_outcome' || original.cost_source === 'unknown'
      || NON_RETRYABLE_RUN_ERRORS.has(original.error_code)) {
      const outputMissing = original.error_code === 'output_missing';
      const error = new Error(outputMissing
        ? 'A paid provider response had no recognized output and cannot be retried automatically.'
        : 'This run has an unknown provider outcome and cannot be retried automatically.');
      error.code = outputMissing ? 'run_not_retryable' : 'unknown_outcome';
      error.statusCode = 409;
      throw error;
    }
    return this.queueRun({
      panelId: original.panel_id,
      stage: original.stage,
      provider: original.provider,
      providerProfile: original.provider_profile,
      providerContractFingerprint: original.provider_contract_fingerprint,
      toolName: original.tool_name,
      params: original.params,
      idempotencyKey,
      inputVersions: original.inputVersions,
      pricingRevision: original.pricing_revision,
      estimatedCostPoints: original.estimated_cost_points,
      providerPhase: original.provider_phase
    });
  }

  cancelQueuedRun(runId) {
    const result = this.db.prepare("UPDATE run_attempts SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), runId);
    return { cancelled: Boolean(result.changes), run: this.getRun(runId) };
  }

  listRunsForBatch(batchId) {
    return this.db.prepare(`
      SELECT r.* FROM run_attempts r
      JOIN panels p ON p.id = r.panel_id
      WHERE p.batch_id = ? ORDER BY r.created_at
    `).all(batchId).map(this.serializeRun);
  }

  saveLayoutExport({ batchId, manifestHash, manifestPath, pages }) {
    const existing = this.db.prepare('SELECT * FROM layout_exports WHERE batch_id = ? AND manifest_hash = ?').get(batchId, manifestHash);
    if (existing) return { ...existing, pages: parseJson(existing.pages_json, []) };
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO layout_exports (id, batch_id, manifest_hash, manifest_path, pages_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, batchId, manifestHash, manifestPath, json(pages), now());
    const created = this.db.prepare('SELECT * FROM layout_exports WHERE id = ?').get(id);
    return { ...created, pages: parseJson(created.pages_json, []) };
  }

  getLayoutExport(id) {
    const entry = this.db.prepare('SELECT * FROM layout_exports WHERE id = ?').get(id);
    return entry ? { ...entry, pages: parseJson(entry.pages_json, []) } : undefined;
  }
}
