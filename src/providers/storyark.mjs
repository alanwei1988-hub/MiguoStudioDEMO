import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { assertSafeProviderUrl, redactSensitive, sha256, stableJson } from '../security.mjs';

const STORYARK_HOST = 'storyark.miguocomics.com';
const STORYARK_MCP_PATH = '/api/mcp/v1';
const STORYARK_UPLOAD_PATH = '/api/file/v1/upload/qiniu';
const REQUIRED_TOOLS = Object.freeze(['list_projects', 'storyboard_inference', 'get_storyboard_task']);
const IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const STORYARK_CONNECTION_ID = 'storyark_v3';
export const STORYARK_CONTRACT_FINGERPRINT = '1ac04b096ad0851006d405043a634c0e8a36175c19bcba1515cabebc69746ce0';
const DEFAULT_APPROVED_TOOL_SCHEMAS = Object.freeze({
  list_projects: 'efddc7bd8bbcef73a14eb1ace1ffdaec81e518ef1e13c1e9271d0b8acb694a49',
  storyboard_inference: '208b61f0130a91675a003e64915579330dde3a15b13afbab155107835488ffee',
  get_storyboard_task: 'ee34b1979c49a9ddd688f7d2a16e00b2fc4b1a0d4e95d76be2796a10befe0f87'
});

function codedError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function markUnknownBilling(error, { providerAccepted = false, facts = null } = {}) {
  error.billingOutcome = 'unknown';
  if (providerAccepted) error.providerAccepted = true;
  if (facts?.taskIds?.[0]) error.providerTaskId = facts.taskIds[0];
  if (facts?.requestIds?.[0]) error.providerRequestId = facts.requestIds[0];
  return error;
}

function abortSignal(timeoutMs, externalSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
}

function parseMcpPayload(text) {
  try { return JSON.parse(text); } catch { /* The MCP endpoint may reply as SSE. */ }
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* Ignore heartbeats. */ }
  }
  return events.findLast((event) => event?.result || event?.error) || events.at(-1);
}

function parseJsonString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function normalizeHostList(value) {
  if (value == null) return [STORYARK_HOST];
  if (!Array.isArray(value) || !value.length) {
    throw codedError('StoryArk outputHosts must be a non-empty array of exact host names.', 'config_invalid');
  }
  return [...new Set(value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || /[/?#*@]/.test(entry)) {
      throw codedError('StoryArk outputHosts entries must be exact host names.', 'config_invalid');
    }
    const host = entry.trim().toLowerCase();
    let parsedHost;
    try { parsedHost = new URL(`https://${host}`).hostname; } catch {
      throw codedError('StoryArk outputHosts entries must be valid DNS host names.', 'config_invalid');
    }
    if (net.isIP(host) || parsedHost !== host) {
      throw codedError('StoryArk outputHosts entries must be valid DNS host names.', 'config_invalid');
    }
    return host;
  }))];
}

function validateFixedMcpUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw codedError('StoryArk MCP URL is invalid.', 'config_invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== STORYARK_HOST || url.port
    || url.username || url.password || url.pathname.replace(/\/$/, '') !== STORYARK_MCP_PATH
    || url.search || url.hash) {
    throw codedError('StoryArk MCP URL must use the approved StoryArk HTTPS endpoint.', 'config_invalid');
  }
  return new URL(`https://${STORYARK_HOST}${STORYARK_MCP_PATH}`);
}

function validateIdentifier(value, label, maxLength = 200) {
  if (typeof value !== 'string') throw codedError(`${label} is required.`, 'input_invalid');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw codedError(`${label} is invalid.`, 'input_invalid');
  }
  return normalized;
}

function validateAsset(asset, label) {
  if (!asset || typeof asset !== 'object') throw codedError(`${label} is required.`, 'input_invalid');
  const blobPath = asset.blob_path ?? asset.blobPath;
  const mimeType = asset.mime_type ?? asset.mimeType;
  if (typeof blobPath !== 'string' || !blobPath.trim()) {
    throw codedError(`${label} does not reference a stored asset.`, 'input_invalid');
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw codedError(`${label} must be PNG, JPEG, or WebP.`, 'input_invalid');
  }
  return { ...asset, blobPath, mimeType };
}

function canonicalEchoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return String(rawUrl);
  }
}

function extractUrls(text) {
  if (typeof text !== 'string') return [];
  return (text.match(/https:\/\/[^\s"'<>\\]+/g) || []).map((url) => url.replace(/[),.;\]}]+$/, ''));
}

function collectResultFacts(value, excludedUrls = []) {
  const facts = {
    statuses: [],
    taskIds: [],
    requestIds: [],
    messages: [],
    urls: []
  };
  const excluded = new Set(excludedUrls.map(canonicalEchoUrl));
  const skippedContext = /(arguments?|request(?:_?body)?|inputs?|refer(?:ence)?|storyboard[_-]?(?:image|url))/i;

  const visit = (input, trail = [], depth = 0) => {
    if (depth > 14 || input == null) return;
    if (typeof input === 'string') {
      const parsed = parseJsonString(input);
      if (parsed !== undefined) {
        visit(parsed, trail, depth + 1);
        return;
      }
      const hasUrlContext = trail.some((key) => /(?:output|result|images?|files?|urls?)/i.test(key));
      if (hasUrlContext && !trail.some((key) => skippedContext.test(key))) {
        for (const url of extractUrls(input)) {
          if (!excluded.has(canonicalEchoUrl(url))) facts.urls.push(url);
        }
      }
      return;
    }
    if (Array.isArray(input)) {
      for (const child of input) visit(child, trail, depth + 1);
      return;
    }
    if (typeof input !== 'object') return;

    for (const [rawKey, child] of Object.entries(input)) {
      const key = rawKey.toLowerCase();
      const nextTrail = [...trail, key];
      if (/^(status|state|task_status)$/.test(key) && typeof child === 'string') facts.statuses.push(child);
      if (/^(task_?id|job_?id)$/.test(key) && typeof child === 'string') facts.taskIds.push(child);
      if (/^(request_?id|trace_?id|provider_request_?id)$/.test(key) && typeof child === 'string') facts.requestIds.push(child);
      if (/^(message|error|error_message|detail|reason)$/.test(key) && typeof child === 'string') facts.messages.push(child);
      visit(child, nextTrail, depth + 1);
    }
  };
  visit(value);
  facts.urls = [...new Set(facts.urls)];
  facts.taskIds = [...new Set(facts.taskIds)];
  facts.requestIds = [...new Set(facts.requestIds)];
  return facts;
}

function mappedStatus(statuses, { hasOutputs, hasTaskId, isError }) {
  if (isError) return 'failed';
  const values = statuses.map((raw) => String(raw).trim().toLowerCase());
  if (values.some((value) => /^(failed|failure|error|errored|cancelled|canceled|rejected)$/.test(value))) return 'failed';
  if (values.some((value) => /^(succeeded|success|completed|complete|done|finished)$/.test(value))) return 'succeeded';
  if (values.some((value) => /^(processing|pending|queued|running|submitted|in_progress)$/.test(value))) return 'processing';
  if (hasOutputs) return 'succeeded';
  if (hasTaskId) return 'processing';
  return 'unknown';
}

function findProjectRecords(value) {
  const records = [];
  const visit = (input, depth = 0) => {
    if (depth > 12 || input == null) return;
    if (typeof input === 'string') {
      const parsed = parseJsonString(input);
      if (parsed !== undefined) visit(parsed, depth + 1);
      return;
    }
    if (Array.isArray(input)) {
      for (const child of input) visit(child, depth + 1);
      return;
    }
    if (typeof input !== 'object') return;
    const id = input.project_id ?? input.projectId ?? input.id;
    if (typeof id === 'string' && id.trim()) {
      const name = input.project_name ?? input.projectName ?? input.name ?? '';
      const description = input.description ?? input.project_description ?? '';
      records.push({ id, name, description });
    }
    for (const child of Object.values(input)) visit(child, depth + 1);
  };
  visit(value);
  const seen = new Set();
  return records.filter((record) => !seen.has(record.id) && seen.add(record.id)).slice(0, 50);
}

async function readResponseLimited(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw codedError('StoryArk output exceeds the 50 MB safety limit.', 'output_too_large');
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw codedError('StoryArk output exceeds the 50 MB safety limit.', 'output_too_large');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw codedError('StoryArk output exceeds the 50 MB safety limit.', 'output_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export class StoryArkProvider {
  constructor({ config, assetService, fetchImpl = globalThis.fetch, urlGuard = assertSafeProviderUrl }) {
    if (!config || typeof config !== 'object') throw codedError('StoryArk configuration is required.', 'config_invalid');
    if (typeof fetchImpl !== 'function') throw codedError('A fetch implementation is required.', 'config_invalid');
    this.config = config;
    this.assetService = assetService;
    this.fetch = fetchImpl;
    this.urlGuard = urlGuard;
    this.mcpUrl = validateFixedMcpUrl(config.mcpUrl);
    this.origin = this.mcpUrl.origin;
    this.timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 60_000;
    this.outputHosts = normalizeHostList(config.outputHosts);
    this.approvedToolSchemas = config.approvedToolSchemas || DEFAULT_APPROVED_TOOL_SCHEMAS;
    this.knownSecrets = [config.accountId, config.apiToken].filter(Boolean);
    this.sessionId = null;
    this.capabilitySnapshot = null;
    this.initializationPromise = null;
  }

  assertConfigured() {
    if (typeof this.config.accountId !== 'string' || !this.config.accountId.trim()
      || typeof this.config.apiToken !== 'string' || !this.config.apiToken.trim()) {
      throw codedError('StoryArk credentials are not configured.', 'auth_invalid');
    }
  }

  assertExecutionEnabled() {
    this.assertConfigured();
    if (!this.config.allowRealProvider || !this.config.internalUseAcknowledged) {
      throw codedError('StoryArk generation is blocked by the two internal P0 safety gates.', 'real_provider_blocked');
    }
  }

  headers(extra = {}) {
    return {
      'x-api-user': this.config.accountId,
      'x-api-token': this.config.apiToken,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...extra
    };
  }

  async assertEndpoint(url, expectedPath) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== STORYARK_HOST || parsed.port
      || parsed.pathname !== expectedPath || parsed.search || parsed.hash) {
      throw codedError('StoryArk request target is not approved.', 'unsafe_provider_url');
    }
    await this.urlGuard(parsed.href, [STORYARK_HOST]);
    return parsed;
  }

  async rpc(method, params = {}, { signal, sideEffecting = false } = {}) {
    this.assertConfigured();
    await this.assertEndpoint(this.mcpUrl.href, STORYARK_MCP_PATH);
    let response;
    try {
      response = await this.fetch(this.mcpUrl.href, {
        method: 'POST',
        redirect: 'manual',
        headers: this.headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: abortSignal(this.timeoutMs, signal)
      });
    } catch (cause) {
      const interrupted = codedError(
        sideEffecting ? 'StoryArk request was interrupted; the provider outcome may be unknown.' : 'StoryArk request could not be completed.',
        sideEffecting ? 'unknown_outcome' : (cause?.name === 'AbortError' || cause?.name === 'TimeoutError' ? 'network_timeout_retryable' : 'provider_unavailable')
      );
      throw sideEffecting ? markUnknownBilling(interrupted) : interrupted;
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      throw codedError(
        sideEffecting ? 'StoryArk redirected a submitted request; the provider outcome may be unknown.' : 'StoryArk endpoint redirects are not allowed.',
        sideEffecting ? 'unknown_outcome' : 'unsafe_provider_redirect'
      );
    }
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    let text;
    try { text = await response.text(); } catch {
      const interrupted = codedError(
        sideEffecting ? 'StoryArk response was interrupted; the provider outcome may be unknown.' : 'StoryArk response was interrupted.',
        sideEffecting ? 'unknown_outcome' : 'provider_unavailable'
      );
      throw sideEffecting
        ? markUnknownBilling(interrupted, { providerAccepted: true })
        : interrupted;
    }
    const payload = parseMcpPayload(text);
    if (!payload) {
      const malformed = codedError(
        sideEffecting ? 'StoryArk returned an unreadable response; the provider outcome may be unknown.' : 'StoryArk returned an unreadable response.',
        sideEffecting ? 'unknown_outcome' : 'malformed_response'
      );
      throw sideEffecting
        ? markUnknownBilling(malformed, { providerAccepted: true })
        : malformed;
    }
    if (!response.ok || payload.error) {
      const safe = redactSensitive(payload.error || {}, this.knownSecrets);
      const message = typeof safe?.message === 'string' ? safe.message.slice(0, 500) : `StoryArk returned HTTP ${response.status}.`;
      let code = response.status === 401 || response.status === 403 ? 'auth_invalid'
        : response.status === 400 || response.status === 404 || response.status === 422 ? 'input_invalid'
          : response.status === 429 ? 'rate_limited' : 'provider_unavailable';
      if (sideEffecting && !['auth_invalid', 'input_invalid'].includes(code)) {
        code = 'unknown_outcome';
        const facts = collectResultFacts(payload.error || {});
        throw markUnknownBilling(codedError(message, code), { providerAccepted: true, facts });
      }
      throw codedError(message, code);
    }
    return payload.result;
  }

  async ensureInitialized() {
    this.assertConfigured();
    if (this.capabilitySnapshot) return this.capabilitySnapshot;
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const initialized = await this.rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'manga-p0-studio-storyark', version: '0.1.0' }
        });
        const tools = [];
        let cursor;
        for (let page = 0; page < 20; page += 1) {
          const listed = await this.rpc('tools/list', cursor ? { cursor } : {});
          tools.push(...(Array.isArray(listed?.tools) ? listed.tools : []));
          cursor = listed?.nextCursor ?? listed?.next_cursor;
          if (!cursor) break;
          if (page === 19) throw codedError('StoryArk tools/list exceeded the pagination safety limit.', 'malformed_response');
        }
        const available = [...new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'))];
        const missing = REQUIRED_TOOLS.filter((name) => !available.includes(name));
        const schemaDrift = REQUIRED_TOOLS.filter((name) => {
          const tool = tools.find((candidate) => candidate?.name === name);
          return tool && sha256(stableJson(tool.inputSchema || {})) !== this.approvedToolSchemas[name];
        });
        const snapshot = {
          ok: missing.length === 0 && schemaDrift.length === 0,
          providerFamily: 'miguo',
          connectionId: STORYARK_CONNECTION_ID,
          server: initialized?.serverInfo || null,
          protocolVersion: initialized?.protocolVersion || null,
          required: [...REQUIRED_TOOLS],
          available,
          missing,
          schemaDrift,
          schemaFingerprint: sha256(stableJson(tools.map(({ name, inputSchema }) => ({ name, inputSchema }))
            .sort((left, right) => left.name.localeCompare(right.name)))),
          contractFingerprint: STORYARK_CONTRACT_FINGERPRINT
        };
        if (missing.length) throw codedError(`StoryArk is missing required tools: ${missing.join(', ')}.`, 'capability_missing');
        if (schemaDrift.length) {
          const error = codedError(`StoryArk tool schema changed and requires review: ${schemaDrift.join(', ')}.`, 'capability_schema_drift');
          error.details = { schemaDrift };
          throw error;
        }
        this.capabilitySnapshot = snapshot;
        return snapshot;
      })().finally(() => { this.initializationPromise = null; });
    }
    return this.initializationPromise;
  }

  async probe() {
    return this.ensureInitialized();
  }

  async callReadOnlyTool(name, args, signal) {
    await this.ensureInitialized();
    const result = await this.rpc('tools/call', { name, arguments: args }, { signal });
    if (result?.isError) throw codedError(`StoryArk ${name} returned an error result.`, 'provider_tool_error');
    return result;
  }

  async listProjects({ signal } = {}) {
    const result = await this.callReadOnlyTool('list_projects', {}, signal);
    return findProjectRecords(result).map((record) => redactSensitive({
      id: String(record.id).slice(0, 200),
      name: typeof record.name === 'string' ? record.name.slice(0, 300) : '',
      description: typeof record.description === 'string' ? record.description.slice(0, 1_000) : ''
    }, this.knownSecrets));
  }

  async uploadAsset(asset, signal) {
    this.assertExecutionEnabled();
    if (!this.assetService || typeof this.assetService.read !== 'function') {
      throw codedError('StoryArk asset storage is unavailable.', 'provider_unavailable');
    }
    const uploadUrl = `${this.origin}${STORYARK_UPLOAD_PATH}`;
    await this.assertEndpoint(uploadUrl, STORYARK_UPLOAD_PATH);
    const buffer = await this.assetService.read(asset.blobPath);
    const form = new FormData();
    const extension = asset.mimeType === 'image/jpeg' ? 'jpg' : asset.mimeType === 'image/webp' ? 'webp' : 'png';
    form.append('file', new Blob([buffer], { type: asset.mimeType }), `${String(asset.id || 'asset').slice(0, 80)}.${extension}`);
    let response;
    try {
      response = await this.fetch(uploadUrl, {
        method: 'POST', redirect: 'manual', headers: this.headers(), body: form,
        signal: abortSignal(Math.min(this.timeoutMs, 120_000), signal)
      });
    } catch {
      throw codedError('StoryArk image upload was interrupted.', 'network_timeout_retryable');
    }
    if (REDIRECT_STATUSES.has(response.status)) throw codedError('StoryArk upload redirects are not allowed.', 'unsafe_provider_redirect');
    const payload = await response.json().catch(() => null);
    const rawUrl = payload?.data?.url ?? payload?.url;
    if (!response.ok || typeof rawUrl !== 'string') {
      throw codedError(`StoryArk upload failed with HTTP ${response.status}.`, [401, 403].includes(response.status) ? 'auth_invalid' : 'input_image_unreachable');
    }
    let parsed;
    try { parsed = new URL(rawUrl); } catch { throw codedError('StoryArk upload returned an invalid asset URL.', 'malformed_response'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw codedError('StoryArk upload returned an unsafe asset URL.', 'unsafe_output_url');
    }
    return parsed.href;
  }

  async assertOutputUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { throw codedError('StoryArk returned an invalid output URL.', 'unsafe_output_url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !this.outputHosts.includes(url.hostname.toLowerCase())) {
      throw codedError('StoryArk returned an output URL outside the approved hosts.', 'unsafe_output_url');
    }
    await this.urlGuard(url.href, [url.hostname.toLowerCase()]);
    return url;
  }

  async normalizeTaskResult(result, excludedUrls = [], fallbackTaskId = null) {
    const facts = collectResultFacts(result, excludedUrls);
    const outputUrls = [];
    for (const candidate of facts.urls) outputUrls.push((await this.assertOutputUrl(candidate)).href);
    const taskId = facts.taskIds[0] || fallbackTaskId || null;
    const status = mappedStatus(facts.statuses, { hasOutputs: outputUrls.length > 0, hasTaskId: Boolean(taskId), isError: Boolean(result?.isError) });
    const safeMessage = redactSensitive(facts.messages[0] || (status === 'failed' ? 'StoryArk did not return a usable task result.' : ''), this.knownSecrets);
    return {
      status,
      taskId,
      outputUrls: [...new Set(outputUrls)],
      providerRequestId: facts.requestIds[0] || result?._meta?.requestId || result?._meta?.request_id || null,
      message: typeof safeMessage === 'string' ? safeMessage.slice(0, 500) : '',
      contractFingerprint: STORYARK_CONTRACT_FINGERPRINT
    };
  }

  async submitStoryboard({
    projectId,
    storyboardAsset,
    referenceAsset,
    imageSize = '1K',
    expectedResultCount = 1,
    removeBg = false,
    signal
  }) {
    this.assertExecutionEnabled();
    const validatedProjectId = validateIdentifier(projectId, 'projectId');
    if (!IMAGE_SIZES.has(imageSize)) throw codedError('imageSize must be 1K, 2K, or 4K.', 'input_invalid');
    if (!Number.isInteger(expectedResultCount) || expectedResultCount < 1 || expectedResultCount > 4) {
      throw codedError('expectedResultCount must be an integer from 1 to 4.', 'input_invalid');
    }
    if (typeof removeBg !== 'boolean') throw codedError('removeBg must be a boolean.', 'input_invalid');
    const storyboard = validateAsset(storyboardAsset, 'storyboardAsset');
    const reference = validateAsset(referenceAsset, 'referenceAsset');
    await this.ensureInitialized();
    const [storyboardImageUrl, referenceImageUrl] = await Promise.all([
      this.uploadAsset(storyboard, signal),
      this.uploadAsset(reference, signal)
    ]);
    const args = {
      project_id: validatedProjectId,
      storyboard_image_url: storyboardImageUrl,
      refer_image_url: referenceImageUrl,
      image_size: imageSize,
      expected_result_count: expectedResultCount,
      remove_bg: removeBg
    };
    const result = await this.rpc('tools/call', { name: 'storyboard_inference', arguments: args }, { signal, sideEffecting: true });
    try {
      return await this.normalizeTaskResult(result, [storyboardImageUrl, referenceImageUrl]);
    } catch (error) {
      const facts = collectResultFacts(result, [storyboardImageUrl, referenceImageUrl]);
      throw markUnknownBilling(error, { providerAccepted: true, facts });
    }
  }

  async getStoryboardTask(taskId, { signal } = {}) {
    const validatedTaskId = validateIdentifier(taskId, 'taskId');
    const result = await this.callReadOnlyTool('get_storyboard_task', { task_id: validatedTaskId }, signal);
    return this.normalizeTaskResult(result, [], validatedTaskId);
  }

  async downloadOutput(rawUrl, signal) {
    let current = await this.assertOutputUrl(rawUrl);
    const originalHost = current.hostname.toLowerCase();
    let response;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      try {
        response = await this.fetch(current.href, {
          method: 'GET', redirect: 'manual', signal: abortSignal(Math.min(this.timeoutMs, 120_000), signal)
        });
      } catch {
        throw codedError('StoryArk output download failed.', 'output_fetch_failed');
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      if (redirects === 4) throw codedError('StoryArk output exceeded the redirect safety limit.', 'output_fetch_failed');
      const location = response.headers.get('location');
      if (!location) throw codedError('StoryArk output redirect did not provide a location.', 'output_fetch_failed');
      const next = await this.assertOutputUrl(new URL(location, current).href);
      if (next.hostname.toLowerCase() !== originalHost) {
        throw codedError('StoryArk output attempted a cross-host redirect.', 'unsafe_output_redirect');
      }
      current = next;
    }
    if (!response?.ok) throw codedError(`StoryArk output download returned HTTP ${response?.status || 0}.`, 'output_fetch_failed');
    return readResponseLimited(response, MAX_OUTPUT_BYTES);
  }
}
