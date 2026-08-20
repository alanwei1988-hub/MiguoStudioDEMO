import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

import { config, ensureRuntimeDirectories } from '../src/config.mjs';
import { P0Database } from '../src/db.mjs';
import { sha256, assertSafeProviderUrl } from '../src/security.mjs';
import { AssetService } from '../src/services/assets.mjs';
import { MIGUO_FACTORY_CONNECTION_ID } from '../src/providers/miguo.mjs';

const FACTORY_ORIGIN = 'https://factory.miguocomics.com';
const FACTORY_OUTPUT_HOST = 'oss.miguocomics.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

const CLASSIC_RECOVERY_PROFILES = Object.freeze([
  Object.freeze({
    stage: 'ink',
    toolName: 'line_art_beautify_v4',
    taskType: 5,
    taskVersion: 'v4',
    inputMetaKey: 'inputImageUrl',
    outputMetaKey: 'outputImageUrl',
    evidenceLabel: 'lineart-v4'
  }),
  Object.freeze({
    stage: 'color',
    toolName: 'coloring_v4',
    taskType: 2,
    taskVersion: 'v4',
    inputMetaKey: 'inputImageUrl',
    outputMetaKey: 'compositedImageUrl',
    evidenceLabel: 'coloring-v4'
  })
]);

function recoveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readBounded(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw recoveryError('response_too_large', 'A recovery response exceeded its safety limit.');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw recoveryError('response_too_large', 'A recovery response exceeded its safety limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchFactoryJson(pathname, { runtimeConfig, fetchImpl }) {
  const url = new URL(pathname, FACTORY_ORIGIN);
  if (url.origin !== FACTORY_ORIGIN || !url.pathname.startsWith('/api/')) {
    throw recoveryError('unsafe_factory_endpoint', 'The recovery endpoint is outside the fixed Factory API origin.');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-api-user': runtimeConfig.miguo.accountId,
        'x-api-token': runtimeConfig.miguo.apiToken,
        accept: 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    });
  } catch (cause) {
    throw recoveryError('factory_read_failed', 'The fixed Factory read-only evidence request failed.', { cause });
  }
  const body = await readBounded(response, MAX_JSON_BYTES);
  if (!response.ok) throw recoveryError('factory_read_failed', `Factory evidence returned HTTP ${response.status}.`);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw recoveryError('factory_evidence_invalid', 'Factory returned invalid JSON evidence.');
  }
}

function taskMeta(detail, taskId, profile) {
  if (Number(detail?.code) !== 0 || !detail?.data || detail.data.taskId !== taskId) {
    throw recoveryError('factory_task_mismatch', 'Factory task detail did not match the requested task.');
  }
  const data = detail.data;
  if (Number(data.type) !== profile.taskType
    || String(data.version).toLowerCase() !== profile.taskVersion) {
    throw recoveryError(
      'factory_task_mismatch',
      `Only a Factory type-${profile.taskType} ${profile.taskVersion} task can recover this ${profile.toolName} run.`
    );
  }
  if (!(data.inferenceChannel === 1 || String(data.inferenceChannel).toLowerCase() === 'slow')) {
    throw recoveryError('factory_task_mismatch', 'This recovery is pinned to the audited slow inference channel.');
  }
  let meta = data.meta;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { throw recoveryError('factory_task_mismatch', 'Factory task metadata was invalid.'); }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || Number(meta.status) !== 2
    || typeof meta[profile.inputMetaKey] !== 'string'
    || typeof meta[profile.outputMetaKey] !== 'string') {
    throw recoveryError('factory_task_not_finished', 'Factory task evidence was not a completed result.');
  }
  // `data.type` is the cross-tool Factory task discriminator. Some tools also
  // expose a tool-internal `meta.taskType` subtype (for example Coloring v4
  // currently returns 0), so it must not be compared with the outer task type.
  const exactOssUrl = (rawUrl, label) => {
    let url;
    try { url = new URL(rawUrl); } catch {
      throw recoveryError('unsafe_output_url', `Factory task ${label} URL was invalid.`);
    }
    if (url.protocol !== 'https:' || url.hostname !== FACTORY_OUTPUT_HOST
      || url.username || url.password || url.port) {
      throw recoveryError('unsafe_output_url', `Factory task ${label} was outside the exact approved OSS host.`);
    }
    return url;
  };
  return {
    data,
    meta,
    inputUrl: exactOssUrl(meta[profile.inputMetaKey], 'input'),
    outputUrl: exactOssUrl(meta[profile.outputMetaKey], 'output')
  };
}

function ledgerEvidence(ledger, taskId) {
  const items = ledger?.data?.items;
  if (!Array.isArray(items)) throw recoveryError('factory_ledger_invalid', 'Factory ledger evidence was invalid.');
  const matches = items.filter((item) => item?.correlationId === taskId);
  if (matches.length !== 1) {
    throw recoveryError('factory_ledger_ambiguous', 'Factory ledger must contain exactly one matching task entry.');
  }
  const entry = matches[0];
  if (Number(entry.type) !== 2 || Number(entry.reason) !== 6 || Number(entry.amount) !== 0) {
    throw recoveryError('factory_cost_not_zero', 'Factory ledger did not confirm a zero-point deduction for this task.');
  }
  return entry;
}

async function downloadExactOss(outputUrl, { fetchImpl, urlGuard }) {
  await urlGuard(outputUrl.href, [FACTORY_OUTPUT_HOST]);
  let response;
  try {
    response = await fetchImpl(outputUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    throw recoveryError('output_fetch_failed', 'The already-generated Factory output could not be downloaded safely.');
  }
  if (!response.ok) throw recoveryError('output_fetch_failed', `Factory output returned HTTP ${response.status}.`);
  return readBounded(response, MAX_OUTPUT_BYTES);
}

function exactFrozenInputs(db, run) {
  const frozen = run.inputVersions;
  const current = db.getRequiredInputs(run.panel_id, run.stage)
    .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  if (JSON.stringify(current) !== JSON.stringify(frozen)) {
    throw recoveryError('input_snapshot_changed', 'The current approved input no longer matches the failed run snapshot.');
  }
  return frozen.map(({ id, role, sha256: expectedSha }) => {
    const asset = db.getAsset(id);
    if (!asset || asset.sha256 !== expectedSha) {
      throw recoveryError('input_asset_mismatch', 'A frozen input asset failed its identity check.');
    }
    return { ...asset, role };
  });
}

function assertRecoverableRun(db, runId, taskId) {
  const run = db.getRun(runId);
  const profile = CLASSIC_RECOVERY_PROFILES.find((candidate) => (
    candidate.stage === run?.stage && candidate.toolName === run?.tool_name
  ));
  if (!run || run.provider !== 'miguo' || run.provider_profile !== MIGUO_FACTORY_CONNECTION_ID
    || !profile
    || run.status !== 'failed' || run.error_code !== 'output_missing' || run.cost_source !== 'unknown') {
    throw recoveryError(
      'run_not_reconcilable',
      'Target run is not a supported failed unknown-cost Factory output_missing attempt.'
    );
  }
  if (run.provider_task_id && run.provider_task_id !== taskId) {
    throw recoveryError('factory_task_mismatch', 'The requested Factory task conflicts with stored run evidence.');
  }
  return { run, profile };
}

export async function recoverClassicTask({
  runtimeConfig = config,
  runId,
  taskId,
  apply = false,
  confirmRunId = null,
  fetchImpl = globalThis.fetch,
  urlGuard = assertSafeProviderUrl
}) {
  if (!runId || !taskId) throw recoveryError('recovery_arguments_required', 'Both runId and taskId are required.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(runId) || !uuid.test(taskId)) {
    throw recoveryError('recovery_arguments_invalid', 'runId and taskId must be exact UUID values.');
  }
  if (runtimeConfig.miguo.allowRealProvider || runtimeConfig.miguo.internalUseAcknowledged) {
    throw recoveryError('classic_gates_must_be_closed', 'Both classic paid-execution gates must be closed during recovery.');
  }
  if (!runtimeConfig.miguo.accountId || !runtimeConfig.miguo.apiToken) {
    throw recoveryError('auth_invalid', 'Factory read-only credentials are required.');
  }
  if (apply && confirmRunId !== runId) {
    throw recoveryError('recovery_confirmation_required', 'Applying recovery requires --confirm-run-id to exactly match --run-id.');
  }

  ensureRuntimeDirectories(runtimeConfig);
  const db = new P0Database(runtimeConfig.databasePath);
  try {
    const { run, profile } = assertRecoverableRun(db, runId, taskId);
    const panel = db.getPanel(run.panel_id);
    const inputs = exactFrozenInputs(db, run);
    const primary = inputs[0];
    if (!panel || !primary) throw recoveryError('input_asset_mismatch', 'The target panel or input asset was missing.');
    const assetService = new AssetService({ assetsRoot: runtimeConfig.assetsRoot });
    for (const input of inputs) {
      const localBytes = await assetService.read(input.blob_path);
      if (sha256(localBytes) !== input.sha256) {
        throw recoveryError('asset_integrity_mismatch', 'A frozen local input asset failed its content hash check.');
      }
    }

    const encodedTaskId = encodeURIComponent(taskId);
    const [detail, ledger] = await Promise.all([
      fetchFactoryJson(`/api/task-history/v1/detail/${encodedTaskId}`, { runtimeConfig, fetchImpl }),
      fetchFactoryJson('/api/coins/v1/transactions/1?pageSize=50&type=2', { runtimeConfig, fetchImpl })
    ]);
    const task = taskMeta(detail, taskId, profile);
    ledgerEvidence(ledger, taskId);
    const [providerInput, buffer] = await Promise.all([
      downloadExactOss(task.inputUrl, { fetchImpl, urlGuard }),
      downloadExactOss(task.outputUrl, { fetchImpl, urlGuard })
    ]);
    if (sha256(providerInput) !== primary.sha256) {
      throw recoveryError(
        'factory_input_mismatch',
        'Factory task input bytes do not match the frozen Studio input asset.'
      );
    }
    const rawSha256 = sha256(buffer);
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 80_000_000 }).rotate();
    const metadata = await image.metadata();
    const width = metadata.autoOrient?.width || metadata.width;
    const height = metadata.autoOrient?.height || metadata.height;
    if (width !== primary.width || height !== primary.height) {
      throw recoveryError(
        'geometry_mismatch',
        `Recovered output dimensions ${width}x${height} do not exactly match ${primary.width}x${primary.height}.`
      );
    }

    const audit = {
      ok: true,
      applied: false,
      runId,
      taskId,
      taskType: Number(task.data.type),
      taskVersion: String(task.data.version),
      stage: run.stage,
      toolName: run.tool_name,
      taskStatus: Number(task.meta.status),
      inferenceChannel: String(task.data.inferenceChannel),
      outputHost: task.outputUrl.hostname,
      outputRawSha256: rawSha256,
      width,
      height,
      confirmedCostPoints: 0,
      costSource: 'no_charge_confirmed'
    };
    if (!apply) return audit;

    const ingested = await assetService.ingestGeneratedBuffer(buffer, {
      batchId: panel.batch_id,
      panelId: panel.id,
      stage: run.stage,
      runId: run.id,
      expectedWidth: primary.width,
      expectedHeight: primary.height,
      providerMetadata: {
        provider: 'miguo',
        providerFamily: 'miguo',
        providerConnectionId: MIGUO_FACTORY_CONNECTION_ID,
        reconciledExistingProviderOutput: true,
        providerTaskId: taskId,
        providerTaskType: profile.taskType,
        providerTaskVersion: profile.taskVersion,
        providerOutputHost: task.outputUrl.hostname,
        providerRawSha256: rawSha256
      }
    });
    let candidate = db.findReusableCandidateForClassicRun(run.id, ingested.sha256);
    if (!candidate) {
      candidate = db.createAssetVersion({
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
    const reconciliation = db.attachExistingOutputToClassicRun({
      runId: run.id,
      outputAssetVersionId: candidate.id,
      idempotencyKey: `recover-classic-task:${run.id}:${taskId}:v1`,
      providerTaskId: taskId,
      verifiedOutputHost: task.outputUrl.hostname,
      verifiedOutputRawSha256: rawSha256,
      costPoints: 0,
      costSource: 'no_charge_confirmed',
      note: 'Recovered a verified completed Factory task without another generation call.',
      evidenceReference: `factory-task:${taskId}:${profile.evidenceLabel};ledger:type2:reason6`
    });
    return {
      ...audit,
      applied: true,
      outputAssetVersionId: candidate.id,
      outputAssetSha256: candidate.sha256,
      reconciliationEventId: reconciliation.event.id
    };
  } finally {
    db.close();
  }
}

function cliArguments(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') result.apply = true;
    else if (argument === '--run-id') result.runId = argv[++index];
    else if (argument === '--task-id') result.taskId = argv[++index];
    else if (argument === '--confirm-run-id') result.confirmRunId = argv[++index];
    else throw recoveryError('invalid_recovery_argument', `Unsupported recovery argument: ${argument}`);
  }
  return result;
}

async function main() {
  try {
    const result = await recoverClassicTask(cliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || 'recovery_failed',
      message: String(error?.message || 'Classic recovery failed.').slice(0, 500)
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
