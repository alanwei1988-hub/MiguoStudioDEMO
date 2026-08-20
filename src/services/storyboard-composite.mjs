import sharp from 'sharp';
import { sha256 } from '../security.mjs';

const MAX_MASK_COVERAGE = 0.78;
const LEGACY_COMPOSITE_REVISION = 'selective-reference-rgb-lineart-v2';
const INSTANCE_COMPOSITE_REVISION = 'selective-reference-instance-chroma-lineart-v3';
const SOLID_INK_LUMINANCE = 72;
const FADE_INK_LUMINANCE = 205;
const LEGACY_TARGET_STRATEGY = 'storyark-full-page-selective-composite-v1';
const INSTANCE_TARGET_STRATEGY = 'storyboard-reference-instance-composite-v2';
const PROVIDER_CHROMA_THRESHOLD = 10;
const PROVIDER_CHROMA_DILATION_RADIUS = 2;

function compositeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function polygonMarkup(records, fill) {
  return records.flatMap((record) => record.polygons || []).map((polygon) => {
    const points = (polygon.pixels || []).map((point) => `${Number(point.x)},${Number(point.y)}`).join(' ');
    return `<polygon points="${points}" fill="${fill}"/>`;
  }).join('');
}

async function rasterMask(records, width, height) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="black"/>
    ${polygonMarkup(records, 'white')}
  </svg>`);
  return sharp(svg, { density: 72 }).greyscale().raw().toBuffer();
}

async function targetMaskBuffers(target, width, height) {
  if (![LEGACY_TARGET_STRATEGY, INSTANCE_TARGET_STRATEGY].includes(target?.strategy)
    || !Array.isArray(target.regions) || !target.regions.length
    || !Array.isArray(target.protectedRegions)) {
    throw compositeError('storyboard_composite_plan_invalid', 'The StoryArk selective-composite plan is missing or unsupported.');
  }
  if (target.strategy === INSTANCE_TARGET_STRATEGY
    && (!Array.isArray(target.matchedInstances) || !target.matchedInstances.length)) {
    throw compositeError('storyboard_composite_plan_invalid', 'The instance-aware plan has no approved character envelopes.');
  }
  if (target.sourceWidth !== width || target.sourceHeight !== height) {
    throw compositeError('storyboard_composite_geometry_mismatch', 'The selective-composite plan no longer matches the storyboard dimensions.');
  }
  const [declaredRegions, protectedMask, instancePermission] = await Promise.all([
    rasterMask(target.regions, width, height),
    rasterMask(target.protectedRegions, width, height),
    target.strategy === INSTANCE_TARGET_STRATEGY
      ? rasterMask(target.matchedInstances, width, height)
      : Promise.resolve(null)
  ]);
  const pixelCount = width * height;
  const semanticMask = Buffer.alloc(pixelCount);
  const permissionMask = Buffer.alloc(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const protectedAlpha = protectedMask[pixel] / 255;
    const permission = instancePermission ? instancePermission[pixel] : declaredRegions[pixel];
    permissionMask[pixel] = Math.round(permission * (1 - protectedAlpha));
    semanticMask[pixel] = Math.round(
      Math.min(declaredRegions[pixel], permission) * (1 - protectedAlpha)
    );
  }
  return { semanticMask, permissionMask, protectedMask };
}

export async function measureSelectiveStoryboardMask(target, width, height) {
  const { permissionMask: mask } = await targetMaskBuffers(target, width, height);
  let coveredPixels = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] > 0) coveredPixels += 1;
  }
  const pixelCount = width * height;
  const coverage = coveredPixels / pixelCount;
  if (!coveredPixels) {
    throw compositeError('storyboard_composite_mask_empty', 'The approved reference mask contains no pixels.');
  }
  if (coverage > MAX_MASK_COVERAGE) {
    throw compositeError(
      'storyboard_composite_mask_too_broad',
      'The Agent mask covers too much of the storyboard to guarantee that unmatched content stays unchanged.'
    );
  }
  return { mask, coveredPixels, coverage: Number(coverage.toFixed(6)) };
}

async function rgba(buffer, { width = null, height = null } = {}) {
  let pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: 160_000_000 });
  if (width && height) pipeline = pipeline.resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 });
  return pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function visibleRgb(data, offset) {
  const alpha = data[offset + 3] / 255;
  return [
    data[offset] * alpha + 255 * (1 - alpha),
    data[offset + 1] * alpha + 255 * (1 - alpha),
    data[offset + 2] * alpha + 255 * (1 - alpha)
  ];
}

function luminance(red, green, blue) {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

function sourceInkStrength(sourceLuminance) {
  const normalized = Math.max(0, Math.min(
    1,
    (FADE_INK_LUMINANCE - sourceLuminance) / (FADE_INK_LUMINANCE - SOLID_INK_LUMINANCE)
  ));
  return normalized * normalized * (3 - 2 * normalized);
}

function chroma(red, green, blue) {
  return Math.max(red, green, blue) - Math.min(red, green, blue);
}

function dilateMaskWithin(seed, permission, width, height, radius) {
  const output = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (!permission[pixel]) continue;
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          if ((dx * dx) + (dy * dy) > radius * radius) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (seed[yy * width + xx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) output[pixel] = permission[pixel];
    }
  }
  return output;
}

function effectiveInstanceMask({ source, rendered, semanticMask, permissionMask, width, height }) {
  const seed = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (!permissionMask[pixel]) continue;
    const offset = pixel * 4;
    const sourceRgb = visibleRgb(source.data, offset);
    const providerRgb = visibleRgb(rendered.data, offset);
    const sourceChroma = chroma(...sourceRgb);
    const providerChroma = chroma(...providerRgb);
    if (providerChroma >= PROVIDER_CHROMA_THRESHOLD
      && providerChroma - sourceChroma >= PROVIDER_CHROMA_THRESHOLD - 2) {
      seed[pixel] = permissionMask[pixel];
    }
  }
  const expandedEvidence = dilateMaskWithin(
    seed,
    permissionMask,
    width,
    height,
    PROVIDER_CHROMA_DILATION_RADIUS
  );
  const mask = Buffer.alloc(width * height);
  let evidenceExpandedPixels = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = Math.max(semanticMask[pixel], expandedEvidence[pixel]);
    if (expandedEvidence[pixel] && !semanticMask[pixel]) evidenceExpandedPixels += 1;
  }
  return { mask, evidenceExpandedPixels };
}

export async function createSelectiveStoryboardEditMask({ sourceBuffer, target }) {
  const source = await rgba(sourceBuffer);
  const { width, height } = source.info;
  const measured = await measureSelectiveStoryboardMask(target, width, height);
  const alpha = Buffer.alloc(width * height);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = 255 - measured.mask[pixel];
  const white = Buffer.alloc(width * height * 3, 255);
  const buffer = await sharp(white, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  return {
    buffer,
    width,
    height,
    coveredPixels: measured.coveredPixels,
    coverage: measured.coverage,
    semanticCoverage: measured.coverage,
    lineGuardRadius: 0,
    maskRevision: target.strategy === INSTANCE_TARGET_STRATEGY
      ? 'instance-permission-envelope-v3'
      : 'semantic-target-v2'
  };
}

export async function compositeSelectiveStoryboard({ sourceBuffer, renderedBuffer, target }) {
  const source = await rgba(sourceBuffer);
  const { width, height, channels } = source.info;
  if (channels !== 4 || width < 1 || height < 1) {
    throw compositeError('storyboard_composite_input_invalid', 'The storyboard source could not be decoded as RGBA.');
  }
  const renderedMetadata = await sharp(renderedBuffer, { failOn: 'error', limitInputPixels: 160_000_000 }).metadata();
  if (!renderedMetadata.width || !renderedMetadata.height) {
    throw compositeError('storyboard_composite_output_invalid', 'The StoryArk result could not be decoded.');
  }
  const sourceRatio = width / height;
  const renderedRatio = renderedMetadata.width / renderedMetadata.height;
  if (Math.abs(sourceRatio - renderedRatio) / sourceRatio > 0.035) {
    throw compositeError(
      'storyboard_composite_geometry_mismatch',
      'The StoryArk result changed the storyboard aspect ratio and cannot be placed back safely.'
    );
  }
  const rendered = await rgba(renderedBuffer, { width, height });
  const pixelCount = width * height;
  const masks = await targetMaskBuffers(target, width, height);
  const planned = await measureSelectiveStoryboardMask(target, width, height);
  const effective = target.strategy === INSTANCE_TARGET_STRATEGY
    ? effectiveInstanceMask({
      source,
      rendered,
      semanticMask: masks.semanticMask,
      permissionMask: masks.permissionMask,
      width,
      height
    })
    : { mask: masks.semanticMask, evidenceExpandedPixels: 0 };
  const semanticMask = effective.mask;
  let coveredPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (semanticMask[pixel]) coveredPixels += 1;
  }
  if (!coveredPixels) {
    throw compositeError('storyboard_composite_mask_empty', 'The approved reference mask contains no effective pixels.');
  }
  const coverage = Number((coveredPixels / pixelCount).toFixed(6));

  const outputRaw = Buffer.from(source.data);
  const appliedRegions = [];
  let changedPixels = 0;
  let lineProtectedPixels = 0;
  for (const region of target.regions) appliedRegions.push(`${region.panelLocalId}/${region.localId}`);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const maskAlpha = semanticMask[pixel];
    if (!maskAlpha) continue;
    const offset = pixel * 4;
    const sourceRgb = visibleRgb(source.data, offset);
    const providerRgb = visibleRgb(rendered.data, offset);
    const inkStrength = sourceInkStrength(luminance(...sourceRgb));
    if (inkStrength > 0) lineProtectedPixels += 1;
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      // Use Nano/StoryArk's complete colour and lighting inside Terra's approved
      // semantic regions, then restore the original dark line art at the exact
      // source coordinates. This preserves the model's strong rendering without
      // letting it recolour unmatched characters outside the approved masks.
      const lineRestored = providerRgb[channel] * (1 - inkStrength) + sourceRgb[channel] * inkStrength;
      const color = Math.max(0, Math.min(255, Math.round(
        (source.data[offset + channel] * (255 - maskAlpha) + lineRestored * maskAlpha) / 255
      )));
      if (color !== source.data[offset + channel]) changed = true;
      outputRaw[offset + channel] = color;
    }
    outputRaw[offset + 3] = source.data[offset + 3];
    if (changed) changedPixels += 1;
  }

  const buffer = await sharp(outputRaw, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  const verified = await rgba(buffer);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (semanticMask[pixel] !== 0) continue;
    const offset = pixel * 4;
    if (verified.data[offset] !== source.data[offset]
      || verified.data[offset + 1] !== source.data[offset + 1]
      || verified.data[offset + 2] !== source.data[offset + 2]
      || verified.data[offset + 3] !== source.data[offset + 3]) {
      throw compositeError(
        'storyboard_composite_invariant_failed',
        'A pixel outside the approved reference masks changed during composition.'
      );
    }
  }
  return {
    buffer,
    width,
    height,
    coveredPixels,
    coverage,
    changedPixels,
    lineProtectedPixels,
    appliedRegions,
    compositeRevision: target.strategy === INSTANCE_TARGET_STRATEGY
      ? INSTANCE_COMPOSITE_REVISION
      : LEGACY_COMPOSITE_REVISION,
    targetStrategy: target.strategy,
    permissionCoverage: planned.coverage,
    providerEvidenceExpandedPixels: effective.evidenceExpandedPixels,
    outsideMaskChangedPixels: 0,
    sourceSha256: sha256(sourceBuffer),
    renderedSha256: sha256(renderedBuffer),
    outputSha256: sha256(buffer)
  };
}
