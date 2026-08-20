import assert from 'node:assert/strict';
import test from 'node:test';

import { StoryArkProvider } from '../src/providers/storyark.mjs';
import { sha256, stableJson } from '../src/security.mjs';

const MCP_URL = 'https://storyark.miguocomics.com/api/mcp/v1';
const REQUIRED_TOOLS = [
  { name: 'list_projects', inputSchema: { type: 'object', properties: {} } },
  { name: 'storyboard_inference', inputSchema: { type: 'object', required: ['project_id'] } },
  { name: 'get_storyboard_task', inputSchema: { type: 'object', required: ['task_id'] } }
];

function responseJson(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

async function fakeUrlGuard(rawUrl, allowedHosts) {
  const url = new URL(rawUrl);
  assert.equal(url.protocol, 'https:');
  assert.ok(allowedHosts.includes(url.hostname), `${url.hostname} should be explicitly allowed`);
  return url;
}

function baseConfig(overrides = {}) {
  return {
    accountId: 'fixture-account',
    apiToken: 'fixture-token-never-sent-to-network',
    mcpUrl: MCP_URL,
    timeoutMs: 5_000,
    allowRealProvider: false,
    internalUseAcknowledged: false,
    outputHosts: ['outputs.example.com'],
    approvedToolSchemas: Object.fromEntries(REQUIRED_TOOLS.map((tool) => [tool.name, sha256(stableJson(tool.inputSchema))])),
    ...overrides
  };
}

function fakeAsset(id) {
  return { id, blob_path: `${id}.png`, mime_type: 'image/png' };
}

function fakeAssetService() {
  return { read: async (relativePath) => Buffer.from(`fixture:${relativePath}`) };
}

function rpcMethod(init) {
  return JSON.parse(init.body).method;
}

function makeCatalogFetch({ sessionId = 'storyark-session', onTool, onUpload } = {}) {
  return async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/file/v1/upload/qiniu') {
      return onUpload ? onUpload(rawUrl, init) : responseJson({ data: { url: 'https://uploads.example.com/input.png' } });
    }
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') {
      return responseJson({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-06-18', serverInfo: { name: 'StoryArk fixture', version: '3.0' }
      } }, { headers: { 'mcp-session-id': sessionId } });
    }
    if (request.method === 'tools/list') {
      return responseJson({ jsonrpc: '2.0', id: request.id, result: { tools: REQUIRED_TOOLS } });
    }
    if (request.method === 'tools/call') return onTool(request.params, init);
    throw new Error(`Unexpected method: ${request.method}`);
  };
}

test('separate StoryArk provider instances never share MCP sessions', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const account = init.headers['x-api-user'];
    seen.push({ account, method: request.method, session: init.headers['mcp-session-id'] || null });
    if (request.method === 'initialize') {
      return responseJson({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }, {
        headers: { 'mcp-session-id': `session-${account}` }
      });
    }
    return responseJson({ jsonrpc: '2.0', id: request.id, result: { tools: REQUIRED_TOOLS } });
  };
  const first = new StoryArkProvider({
    config: baseConfig({ accountId: 'account-one', apiToken: 'token-one' }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });
  const second = new StoryArkProvider({
    config: baseConfig({ accountId: 'account-two', apiToken: 'token-two' }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  const [firstProbe, secondProbe] = await Promise.all([first.probe(), second.probe()]);
  assert.equal(firstProbe.ok, true);
  assert.equal(secondProbe.ok, true);
  assert.match(firstProbe.schemaFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(seen, [
    { account: 'account-one', method: 'initialize', session: null },
    { account: 'account-two', method: 'initialize', session: null },
    { account: 'account-one', method: 'tools/list', session: 'session-account-one' },
    { account: 'account-two', method: 'tools/list', session: 'session-account-two' }
  ]);
});

test('probe, project listing, and task status are read-only while paid submission needs both gates', async () => {
  const calls = [];
  const fetchImpl = makeCatalogFetch({
    onTool(params) {
      calls.push(params.name);
      if (params.name === 'list_projects') {
        return responseJson({ jsonrpc: '2.0', id: 'projects', result: {
          content: [{ type: 'text', text: JSON.stringify({ projects: [
            { project_id: 'project-1', project_name: 'Fixture project', description: 'Safe description' }
          ] }) }]
        } });
      }
      if (params.name === 'get_storyboard_task') {
        return responseJson({ jsonrpc: '2.0', id: 'task', result: {
          structuredContent: { status: 'processing', task_id: params.arguments.task_id }
        } });
      }
      throw new Error('Paid inference must not be called while gates are closed.');
    }
  });
  const provider = new StoryArkProvider({
    config: baseConfig(), assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  assert.equal((await provider.probe()).ok, true);
  assert.deepEqual(await provider.listProjects(), [{
    id: 'project-1', name: 'Fixture project', description: 'Safe description'
  }]);
  const status = await provider.getStoryboardTask('task-1');
  assert.equal(status.status, 'processing');
  assert.equal(status.taskId, 'task-1');
  assert.match(status.contractFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(provider.submitStoryboard({
    projectId: 'project-1', storyboardAsset: fakeAsset('story'), referenceAsset: fakeAsset('reference')
  }), (error) => error.code === 'real_provider_blocked');
  assert.deepEqual(calls, ['list_projects', 'get_storyboard_task']);
});

test('submission validates every paid argument before making a network request', async () => {
  let fetchCount = 0;
  const provider = new StoryArkProvider({
    config: baseConfig({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: fakeAssetService(),
    fetchImpl: async () => { fetchCount += 1; throw new Error('Network must not be reached.'); },
    urlGuard: fakeUrlGuard
  });
  const valid = { projectId: 'project-1', storyboardAsset: fakeAsset('story'), referenceAsset: fakeAsset('reference') };

  await assert.rejects(provider.submitStoryboard({ ...valid, imageSize: '8K' }), (error) => error.code === 'input_invalid');
  await assert.rejects(provider.submitStoryboard({ ...valid, expectedResultCount: 0 }), (error) => error.code === 'input_invalid');
  await assert.rejects(provider.submitStoryboard({ ...valid, expectedResultCount: 1.5 }), (error) => error.code === 'input_invalid');
  await assert.rejects(provider.submitStoryboard({ ...valid, removeBg: 'false' }), (error) => error.code === 'input_invalid');
  await assert.rejects(provider.submitStoryboard({ ...valid, referenceAsset: null }), (error) => error.code === 'input_invalid');
  await assert.rejects(provider.submitStoryboard({ ...valid, projectId: '\u0000bad' }), (error) => error.code === 'input_invalid');
  assert.equal(fetchCount, 0);
});

test('submission normalizes unknown MCP shapes and rejects echoed input URLs as outputs', async () => {
  let uploadNumber = 0;
  let submittedArguments;
  const fetchImpl = makeCatalogFetch({
    sessionId: 'submit-session',
    onUpload(_url, init) {
      assert.equal(init.headers['mcp-session-id'], 'submit-session');
      uploadNumber += 1;
      return responseJson({ data: { url: `https://uploads.example.com/input-${uploadNumber}.png?signature=fixture` } });
    },
    onTool(params) {
      assert.equal(params.name, 'storyboard_inference');
      submittedArguments = params.arguments;
      return responseJson({ jsonrpc: '2.0', id: 'submit', result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'completed',
            task_id: 'story-task-1',
            arguments: {
              storyboard_image_url: params.arguments.storyboard_image_url,
              refer_image_url: params.arguments.refer_image_url
            },
            nested: { outputs: [{ image_url: 'https://outputs.example.com/generated-1.png?signed=yes' }] }
          })
        }],
        _meta: { requestId: 'provider-request-1' }
      } });
    }
  });
  const provider = new StoryArkProvider({
    config: baseConfig({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  const normalized = await provider.submitStoryboard({
    projectId: 'project-1',
    storyboardAsset: fakeAsset('story'),
    referenceAsset: fakeAsset('reference'),
    imageSize: '2K',
    expectedResultCount: 2,
    removeBg: true
  });
  assert.deepEqual(submittedArguments, {
    project_id: 'project-1',
    storyboard_image_url: 'https://uploads.example.com/input-1.png?signature=fixture',
    refer_image_url: 'https://uploads.example.com/input-2.png?signature=fixture',
    image_size: '2K',
    expected_result_count: 2,
    remove_bg: true
  });
  assert.deepEqual(normalized, {
    status: 'succeeded',
    taskId: 'story-task-1',
    outputUrls: ['https://outputs.example.com/generated-1.png?signed=yes'],
    providerRequestId: 'provider-request-1',
    message: '',
    contractFingerprint: normalized.contractFingerprint
  });
  assert.match(normalized.contractFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(normalized.outputUrls.some((url) => url.includes('uploads.example.com')), false);
});

test('an interrupted paid tool call is unknown outcome and never exposes credentials', async () => {
  const secret = 'top-secret-storyark-token';
  const fetchImpl = makeCatalogFetch({
    onUpload() {
      return responseJson({ data: { url: 'https://uploads.example.com/input.png' } });
    },
    onTool(params) {
      assert.equal(params.name, 'storyboard_inference');
      throw new Error(`socket reset near ${secret}`);
    }
  });
  const provider = new StoryArkProvider({
    config: baseConfig({ apiToken: secret, allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  await assert.rejects(provider.submitStoryboard({
    projectId: 'project-1', storyboardAsset: fakeAsset('story'), referenceAsset: fakeAsset('reference')
  }), (error) => {
    assert.equal(error.code, 'unknown_outcome');
    assert.doesNotMatch(String(error), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), new RegExp(secret));
    return true;
  });
});

test('a rejected output URL preserves the accepted StoryArk task id for recovery', async () => {
  const fetchImpl = makeCatalogFetch({
    onUpload() {
      return responseJson({ data: { url: 'https://uploads.example.com/input.png' } });
    },
    onTool(params) {
      assert.equal(params.name, 'storyboard_inference');
      return responseJson({ jsonrpc: '2.0', id: 'submit', result: {
        structuredContent: {
          status: 'completed',
          task_id: 'recoverable-task-1',
          outputs: [{ image_url: 'https://unapproved.example.com/result.png' }]
        },
        _meta: { requestId: 'recoverable-request-1' }
      } });
    }
  });
  const provider = new StoryArkProvider({
    config: baseConfig({ allowRealProvider: true, internalUseAcknowledged: true }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  await assert.rejects(provider.submitStoryboard({
    projectId: 'project-1', storyboardAsset: fakeAsset('story'), referenceAsset: fakeAsset('reference')
  }), (error) => {
    assert.equal(error.code, 'unsafe_output_url');
    assert.equal(error.providerAccepted, true);
    assert.equal(error.billingOutcome, 'unknown');
    assert.equal(error.providerTaskId, 'recoverable-task-1');
    assert.equal(error.providerRequestId, 'recoverable-request-1');
    return true;
  });
});

test('output download uses no authentication, enforces exact hosts, blocks cross-host redirects, and caps 50 MB', async () => {
  const requests = [];
  const fetchImpl = async (rawUrl, init) => {
    requests.push({ url: rawUrl, headers: init.headers });
    const url = new URL(rawUrl);
    if (url.pathname === '/small.png') return new Response(Buffer.from('fixture-image'), { status: 200 });
    if (url.pathname === '/oversize.png') {
      return new Response(null, { status: 200, headers: { 'content-length': String(50 * 1024 * 1024 + 1) } });
    }
    if (url.pathname === '/redirect.png') {
      return new Response(null, { status: 302, headers: { location: 'https://second.example.com/final.png' } });
    }
    throw new Error(`Unexpected output URL: ${rawUrl}`);
  };
  const provider = new StoryArkProvider({
    config: baseConfig({ outputHosts: ['outputs.example.com', 'second.example.com'] }),
    assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });

  assert.equal((await provider.downloadOutput('https://outputs.example.com/small.png')).toString(), 'fixture-image');
  await assert.rejects(provider.downloadOutput('https://outputs.example.com/oversize.png'), (error) => error.code === 'output_too_large');
  await assert.rejects(provider.downloadOutput('https://outputs.example.com/redirect.png'), (error) => error.code === 'unsafe_output_redirect');
  await assert.rejects(provider.downloadOutput('https://unapproved.example.com/result.png'), (error) => error.code === 'unsafe_output_url');
  assert.ok(requests.every((request) => request.headers === undefined), 'Output downloads must never carry provider credentials.');
});

test('constructor rejects endpoint drift and wildcard output allowlists', () => {
  assert.throws(() => new StoryArkProvider({
    config: baseConfig({ mcpUrl: 'https://evil.example.com/api/mcp/v1' }), assetService: fakeAssetService()
  }), (error) => error.code === 'config_invalid');
  assert.throws(() => new StoryArkProvider({
    config: baseConfig({ outputHosts: ['*.example.com'] }), assetService: fakeAssetService()
  }), (error) => error.code === 'config_invalid');
});

test('StoryArk schema drift fails closed before any paid generation call', async () => {
  const driftedTools = REQUIRED_TOOLS.map((tool) => tool.name === 'storyboard_inference'
    ? { ...tool, inputSchema: { ...tool.inputSchema, required: [] } } : tool);
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') {
      return responseJson({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (request.method === 'tools/list') {
      return responseJson({ jsonrpc: '2.0', id: request.id, result: { tools: driftedTools } });
    }
    throw new Error('tools/call must not be reached after schema drift.');
  };
  const provider = new StoryArkProvider({
    config: baseConfig(), assetService: fakeAssetService(), fetchImpl, urlGuard: fakeUrlGuard
  });
  await assert.rejects(provider.probe(), (error) => {
    assert.equal(error.code, 'capability_schema_drift');
    assert.deepEqual(error.details.schemaDrift, ['storyboard_inference']);
    return true;
  });
});
