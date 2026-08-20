import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addPanelWithSource,
  createCandidate,
  createHarness,
  generateAndPromote
} from './helpers.mjs';

test('mock provider completes ink -> color -> light with aligned immutable assets', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('three-stage mock acceptance');
  const { panel, source } = await addPanelWithSource(harness, {
    batchId: batch.id,
    ordinal: 1,
    width: 320,
    height: 448,
    seed: 11
  });

  const ink = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'ink',
    idempotencyKey: 'p0:panel-1:ink:1'
  });
  const color = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'color',
    idempotencyKey: 'p0:panel-1:color:1'
  });
  const light = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'light',
    idempotencyKey: 'p0:panel-1:light:1'
  });

  const snapshot = harness.db.getPanelSnapshot(panel.id);
  assert.equal(snapshot.current.source.id, source.id);
  assert.equal(snapshot.current.ink.id, ink.asset.id);
  assert.equal(snapshot.current.color.id, color.asset.id);
  assert.equal(snapshot.current.light.id, light.asset.id);
  assert.deepEqual(snapshot.runs.map((run) => run.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(snapshot.runs.reduce((total, run) => total + run.cost_points, 0), 80);

  for (const asset of [source, ink.asset, color.asset, light.asset]) {
    assert.equal(asset.width, source.width);
    assert.equal(asset.height, source.height);
    const actual = await harness.assetService.metadata(asset.blob_path);
    assert.equal(actual.width, source.width);
    assert.equal(actual.height, source.height);
  }

  assert.equal(harness.db.assetDependsOn(ink.asset.id, source.id, 'source'), true);
  assert.equal(harness.db.assetDependsOn(color.asset.id, ink.asset.id, 'ink'), true);
  assert.equal(harness.db.assetDependsOn(light.asset.id, color.asset.id, 'color'), true);
  assert.equal(harness.db.assetDependsOn(light.asset.id, ink.asset.id, 'ink'), true);
});

test('promoting a new upstream candidate makes descendants stale and restoring the old candidate revives them', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('candidate rollback acceptance');
  const { panel, source } = await addPanelWithSource(harness, {
    batchId: batch.id,
    ordinal: 1,
    width: 300,
    height: 400,
    seed: 21
  });

  const firstInk = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'ink',
    idempotencyKey: 'rollback:ink:1'
  });
  const color = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'color',
    idempotencyKey: 'rollback:color:1'
  });
  const light = await generateAndPromote(harness, {
    panelId: panel.id,
    stage: 'light',
    idempotencyKey: 'rollback:light:1'
  });

  const originalRecords = new Map(
    [firstInk.asset, color.asset, light.asset].map((asset) => [asset.id, {
      sha256: asset.sha256,
      blobPath: asset.blob_path,
      bytes: null
    }])
  );
  for (const record of originalRecords.values()) {
    record.bytes = await harness.assetService.read(record.blobPath);
  }

  const secondInk = await createCandidate(harness, {
    batchId: batch.id,
    panelId: panel.id,
    stage: 'ink',
    inputs: [{ id: source.id, role: 'source' }],
    width: source.width,
    height: source.height,
    seed: 99
  });
  assert.notEqual(secondInk.sha256, firstInk.asset.sha256);
  harness.db.promoteAsset(secondInk.id);

  let snapshot = harness.db.getPanelSnapshot(panel.id);
  assert.equal(snapshot.current.ink.id, secondInk.id);
  assert.equal(snapshot.current.ink.status, 'approved');
  assert.equal(snapshot.current.color.id, color.asset.id);
  assert.equal(snapshot.current.color.status, 'stale');
  assert.equal(snapshot.current.light.id, light.asset.id);
  assert.equal(snapshot.current.light.status, 'stale');
  assert.equal(harness.db.getAsset(firstInk.asset.id).status, 'superseded');

  for (const [assetId, before] of originalRecords) {
    const after = harness.db.getAsset(assetId);
    assert.equal(after.sha256, before.sha256, 'Version hashes must never be rewritten.');
    assert.equal(after.blob_path, before.blobPath, 'Version paths must never be rewritten.');
    assert.deepEqual(await harness.assetService.read(after.blob_path), before.bytes);
  }

  harness.db.promoteAsset(firstInk.asset.id);
  snapshot = harness.db.getPanelSnapshot(panel.id);
  assert.equal(snapshot.current.ink.id, firstInk.asset.id);
  assert.equal(snapshot.current.ink.status, 'approved');
  assert.equal(snapshot.current.color.id, color.asset.id);
  assert.equal(snapshot.current.color.status, 'approved');
  assert.equal(snapshot.current.light.id, light.asset.id);
  assert.equal(snapshot.current.light.status, 'approved');
  assert.equal(harness.db.getAsset(secondInk.id).status, 'superseded');
});
