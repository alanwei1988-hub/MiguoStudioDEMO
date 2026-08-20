import { randomUUID } from 'node:crypto';
import { assertSafeProviderUrl, redactSensitive, stableJson, sha256 } from '../security.mjs';
import { factoryClassicContract } from './factory-contracts.mjs';

const COST_ESTIMATE = Object.freeze({
  slow: { ink: 20, color: 30, light: 30 },
  fast: { ink: 60, color: 90, light: 90 }
});

export const MIGUO_FACTORY_CONNECTION_ID = 'factory_classic';
export const MIGUO_FACTORY_CONTRACT_FINGERPRINT = '2d40f5dd2bae043fabe2f3701106b17104eac0047ecf5fd9bc12a4b9d8e73792';
const APPROVED_TOOL_SCHEMAS = Object.freeze({
  line_art_beautify_v4: '54d6c850d3db1054c8a9d5f87c8f3c4980f4a70f77b8f6d7e91a0906d1be724f',
  coloring_v4: '924b819f4fef78c9f295d3866f2eac532e7a0cb0e215c199a2e61067c9b0de57',
  shadowing_v7: '341e89f411e0c1f6a7fbc58d1f4b05462df9f3b81485b25019f8895dde7fed88'
});

export function estimateMiguoPoints(stage, channel = 'slow') {
  return COST_ESTIMATE[channel]?.[stage] ?? 0;
}

function abortSignal(timeoutMs, externalSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
}

const OUTPUT_URL_KEYS = new Set([
  'output_url', 'outputUrl', 'image_url', 'imageUrl', 'result_url', 'resultUrl', 'resultImage', 'url',
  'OutputImageUrl'
]);
const OUTPUT_ARRAY_KEYS = new Set([
  'output_urls', 'outputUrls', 'images', 'results', 'outputs', 'OutputImageUrls'
]);
const LINE_ART_CONTRACT = factoryClassicContract('line_art_beautify_v4', 'ink');
const COLORING_CONTRACT = factoryClassicContract('coloring_v4', 'color');
const SHADOWING_CONTRACT = factoryClassicContract('shadowing_v7', 'light');
const LINE_ART_PRIMARY_OUTPUT_URL_KEYS = new Set(LINE_ART_CONTRACT.mcpPrimaryUrlKeys);
const COLORING_PRIMARY_OUTPUT_URL_KEYS = new Set(COLORING_CONTRACT.mcpPrimaryUrlKeys);
const COLORING_PRIMARY_OUTPUT_ARRAY_KEYS = new Set(COLORING_CONTRACT.mcpPrimaryArrayKeys);
const SHADOWING_PRIMARY_OUTPUT_URL_KEYS = new Set(SHADOWING_CONTRACT.mcpPrimaryUrlKeys);
const SHADOWING_PRIMARY_OUTPUT_ARRAY_KEYS = new Set(SHADOWING_CONTRACT.mcpPrimaryArrayKeys);
const RESULT_CONTAINER_KEYS = new Set([
  'text', 'structuredContent', 'data', 'result', 'content'
]);
const PROVIDER_REQUEST_ID_KEYS = new Set([
  'request_id', 'requestId', 'provider_request_id', 'providerRequestId', 'trace_id', 'traceId'
]);
const PROVIDER_TASK_ID_KEYS = new Set([
  'task_id', 'taskId', 'provider_task_id', 'providerTaskId', 'job_id', 'jobId'
]);

function safeProviderIdentifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /\s|[?#@]/.test(trimmed)) return null;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(trimmed) ? trimmed : null;
}

function collectProviderIdentifiers(value, facts = { requestIds: [], taskIds: [] }, depth = 0, seen = new Set()) {
  if (depth > 10 || value == null) return facts;
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) {
    if (parsed) collectProviderIdentifiers(parsed, facts, depth + 1, seen);
    return facts;
  }
  if (typeof value !== 'object' || seen.has(value)) return facts;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.slice(0, 64).map((child, index) => [String(index), child])
    : Object.entries(value).slice(0, 128);
  for (const [key, child] of entries) {
    const identifier = safeProviderIdentifier(child);
    if (PROVIDER_REQUEST_ID_KEYS.has(key) && identifier && !facts.requestIds.includes(identifier)) {
      facts.requestIds.push(identifier);
    }
    if (PROVIDER_TASK_ID_KEYS.has(key) && identifier && !facts.taskIds.includes(identifier)) {
      facts.taskIds.push(identifier);
    }
    collectProviderIdentifiers(child, facts, depth + 1, seen);
  }
  return facts;
}

function valueFreeShape(value, budget = { nodes: 0 }, depth = 0, seen = new Set(), key = '') {
  budget.nodes += 1;
  if (budget.nodes > 1_024 || depth > 12) return 'truncated';
  if (value === null) return 'null';
  if (typeof value === 'string' && key === 'text') {
    const embedded = parseEmbeddedJson(value);
    if (embedded !== null && embedded !== value) {
      return {
        type: 'embedded-json',
        value: valueFreeShape(embedded, budget, depth + 1, seen)
      };
    }
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return 'circular';
    seen.add(value);
    return {
      type: 'array',
      length: value.length === 0 ? '0' : value.length === 1 ? '1' : value.length <= 8 ? '2-8' : '9+',
      items: value.slice(0, 8).map((child) => valueFreeShape(child, budget, depth + 1, seen, key))
    };
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return 'circular';
    seen.add(value);
    return {
      type: 'object',
      fields: Object.fromEntries(Object.keys(value).sort().slice(0, 128)
        .map((childKey) => [childKey, valueFreeShape(value[childKey], budget, depth + 1, seen, childKey)]))
    };
  }
  if (typeof value === 'string') return value.startsWith('https://') ? 'https-url' : 'string';
  return typeof value;
}

export function fingerprintMiguoResultShape(result) {
  return `mcp-result-shape-v2:${sha256(stableJson(valueFreeShape(result)))}`;
}

function observeProviderResult(result) {
  const identifiers = collectProviderIdentifiers(result);
  return {
    providerRequestId: identifiers.requestIds[0] || null,
    providerTaskId: identifiers.taskIds[0] || null,
    resultShapeFingerprint: fingerprintMiguoResultShape(result)
  };
}

function parseEmbeddedJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^https:\/\/[^\s]+$/.test(trimmed)) return { output_url: trimmed };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function collectDeclaredOutputUrls(value, result = [], key = '') {
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) {
    if (parsed) collectDeclaredOutputUrls(parsed, result, key);
    return result;
  }
  if (Array.isArray(value)) {
    if (!OUTPUT_ARRAY_KEYS.has(key) && key !== 'content') return result;
    for (const child of value) collectDeclaredOutputUrls(child, result, key);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [childKey, child] of Object.entries(value)) {
    if (OUTPUT_URL_KEYS.has(childKey) && typeof child === 'string' && child.startsWith('https://')) {
      result.push(child);
      continue;
    }
    if (childKey === 'text' || childKey === 'structuredContent' || childKey === 'data'
      || childKey === 'result' || childKey === 'content' || OUTPUT_ARRAY_KEYS.has(childKey)) {
      collectDeclaredOutputUrls(child, result, childKey);
    }
  }
  return result;
}

function collectLineArtPrimaryOutputUrls(value, result = [], key = '', depth = 0, seen = new Set()) {
  if (depth > 12 || value == null) return result;
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) {
    if (parsed) collectLineArtPrimaryOutputUrls(parsed, result, key, depth + 1, seen);
    return result;
  }
  if (Array.isArray(value)) {
    if (key !== 'content') return result;
    for (const child of value.slice(0, 64)) {
      collectLineArtPrimaryOutputUrls(child, result, key, depth + 1, seen);
    }
    return result;
  }
  if (typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  for (const [childKey, child] of Object.entries(value).slice(0, 128)) {
    if (LINE_ART_PRIMARY_OUTPUT_URL_KEYS.has(childKey)
      && typeof child === 'string' && child.startsWith('https://')) {
      result.push(child);
      continue;
    }
    if (RESULT_CONTAINER_KEYS.has(childKey)) {
      collectLineArtPrimaryOutputUrls(child, result, childKey, depth + 1, seen);
    }
  }
  return result;
}

function collectColoringPrimaryOutputUrls(value, result = [], key = '', depth = 0, seen = new Set()) {
  if (depth > 12 || value == null) return result;
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) {
    if (parsed) collectColoringPrimaryOutputUrls(parsed, result, key, depth + 1, seen);
    return result;
  }
  if (Array.isArray(value)) {
    if (key !== 'content' && !COLORING_PRIMARY_OUTPUT_ARRAY_KEYS.has(key)) return result;
    for (const child of value.slice(0, 64)) {
      if (COLORING_PRIMARY_OUTPUT_ARRAY_KEYS.has(key)
        && typeof child === 'string' && child.startsWith('https://')) {
        result.push(child);
      } else {
        collectColoringPrimaryOutputUrls(child, result, key, depth + 1, seen);
      }
    }
    return result;
  }
  if (typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  for (const [childKey, child] of Object.entries(value).slice(0, 128)) {
    if (COLORING_PRIMARY_OUTPUT_URL_KEYS.has(childKey)
      && typeof child === 'string' && child.startsWith('https://')) {
      result.push(child);
      continue;
    }
    if (COLORING_PRIMARY_OUTPUT_ARRAY_KEYS.has(childKey) || RESULT_CONTAINER_KEYS.has(childKey)) {
      collectColoringPrimaryOutputUrls(child, result, childKey, depth + 1, seen);
    }
  }
  return result;
}

function collectShadowingPrimaryOutputUrls(value, result = [], key = '', depth = 0, seen = new Set()) {
  if (depth > 12 || value == null) return result;
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) {
    if (parsed) collectShadowingPrimaryOutputUrls(parsed, result, key, depth + 1, seen);
    return result;
  }
  if (Array.isArray(value)) {
    if (key !== 'content' && !SHADOWING_PRIMARY_OUTPUT_ARRAY_KEYS.has(key)) return result;
    for (const child of value.slice(0, 64)) {
      if (SHADOWING_PRIMARY_OUTPUT_ARRAY_KEYS.has(key)
        && typeof child === 'string' && child.startsWith('https://')) {
        result.push(child);
      } else {
        collectShadowingPrimaryOutputUrls(child, result, key, depth + 1, seen);
      }
    }
    return result;
  }
  if (typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  for (const [childKey, child] of Object.entries(value).slice(0, 128)) {
    if (SHADOWING_PRIMARY_OUTPUT_URL_KEYS.has(childKey)
      && typeof child === 'string' && child.startsWith('https://')) {
      result.push(child);
      continue;
    }
    if (SHADOWING_PRIMARY_OUTPUT_ARRAY_KEYS.has(childKey) || RESULT_CONTAINER_KEYS.has(childKey)) {
      collectShadowingPrimaryOutputUrls(child, result, childKey, depth + 1, seen);
    }
  }
  return result;
}

function hasDeclaredToolFailure(value, key = '', depth = 0, seen = new Set()) {
  if (depth > 10 || value == null) return false;
  const parsed = parseEmbeddedJson(value);
  if (parsed !== value) return parsed ? hasDeclaredToolFailure(parsed, key, depth + 1, seen) : false;
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value)
    && ((Object.hasOwn(value, 'Success') && value.Success === false)
      || (Object.hasOwn(value, 'success') && value.success === false))) return true;
  if (Array.isArray(value)) {
    if (!OUTPUT_ARRAY_KEYS.has(key) && key !== 'content') return false;
    return value.slice(0, 64).some((child) => hasDeclaredToolFailure(child, key, depth + 1, seen));
  }
  return Object.entries(value).some(([childKey, child]) => (
    childKey === 'text' || childKey === 'structuredContent' || childKey === 'data'
      || childKey === 'result' || childKey === 'content' || OUTPUT_ARRAY_KEYS.has(childKey)
  ) && hasDeclaredToolFailure(child, childKey, depth + 1, seen));
}

function parseMcpPayload(text) {
  try { return JSON.parse(text); } catch { /* Some MCP servers reply with SSE. */ }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* Ignore non-JSON heartbeat data. */ }
  }
  if (!events.length) return undefined;
  return events.findLast((event) => event?.result || event?.error) || events.at(-1);
}

function normalizeMcpError(error, stage = 'unknown') {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return Object.assign(new Error(`Miguo ${stage} request timed out; outcome may be unknown.`), { code: 'unknown_outcome' });
  }
  if (error?.code) return error;
  return Object.assign(new Error(`Miguo ${stage} request failed.`), { code: 'provider_unavailable', cause: error });
}

function markUnknownBilling(error, { providerAccepted = false } = {}) {
  error.billingOutcome = 'unknown';
  if (providerAccepted) error.providerAccepted = true;
  return error;
}

async function assertPublicHttps(rawUrl, allowedHosts, urlGuard = assertSafeProviderUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw Object.assign(new Error('Provider output URL must use HTTPS.'), { code: 'unsafe_output_url' });
  if (url.username || url.password || url.port) {
    throw Object.assign(new Error('Provider output URL contains forbidden authority fields.'), { code: 'unsafe_output_url' });
  }
  try {
    await urlGuard(url.href, allowedHosts);
  } catch (error) {
    error.code = 'unsafe_output_url';
    throw error;
  }
  return url;
}

export class MiguoProvider {
  constructor({ config, assetService, fetchImpl = globalThis.fetch, urlGuard = assertSafeProviderUrl }) {
    this.config = config;
    this.assetService = assetService;
    this.fetch = fetchImpl;
    this.urlGuard = urlGuard;
    this.approvedToolSchemas = config.approvedToolSchemas || APPROVED_TOOL_SCHEMAS;
    this.origin = new URL(config.mcpUrl).origin;
    this.knownSecrets = [config.accountId, config.apiToken];
    this.sessionId = null;
    this.capabilitySnapshot = null;
    this.initializationPromise = null;
  }

  assertConfigured() {
    if (!this.config.accountId || !this.config.apiToken) {
      throw Object.assign(new Error('Miguo credentials are not configured.'), { code: 'auth_invalid' });
    }
  }

  assertEnabled() {
    this.assertConfigured();
    if (!this.config.allowRealProvider || !this.config.internalUseAcknowledged) {
      throw Object.assign(new Error('Real Miguo calls are blocked by the two internal P0 safety gates.'), { code: 'real_provider_blocked' });
    }
  }

  async assertEndpoint() {
    const url = new URL(this.config.mcpUrl);
    if (url.origin !== 'https://factory.miguocomics.com' || url.pathname !== '/api/mcp/v1'
      || url.search || url.hash || url.username || url.password) {
      throw Object.assign(new Error('The Miguo Factory endpoint is outside the approved fixed route.'), { code: 'provider_not_configured' });
    }
    await this.urlGuard(url.href, ['factory.miguocomics.com']);
  }

  headers(extra = {}) {
    return {
      'x-api-user': this.config.accountId,
      'x-api-token': this.config.apiToken,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...extra
    };
  }

  async rpc(method, params = {}, { signal, paid = method === 'tools/call' } = {}) {
    if (paid) this.assertEnabled();
    else this.assertConfigured();
    await this.assertEndpoint();
    let response;
    try {
      response = await this.fetch(this.config.mcpUrl, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        redirect: 'error',
        signal: abortSignal(this.config.timeoutMs, signal)
      });
    } catch (error) {
      const normalized = normalizeMcpError(error, method);
      if (method === 'tools/call') {
        normalized.code = 'unknown_outcome';
        markUnknownBilling(normalized);
      }
      throw normalized;
    }
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    let text;
    try {
      text = await response.text();
    } catch (error) {
      const interrupted = Object.assign(new Error(`Miguo ${method} response was interrupted.`), {
        code: method === 'tools/call' ? 'unknown_outcome' : 'provider_unavailable',
        cause: error
      });
      throw method === 'tools/call'
        ? markUnknownBilling(interrupted, { providerAccepted: true })
        : interrupted;
    }
    const payload = parseMcpPayload(text);
    if (!payload) {
      const malformed = Object.assign(
        new Error(`Miguo returned an unreadable ${response.status} response.`),
        { code: 'malformed_response' }
      );
      throw method === 'tools/call'
        ? markUnknownBilling(malformed, { providerAccepted: true })
        : malformed;
    }
    if (!response.ok || payload.error) {
      const safe = redactSensitive(payload.error || { status: response.status }, this.knownSecrets);
      const error = new Error(safe?.message || `Miguo returned HTTP ${response.status}.`);
      error.code = response.status === 401 || response.status === 403 ? 'auth_invalid'
        : response.status === 429 ? 'rate_limited'
          : response.status >= 500 ? 'provider_unavailable' : 'input_invalid';
      if (method === 'tools/call' && ![400, 401, 403, 404, 422].includes(response.status)) {
        error.code = 'unknown_outcome';
        markUnknownBilling(error, { providerAccepted: true });
      }
      throw error;
    }
    return payload.result;
  }

  async probe() {
    return this.ensureInitialized();
  }

  async ensureInitialized() {
    if (this.capabilitySnapshot) return this.capabilitySnapshot;
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const initialized = await this.rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'manga-p0-studio', version: '0.1.0' }
        });
        const listed = await this.rpc('tools/list', {});
        const required = Object.keys(APPROVED_TOOL_SCHEMAS);
        const available = (listed?.tools || []).map((tool) => tool.name);
        const missing = required.filter((name) => !available.includes(name));
        const schemaDrift = required.filter((name) => {
          const tool = (listed?.tools || []).find((candidate) => candidate.name === name);
          return tool && sha256(stableJson(tool.inputSchema || {})) !== this.approvedToolSchemas[name];
        });
        const snapshot = {
          ok: missing.length === 0 && schemaDrift.length === 0,
          providerFamily: 'miguo',
          connectionId: MIGUO_FACTORY_CONNECTION_ID,
          server: initialized?.serverInfo || null,
          protocolVersion: initialized?.protocolVersion || null,
          required,
          available,
          missing,
          schemaDrift,
          schemaFingerprint: sha256(stableJson((listed?.tools || [])
            .map(({ name, inputSchema }) => ({ name, inputSchema }))
            .sort((left, right) => left.name.localeCompare(right.name)))),
          contractFingerprint: MIGUO_FACTORY_CONTRACT_FINGERPRINT
        };
        if (missing.length) {
          throw Object.assign(new Error(`Miguo is missing required P0 tools: ${missing.join(', ')}`), {
            code: 'capability_missing'
          });
        }
        if (schemaDrift.length) {
          throw Object.assign(new Error(`Miguo tool schema changed and requires review: ${schemaDrift.join(', ')}`), {
            code: 'capability_schema_drift', details: { schemaDrift }
          });
        }
        this.capabilitySnapshot = snapshot;
        return snapshot;
      })().finally(() => {
        this.initializationPromise = null;
      });
    }
    return this.initializationPromise;
  }

  async uploadAsset(asset, signal) {
    this.assertEnabled();
    const uploadUrl = `${this.origin}/api/file/v1/upload/oss`;
    await this.urlGuard(uploadUrl, ['factory.miguocomics.com']);
    const buffer = await this.assetService.read(asset.blob_path);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: asset.mime_type }), `${asset.id}.png`);
    let response;
    try {
      response = await this.fetch(uploadUrl, {
        method: 'POST', headers: this.headers(), body: form,
        redirect: 'error',
        signal: abortSignal(Math.min(this.config.timeoutMs, 120_000), signal)
      });
    } catch (error) {
      const normalized = normalizeMcpError(error, 'upload');
      if (normalized.code === 'unknown_outcome') normalized.code = 'network_timeout_retryable';
      throw normalized;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.data?.url) {
      const error = new Error(`Miguo upload failed with HTTP ${response.status}.`);
      error.code = response.status === 401 || response.status === 403 ? 'auth_invalid' : 'input_image_unreachable';
      throw error;
    }
    await assertPublicHttps(payload.data.url, this.config.outputHosts || ['factory.miguocomics.com'], this.urlGuard);
    return payload.data.url;
  }

  async downloadOutput(rawUrl, signal) {
    const allowedHosts = this.config.outputHosts || ['factory.miguocomics.com'];
    let currentUrl = await assertPublicHttps(rawUrl, allowedHosts, this.urlGuard);
    let response;
    try {
      response = await this.fetch(currentUrl, { redirect: 'manual', signal: abortSignal(120_000, signal) });
      let redirects = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirects < 4) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = await assertPublicHttps(new URL(location, currentUrl).href, allowedHosts, this.urlGuard);
        response = await this.fetch(currentUrl, { redirect: 'manual', signal: abortSignal(120_000, signal) });
        redirects += 1;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        throw Object.assign(new Error('Miguo output exceeded the redirect safety limit.'), { code: 'output_fetch_failed' });
      }
    } catch (error) {
      throw Object.assign(new Error('Miguo output download failed.'), { code: 'output_fetch_failed', cause: error });
    }
    if (!response.ok) throw Object.assign(new Error(`Miguo output download returned HTTP ${response.status}.`), { code: 'output_fetch_failed' });
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > 50 * 1024 * 1024) throw Object.assign(new Error('Miguo output exceeds the 50 MB safety limit.'), { code: 'output_too_large' });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) throw Object.assign(new Error('Miguo output exceeds the 50 MB safety limit.'), { code: 'output_too_large' });
    return buffer;
  }

  async execute({ run, inputs, signal, onProviderEvidence = null }) {
    if (run.provider_profile && run.provider_profile !== MIGUO_FACTORY_CONNECTION_ID) {
      throw Object.assign(new Error('This run is pinned to a different Miguo connection.'), { code: 'provider_not_configured' });
    }
    if (run.provider_contract_fingerprint
      && run.provider_contract_fingerprint !== MIGUO_FACTORY_CONTRACT_FINGERPRINT) {
      throw Object.assign(new Error('This run is pinned to an unsupported Miguo Factory contract revision.'), {
        code: 'capability_schema_drift'
      });
    }
    await this.ensureInitialized();
    const uploaded = Object.fromEntries(await Promise.all(inputs.map(async (input) => [input.role, await this.uploadAsset(input, signal)])));
    const channel = run.params.channel || this.config.channel;
    let args;
    if (run.stage === 'ink') {
      args = {
        image_url: uploaded.source,
        strength: run.params.strength ?? 0.5,
        style: run.params.style || 'none',
        thickness: run.params.thickness ?? 0.5,
        facialSeparation: Boolean(run.params.facialSeparation),
        channel
      };
      if (run.params.prompt) args.prompt = String(run.params.prompt).slice(0, 500);
    } else if (run.stage === 'color') {
      args = { input_image_url: uploaded.ink, channel };
      if (Array.isArray(run.params.refer_image_urls) && run.params.refer_image_urls.length) {
        args.refer_image_urls = run.params.refer_image_urls.slice(0, 4);
      }
    } else if (run.stage === 'light') {
      args = {
        color_image_url: uploaded.color,
        line_art_image_url: uploaded.ink,
        style: run.params.style || 'nvpin',
        color: run.params.color || 'nvpin_rule',
        light: run.params.light || 'top_left',
        shadow_strength: run.params.shadow_strength ?? 0.5,
        channel
      };
    } else {
      throw Object.assign(new Error(`Unsupported Miguo stage: ${run.stage}`), { code: 'capability_missing' });
    }

    let result;
    let providerEvidence = null;
    try {
      result = await this.rpc('tools/call', { name: run.tool_name, arguments: args }, { signal });
      providerEvidence = observeProviderResult(result);
      if (onProviderEvidence) await onProviderEvidence(providerEvidence);
    } catch (error) {
      if (!['auth_invalid', 'input_invalid', 'real_provider_blocked'].includes(error.code)) error.code = 'unknown_outcome';
      if (providerEvidence) Object.assign(error, providerEvidence);
      throw error;
    }
    // A successful tools/call response is the billing boundary. Anything that
    // fails after this point (result interpretation, URL validation or output
    // download) must never be presented as a safely retryable, zero-cost call.
    try {
      if (result?.isError || hasDeclaredToolFailure(result)) {
        const error = new Error('Miguo tool returned an error result.');
        error.code = 'provider_tool_error';
        throw error;
      }
      const uploadedUrls = new Set(Object.values(uploaded));
      const declaredUrls = run.tool_name === 'line_art_beautify_v4'
        ? collectLineArtPrimaryOutputUrls(result)
        : run.tool_name === 'coloring_v4'
          ? collectColoringPrimaryOutputUrls(result)
          : run.tool_name === 'shadowing_v7'
            ? collectShadowingPrimaryOutputUrls(result)
            : collectDeclaredOutputUrls(result);
      const urls = [...new Set(declaredUrls.filter((url) => !uploadedUrls.has(url)))];
      if (!urls.length) throw Object.assign(new Error('Miguo result did not contain an output image URL.'), { code: 'output_missing' });
      if (urls.length !== 1) throw Object.assign(new Error('Miguo result contained ambiguous output image URLs.'), { code: 'malformed_response' });
      const buffer = await this.downloadOutput(urls[0], signal);
      return {
        buffer,
        providerRequestId: providerEvidence?.providerRequestId || null,
        providerTaskId: providerEvidence?.providerTaskId || null,
        resultShapeFingerprint: providerEvidence?.resultShapeFingerprint || null,
        costPoints: estimateMiguoPoints(run.stage, channel),
        costSource: 'estimate',
        metadata: {
          provider: 'miguo', providerFamily: 'miguo',
          providerConnectionId: MIGUO_FACTORY_CONNECTION_ID,
          contractFingerprint: MIGUO_FACTORY_CONTRACT_FINGERPRINT,
          tool: run.tool_name, channel,
          schemaNote: 'Output URL read from approved result fields and immediately ingested.'
        }
      };
    } catch (error) {
      error.billingOutcome = 'unknown';
      error.providerAccepted = true;
      if (providerEvidence) Object.assign(error, providerEvidence);
      throw error;
    }
  }
}
