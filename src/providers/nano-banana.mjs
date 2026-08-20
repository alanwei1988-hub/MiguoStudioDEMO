import sharp from 'sharp';

import { sha256 } from '../security.mjs';

const MAX_RESPONSE_BYTES = 70 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MODEL = 'gemini-3.1-flash-image';

export const NANO_BANANA_CONNECTION_ID = 'studio_relay_nano_banana_2';
export const NANO_BANANA_CONTRACT_FINGERPRINT = 'bb95130cbdf3e4026778233f5fa9dbe98b9aea41f8ce21b03e9ed971f34d398d';
export const NANO_BANANA_RAW_ROUTE_REVISION = 'nano-banana-2-provider-raw-resize-1';
export const NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION = 'nano-banana-2-instance-chroma-composite-3';

function providerError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function markResponseOutcome(error, response) {
  if (response?.ok) {
    error.providerAccepted = true;
    error.billingOutcome = 'unknown';
  }
  return error;
}

function baseUrl(value) {
  let url;
  try { url = new URL(String(value || '').replace(/\/+$/, '') + '/'); } catch {
    throw providerError('image_model_not_configured', 'The Studio image-model relay URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw providerError('image_model_not_configured', 'The Studio image-model relay must use a plain HTTPS base URL.');
  }
  return url;
}

async function readLimitedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) throw providerError('output_too_large', 'The image-model response exceeded 70 MB.');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw providerError('output_too_large', 'The image-model response exceeded 70 MB.');
  return text;
}

function decodeOutput(payload) {
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length < 1000 || payload?.data?.length !== 1) {
    throw providerError('output_missing', 'Nano Banana 2 did not return exactly one inline image.');
  }
  const buffer = Buffer.from(encoded.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_OUTPUT_BYTES) {
    throw providerError('output_too_large', 'The Nano Banana 2 output is empty or exceeds 50 MB.');
  }
  return buffer;
}

function renderPrompt(modificationNote = '') {
  return `Edit the FIRST image only. It is the authoritative complete black-and-white manga storyboard page. The SECOND image is the sole approved color reference for matching characters and visible elements.

Every transparent mask island is an approved character instance or one of its approved visible materials. Apply the reference palette to every approved instance, including multiple similar people in the same panel. Within each approved instance, complete all visibly supported hair, face/neck/arm/hand skin, uniform pieces, neckwear, skirt/trousers, socks, shoes, hair accessories, and handheld satchel/handbag body, handle, and strap. Do not stop after coloring only the face, hair, or torso.\n\nWithin the transparent edit mask only, transfer colors and restrained light/shadow that are visibly supported by the SECOND image. Preserve the FIRST image's exact canvas, panel layout, camera angle, body orientation, face direction, pose, gesture, expression, silhouette, contour, black ink, screentone, text, speech bubbles, panel borders, unmatched characters, objects, and backgrounds. Do not rotate, mirror, redraw, replace, move, crop, enlarge, erase, or invent any person or object. A front-facing person must remain front-facing and every limb must remain in the same pixel-space pose. Leave unmatched or uncertain content monochrome. Return the complete page at the original aspect ratio.${modificationNote ? `\n\nOptional user guidance (must not override any preservation rule): ${modificationNote}` : ''}`;
}

export class NanoBananaProvider {
  constructor({ config = {}, assetService, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.assetService = assetService;
    this.fetchImpl = fetchImpl;
  }

  configured() {
    return Boolean(this.config.baseUrl && this.config.apiKey);
  }

  async renderStoryboard({ sourceAsset, referenceAsset, editMask, modificationNote = '', idempotencyKey }) {
    if (!this.config.enabled || !this.config.allowGeneration || !this.config.internalUseAcknowledged) {
      throw providerError('real_provider_blocked', 'Nano Banana 2 generation is disabled by the Studio safety gates.');
    }
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw providerError('image_model_not_configured', 'Nano Banana 2 is not configured.');
    }
    if (!Buffer.isBuffer(editMask) || !editMask.length) {
      throw providerError('storyboard_composite_plan_invalid', 'Nano Banana 2 requires a strict edit mask.');
    }
    const [source, reference] = await Promise.all([
      this.assetService.read(sourceAsset.blob_path),
      this.assetService.read(referenceAsset.blob_path)
    ]);
    if (sha256(source) !== sourceAsset.sha256 || sha256(reference) !== referenceAsset.sha256) {
      throw providerError('asset_integrity_mismatch', 'A Nano Banana 2 input failed its integrity check.');
    }
    const sourceMetadata = await sharp(source, { failOn: 'error' }).metadata();
    const targetSize = sourceMetadata.width / sourceMetadata.height >= 1 ? '1024x768' : '768x1024';
    const form = new FormData();
    form.append('model', this.config.model || MODEL);
    form.append('image[]', new Blob([source], { type: sourceAsset.mime_type }), 'storyboard.png');
    form.append('image[]', new Blob([reference], { type: referenceAsset.mime_type }), 'character-reference.png');
    form.append('mask', new Blob([editMask], { type: 'image/png' }), 'strict-edit-mask.png');
    form.append('prompt', renderPrompt(String(modificationNote || '').trim().slice(0, 500)));
    form.append('size', targetSize);
    form.append('quality', 'medium');
    form.append('output_format', 'png');
    form.append('background', 'opaque');
    form.append('n', '1');

    let response;
    try {
      response = await this.fetchImpl(new URL('images/edits', baseUrl(this.config.baseUrl)), {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        body: form,
        signal: AbortSignal.timeout(this.config.timeoutMs || 600_000)
      });
    } catch (error) {
      throw providerError('unknown_outcome', 'The Nano Banana 2 request outcome is unknown and must not be submitted again automatically.', {
        billingOutcome: 'unknown', providerAccepted: true, cause: error
      });
    }

    let raw;
    try { raw = await readLimitedText(response); } catch (error) {
      if (error?.code === 'output_too_large') throw markResponseOutcome(error, response);
      throw markResponseOutcome(providerError(
        'unknown_outcome',
        'The Nano Banana 2 response was interrupted after submission.',
        { billingOutcome: 'unknown', providerAccepted: true, cause: error }
      ), response);
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
      throw markResponseOutcome(providerError('malformed_response', 'Nano Banana 2 returned malformed JSON.', {
        billingOutcome: response.ok ? 'unknown' : 'not_incurred', providerAccepted: response.ok
      }), response);
    }
    if (!response.ok || payload?.error) {
      const code = response.status === 429 ? 'rate_limited'
        : response.status === 401 || response.status === 403 ? 'auth_invalid' : 'provider_tool_error';
      throw markResponseOutcome(
        providerError(code, 'The Nano Banana 2 relay rejected the image request.'),
        response
      );
    }
    let output;
    try {
      output = decodeOutput(payload);
    } catch (error) {
      throw markResponseOutcome(error, response);
    }
    try {
      const metadata = await sharp(output, { failOn: 'error', limitInputPixels: 160_000_000 }).metadata();
      const outputWidth = metadata.autoOrient?.width || metadata.width;
      const outputHeight = metadata.autoOrient?.height || metadata.height;
      if (!outputWidth || !outputHeight) {
        throw providerError('output_missing', 'Nano Banana 2 returned an undecodable image.');
      }
      const sourceRatio = sourceAsset.width / sourceAsset.height;
      const outputRatio = outputWidth / outputHeight;
      if (Math.abs(sourceRatio - outputRatio) / sourceRatio > 0.04) {
        throw providerError('storyboard_composite_geometry_mismatch', 'Nano Banana 2 changed the page aspect ratio.');
      }
    } catch (error) {
      const coded = ['output_missing', 'storyboard_composite_geometry_mismatch'].includes(error?.code)
        ? error
        : providerError('output_missing', 'Nano Banana 2 returned an undecodable image.', { cause: error });
      throw markResponseOutcome(coded, response);
    }
    return {
      status: 'succeeded',
      outputBuffers: [output],
      providerRequestId: response.headers.get('x-request-id') || response.headers.get('request-id') || null,
      model: this.config.model || MODEL
    };
  }
}
