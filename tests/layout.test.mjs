import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { GRID_2X2_V1 } from '../src/services/layout.mjs';
import {
  addPanelWithSource,
  createApprovedSyntheticChain,
  createCandidate,
  createHarness
} from './helpers.mjs';

async function readExport(harness, exportId) {
  const record = harness.db.getLayoutExport(exportId);
  const manifestBytes = await harness.layoutService.readExportFile(record.manifest_path);
  const pageBytes = await Promise.all(record.pages.map((page) => harness.layoutService.readExportFile(page.relativePath)));
  return { record, manifestBytes, manifest: JSON.parse(manifestBytes), pageBytes };
}

test('the fixed 2x2 renderer is deterministic, ordinal-driven, and localizes a one-panel update', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('2x2 deterministic acceptance');
  const dimensions = [
    [288, 480], [480, 288], [320, 320], [320, 512],
    [512, 320], [384, 384], [336, 504], [504, 336],
    [416, 416], [352, 528], [528, 352], [360, 480]
  ];
  const chains = new Map();

  // Deliberately insert in reverse completion order. Layout must still use panel ordinal.
  for (let ordinal = 12; ordinal >= 1; ordinal -= 1) {
    const [width, height] = dimensions[ordinal - 1];
    const { panel, source } = await addPanelWithSource(harness, {
      batchId: batch.id,
      ordinal,
      width,
      height,
      seed: ordinal,
      filename: `P0-${String(ordinal).padStart(2, '0')}.png`
    });
    chains.set(ordinal, {
      panel,
      ...createApprovedSyntheticChain(harness, { panelId: panel.id, source })
    });
  }

  const firstSaved = await harness.layoutService.exportBatch(batch.id);
  const first = await readExport(harness, firstSaved.id);
  assert.equal(first.record.pages.length, 3);
  assert.deepEqual(
    first.record.pages.flatMap((page) => page.slots.map((slot) => slot.ordinal)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
  for (const page of first.record.pages) {
    assert.equal(page.width, GRID_2X2_V1.canvas.width);
    assert.equal(page.height, GRID_2X2_V1.canvas.height);
    assert.equal(page.slots.length, 4);
    assert.deepEqual(
      page.slots.map((slot) => ({ x: slot.slotRect.x, y: slot.slotRect.y })),
      GRID_2X2_V1.positions
    );
    for (const slot of page.slots) {
      assert.ok(slot.renderedRect.width <= GRID_2X2_V1.slot.width);
      assert.ok(slot.renderedRect.height <= GRID_2X2_V1.slot.height);
    }
  }

  const firstPanel = chains.get(1);
  const alternateInk = await createCandidate(harness, {
    batchId: batch.id,
    panelId: firstPanel.panel.id,
    stage: 'ink',
    inputs: [{ id: firstPanel.source.id, role: 'source' }],
    width: firstPanel.source.width,
    height: firstPanel.source.height,
    seed: 301
  });
  harness.db.promoteAsset(alternateInk.id);
  assert.equal(harness.db.getBatchDetails(batch.id).exports[0].isOutdated, true, 'A stale selected light makes its export outdated.');
  harness.db.promoteAsset(firstPanel.ink.id);
  assert.equal(harness.db.getBatchDetails(batch.id).exports[0].isOutdated, false, 'Restoring the matching lineage revives the export.');

  // Remove only the export index, then force the exact same snapshot to render again.
  harness.db.db.prepare('DELETE FROM layout_exports WHERE id = ?').run(first.record.id);
  const secondSaved = await harness.layoutService.exportBatch(batch.id);
  const second = await readExport(harness, secondSaved.id);
  assert.equal(second.record.manifest_hash, first.record.manifest_hash);
  assert.deepEqual(second.manifestBytes, first.manifestBytes);
  assert.deepEqual(
    second.record.pages.map((page) => page.pixelSha256),
    first.record.pages.map((page) => page.pixelSha256)
  );
  assert.deepEqual(
    second.record.pages.map((page) => page.sha256),
    first.record.pages.map((page) => page.sha256)
  );
  for (let index = 0; index < first.pageBytes.length; index += 1) {
    assert.deepEqual(second.pageBytes[index], first.pageBytes[index]);
  }

  const changed = chains.get(5);
  const variant = await createCandidate(harness, {
    batchId: batch.id,
    panelId: changed.panel.id,
    stage: 'light',
    inputs: [
      { id: changed.color.id, role: 'color' },
      { id: changed.ink.id, role: 'ink' }
    ],
    width: changed.source.width,
    height: changed.source.height,
    seed: 205
  });
  harness.db.promoteAsset(variant.id);

  const beforeRefresh = harness.db.getBatchDetails(batch.id);
  assert.equal(beforeRefresh.exports[0].isOutdated, true, 'A historical export must be marked outdated after selection changes.');

  const thirdSaved = await harness.layoutService.exportBatch(batch.id);
  const third = await readExport(harness, thirdSaved.id);
  assert.notEqual(third.record.manifest_hash, second.record.manifest_hash);
  assert.equal(third.record.pages[0].sha256, second.record.pages[0].sha256);
  assert.notEqual(third.record.pages[1].sha256, second.record.pages[1].sha256);
  assert.equal(third.record.pages[2].sha256, second.record.pages[2].sha256);
  assert.deepEqual(
    third.record.pages.flatMap((page) => page.slots.map((slot) => slot.ordinal)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
  assert.equal(third.record.pages[1].slots[0].assetVersionId, variant.id);
  assert.equal(harness.db.getBatchDetails(batch.id).exports[0].isOutdated, false);

  harness.db.db.prepare('DELETE FROM layout_exports WHERE id = ?').run(third.record.id);
  await fs.writeFile(harness.assetService.absolute(variant.blob_path), Buffer.from('tampered fixture'));
  await assert.rejects(
    () => harness.layoutService.exportBatch(batch.id),
    (error) => error.code === 'asset_integrity_mismatch'
  );
});
