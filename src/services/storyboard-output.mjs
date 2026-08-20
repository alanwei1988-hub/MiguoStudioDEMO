import sharp from 'sharp';

import { sha256 } from '../security.mjs';

export const PROVIDER_RAW_RESIZE_REVISION = 'provider-raw-resize-v1';
export const PROVIDER_RAW_ASPECT_RATIO_TOLERANCE = 0.04;

function outputError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

export async function normalizeProviderRawStoryboard({
  providerBuffer,
  sourceWidth,
  sourceHeight
}) {
  if (!Buffer.isBuffer(providerBuffer) || !providerBuffer.length) {
    throw outputError('storyboard_composite_output_invalid', 'The provider raw storyboard output is empty.');
  }
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1) {
    throw outputError('storyboard_composite_geometry_mismatch', 'The source storyboard dimensions are invalid.');
  }

  let metadata;
  try {
    metadata = await sharp(providerBuffer, {
      failOn: 'error',
      limitInputPixels: 160_000_000
    }).metadata();
  } catch (error) {
    throw outputError(
      'storyboard_composite_output_invalid',
      'The provider raw storyboard output could not be decoded.',
      error
    );
  }

  const providerOriginalWidth = metadata.autoOrient?.width || metadata.width;
  const providerOriginalHeight = metadata.autoOrient?.height || metadata.height;
  if (!providerOriginalWidth || !providerOriginalHeight) {
    throw outputError('storyboard_composite_output_invalid', 'The provider raw storyboard has no readable dimensions.');
  }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw outputError('storyboard_composite_output_invalid', 'The provider raw storyboard uses an unsupported image format.');
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const providerRatio = providerOriginalWidth / providerOriginalHeight;
  const aspectRatioDelta = Math.abs(sourceRatio - providerRatio) / sourceRatio;
  if (aspectRatioDelta > PROVIDER_RAW_ASPECT_RATIO_TOLERANCE) {
    throw outputError(
      'storyboard_composite_geometry_mismatch',
      'The provider raw storyboard changed the page aspect ratio beyond the allowed tolerance.'
    );
  }

  let buffer;
  try {
    buffer = await sharp(providerBuffer, {
      failOn: 'error',
      limitInputPixels: 160_000_000
    })
      .rotate()
      .resize(sourceWidth, sourceHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .flatten({ background: '#FFFFFF' })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
  } catch (error) {
    throw outputError(
      'storyboard_composite_output_invalid',
      'The provider raw storyboard could not be normalized safely.',
      error
    );
  }

  return {
    buffer,
    providerRawSha256: sha256(providerBuffer),
    providerOriginalWidth,
    providerOriginalHeight,
    providerOriginalFormat: metadata.format,
    aspectRatioDelta,
    transform: providerOriginalWidth === sourceWidth && providerOriginalHeight === sourceHeight
      ? [1, 0, 0, 1, 0, 0]
      : [sourceWidth / providerOriginalWidth, 0, 0, sourceHeight / providerOriginalHeight, 0, 0],
    resizeFit: 'fill',
    resizeKernel: 'lanczos3',
    postProcess: PROVIDER_RAW_RESIZE_REVISION
  };
}
