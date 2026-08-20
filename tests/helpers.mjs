import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { P0Database } from '../src/db.mjs';
import { toolForStage } from '../src/domain.mjs';
import { MockProvider } from '../src/providers/mock.mjs';
import { AssetService } from '../src/services/assets.mjs';
import { LayoutService } from '../src/services/layout.mjs';
import { RunWorker } from '../src/services/worker.mjs';

export async function createHarness(t, { faultMode = 'none', latencyMs = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-test-'));
  const assetsRoot = path.join(root, 'assets');
  const exportsRoot = path.join(root, 'exports');
  await Promise.all([
    fs.mkdir(assetsRoot, { recursive: true }),
    fs.mkdir(exportsRoot, { recursive: true })
  ]);

  const db = new P0Database(path.join(root, 'p0.sqlite'));
  const assetService = new AssetService({ assetsRoot });
  const mockProvider = new MockProvider({ assetService, faultMode, latencyMs });
  const worker = new RunWorker({
    db,
    assetService,
    providers: { mock: mockProvider },
    concurrency: 1,
    pollMs: 5
  });
  const layoutService = new LayoutService({ db, assetService, exportsRoot });

  t.after(async () => {
    await worker.stop();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  return { root, assetsRoot, exportsRoot, db, assetService, mockProvider, worker, layoutService };
}

export async function makePanelPng({ width = 320, height = 384, seed = 1 } = {}) {
  const hue = (seed * 47) % 255;
  const accent = (seed * 83) % 255;
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="rgb(${30 + (hue % 120)},${45 + (accent % 100)},${80 + (hue % 90)})"/>
      <circle cx="${Math.round(width * 0.35)}" cy="${Math.round(height * 0.35)}" r="${Math.max(4, Math.round(Math.min(width, height) * 0.18))}" fill="rgb(244,220,190)" stroke="rgb(28,25,35)" stroke-width="3"/>
      <path d="M ${Math.round(width * 0.16)} ${Math.round(height * 0.78)} Q ${Math.round(width * 0.5)} ${Math.round(height * 0.42)} ${Math.round(width * 0.84)} ${Math.round(height * 0.78)}" fill="none" stroke="rgb(20,18,26)" stroke-width="4"/>
      <rect x="${Math.round(width * 0.62)}" y="${Math.round(height * 0.16)}" width="${Math.max(5, Math.round(width * 0.14))}" height="${Math.max(6, Math.round(height * 0.22))}" fill="rgb(${120 + (accent % 100)},${40 + (hue % 80)},${70 + (accent % 90)})"/>
    </svg>
  `);
  return sharp(svg)
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
}

export async function addPanelWithSource(harness, {
  batchId,
  ordinal = 1,
  width = 320,
  height = 384,
  seed = ordinal,
  filename = `P0-${String(ordinal).padStart(2, '0')}.png`
}) {
  const panelId = randomUUID();
  const panel = harness.db.addPanel({ panelId, id: panelId, batchId, ordinal, originalFilename: filename });
  const buffer = await makePanelPng({ width, height, seed });
  const normalized = await harness.assetService.normalizeUpload(buffer, {
    batchId,
    panelId,
    originalFilename: filename
  });
  const source = harness.db.createAssetVersion({
    panelId,
    stage: 'source',
    blobPath: normalized.relativePath,
    sha256: normalized.sha256,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    byteSize: normalized.byteSize,
    status: 'approved',
    metadata: normalized.metadata
  });
  return { panel, source };
}

export function queueStage(harness, {
  panelId,
  stage,
  provider = 'mock',
  idempotencyKey = `${panelId}:${stage}:${randomUUID()}`,
  params = {}
}) {
  const inputVersions = harness.db.getRequiredInputs(panelId, stage)
    .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  return harness.db.queueRun({
    panelId,
    stage,
    provider,
    toolName: toolForStage(stage),
    params,
    idempotencyKey,
    inputVersions
  }).run;
}

export async function processNext(harness, expectedRunId) {
  const claimed = harness.db.claimNextQueued();
  assert.ok(claimed, 'Expected a queued run to be claimable.');
  if (expectedRunId) assert.equal(claimed.id, expectedRunId);
  await harness.worker.process(claimed);
  return harness.db.getRun(claimed.id);
}

export async function generateAndPromote(harness, { panelId, stage, idempotencyKey, params }) {
  const queued = queueStage(harness, { panelId, stage, idempotencyKey, params });
  const completed = await processNext(harness, queued.id);
  assert.equal(completed.status, 'succeeded', `${stage} mock run should succeed.`);
  const candidate = harness.db.getAsset(completed.output_asset_version_id);
  assert.equal(candidate.status, 'candidate');
  harness.db.promoteAsset(candidate.id);
  return { run: completed, asset: harness.db.getAsset(candidate.id) };
}

export async function createCandidate(harness, {
  batchId,
  panelId,
  stage,
  inputs,
  width,
  height,
  seed,
  runId = `fixture-${randomUUID()}`
}) {
  const buffer = await makePanelPng({ width, height, seed });
  const ingested = await harness.assetService.ingestGeneratedBuffer(buffer, {
    batchId,
    panelId,
    stage,
    runId,
    expectedWidth: width,
    expectedHeight: height,
    providerMetadata: { provider: 'fixture', deterministic: true }
  });
  return harness.db.createAssetVersion({
    panelId,
    stage,
    parentVersionId: inputs[0]?.id ?? null,
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

export function createApprovedSyntheticChain(harness, { panelId, source }) {
  const common = {
    panelId,
    blobPath: source.blob_path,
    sha256: source.sha256,
    mimeType: source.mime_type,
    width: source.width,
    height: source.height,
    byteSize: source.byte_size,
    status: 'approved',
    metadata: { fixture: true }
  };
  const ink = harness.db.createAssetVersion({
    ...common,
    stage: 'ink',
    parentVersionId: source.id,
    inputEdges: [{ id: source.id, role: 'source' }]
  });
  const color = harness.db.createAssetVersion({
    ...common,
    stage: 'color',
    parentVersionId: ink.id,
    inputEdges: [{ id: ink.id, role: 'ink' }]
  });
  const light = harness.db.createAssetVersion({
    ...common,
    stage: 'light',
    parentVersionId: color.id,
    inputEdges: [
      { id: color.id, role: 'color' },
      { id: ink.id, role: 'ink' }
    ]
  });
  return { source, ink, color, light };
}
