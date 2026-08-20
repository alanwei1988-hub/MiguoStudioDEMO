import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  compositeSelectiveStoryboard,
  createSelectiveStoryboardEditMask
} from '../src/services/storyboard-composite.mjs';

const WIDTH = 200;
const HEIGHT = 200;

function polygon(left, top, right, bottom) {
  return {
    normalized: [
      { x: left / WIDTH, y: top / HEIGHT }, { x: right / WIDTH, y: top / HEIGHT },
      { x: right / WIDTH, y: bottom / HEIGHT }, { x: left / WIDTH, y: bottom / HEIGHT }
    ],
    pixels: [
      { x: left, y: top }, { x: right, y: top },
      { x: right, y: bottom }, { x: left, y: bottom }
    ]
  };
}

function target({ broad = false } = {}) {
  return {
    strategy: 'storyark-full-page-selective-composite-v1',
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    matchedRegionCount: 1,
    protectedRegionCount: broad ? 0 : 1,
    regions: [{
      panelLocalId: 'panel-1', localId: 'reference-character', kind: 'character',
      renderOrder: 1, polygons: [broad ? polygon(0, 0, 199, 199) : polygon(0, 0, 100, 150)]
    }],
    protectedRegions: broad ? [] : [{
      panelLocalId: 'panel-1', localId: 'speech', kind: 'speech_bubble',
      polygons: [polygon(40, 40, 80, 80)]
    }]
  };
}

async function pixel(buffer, x, y) {
  const raw = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * raw.info.width + x) * 4;
  return [...raw.data.subarray(offset, offset + 4)];
}

test('selective storyboard composite changes only approved masks and restores source line art', async () => {
  const sourceBuffer = await sharp(Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><rect x="19" y="0" width="3" height="150" fill="black"/></svg>`)).png().toBuffer();
  const renderedBuffer = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 22, g: 126, b: 220, alpha: 1 } }
  }).png().toBuffer();

  const result = await compositeSelectiveStoryboard({ sourceBuffer, renderedBuffer, target: target() });
  const colored = await pixel(result.buffer, 10, 10);
  assert.deepEqual(colored, [22, 126, 220, 255], 'approved white fill receives the complete proposal RGB and lighting');
  assert.deepEqual(await pixel(result.buffer, 20, 10), [0, 0, 0, 255], 'source line art is restored at its exact coordinates');
  assert.deepEqual(await pixel(result.buffer, 60, 60), [255, 255, 255, 255], 'explicit protected region stays byte-identical');
  assert.deepEqual(await pixel(result.buffer, 170, 170), [255, 255, 255, 255], 'outside every mask stays byte-identical');
  assert.ok(result.coverage > 0 && result.coverage < 0.5);
  assert.equal(result.compositeRevision, 'selective-reference-rgb-lineart-v2');
  assert.ok(result.lineProtectedPixels > 0);
  const metadata = await sharp(result.buffer).metadata();
  assert.deepEqual([metadata.width, metadata.height], [WIDTH, HEIGHT], 'finished output keeps the exact storyboard canvas');
  assert.equal(result.sourceSha256.length, 64);
  assert.equal(result.renderedSha256.length, 64);

  const editMask = await createSelectiveStoryboardEditMask({ sourceBuffer, target: target() });
  assert.deepEqual([editMask.width, editMask.height], [WIDTH, HEIGHT]);
  assert.equal(editMask.coverage, editMask.semanticCoverage, 'provider may edit the complete semantic region; line art is restored after rendering');
  assert.equal(editMask.lineGuardRadius, 0);
  assert.equal(editMask.maskRevision, 'semantic-target-v2');
});

test('selective storyboard composite rejects a mask that can overwrite most of the page', async () => {
  const input = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  }).png().toBuffer();
  await assert.rejects(
    compositeSelectiveStoryboard({ sourceBuffer: input, renderedBuffer: input, target: target({ broad: true }) }),
    (error) => error.code === 'storyboard_composite_mask_too_broad'
  );
});

test('instance-aware composite fills two approved lookalikes and their separated parts while protecting a third character', async () => {
  const sourceBuffer = await sharp(Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <path d="M10 10h50v170H10z M75 10h50v170H75z M140 10h50v170h-50z" fill="none" stroke="black" stroke-width="2"/>
  </svg>`)).png().toBuffer();
  const renderedBuffer = await sharp(Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <rect x="10" y="10" width="50" height="170" fill="#168ee4"/>
    <rect x="75" y="10" width="50" height="170" fill="#d57932"/>
    <rect x="140" y="10" width="50" height="170" fill="#168ee4"/>
  </svg>`)).png().toBuffer();
  const instanceTarget = {
    strategy: 'storyboard-reference-instance-composite-v2',
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    matchedRegionCount: 2,
    protectedRegionCount: 1,
    regions: [
      { panelLocalId: 'panel-1', localId: 'first-hair', kind: 'hair', polygons: [polygon(12, 12, 58, 55)] },
      { panelLocalId: 'panel-1', localId: 'second-hair', kind: 'hair', polygons: [polygon(77, 12, 123, 55)] }
    ],
    matchedInstances: [
      { panelLocalId: 'panel-1', localId: 'first', polygons: [polygon(10, 10, 60, 180)] },
      { panelLocalId: 'panel-1', localId: 'second', polygons: [polygon(75, 10, 125, 180)] }
    ],
    protectedRegions: [
      { panelLocalId: 'panel-1', localId: 'third-unmatched', kind: 'unmatched_character', polygons: [polygon(140, 10, 190, 180)] }
    ]
  };

  const result = await compositeSelectiveStoryboard({ sourceBuffer, renderedBuffer, target: instanceTarget });
  assert.deepEqual(await pixel(result.buffer, 30, 130), [22, 142, 228, 255], 'separated arm/bag area of first accepted instance is filled');
  assert.deepEqual(await pixel(result.buffer, 100, 130), [213, 121, 50, 255], 'second accepted lookalike is independently filled');
  assert.deepEqual(await pixel(result.buffer, 165, 130), [255, 255, 255, 255], 'the unmatched third character remains source-identical');
  assert.deepEqual(await pixel(result.buffer, 195, 195), [255, 255, 255, 255], 'pixels outside every approved instance remain source-identical');
  assert.ok(result.providerEvidenceExpandedPixels > 0);
  assert.equal(result.outsideMaskChangedPixels, 0);
  assert.equal(result.targetStrategy, 'storyboard-reference-instance-composite-v2');
  assert.equal(result.compositeRevision, 'selective-reference-instance-chroma-lineart-v3');

  const editMask = await createSelectiveStoryboardEditMask({ sourceBuffer, target: instanceTarget });
  assert.ok(editMask.coverage > 0.4 && editMask.coverage < 0.5,
    'provider permission covers the complete two character instances but not the third');
  assert.equal(editMask.maskRevision, 'instance-permission-envelope-v3');
});
