import { sha256, assertSafeProviderUrl } from '../security.mjs';
import { factoryClassicContract } from './factory-contracts.mjs';

const FACTORY_ORIGIN = 'https://factory.miguocomics.com';
const FACTORY_OUTPUT_HOST = 'oss.miguocomics.com';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_HISTORY_PAGES = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recoveryError = (code, message, { retryable = false } = {}) => Object.assign(
  new Error(message), { code, retryableRecovery: retryable }
);

async function readBounded(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw recoveryError('recovery_response_too_large', 'Factory recovery response exceeded its safety limit.');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw recoveryError('recovery_response_too_large', 'Factory recovery response exceeded its safety limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

const maybeJson = (value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
};

const exactOssUrl = (rawUrl, label) => {
  let url;
  try { url = new URL(rawUrl); } catch {
    throw recoveryError('unsafe_output_url', `Factory ${label} URL was invalid.`);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== FACTORY_OUTPUT_HOST
    || url.username || url.password || url.port) {
    throw recoveryError('unsafe_output_url', `Factory ${label} URL was outside the exact approved output host.`);
  }
  return url;
};

function exactHistoryOutput(meta, profile) {
  const value = meta?.[profile.historyOutputKey];
  if (profile.historyOutputKind === 'url') {
    if (typeof value !== 'string') throw recoveryError('factory_output_not_ready', 'Factory task did not yet expose its finished output.', { retryable: true });
    return exactOssUrl(value, 'output');
  }
  if (profile.historyOutputKind === 'single-item-array') {
    if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') {
      throw recoveryError('factory_output_not_ready', 'Factory task did not yet expose one unambiguous finished preview.', { retryable: true });
    }
    return exactOssUrl(value[0], 'output preview');
  }
  throw recoveryError('output_contract_unverified', 'Factory output materialization contract is not verified.');
}

function timeWindow(run) {
  const started = Date.parse(run.started_at || run.created_at || '');
  const observed = Date.parse(run.provider_result_observed_at || run.finished_at || '');
  if (!Number.isFinite(started) || !Number.isFinite(observed)) {
    throw recoveryError('recovery_evidence_incomplete', 'Studio run timing evidence is incomplete.');
  }
  return { minimum: started - 30_000, maximum: Math.max(started, observed) + 30_000 };
}

function channelMatches(value, run) {
  const expected = String(run.params?.channel || 'slow').toLowerCase();
  if (expected !== 'slow') return false;
  return value === 1 || String(value).toLowerCase() === 'slow';
}

function parametersMatch(meta, run) {
  const params = run.params || {};
  if (run.tool_name === 'line_art_beautify_v4') {
    const numeric = [
      ['strength', params.strength ?? 0.5],
      ['thickness', params.thickness ?? 0.5]
    ];
    if (numeric.some(([key, expected]) => meta[key] != null
      && (!Number.isFinite(Number(meta[key])) || Number(meta[key]) !== Number(expected)))) return false;
    if (meta.style != null && String(meta.style) !== String(params.style || 'none')) return false;
    if (meta.facialSeparation != null) {
      const normalized = typeof meta.facialSeparation === 'string'
        ? meta.facialSeparation.trim().toLowerCase() : meta.facialSeparation;
      const actual = normalized === true || normalized === 1 || normalized === '1' || normalized === 'true';
      const recognized = actual || normalized === false || normalized === 0
        || normalized === '0' || normalized === 'false';
      if (!recognized || actual !== Boolean(params.facialSeparation)) return false;
    }
    if ((meta.prompt != null || params.prompt) && String(meta.prompt || '') !== String(params.prompt || '')) return false;
    return true;
  }
  if (run.tool_name === 'coloring_v4') {
    const references = meta.referImageUrls;
    return references == null || (Array.isArray(references) && references.length === 0);
  }
  if (run.tool_name !== 'shadowing_v7') return true;
  return String(meta.style) === String(params.style || 'nvpin')
    && String(meta.color) === String(params.color || 'nvpin_rule')
    && String(meta.light) === String(params.light || 'top_left')
    && Number(meta.shadowStrength) === Number(params.shadow_strength ?? 0.5);
}

function historyItems(payload) {
  const list = payload?.data?.list;
  if (Number(payload?.code) !== 0 || !Array.isArray(list)) {
    throw recoveryError('factory_history_unavailable', 'Factory task history was temporarily unavailable.', { retryable: true });
  }
  return list;
}

export class FactoryClassicRecoveryClient {
  constructor({ config, fetchImpl = globalThis.fetch, urlGuard = assertSafeProviderUrl }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.urlGuard = urlGuard;
    const origin = new URL(config.mcpUrl || FACTORY_ORIGIN).origin;
    if (origin !== FACTORY_ORIGIN) throw recoveryError('provider_not_configured', 'Factory recovery requires the fixed official origin.');
  }

  async fetchJson(pathname) {
    const url = new URL(pathname, FACTORY_ORIGIN);
    const allowed = /^\/api\/task-history\/v1\/list\/(?:[1-9]|10)$/.test(url.pathname)
      || /^\/api\/task-history\/v1\/detail\/[0-9a-f-]{36}$/i.test(url.pathname)
      || /^\/api\/(?:lineart-beautify\/v4|coloring\/v4|shadow\/v7)\/task\/[0-9a-f-]{36}$/i.test(url.pathname)
      || url.pathname === '/api/coins/v1/transactions/1';
    if (url.origin !== FACTORY_ORIGIN || !allowed) {
      throw recoveryError('unsafe_factory_endpoint', 'Factory recovery attempted an endpoint outside its fixed GET allowlist.');
    }
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'x-api-user': this.config.accountId,
          'x-api-token': this.config.apiToken,
          accept: 'application/json'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw recoveryError('factory_read_failed', 'Factory read-only recovery request failed.', { retryable: true });
    }
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    if (!response.ok) throw recoveryError('factory_read_failed', `Factory recovery returned HTTP ${response.status}.`, { retryable: response.status >= 500 });
    try { return JSON.parse(bytes.toString('utf8')); } catch {
      throw recoveryError('factory_evidence_invalid', 'Factory returned invalid JSON recovery evidence.', { retryable: true });
    }
  }

  async downloadExactOss(rawUrl, label) {
    const url = rawUrl instanceof URL ? rawUrl : exactOssUrl(rawUrl, label);
    await this.urlGuard(url.href, [FACTORY_OUTPUT_HOST]);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000)
      });
    } catch {
      throw recoveryError('output_fetch_failed', `Factory ${label} could not be read safely.`, { retryable: true });
    }
    if (!response.ok) throw recoveryError('output_fetch_failed', `Factory ${label} returned HTTP ${response.status}.`, { retryable: response.status >= 500 });
    return readBounded(response, MAX_IMAGE_BYTES);
  }

  async matchingDetail({ item, profile, run, inputsByRole, strictIdentity = false }) {
    if (!UUID.test(String(item?.taskId || ''))) return null;
    const detail = await this.fetchJson(`/api/task-history/v1/detail/${encodeURIComponent(item.taskId)}`);
    const data = detail?.data;
    let meta = maybeJson(data?.meta);
    if (Number(detail?.code) !== 0 || !data) return null;
    const identityMismatch = data.taskId !== item.taskId
      || Number(data.type) !== profile.taskType
      || String(data.version).toLowerCase() !== profile.taskVersion
      || !channelMatches(data.inferenceChannel, run);
    if (identityMismatch) {
      if (strictIdentity) {
        throw recoveryError('factory_task_conflict', 'Persisted Factory task evidence conflicted with the frozen task contract.');
      }
      return null;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || ![2, 3].includes(Number(meta.status))) return null;
    if (!parametersMatch(meta, run)) {
      if (strictIdentity) {
        throw recoveryError('factory_task_conflict', 'Persisted Factory task parameters conflicted with the frozen Studio request.');
      }
      return null;
    }

    const inputUrls = new Set();
    for (const inputField of profile.inputFields) {
      const frozen = inputsByRole.get(inputField.role);
      if (!frozen || typeof meta[inputField.metaKey] !== 'string') {
        if (strictIdentity) {
          throw recoveryError('factory_task_conflict', 'Persisted Factory task inputs conflicted with the frozen Studio inputs.');
        }
        return null;
      }
      const inputUrl = exactOssUrl(meta[inputField.metaKey], `${inputField.role} input`);
      inputUrls.add(inputUrl.href);
      const providerBytes = await this.downloadExactOss(inputUrl, `${inputField.role} input`);
      if (providerBytes.length !== frozen.byte_size || sha256(providerBytes) !== frozen.sha256) {
        if (strictIdentity) {
          throw recoveryError('factory_task_conflict', 'Persisted Factory task input content did not match the frozen Studio input.');
        }
        return null;
      }
    }
    if (Number(meta.status) === 3) {
      return { data, meta, outputUrl: null, outcome: 'failed' };
    }
    let outputUrl;
    try {
      outputUrl = exactHistoryOutput(meta, profile);
    } catch (error) {
      if (error?.code === 'factory_output_not_ready') return null;
      throw error;
    }
    if (inputUrls.has(outputUrl.href)) {
      throw recoveryError('factory_output_invalid', 'Factory finished output echoed a frozen input URL.');
    }
    return { data, meta, outputUrl, outcome: 'succeeded' };
  }

  async historyCandidates({ profile, run, window }) {
    const candidates = [];
    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const payload = await this.fetchJson(`/api/task-history/v1/list/${page}?type=${profile.taskType}&pageSize=100`);
      const items = historyItems(payload);
      const timestamps = items.map((item) => Date.parse(item?.createAt || item?.createdAt || ''));
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const createdAt = timestamps[index];
        if (UUID.test(String(item?.taskId || ''))
          && Number(item.type) === profile.taskType
          && String(item.version).toLowerCase() === profile.taskVersion
          && channelMatches(item.inferenceChannel, run)
          && Number.isFinite(createdAt) && createdAt >= window.minimum && createdAt <= window.maximum) {
          candidates.push(item);
        }
      }
      const finiteTimes = timestamps.filter(Number.isFinite);
      const descending = finiteTimes.every((value, index) => index === 0 || finiteTimes[index - 1] >= value);
      const oldest = finiteTimes.length ? Math.min(...finiteTimes) : null;
      const totalPages = Number(payload?.data?.totalPage);
      if (!items.length || items.length < 100 || (Number.isFinite(totalPages) && page >= totalPages)
        || (descending && oldest != null && oldest < window.minimum)) break;
    }
    return candidates;
  }

  async ledger(taskId) {
    const payload = await this.fetchJson('/api/coins/v1/transactions/1?pageSize=100&type=2');
    const items = payload?.data?.items;
    if (!Array.isArray(items)) throw recoveryError('factory_ledger_unavailable', 'Factory ledger was temporarily unavailable.', { retryable: true });
    const matches = items.filter((item) => item?.correlationId === taskId);
    if (!matches.length) throw recoveryError('factory_ledger_pending', 'Factory ledger has not published the task entry yet.', { retryable: true });
    if (matches.length !== 1) throw recoveryError('factory_ledger_ambiguous', 'Factory ledger contained multiple entries for one task.');
    const entry = matches[0];
    const amount = entry.amount;
    if (Number(entry.type) !== 2 || Number(entry.reason) !== 6
      || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw recoveryError('factory_ledger_invalid', 'Factory ledger evidence did not match an inference deduction.');
    }
    return {
      costPoints: amount,
      costSource: amount === 0 ? 'no_charge_confirmed' : 'provider_statement'
    };
  }

  async recover({ run, inputs }) {
    const profile = factoryClassicContract(run.tool_name, run.stage);
    if (!profile) throw recoveryError('output_contract_unverified', 'This Factory tool has no verified automatic recovery contract.');
    if (!this.config.accountId || !this.config.apiToken) throw recoveryError('auth_invalid', 'Factory recovery credentials are not configured.');
    const window = timeWindow(run);
    const inputsByRole = new Map(inputs.map((input) => [input.role, input]));
    const matches = [];
    const persistedTaskId = run.provider_task_id == null || run.provider_task_id === ''
      ? null : String(run.provider_task_id);
    if (persistedTaskId && !UUID.test(persistedTaskId)) {
      throw recoveryError('factory_task_conflict', 'Persisted Factory task identity was invalid.');
    }
    const candidates = persistedTaskId
      ? [{ taskId: persistedTaskId }]
      : await this.historyCandidates({ profile, run, window });
    if (!candidates.length) throw recoveryError('factory_task_pending', 'Factory task history has not exposed the accepted task yet.', { retryable: true });
    if (!persistedTaskId && candidates.length > 8) {
      throw recoveryError('factory_task_ambiguous', 'Too many Factory tasks overlap the accepted call window.');
    }
    for (const item of candidates) {
      const match = await this.matchingDetail({
        item, profile, run, inputsByRole, strictIdentity: Boolean(persistedTaskId)
      });
      if (match) matches.push({ item, ...match });
    }
    if (!matches.length) throw recoveryError('factory_task_pending', 'Factory has not exposed a uniquely matching completed task yet.', { retryable: true });
    if (matches.length !== 1) throw recoveryError('factory_task_ambiguous', 'Multiple Factory tasks match the frozen Studio inputs.');
    const match = matches[0];

    const direct = await this.fetchJson(`${profile.directTaskPath}${encodeURIComponent(match.item.taskId)}`);
    const expectedStatus = match.outcome === 'failed' ? 3 : 2;
    const directData = direct?.data;
    const directIdentityMismatch = (directData?.taskId != null && directData.taskId !== match.item.taskId)
      || (directData?.type != null && Number(directData.type) !== profile.taskType)
      || (directData?.version != null
        && String(directData.version).toLowerCase() !== profile.taskVersion)
      || (directData?.inferenceChannel != null && !channelMatches(directData.inferenceChannel, run));
    if (directIdentityMismatch) {
      throw recoveryError('factory_task_conflict', 'Factory direct task evidence conflicted with the selected task contract.');
    }
    if (Number(direct?.code) !== 0 || Number(directData?.status) !== expectedStatus) {
      throw recoveryError('factory_task_pending', 'Factory task is not yet confirmed finished by its status endpoint.', { retryable: true });
    }
    if (match.outcome === 'failed') {
      const ledger = await this.ledger(match.item.taskId);
      return {
        outcome: 'failed',
        providerTaskId: match.item.taskId,
        providerTaskType: profile.taskType,
        providerTaskVersion: profile.taskVersion,
        evidenceReference: `factory-task:${match.item.taskId}:${profile.evidenceLabel}:failed;ledger:type2:reason6`,
        ...ledger
      };
    }
    const [ledger, buffer] = await Promise.all([
      this.ledger(match.item.taskId),
      this.downloadExactOss(match.outputUrl, 'finished output')
    ]);
    const outputRawSha256 = sha256(buffer);
    if (inputs.some((input) => input.sha256 === outputRawSha256)) {
      throw recoveryError('factory_output_invalid', 'Factory finished output was byte-identical to a frozen input.');
    }
    return {
      outcome: 'succeeded',
      buffer,
      providerTaskId: match.item.taskId,
      providerTaskType: profile.taskType,
      providerTaskVersion: profile.taskVersion,
      outputHost: match.outputUrl.hostname,
      outputRawSha256,
      evidenceReference: `factory-task:${match.item.taskId}:${profile.evidenceLabel};ledger:type2:reason6`,
      ...ledger
    };
  }
}
