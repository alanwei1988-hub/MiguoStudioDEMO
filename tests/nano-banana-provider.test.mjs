import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { NanoBananaProvider } from '../src/providers/nano-banana.mjs';
import { sha256 } from '../src/security.mjs';

async function png(width, height, color) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

function response(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

async function fixture() {
  const source = await png(60, 80, { r: 255, g: 255, b: 255, alpha: 1 });
  const reference = await png(30, 60, { r: 42, g: 126, b: 190, alpha: 1 });
  const mask = await png(60, 80, { r: 255, g: 255, b: 255, alpha: 0 });
  const assets = new Map([['source', source], ['reference', reference]]);
  return {
    source, reference, mask,
    sourceAsset: { blob_path: 'source', sha256: sha256(source), mime_type: 'image/png', width: 60, height: 80 },
    referenceAsset: { blob_path: 'reference', sha256: sha256(reference), mime_type: 'image/png', width: 30, height: 60 },
    assetService: { read: async path => assets.get(path) }
  };
}

test('Nano Banana 2 submits one masked edit and accepts one inline image only', async () => {
  const f = await fixture();
  const output = await png(768, 1024, { r: 90, g: 160, b: 210, alpha: 1 });
  let calls = 0;
  const provider = new NanoBananaProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', model: 'gemini-3.1-flash-image',
      enabled: true, allowGeneration: true, internalUseAcknowledged: true, timeoutMs: 30_000
    },
    assetService: f.assetService,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url.toString(), 'https://relay.example/v1/images/edits');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer fixture-secret');
      assert.equal(options.headers['idempotency-key'], 'nano-fixture-key');
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('model'), 'gemini-3.1-flash-image');
      assert.equal(options.body.getAll('image[]').length, 2);
      assert.ok(options.body.get('mask') instanceof Blob);
      assert.match(options.body.get('prompt'), /every approved instance[\s\S]*?multiple similar people in the same panel/);
      assert.match(options.body.get('prompt'), /face\/neck\/arm\/hand skin[\s\S]*?satchel\/handbag body, handle, and strap/);
      assert.match(options.body.get('prompt'), /Optional user guidance[\s\S]*?蓝色更接近参考图/);
      return response({ data: [{ b64_json: output.toString('base64') }] }, { headers: { 'x-request-id': 'req-safe-1' } });
    }
  });

  const result = await provider.renderStoryboard({
    sourceAsset: f.sourceAsset,
    referenceAsset: f.referenceAsset,
    editMask: f.mask,
    modificationNote: '蓝色更接近参考图',
    idempotencyKey: 'nano-fixture-key'
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputBuffers.length, 1);
  assert.equal(result.providerRequestId, 'req-safe-1');
  assert.equal(result.model, 'gemini-3.1-flash-image');
});

test('Nano Banana 2 never retries an uncertain submitted request', async () => {
  const f = await fixture();
  let calls = 0;
  const provider = new NanoBananaProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', model: 'gemini-3.1-flash-image',
      enabled: true, allowGeneration: true, internalUseAcknowledged: true, timeoutMs: 30_000
    },
    assetService: f.assetService,
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); }
  });
  await assert.rejects(
    provider.renderStoryboard({ sourceAsset: f.sourceAsset, referenceAsset: f.referenceAsset, editMask: f.mask }),
    error => error.code === 'unknown_outcome' && error.billingOutcome === 'unknown'
  );
  assert.equal(calls, 1);
});

test('Nano Banana 2 fails closed for disabled gates, multiple outputs, or changed page geometry', async () => {
  const f = await fixture();
  const disabled = new NanoBananaProvider({
    config: { baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', enabled: true },
    assetService: f.assetService,
    fetchImpl: async () => { throw new Error('must not call'); }
  });
  await assert.rejects(
    disabled.renderStoryboard({ sourceAsset: f.sourceAsset, referenceAsset: f.referenceAsset, editMask: f.mask }),
    error => error.code === 'real_provider_blocked'
  );

  const square = await png(500, 500, { r: 30, g: 100, b: 180, alpha: 1 });
  const drift = new NanoBananaProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', model: 'gemini-3.1-flash-image',
      enabled: true, allowGeneration: true, internalUseAcknowledged: true
    },
    assetService: f.assetService,
    fetchImpl: async () => response({ data: [{ b64_json: square.toString('base64') }] })
  });
  await assert.rejects(
    drift.renderStoryboard({ sourceAsset: f.sourceAsset, referenceAsset: f.referenceAsset, editMask: f.mask }),
    error => error.code === 'storyboard_composite_geometry_mismatch'
      && error.providerAccepted === true
      && error.billingOutcome === 'unknown'
  );
});

test('Nano Banana 2 marks every invalid HTTP 2xx output as accepted with unknown billing', async () => {
  const f = await fixture();
  const invalidImage = Buffer.alloc(1_024, 7).toString('base64');
  const provider = new NanoBananaProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', model: 'gemini-3.1-flash-image',
      enabled: true, allowGeneration: true, internalUseAcknowledged: true
    },
    assetService: f.assetService,
    fetchImpl: async () => response({ data: [{ b64_json: invalidImage }] })
  });
  await assert.rejects(
    provider.renderStoryboard({ sourceAsset: f.sourceAsset, referenceAsset: f.referenceAsset, editMask: f.mask }),
    error => error.code === 'output_missing'
      && error.providerAccepted === true
      && error.billingOutcome === 'unknown'
  );

  const valid = await png(768, 1024, { r: 90, g: 160, b: 210, alpha: 1 });
  const multiple = new NanoBananaProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-secret', model: 'gemini-3.1-flash-image',
      enabled: true, allowGeneration: true, internalUseAcknowledged: true
    },
    assetService: f.assetService,
    fetchImpl: async () => response({
      data: [{ b64_json: valid.toString('base64') }, { b64_json: valid.toString('base64') }]
    })
  });
  await assert.rejects(
    multiple.renderStoryboard({ sourceAsset: f.sourceAsset, referenceAsset: f.referenceAsset, editMask: f.mask }),
    error => error.code === 'output_missing'
      && error.providerAccepted === true
      && error.billingOutcome === 'unknown'
  );
});
