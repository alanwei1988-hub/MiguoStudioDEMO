import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MiguoProvider, MIGUO_FACTORY_CONNECTION_ID, MIGUO_FACTORY_CONTRACT_FINGERPRINT,
  fingerprintMiguoResultShape
} from '../src/providers/miguo.mjs';
import { sha256, stableJson } from '../src/security.mjs';

const tools = [
  { name: 'line_art_beautify_v4', inputSchema: { type: 'object', required: ['image_url'] } },
  { name: 'coloring_v4', inputSchema: { type: 'object', required: ['input_image_url'] } },
  { name: 'shadowing_v7', inputSchema: { type: 'object', required: ['color_image_url'] } }
];

function config(overrides = {}) {
  return {
    accountId: 'factory-fixture',
    apiToken: 'factory-fixture-token-never-sent',
    mcpUrl: 'https://factory.miguocomics.com/api/mcp/v1',
    timeoutMs: 5_000,
    channel: 'slow',
    allowRealProvider: false,
    internalUseAcknowledged: false,
    outputHosts: ['outputs.example.com'],
    approvedToolSchemas: Object.fromEntries(tools.map((tool) => [tool.name, sha256(stableJson(tool.inputSchema))])),
    ...overrides
  };
}

async function fakeGuard(rawUrl, hosts) {
  const url = new URL(rawUrl);
  assert.ok(hosts.includes(url.hostname));
  return url;
}

function response(body, headers = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

test('Factory capability probe is read-only with paid gates closed and keeps its own MCP session', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    seen.push({ method: payload.method, session: init.headers['mcp-session-id'] || null, redirect: init.redirect });
    if (payload.method === 'initialize') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'factory-session' });
    }
    return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
  };
  const provider = new MiguoProvider({ config: config(), assetService: {}, fetchImpl, urlGuard: fakeGuard });
  const snapshot = await provider.probe();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.connectionId, MIGUO_FACTORY_CONNECTION_ID);
  assert.equal(snapshot.contractFingerprint, '2d40f5dd2bae043fabe2f3701106b17104eac0047ecf5fd9bc12a4b9d8e73792');
  assert.equal(snapshot.contractFingerprint, MIGUO_FACTORY_CONTRACT_FINGERPRINT);
  assert.deepEqual(seen, [
    { method: 'initialize', session: null, redirect: 'error' },
    { method: 'tools/list', session: 'factory-session', redirect: 'error' }
  ]);
  await assert.rejects(provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  }), (error) => error.code === 'real_provider_blocked');
});

test('Factory schema drift fails closed before a paid tool call', async () => {
  const drifted = tools.map((tool) => tool.name === 'coloring_v4'
    ? { ...tool, inputSchema: { ...tool.inputSchema, required: [] } } : tool);
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    return payload.method === 'initialize'
      ? response({ jsonrpc: '2.0', id: payload.id, result: {} })
      : response({ jsonrpc: '2.0', id: payload.id, result: { tools: drifted } });
  };
  const provider = new MiguoProvider({ config: config(), assetService: {}, fetchImpl, urlGuard: fakeGuard });
  await assert.rejects(provider.probe(), (error) => {
    assert.equal(error.code, 'capability_schema_drift');
    assert.deepEqual(error.details.schemaDrift, ['coloring_v4']);
    return true;
  });
});

test('Factory authentication errors redact configured secrets', async () => {
  const secret = 'factory-super-secret-token';
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { message: `bad ${secret}` } }), {
      status: 401, headers: { 'content-type': 'application/json' }
    });
  };
  const provider = new MiguoProvider({
    config: config({ apiToken: secret }), assetService: {}, fetchImpl, urlGuard: fakeGuard
  });
  await assert.rejects(provider.probe(), (error) => {
    assert.equal(error.code, 'auth_invalid');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('Factory marks an unreadable paid response as accepted with unknown billing', async () => {
  let paidCalls = 0;
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-input.png' } });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (payload.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    }
    assert.equal(payload.method, 'tools/call');
    paidCalls += 1;
    return new Response('not-json-or-sse', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  }), (error) => {
    assert.equal(error.code, 'unknown_outcome');
    assert.equal(error.providerAccepted, true);
    assert.equal(error.billingOutcome, 'unknown');
    return true;
  });
  assert.equal(paidCalls, 1);
});

test('Factory rejects an unapproved upload host before any paid tool call with a safe error code', async () => {
  let paidCalls = 0;
  const fetchImpl = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://oss.miguocomics.com/uploaded-input.png' } });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (payload.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    }
    paidCalls += 1;
    return response({ jsonrpc: '2.0', id: payload.id, result: {} });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  }), (error) => {
    assert.equal(error.code, 'unsafe_output_url');
    assert.notEqual(error.billingOutcome, 'unknown');
    return true;
  });
  assert.equal(paidCalls, 0);
});

test('Factory accepts only the evidenced PascalCase output fields and records value-free provider evidence first', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-input.png';
  const outputUrl = 'https://outputs.example.com/final-output.png?signature=never-persist-this';
  const observed = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.href === outputUrl) return new Response(Buffer.from('pascal-case-output'), {
      status: 200, headers: { 'content-type': 'image/png' }
    });
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (payload.method === 'tools/list') {
      return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    }
    return response({
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        _meta: { requestId: 'factory-request-pascal-1' },
        task_id: 'factory-task-pascal-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            Success: true,
            InputImageUrls: [inputUrl],
            OutputImageUrls: [inputUrl, outputUrl],
            ToolName: 'coloring_v4',
            Label: 'fixture',
            Params: { ignored: true }
          })
        }]
      }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }],
    onProviderEvidence: async (evidence) => observed.push(evidence)
  });

  assert.equal(result.buffer.toString(), 'pascal-case-output');
  assert.equal(result.providerRequestId, 'factory-request-pascal-1');
  assert.equal(result.providerTaskId, 'factory-task-pascal-1');
  assert.match(result.resultShapeFingerprint, /^mcp-result-shape-v2:[0-9a-f]{64}$/);
  assert.deepEqual(observed, [{
    providerRequestId: 'factory-request-pascal-1',
    providerTaskId: 'factory-task-pascal-1',
    resultShapeFingerprint: result.resultShapeFingerprint
  }]);
  assert.doesNotMatch(JSON.stringify(observed), /signature=|final-output|uploaded-input/,
    'Persistable evidence must never contain provider URL values.');
});

test('Factory treats embedded Success=false as an accepted tool error and never downloads an output', async () => {
  let downloadCalls = 0;
  let observed = null;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-input.png' } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({
          Success: false,
          OutputImageUrl: 'https://outputs.example.com/should-not-download.png'
        }) }]
      }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }],
    onProviderEvidence: async (evidence) => { observed = evidence; }
  }), (error) => {
    assert.equal(error.code, 'provider_tool_error');
    assert.equal(error.providerAccepted, true);
    assert.equal(error.billingOutcome, 'unknown');
    assert.equal(error.resultShapeFingerprint, observed.resultShapeFingerprint);
    return true;
  });
  assert.equal(downloadCalls, 0);
  assert.match(observed.resultShapeFingerprint, /^mcp-result-shape-v2:[0-9a-f]{64}$/);
});

test('Factory coloring v4 selects the audited lower-camel composited image and ignores ZIP and generic URLs', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-coloring-input.png';
  const outputUrl = 'https://outputs.example.com/composited-coloring-output.png';
  const zipUrl = 'https://outputs.example.com/coloring-layers.zip';
  const genericUrl = 'https://outputs.example.com/generic-not-an-output.png';
  const itemUrl = 'https://outputs.example.com/intermediate-layer.png';
  const downloaded = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.hostname === 'outputs.example.com') {
      downloaded.push(url.href);
      return new Response(Buffer.from('canonical-coloring-output'), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        inputImageUrl: inputUrl,
        compositedImageUrl: outputUrl,
        resultZipFileUrl: zipUrl,
        resultItems: [{ name: 'FlatColor', url: itemUrl }],
        url: genericUrl
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  });

  assert.equal(result.buffer.toString(), 'canonical-coloring-output');
  assert.deepEqual(downloaded, [outputUrl]);
});

test('Factory coloring v4 deduplicates matching canonical and legacy output declarations after removing input echo', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-coloring-input.png';
  const outputUrl = 'https://outputs.example.com/composited-coloring-output.png';
  const downloaded = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.href === outputUrl) {
      downloaded.push(url.href);
      return new Response(Buffer.from('deduplicated-coloring-output'), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { structuredContent: {
        compositedImageUrl: outputUrl,
        OutputImageUrl: outputUrl,
        OutputImageUrls: [inputUrl, outputUrl]
      } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  });

  assert.equal(result.buffer.toString(), 'deduplicated-coloring-output');
  assert.deepEqual(downloaded, [outputUrl]);
});

test('Factory coloring v4 fails closed when canonical and legacy declarations conflict', async () => {
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-coloring-input.png' } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { data: {
        compositedImageUrl: 'https://outputs.example.com/canonical-output.png',
        OutputImageUrls: ['https://outputs.example.com/conflicting-legacy-output.png']
      } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  }), (error) => error.code === 'malformed_response'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory coloring v4 ignores input echo, ZIP, intermediate and generic URLs when no primary output exists', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-coloring-input.png';
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        inputImageUrl: inputUrl,
        compositedImageUrl: inputUrl,
        resultZipFileUrl: 'https://outputs.example.com/layers.zip',
        resultItems: [{ url: 'https://outputs.example.com/intermediate.png' }],
        url: 'https://outputs.example.com/generic.png'
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  }), (error) => error.code === 'output_missing'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory treats embedded lower-camel success=false as an accepted tool error and never downloads a coloring output', async () => {
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-coloring-input.png' } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        success: false,
        compositedImageUrl: 'https://outputs.example.com/should-not-download.png'
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  }), (error) => error.code === 'provider_tool_error'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory shadowing v7 selects the complete preview and ignores raw, overlay, cropped and generic images', async () => {
  const uploadedUrls = [
    'https://outputs.example.com/uploaded-color-input.png',
    'https://outputs.example.com/uploaded-ink-input.png'
  ];
  const previewUrl = 'https://outputs.example.com/complete-shadow-preview.png';
  const rawShadowUrl = 'https://outputs.example.com/raw-shadow-layer.png';
  const overlayUrl = 'https://outputs.example.com/shadow-overlay.png';
  const croppedUrl = 'https://outputs.example.com/cropped-shadow.png';
  const genericUrl = 'https://outputs.example.com/generic-not-an-output.png';
  const downloaded = [];
  let uploadIndex = 0;
  let calledArgs = null;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: uploadedUrls[uploadIndex++] } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloaded.push(url.href);
      return new Response(Buffer.from('complete-shadow-preview'), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    calledArgs = payload.params.arguments;
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        colorImageUrl: uploadedUrls[0],
        lineArtImageUrl: uploadedUrls[1],
        outputPreviewImageUrls: [previewUrl],
        outputShadowImageUrls: [rawShadowUrl],
        outputOverlayImageUrl: overlayUrl,
        outputCroppedShadowImages: [{ imageUrl: croppedUrl, x: 5, y: 7 }],
        url: genericUrl
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'light', params: {}, tool_name: 'shadowing_v7' },
    inputs: [
      { role: 'color', blob_path: 'color.png', mime_type: 'image/png', id: 'color' },
      { role: 'ink', blob_path: 'ink.png', mime_type: 'image/png', id: 'ink' }
    ]
  });

  assert.equal(result.buffer.toString(), 'complete-shadow-preview');
  assert.deepEqual(downloaded, [previewUrl]);
  assert.deepEqual(calledArgs, {
    color_image_url: uploadedUrls[0],
    line_art_image_url: uploadedUrls[1],
    style: 'nvpin',
    color: 'nvpin_rule',
    light: 'top_left',
    shadow_strength: 0.5,
    channel: 'slow'
  });
});

test('Factory shadowing v7 deduplicates matching preview and legacy declarations after removing input echoes', async () => {
  const uploadedUrls = [
    'https://outputs.example.com/uploaded-color-input.png',
    'https://outputs.example.com/uploaded-ink-input.png'
  ];
  const previewUrl = 'https://outputs.example.com/complete-shadow-preview.png';
  const downloaded = [];
  let uploadIndex = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: uploadedUrls[uploadIndex++] } });
    }
    if (url.href === previewUrl) {
      downloaded.push(url.href);
      return new Response(Buffer.from('deduplicated-shadow-preview'), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { structuredContent: {
        outputPreviewImageUrls: [previewUrl],
        OutputImageUrl: previewUrl,
        OutputImageUrls: [...uploadedUrls, previewUrl]
      } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'light', params: {}, tool_name: 'shadowing_v7' },
    inputs: [
      { role: 'color', blob_path: 'color.png', mime_type: 'image/png', id: 'color' },
      { role: 'ink', blob_path: 'ink.png', mime_type: 'image/png', id: 'ink' }
    ]
  });

  assert.equal(result.buffer.toString(), 'deduplicated-shadow-preview');
  assert.deepEqual(downloaded, [previewUrl]);
});

test('Factory shadowing v7 fails closed when canonical and legacy main outputs conflict', async () => {
  const uploadedUrls = [
    'https://outputs.example.com/uploaded-color-input.png',
    'https://outputs.example.com/uploaded-ink-input.png'
  ];
  let uploadIndex = 0;
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: uploadedUrls[uploadIndex++] } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { data: {
        outputPreviewImageUrls: ['https://outputs.example.com/canonical-preview.png'],
        OutputImageUrl: 'https://outputs.example.com/conflicting-legacy-output.png'
      } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'light', params: {}, tool_name: 'shadowing_v7' },
    inputs: [
      { role: 'color', blob_path: 'color.png', mime_type: 'image/png', id: 'color' },
      { role: 'ink', blob_path: 'ink.png', mime_type: 'image/png', id: 'ink' }
    ]
  }), (error) => error.code === 'malformed_response'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory shadowing v7 rejects raw, overlay, cropped, generic and input URLs without a complete preview', async () => {
  const uploadedUrls = [
    'https://outputs.example.com/uploaded-color-input.png',
    'https://outputs.example.com/uploaded-ink-input.png'
  ];
  let uploadIndex = 0;
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: uploadedUrls[uploadIndex++] } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        colorImageUrl: uploadedUrls[0],
        lineArtImageUrl: uploadedUrls[1],
        outputPreviewImageUrls: [uploadedUrls[0]],
        outputShadowImageUrls: ['https://outputs.example.com/raw-shadow-layer.png'],
        outputOverlayImageUrl: 'https://outputs.example.com/shadow-overlay.png',
        outputCroppedShadowImages: [{ imageUrl: 'https://outputs.example.com/cropped-shadow.png', x: 5, y: 7 }],
        url: 'https://outputs.example.com/generic.png'
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'light', params: {}, tool_name: 'shadowing_v7' },
    inputs: [
      { role: 'color', blob_path: 'color.png', mime_type: 'image/png', id: 'color' },
      { role: 'ink', blob_path: 'ink.png', mime_type: 'image/png', id: 'ink' }
    ]
  }), (error) => error.code === 'output_missing'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory result-shape v2 parses embedded JSON while retaining only value-free structure', () => {
  const first = fingerprintMiguoResultShape({
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      compositedImageUrl: 'https://outputs.example.com/first.png?signature=secret-one',
      taskToken: 'secret-one'
    }) }]
  });
  const sameShapeDifferentValues = fingerprintMiguoResultShape({
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({
      success: false,
      compositedImageUrl: 'https://different.example.com/second.png?signature=secret-two',
      taskToken: 'secret-two'
    }) }]
  });
  const differentShape = fingerprintMiguoResultShape({
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      outputImageUrl: 'https://outputs.example.com/line-art.png'
    }) }]
  });

  assert.match(first, /^mcp-result-shape-v2:[0-9a-f]{64}$/);
  assert.equal(first, sameShapeDifferentValues);
  assert.notEqual(first, differentShape);
  assert.doesNotMatch(first, /outputs|different|signature|secret|first|second/);
});

test('Factory keeps multiple PascalCase output URLs fail-closed instead of selecting one arbitrarily', async () => {
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-input.png' } });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        Success: true,
        OutputImageUrls: [
          'https://outputs.example.com/output-a.png',
          'https://outputs.example.com/output-b.png'
        ]
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });
  await assert.rejects(provider.execute({
    run: { stage: 'color', params: {}, tool_name: 'coloring_v4' },
    inputs: [{ role: 'ink', blob_path: 'fixture.png', mime_type: 'image/png', id: 'ink' }]
  }), (error) => error.code === 'malformed_response' && error.providerAccepted === true);
});

test('Factory line-art v4 selects lower-camel outputImageUrl and ignores the facial auxiliary image', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-input.png';
  const outputUrl = 'https://outputs.example.com/line-art-output.png';
  const facialUrl = 'https://outputs.example.com/line-art-facial-output.png';
  const unrelatedUrl = 'https://outputs.example.com/unrelated.png';
  const downloaded = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.hostname === 'outputs.example.com') {
      downloaded.push(url.href);
      return new Response(Buffer.from('line-art-main-output'), {
        status: 200, headers: { 'content-type': 'image/png' }
      });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        success: true,
        inputImageUrl: inputUrl,
        outputImageUrl: outputUrl,
        outputFacialImageUrl: facialUrl,
        url: unrelatedUrl
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  });

  assert.equal(result.buffer.toString(), 'line-art-main-output');
  assert.deepEqual(downloaded, [outputUrl]);
});

test('Factory line-art v4 keeps singular PascalCase OutputImageUrl compatibility', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-input.png';
  const outputUrl = 'https://outputs.example.com/pascal-line-art-output.png';
  const downloaded = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.href === outputUrl) {
      downloaded.push(url.href);
      return new Response(Buffer.from('pascal-line-art-output'), { status: 200 });
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { structuredContent: { OutputImageUrl: outputUrl } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  const result = await provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  });

  assert.equal(result.buffer.toString(), 'pascal-line-art-output');
  assert.deepEqual(downloaded, [outputUrl]);
});

test('Factory line-art v4 fails closed when only input echo, facial and unrelated URLs are present', async () => {
  const inputUrl = 'https://outputs.example.com/uploaded-input.png';
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') return response({ data: { url: inputUrl } });
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({
        inputImageUrl: inputUrl,
        outputImageUrl: inputUrl,
        outputFacialImageUrl: 'https://outputs.example.com/facial-only.png',
        OutputImageUrls: ['https://outputs.example.com/non-contract-array.png'],
        url: 'https://outputs.example.com/unrelated.png'
      }) }] }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  }), (error) => error.code === 'output_missing'
    && error.providerAccepted === true
    && error.billingOutcome === 'unknown');
  assert.equal(downloadCalls, 0);
});

test('Factory line-art v4 rejects conflicting lower-camel and PascalCase main outputs', async () => {
  let downloadCalls = 0;
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/oss') {
      return response({ data: { url: 'https://outputs.example.com/uploaded-input.png' } });
    }
    if (url.hostname === 'outputs.example.com') {
      downloadCalls += 1;
      return new Response(Buffer.from('must-not-download'));
    }
    const payload = JSON.parse(init.body);
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id, result: {} });
    if (payload.method === 'tools/list') return response({ jsonrpc: '2.0', id: payload.id, result: { tools } });
    return response({
      jsonrpc: '2.0', id: payload.id,
      result: { data: {
        outputImageUrl: 'https://outputs.example.com/output-a.png',
        OutputImageUrl: 'https://outputs.example.com/output-b.png'
      } }
    });
  };
  const provider = new MiguoProvider({
    config: config({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: { read: async () => Buffer.from('fixture-input') },
    fetchImpl,
    urlGuard: fakeGuard
  });

  await assert.rejects(provider.execute({
    run: { stage: 'ink', params: {}, tool_name: 'line_art_beautify_v4' },
    inputs: [{ role: 'source', blob_path: 'fixture.png', mime_type: 'image/png', id: 'source' }]
  }), (error) => error.code === 'malformed_response' && error.providerAccepted === true);
  assert.equal(downloadCalls, 0);
});
