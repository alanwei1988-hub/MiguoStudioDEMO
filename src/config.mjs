import fs from 'node:fs';
import path from 'node:path';

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function flag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function csv(name, fallback = []) {
  const raw = process.env[name];
  if (raw == null || !raw.trim()) return fallback;
  return [...new Set(raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function choice(name, allowed, fallback) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

loadLocalEnv();

const dataRoot = path.resolve(process.cwd(), process.env.DATA_ROOT || './data');

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 4317, { min: 1, max: 65535 }),
  dataRoot,
  databasePath: path.join(dataRoot, 'p0.sqlite'),
  assetsRoot: path.join(dataRoot, 'assets'),
  exportsRoot: path.join(dataRoot, 'exports'),
  defaultProvider: process.env.DEFAULT_PROVIDER || 'mock',
  workerConcurrency: integer('WORKER_CONCURRENCY', 2, { min: 1, max: 8 }),
  maxUploadFiles: integer('MAX_UPLOAD_FILES', 50, { min: 1, max: 200 }),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 20 * 1024 * 1024, { min: 1024, max: 100 * 1024 * 1024 }),
  maxPointsPerBatch: integer('P0_MAX_POINTS_PER_BATCH', 2_880, { min: 1, max: 1_000_000 }),
  faultMode: process.env.P0_FAULT_MODE || 'none',
  auth: Object.freeze({
    required: flag('AUTH_REQUIRED'),
    allowRegistration: flag('ALLOW_PUBLIC_REGISTRATION', true),
    cookieSecure: flag('AUTH_COOKIE_SECURE'),
    cookiePath: process.env.AUTH_COOKIE_PATH || '/',
    trustProxy: flag('AUTH_TRUST_PROXY'),
    sessionDays: integer('AUTH_SESSION_DAYS', 7, { min: 1, max: 30 }),
    maxUsers: integer('AUTH_MAX_USERS', 100, { min: 1, max: 10_000 })
  }),
  miguo: Object.freeze({
    accountId: process.env.MIGUO_ACCOUNT_ID || '',
    apiToken: process.env.MIGUO_API_TOKEN || '',
    mcpUrl: process.env.MIGUO_MCP_URL || 'https://factory.miguocomics.com/api/mcp/v1',
    channel: process.env.MIGUO_CHANNEL === 'fast' ? 'fast' : 'slow',
    timeoutMs: integer('MIGUO_TIMEOUT_MS', 900_000, { min: 10_000, max: 1_800_000 }),
    allowRealProvider: flag('ALLOW_REAL_PROVIDER'),
    internalUseAcknowledged: flag('P0_INTERNAL_USE_ACK'),
    outputHosts: csv('MIGUO_OUTPUT_HOSTS', ['factory.miguocomics.com', 'oss.miguocomics.com'])
  }),
  storyark: Object.freeze({
    accountId: process.env.MIGUO_STORYARK_ACCOUNT_ID || '',
    apiToken: process.env.MIGUO_STORYARK_API_TOKEN || '',
    mcpUrl: process.env.MIGUO_STORYARK_MCP_URL || 'https://storyark.miguocomics.com/api/mcp/v1',
    timeoutMs: integer('MIGUO_STORYARK_TIMEOUT_MS', 360_000, { min: 10_000, max: 600_000 }),
    allowRealProvider: flag('ALLOW_STORYARK_GENERATION'),
    internalUseAcknowledged: flag('STORYARK_INTERNAL_USE_ACK'),
    outputHosts: csv('MIGUO_STORYARK_OUTPUT_HOSTS', ['storyark.miguocomics.com', 'static-02.miguocomics.com']),
    maxResultsPerBatch: integer('STORYARK_MAX_RESULTS_PER_BATCH', 20, { min: 1, max: 50 })
  }),
  storyboard: Object.freeze({
    renderProvider: choice('STUDIO_STORYBOARD_RENDER_PROVIDER', ['nano_banana_2', 'storyark'], 'nano_banana_2'),
    projectId: process.env.STUDIO_STORYBOARD_PROJECT_ID || ''
  }),
  mainModel: Object.freeze({
    baseUrl: process.env.STUDIO_MAIN_MODEL_BASE_URL || '',
    apiKey: process.env.STUDIO_MAIN_MODEL_API_KEY || '',
    batchModel: process.env.STUDIO_MAIN_MODEL_BATCH_MODEL || 'gpt-5.6-luna',
    interactiveModel: process.env.STUDIO_MAIN_MODEL_INTERACTIVE_MODEL || 'gpt-5.6-terra',
    enabled: flag('STUDIO_MAIN_MODEL_ENABLED'),
    timeoutMs: integer('STUDIO_MAIN_MODEL_TIMEOUT_MS', 600_000, { min: 10_000, max: 900_000 }),
    maxOutputTokens: integer('STUDIO_MAIN_MODEL_MAX_OUTPUT_TOKENS', 16_000, { min: 512, max: 32_000 }),
    maxBatchPanels: integer('STUDIO_MAIN_MODEL_MAX_BATCH_PANELS', 20, { min: 1, max: 50 })
  }),
  imageModel: Object.freeze({
    baseUrl: process.env.STUDIO_IMAGE_MODEL_BASE_URL || process.env.STUDIO_MAIN_MODEL_BASE_URL || '',
    apiKey: process.env.STUDIO_IMAGE_MODEL_API_KEY || process.env.STUDIO_MAIN_MODEL_API_KEY || '',
    model: process.env.STUDIO_IMAGE_MODEL_MODEL || 'gemini-3.1-flash-image',
    enabled: flag('STUDIO_IMAGE_MODEL_ENABLED'),
    allowGeneration: flag('ALLOW_STUDIO_IMAGE_GENERATION'),
    internalUseAcknowledged: flag('STUDIO_IMAGE_INTERNAL_USE_ACK'),
    timeoutMs: integer('STUDIO_IMAGE_MODEL_TIMEOUT_MS', 600_000, { min: 30_000, max: 900_000 })
  })
});

export function ensureRuntimeDirectories(runtimeConfig = config) {
  for (const directory of [runtimeConfig.dataRoot, runtimeConfig.assetsRoot, runtimeConfig.exportsRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function publicConfig(runtimeConfig = config) {
  const configured = Boolean(runtimeConfig.miguo.accountId && runtimeConfig.miguo.apiToken);
  const realEnabled = configured && runtimeConfig.miguo.allowRealProvider && runtimeConfig.miguo.internalUseAcknowledged;
  const storyarkConfigured = Boolean(runtimeConfig.storyark?.accountId && runtimeConfig.storyark?.apiToken);
  const storyarkRealEnabled = storyarkConfigured
    && runtimeConfig.storyark.allowRealProvider
    && runtimeConfig.storyark.internalUseAcknowledged;
  const mainModelConfigured = Boolean(runtimeConfig.mainModel?.baseUrl && runtimeConfig.mainModel?.apiKey);
  const mainModelEnabled = mainModelConfigured && Boolean(runtimeConfig.mainModel?.enabled);
  const imageModelConfigured = Boolean(runtimeConfig.imageModel?.baseUrl && runtimeConfig.imageModel?.apiKey);
  const imageModelEnabled = imageModelConfigured && Boolean(runtimeConfig.imageModel?.enabled)
    && Boolean(runtimeConfig.imageModel?.allowGeneration)
    && Boolean(runtimeConfig.imageModel?.internalUseAcknowledged);
  const storyboardProvider = runtimeConfig.storyboard?.renderProvider === 'storyark' ? 'storyark' : 'nano_banana_2';
  const storyboardConfigured = storyboardProvider === 'storyark'
    ? storyarkConfigured && Boolean(runtimeConfig.storyboard?.projectId)
    : imageModelConfigured;
  const storyboardEnabled = storyboardProvider === 'storyark' ? storyarkRealEnabled : imageModelEnabled;
  return {
    defaultProvider: runtimeConfig.defaultProvider,
    workerConcurrency: runtimeConfig.workerConcurrency,
    maxUploadFiles: runtimeConfig.maxUploadFiles,
    maxPointsPerBatch: runtimeConfig.maxPointsPerBatch,
    auth: {
      required: Boolean(runtimeConfig.auth?.required),
      registrationEnabled: runtimeConfig.auth?.allowRegistration !== false
    },
    miguo: {
      configured,
      realEnabled,
      channel: runtimeConfig.miguo.channel,
      safetyGate: realEnabled ? 'open-for-internal-p0' : 'closed',
      connections: {
        factoryClassic: {
          configured,
          executionEnabled: realEnabled,
          capabilities: ['lineart', 'color', 'shading']
        },
        storyarkV3: {
          configured: storyarkConfigured,
          executionEnabled: storyarkRealEnabled,
          capabilities: ['projects', 'storyboard-inference', 'storyboard-status']
        }
      }
    },
    storyark: {
      configured: storyarkConfigured,
      realEnabled: storyarkRealEnabled,
      safetyGate: storyarkRealEnabled ? 'open-for-internal-mvp' : 'closed',
      maxResultsPerBatch: runtimeConfig.storyark?.maxResultsPerBatch ?? 20
    },
    mainModel: {
      configured: mainModelConfigured,
      enabled: mainModelEnabled
    },
    imageModel: {
      configured: imageModelConfigured,
      enabled: imageModelEnabled,
      safetyGate: imageModelEnabled ? 'open-for-internal-mvp' : 'closed'
    },
    storyboardGeneration: {
      configured: storyboardConfigured,
      enabled: storyboardEnabled,
      maxResultsPerTask: storyboardProvider === 'storyark' ? 4 : 1,
      maxResultsPerBatch: runtimeConfig.storyark?.maxResultsPerBatch ?? 20
    }
  };
}
