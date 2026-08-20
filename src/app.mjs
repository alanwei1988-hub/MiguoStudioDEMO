import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config as defaultConfig, ensureRuntimeDirectories, publicConfig } from './config.mjs';
import { P0Database } from './db.mjs';
import { defaultStageParameters, toolForStage, assertStage } from './domain.mjs';
import { sha256 } from './security.mjs';
import { AssetService } from './services/assets.mjs';
import { LayoutService } from './services/layout.mjs';
import { RunWorker } from './services/worker.mjs';
import { ClassicRecoveryWorker } from './services/classic-recovery-worker.mjs';
import { StoryboardWorker } from './services/storyboard-worker.mjs';
import { StoryboardPlanService } from './services/storyboard-plan.mjs';
import { MockProvider } from './providers/mock.mjs';
import {
  MiguoProvider, estimateMiguoPoints,
  MIGUO_FACTORY_CONNECTION_ID, MIGUO_FACTORY_CONTRACT_FINGERPRINT
} from './providers/miguo.mjs';
import { FactoryClassicRecoveryClient } from './providers/factory-recovery.mjs';
import { StoryArkProvider, STORYARK_CONNECTION_ID, STORYARK_CONTRACT_FINGERPRINT } from './providers/storyark.mjs';
import {
  NanoBananaProvider,
  NANO_BANANA_CONNECTION_ID,
  NANO_BANANA_CONTRACT_FINGERPRINT,
  NANO_BANANA_RAW_ROUTE_REVISION
} from './providers/nano-banana.mjs';
import {
  StudioMainModelProvider,
  STORYBOARD_ANALYSIS_PROMPT_REVISION
} from './providers/studio-main-model.mjs';
import { AuthService, parseCookies, publicUser } from './auth.mjs';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ERROR_STATUS = Object.freeze({
  missing_approved_input: 409,
  active_run_exists: 409,
  attempt_limit_reached: 409,
  run_not_retryable: 409,
  unknown_outcome: 409,
  candidate_not_promotable: 409,
  asset_integrity_mismatch: 409,
  export_input_not_ready: 409,
  real_provider_blocked: 409,
  cost_limit_reached: 409,
  cost_reconciliation_required: 409,
  provider_not_configured: 409,
  main_model_not_configured: 409,
  main_model_disabled: 409,
  image_model_not_configured: 409,
  image_model_unavailable: 409,
  storyboard_analysis_mismatch: 409,
  storyboard_analysis_not_ready: 409,
  unsupported_media_type: 422,
  invalid_image_dimensions: 422,
  invalid_stage: 422,
  FST_REQ_FILE_TOO_LARGE: 413
});

const MIGUO_FACTORY_PRICING_REVISION = 'factory-p0-estimate-2026-08';

function apiError(code, message, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function safeConfiguredHost(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' ? parsed.hostname : '';
  } catch {
    return '';
  }
}

function buildAdminDashboard(snapshot, {
  runtimeConfig, storyarkConfig, mainModelConfig, imageModelConfig, storyboardConfig, authConfig
}) {
  const userById = new Map(snapshot.users.map((user) => [user.id, user]));
  const organizationById = new Map(snapshot.organizations.map((organization) => [organization.id, {
    ...organization,
    taskCount: 0, succeededTaskCount: 0, failedTaskCount: 0, activeTaskCount: 0,
    recordedPoints: 0, unknownCostCount: 0, submissionCount: 0, lastActivityAt: null
  }]));
  const userStats = new Map(snapshot.users.map((user) => [user.id, {
    taskCount: 0, succeededTaskCount: 0, failedTaskCount: 0, activeTaskCount: 0,
    recordedPoints: 0, unknownCostCount: 0, lastActivityAt: user.last_login_at || user.created_at
  }]));
  const terminal = new Set(['succeeded', 'failed']);
  const active = new Set(['queued', 'running', 'processing']);
  const tasks = [];
  const recordTask = (run, kind) => {
    const owner = userById.get(run.owner_user_id);
    const organizationId = owner?.organization_id || null;
    const points = Number(run.cost_points || 0);
    const timestamp = run.finished_at || run.started_at || run.created_at;
    const targetStats = [userStats.get(run.owner_user_id), organizationById.get(organizationId)].filter(Boolean);
    for (const stats of targetStats) {
      stats.taskCount += 1;
      if (run.status === 'succeeded') stats.succeededTaskCount += 1;
      if (run.status === 'failed') stats.failedTaskCount += 1;
      if (active.has(run.status)) stats.activeTaskCount += 1;
      stats.recordedPoints += points;
      if (run.cost_source === 'unknown') stats.unknownCostCount += 1;
      if (!stats.lastActivityAt || timestamp > stats.lastActivityAt) stats.lastActivityAt = timestamp;
    }
    tasks.push({
      id: run.id,
      kind,
      stage: kind === 'classic' ? run.stage : 'storyboard',
      status: run.status,
      provider: kind === 'classic' ? run.provider : run.provider_connection_id,
      batchName: run.batch_name,
      owner: owner ? { id: owner.id, email: owner.email, displayName: owner.display_name } : null,
      organizationId,
      points,
      costSource: run.cost_source,
      createdAt: run.created_at,
      finishedAt: run.finished_at
    });
  };
  snapshot.classicRuns.forEach((run) => recordTask(run, 'classic'));
  snapshot.storyboardRuns.forEach((run) => recordTask(run, 'storyboard'));
  for (const submission of snapshot.submissions) {
    const stats = organizationById.get(submission.organization_id);
    if (!stats) continue;
    stats.submissionCount = Number(submission.count || 0);
    if (submission.last_submitted_at && (!stats.lastActivityAt || submission.last_submitted_at > stats.lastActivityAt)) {
      stats.lastActivityAt = submission.last_submitted_at;
    }
  }
  const successRate = (stats) => {
    const denominator = stats.succeededTaskCount + stats.failedTaskCount;
    return denominator ? Number((stats.succeededTaskCount * 100 / denominator).toFixed(1)) : null;
  };
  const organizations = [...organizationById.values()].map((stats) => ({
    ...stats,
    recordedPoints: Number(stats.recordedPoints.toFixed(2)),
    successRate: successRate(stats)
  }));
  const users = snapshot.users.map((user) => {
    const stats = userStats.get(user.id);
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      organization: user.organization_id ? {
        id: user.organization_id,
        name: user.organization_name,
        role: user.organization_role
      } : null,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      ...stats,
      recordedPoints: Number(stats.recordedPoints.toFixed(2)),
      successRate: successRate(stats)
    };
  });
  const allStats = {
    taskCount: tasks.length,
    succeededTaskCount: tasks.filter((task) => task.status === 'succeeded').length,
    failedTaskCount: tasks.filter((task) => task.status === 'failed').length,
    activeTaskCount: tasks.filter((task) => active.has(task.status)).length,
    recordedPoints: tasks.reduce((sum, task) => sum + task.points, 0),
    unknownCostCount: tasks.filter((task) => task.costSource === 'unknown').length
  };
  const analysisTerminal = snapshot.analysis.filter((item) => terminal.has(item.status));
  const publicRuntime = publicConfig({
    ...runtimeConfig,
    storyark: storyarkConfig,
    mainModel: mainModelConfig,
    imageModel: imageModelConfig,
    storyboard: storyboardConfig
  });
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      organizationCount: organizations.length,
      activeUserCount: users.filter((user) => user.status === 'active').length,
      ...allStats,
      recordedPoints: Number(allStats.recordedPoints.toFixed(2)),
      successRate: successRate(allStats),
      submissionCount: organizations.reduce((sum, item) => sum + item.submissionCount, 0),
      analysisCount: snapshot.analysis.length,
      analysisSuccessRate: analysisTerminal.length
        ? Number((analysisTerminal.filter((item) => item.status === 'succeeded').length * 100 / analysisTerminal.length).toFixed(1))
        : null
    },
    organizations,
    users,
    recentTasks: tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100),
    models: {
      main: {
        configured: publicRuntime.mainModel.configured,
        enabled: publicRuntime.mainModel.enabled,
        baseUrlHost: safeConfiguredHost(mainModelConfig.baseUrl),
        batchModel: mainModelConfig.batchModel,
        interactiveModel: mainModelConfig.interactiveModel,
        timeoutMs: mainModelConfig.timeoutMs
      },
      image: {
        configured: publicRuntime.imageModel.configured,
        enabled: publicRuntime.imageModel.enabled,
        baseUrlHost: safeConfiguredHost(imageModelConfig.baseUrl),
        model: imageModelConfig.model,
        timeoutMs: imageModelConfig.timeoutMs
      },
      classic: publicRuntime.miguo.connections.factoryClassic,
      storyark: publicRuntime.miguo.connections.storyarkV3,
      storyboardProvider: storyboardConfig.renderProvider
    },
    policy: {
      registrationEnabled: authConfig.allowRegistration !== false,
      maxUsers: authConfig.maxUsers,
      maxPointsPerBatch: runtimeConfig.maxPointsPerBatch,
      creatorAttribution: 'batch_owner',
      balanceLedgerAvailable: false
    }
  };
}

function allowedParams(stage, provided = {}) {
  const allowed = stage === 'ink'
    ? ['strength', 'style', 'thickness', 'prompt', 'facialSeparation', 'channel', 'reviewNote']
    : stage === 'color'
      ? ['channel', 'reviewNote']
      : ['style', 'color', 'light', 'shadow_strength', 'channel', 'reviewNote'];
  const unknown = Object.keys(provided).filter((key) => !allowed.includes(key));
  if (unknown.length) throw apiError('invalid_stage_parameters', `Unsupported parameters: ${unknown.join(', ')}`, 422);
  const result = { ...defaultStageParameters(stage), ...provided };
  if (result.prompt) result.prompt = String(result.prompt).slice(0, 500);
  if (result.reviewNote) result.reviewNote = String(result.reviewNote).slice(0, 500);
  if (result.channel && !['fast', 'slow'].includes(result.channel)) throw apiError('invalid_channel', 'Channel must be fast or slow.', 422);
  const numericRanges = {
    strength: [-0.1, 1],
    thickness: [0.2, 2.5],
    shadow_strength: [0, 1]
  };
  for (const [key, [minimum, maximum]] of Object.entries(numericRanges)) {
    if (result[key] == null) continue;
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < minimum || result[key] > maximum) {
      throw apiError('invalid_stage_parameters', `${key} must be a number from ${minimum} to ${maximum}.`, 422);
    }
  }
  if (result.facialSeparation != null && typeof result.facialSeparation !== 'boolean') {
    throw apiError('invalid_stage_parameters', 'facialSeparation must be true or false.', 422);
  }
  const enumValues = stage === 'ink'
    ? { style: ['none', 'style-01', 'style-02', 'style-03'] }
    : stage === 'light'
      ? {
          style: ['mengbao', 'anfen', 'nvpin', 'qiongxiong', 'lingzhu'],
          color: ['gray', 'nvpin_rule', 'zhongchen', 'mengbao', 'nvpin_data'],
          light: ['random', 'front', 'back', 'left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right']
        }
      : {};
  for (const [key, values] of Object.entries(enumValues)) {
    if (!values.includes(result[key])) throw apiError('invalid_stage_parameters', `${key} is not supported by the current Miguo tool contract.`, 422);
  }
  return result;
}

export async function buildApp({ runtimeConfig = defaultConfig, startWorker = true, providerOverrides = {} } = {}) {
  const authConfig = {
    required: false,
    allowRegistration: true,
    cookieSecure: false,
    cookiePath: '/',
    trustProxy: false,
    sessionDays: 7,
    maxUsers: 100,
    ...(runtimeConfig.auth || {})
  };
  const storyarkConfig = {
    accountId: '', apiToken: '',
    mcpUrl: 'https://storyark.miguocomics.com/api/mcp/v1',
    timeoutMs: 360_000,
    allowRealProvider: false,
    internalUseAcknowledged: false,
    outputHosts: ['storyark.miguocomics.com'],
    maxResultsPerBatch: 20,
    ...(runtimeConfig.storyark || {})
  };
  const mainModelConfig = {
    baseUrl: '', apiKey: '',
    batchModel: 'gpt-5.6-luna', interactiveModel: 'gpt-5.6-terra',
    enabled: false, timeoutMs: 600_000, maxOutputTokens: 16_000, maxBatchPanels: 20,
    ...(runtimeConfig.mainModel || {})
  };
  const imageModelConfig = {
    baseUrl: '', apiKey: '', model: 'gemini-3.1-flash-image',
    enabled: false, allowGeneration: false, internalUseAcknowledged: false,
    timeoutMs: 600_000,
    ...(runtimeConfig.imageModel || {})
  };
  const storyboardManagedConfig = Boolean(runtimeConfig.storyboard);
  const storyboardConfig = {
    renderProvider: 'nano_banana_2',
    projectId: '',
    ...(runtimeConfig.storyboard || {})
  };
  ensureRuntimeDirectories(runtimeConfig);
  const maxRequestBytes = Math.min(
    runtimeConfig.maxUploadBytes * runtimeConfig.maxUploadFiles + 1024 * 1024,
    512 * 1024 * 1024
  );
  const app = Fastify({
    logger: false,
    bodyLimit: maxRequestBytes,
    genReqId: () => randomUUID(),
    trustProxy: authConfig.trustProxy
  });
  const db = new P0Database(runtimeConfig.databasePath);
  const auth = new AuthService({ db, config: authConfig });
  const assetService = new AssetService(runtimeConfig);
  const layoutService = new LayoutService({ db, assetService, exportsRoot: runtimeConfig.exportsRoot });
  const storyboardPlanService = new StoryboardPlanService({ db, assetService });
  const providers = {
    mock: new MockProvider({ assetService, faultMode: runtimeConfig.faultMode }),
    miguo: new MiguoProvider({ config: runtimeConfig.miguo, assetService }),
    storyark: new StoryArkProvider({ config: storyarkConfig, assetService }),
    mainModel: new StudioMainModelProvider({ config: mainModelConfig, assetService }),
    nanoBanana: new NanoBananaProvider({ config: imageModelConfig, assetService }),
    ...providerOverrides
  };
  const worker = new RunWorker({ db, assetService, providers, concurrency: runtimeConfig.workerConcurrency });
  const classicRecoveryWorker = new ClassicRecoveryWorker({
    db,
    assetService,
    recoveryClient: new FactoryClassicRecoveryClient({ config: runtimeConfig.miguo })
  });
  const storyboardWorker = new StoryboardWorker({
    db,
    assetService,
    providers: { storyark: providers.storyark, nanoBanana: providers.nanoBanana },
    concurrency: 1
  });

  app.decorate('p0', {
    db, auth, assetService, layoutService, storyboardPlanService, providers, worker, classicRecoveryWorker, storyboardWorker,
    config: { ...runtimeConfig, storyark: storyarkConfig, mainModel: mainModelConfig, imageModel: imageModelConfig }
  });
  db.recoverInterruptedStoryboardAnalyses();
  app.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    const allowedOrigin = origin === 'null'
      || origin === 'http://127.0.0.1:4317'
      || origin === 'http://localhost:4317';
    if (origin && allowedOrigin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      reply.header('access-control-allow-headers', 'Content-Type, Idempotency-Key, X-CSRF-Token');
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-max-age', '600');
    }
    if (request.method === 'OPTIONS') {
      reply.status(204).send();
      return;
    }
    done();
  });
  await app.register(multipart, {
    limits: { files: runtimeConfig.maxUploadFiles, fileSize: runtimeConfig.maxUploadBytes, parts: runtimeConfig.maxUploadFiles + 5 }
  });
  await app.register(fastifyStatic, {
    root: path.resolve(MODULE_ROOT, '../public'),
    prefix: '/'
  });

  app.setErrorHandler((error, request, reply) => {
    const code = error.code || 'internal_error';
    const statusCode = error.statusCode || ERROR_STATUS[code] || 500;
    const safeMessage = statusCode >= 500 ? 'The P0 application could not complete this request.' : error.message;
    reply.status(statusCode).send({
      error: { code, message: safeMessage, requestId: request.id, retryable: ['network_timeout_retryable', 'provider_unavailable', 'rate_limited'].includes(code), details: error.details }
    });
  });

  const cookieName = 'mp.session';
  const cookieFor = (token, maxAge) => {
    const parts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      `Path=${authConfig.cookiePath}`,
      `Max-Age=${maxAge}`,
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (authConfig.cookieSecure) parts.push('Secure');
    return parts.join('; ');
  };
  const sessionToken = (request) => parseCookies(request.headers.cookie || '')[cookieName] || '';
  const publicPaths = new Set([
    '/api/v1/health',
    '/api/v1/config',
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/session'
  ]);
  const authAttempts = new Map();
  const assertAuthRateLimit = (request, email) => {
    const key = `${request.ip}:${String(email || '').trim().toLowerCase()}`;
    const timestamp = Date.now();
    const recent = (authAttempts.get(key) || []).filter((entry) => timestamp - entry < 15 * 60_000);
    if (recent.length >= 5) throw apiError('auth_rate_limited', '尝试次数过多，请 15 分钟后再试。', 429);
    recent.push(timestamp);
    authAttempts.set(key, recent);
    return () => authAttempts.delete(key);
  };
  const requireBatchAccess = (request, batchId) => {
    const batch = db.getBatchRecord(batchId);
    if (!batch) throw apiError('resource_not_found', 'Resource not found.', 404);
    if (authConfig.required && request.authUser?.role !== 'admin' && batch.owner_user_id !== request.authUser?.id) {
      throw apiError('resource_not_found', 'Resource not found.', 404);
    }
    return batch;
  };
  const requireAdmin = (request, message = '只有平台管理员可以使用真实米粿能力。') => {
    if (authConfig.required && request.authUser?.role !== 'admin') {
      throw apiError('admin_required', message, 403);
    }
  };

  const hiddenCreatorMetadataKeys = new Set([
    'providertaskid', 'providerrequestid', 'providerrawsha256', 'sourcesha256',
    'referencesha256', 'masksha256', 'analysisinputfingerprint', 'evidencereference',
    'renderprovider', 'rendermodel', 'analysismodel', 'analysispromptrevision',
    'providerconnectionid', 'providerprofile', 'providertool', 'contractfingerprint', 'routerevision'
  ]);
  const sanitizeCreatorMetadata = (value) => {
    if (Array.isArray(value)) return value.map(sanitizeCreatorMetadata);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !hiddenCreatorMetadataKeys.has(key.replace(/[_-]/g, '').toLowerCase()))
      .map(([key, nested]) => [key, sanitizeCreatorMetadata(nested)]));
  };
  const serializeCreatorAsset = (asset) => {
    if (!asset) return null;
    const {
      blob_path: _blobPath,
      sha256: _sha256,
      metadata_json: _metadataJson,
      ...record
    } = asset;
    return { ...record, metadata: sanitizeCreatorMetadata(asset.metadata || {}) };
  };
  const serializeCreatorStoryboardAnalysis = (analysis) => {
    if (!analysis) return null;
    const {
      model_name: _modelName,
      prompt_revision: _promptRevision,
      input_fingerprint: _inputFingerprint,
      ...record
    } = analysis;
    return record;
  };
  const isClassicCreatorRecovery = (run) => run?.provider === 'miguo'
    && run?.status === 'failed'
    && run?.cost_source === 'unknown'
    && run?.provider_phase === 'accepted';
  const classicCreatorDisplayMessage = (run, displayState) => {
    if (displayState === 'recovering') return '系统正在后台取回生成结果，完成后会自动显示。';
    if (displayState === 'queued') return '任务已进入队列，系统会自动继续处理。';
    if (displayState === 'running') return '正在生成，完成后会自动显示。';
    if (displayState === 'succeeded') return '生成已完成。';
    if (displayState === 'cancelled') return '任务已取消。';
    const messages = {
      auth_invalid: '图像服务连接暂不可用，请稍后重试或联系管理员。',
      input_invalid: '输入素材不符合当前生成要求，请调整后重试。',
      input_image_unreachable: '输入图片暂时无法读取，请稍后重试。',
      network_timeout_retryable: '图像服务暂时响应超时，请稍后重试。',
      provider_unavailable: '图像服务暂时不可用，请稍后重试。',
      rate_limited: '图像服务当前繁忙，请稍后重试。',
      provider_tool_error: '图像服务未能完成本次生成，请调整后重试。',
      geometry_mismatch: '生成结果尺寸与当前画格不符，请重试。',
      real_provider_blocked: '真实图像服务尚未启用，请联系管理员。',
      provider_not_configured: '图像服务尚未配置完成，请联系管理员。',
      capability_schema_drift: '图像服务正在升级，请联系管理员。',
      asset_integrity_mismatch: '输入素材完整性检查未通过，请重新上传后再试。'
    };
    return messages[run?.error_code] || '本次生成未完成，请重试。';
  };
  const creatorCanRetryClassicRun = (run, displayState) => {
    if (displayState !== 'failed' || run.cost_source === 'unknown'
      || ['output_missing', 'unknown_outcome'].includes(run.error_code)) return false;
    if (run.provider === 'miguo'
      && db.countAttemptsForInputs(run.panel_id, run.stage, run.inputVersions, run.provider) >= 2) return false;
    if (db.getActiveRun(run.panel_id, run.stage)) return false;
    try {
      const currentInputs = db.getRequiredInputs(run.panel_id, run.stage)
        .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
      return JSON.stringify(currentInputs) === JSON.stringify(run.inputVersions);
    } catch {
      return false;
    }
  };
  const serializeCreatorRun = (run) => {
    if (!run) return null;
    const displayState = isClassicCreatorRecovery(run) ? 'recovering' : run.status;
    return {
      id: run.id,
      panel_id: run.panel_id,
      stage: run.stage,
      provider: run.provider,
      status: run.status,
      params: run.params || {},
      output_asset_version_id: run.output_asset_version_id || null,
      created_at: run.created_at,
      started_at: run.started_at || null,
      finished_at: run.finished_at || null,
      duration_ms: run.duration_ms ?? null,
      displayState,
      displayMessage: classicCreatorDisplayMessage(run, displayState),
      canRetry: creatorCanRetryClassicRun(run, displayState)
    };
  };
  const serializeCreatorStoryboardRun = (run) => {
    if (!run) return null;
    const {
      provider_task_id: _providerTaskId,
      provider_request_id: _providerRequestId,
      provider_connection_id: _providerConnectionId,
      provider_tool: _providerTool,
      provider_contract_fingerprint: _providerContractFingerprint,
      contract_fingerprint: _contractFingerprint,
      cost_points: _costPoints,
      cost_source: _costSource,
      ...record
    } = run;
    return {
      ...record,
      request: sanitizeCreatorMetadata(run.request || {}),
      outputs: (record.outputs || []).map((output) => {
        const {
          blob_path: _blobPath,
          sha256: _sha256,
          metadata_json: _metadataJson,
          ...creatorOutput
        } = output;
        return {
          ...creatorOutput,
          metadata: sanitizeCreatorMetadata(output.metadata || {})
        };
      })
    };
  };
  const serializeCreatorPanel = (panel) => ({
    ...panel,
    current: Object.fromEntries(Object.entries(panel.current || {})
      .map(([stage, asset]) => [stage, serializeCreatorAsset(asset)])),
    versions: (panel.versions || []).map(serializeCreatorAsset),
    runs: (panel.runs || []).map(serializeCreatorRun)
  });
  const serializeCreatorBatch = (batch) => {
    if (!batch) return null;
    const totals = batch.totals ? {
      run_count: batch.totals.run_count,
      duration_ms: batch.totals.duration_ms,
      failed_runs: batch.totals.failed_runs,
      active_runs: batch.totals.active_runs
    } : undefined;
    return {
      ...batch,
      panels: (batch.panels || []).map(serializeCreatorPanel),
      totals,
      storyboardAnalyses: (batch.storyboardAnalyses || []).map(serializeCreatorStoryboardAnalysis),
      storyboardRuns: (batch.storyboardRuns || []).map(serializeCreatorStoryboardRun)
    };
  };

  app.addHook('preHandler', async (request) => {
    request.authUser = null;
    request.authSession = null;
    if (!authConfig.required) return;
    const pathOnly = request.url.split('?')[0];
    if (publicPaths.has(pathOnly)) return;
    if (!pathOnly.startsWith('/api/')) return;
    const session = auth.authenticate(sessionToken(request));
    if (!session) throw apiError('authentication_required', '请先登录后继续。', 401);
    request.authSession = session;
    request.authUser = publicUser(session);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (!csrf || csrf !== session.csrf_token) throw apiError('csrf_invalid', '页面会话已变化，请刷新后重试。', 403);
    }
    if (request.authUser.role === 'admin') return;
    const params = request.params || {};
    if (params.batchId) requireBatchAccess(request, params.batchId);
    if (params.panelId) {
      const panel = db.getPanel(params.panelId);
      if (!panel) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, panel.batch_id);
    }
    if (params.runId) {
      const run = db.getRun(params.runId);
      const panel = run && db.getPanel(run.panel_id);
      if (!panel) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, panel.batch_id);
    }
    if (params.assetId) {
      const asset = db.getAsset(params.assetId);
      const panel = asset && db.getPanel(asset.panel_id);
      if (!panel) throw apiError('resource_not_found', 'Resource not found.', 404);
      const submittedOrganizationRead = ['GET', 'HEAD'].includes(request.method)
        && db.canUserReadSubmittedAsset(request.authUser.id, params.assetId);
      if (!submittedOrganizationRead) requireBatchAccess(request, panel.batch_id);
    }
    if (params.exportId) {
      const exported = db.getLayoutExport(params.exportId);
      if (!exported) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, exported.batch_id);
    }
    if (params.storyboardRunId) {
      const run = db.getStoryboardRun(params.storyboardRunId);
      const panel = run && db.getPanel(run.panel_id);
      if (!panel) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, panel.batch_id);
    }
    if (params.storyboardOutputId) {
      const output = db.getStoryboardOutput(params.storyboardOutputId, { includeDeleted: true });
      const run = output && db.getStoryboardRun(output.storyboard_run_id);
      const panel = run && db.getPanel(run.panel_id);
      if (!panel) throw apiError('resource_not_found', 'Resource not found.', 404);
      const submittedOrganizationRead = ['GET', 'HEAD'].includes(request.method)
        && db.canUserReadSubmittedOutput(request.authUser.id, params.storyboardOutputId);
      if (!submittedOrganizationRead) requireBatchAccess(request, panel.batch_id);
    }
    if (params.storyboardReferenceId) {
      const reference = db.getStoryboardReference(params.storyboardReferenceId);
      if (!reference) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, reference.batch_id);
    }
  });

  const effectiveRuntimeConfig = {
    ...runtimeConfig,
    storyark: storyarkConfig,
    mainModel: mainModelConfig,
    imageModel: imageModelConfig
  };
  app.get('/api/v1/health', async () => ({ ok: true, now: new Date().toISOString(), config: publicConfig(effectiveRuntimeConfig) }));
  app.get('/api/v1/config', async () => publicConfig(effectiveRuntimeConfig));

  app.post('/api/v1/auth/register', async (request, reply) => {
    const clearRateLimit = assertAuthRateLimit(request, request.body?.email);
    const session = auth.register(request.body || {});
    clearRateLimit();
    reply.header('set-cookie', cookieFor(session.token, authConfig.sessionDays * 86_400));
    reply.status(201);
    return { user: session.user, csrfToken: session.csrfToken, registrationEnabled: auth.registrationEnabled() };
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const clearRateLimit = assertAuthRateLimit(request, request.body?.email);
    const session = auth.login(request.body || {});
    clearRateLimit();
    reply.header('set-cookie', cookieFor(session.token, authConfig.sessionDays * 86_400));
    return { user: session.user, csrfToken: session.csrfToken, registrationEnabled: auth.registrationEnabled() };
  });
  app.get('/api/v1/auth/session', async (request) => {
    const session = auth.authenticate(sessionToken(request));
    if (!session) throw apiError('authentication_required', '请先登录后继续。', 401);
    return { user: publicUser(session), csrfToken: session.csrf_token, registrationEnabled: auth.registrationEnabled() };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    auth.logout(sessionToken(request));
    reply.header('set-cookie', cookieFor('', 0));
    return { ok: true };
  });

  app.get('/api/v1/batches', async (request) => ({
    batches: db.listBatches({
      ownerUserId: request.authUser?.id || null,
      includeAll: !authConfig.required || request.authUser?.role === 'admin',
      workflowType: request.query?.workflowType ?? null
    })
  }));
  app.post('/api/v1/batches', async (request, reply) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name) throw apiError('name_required', 'Please enter a batch name.', 422);
    reply.status(201);
    return db.createBatch(
      name.slice(0, 120),
      request.authUser?.id || null,
      request.body?.workflowType ?? 'comic_pipeline'
    );
  });
  app.get('/api/v1/batches/:batchId', async (request) => {
    const batch = db.getBatchDetails(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    return serializeCreatorBatch(batch);
  });
  app.post('/api/v1/batches/:batchId/panel-deadlines', async (request) => ({
    panels: db.setPanelDeadlines({
      batchId: request.params.batchId,
      updates: request.body?.updates,
      actorUserId: request.authUser?.id || null
    }).map(serializeCreatorPanel)
  }));
  app.post('/api/v1/panels/:panelId/submit', async (request) => ({
    panel: serializeCreatorPanel(db.submitStoryboardPanel({
      panelId: request.params.panelId,
      actorUserId: request.authUser?.id || null,
      assetVersionId: request.body?.assetVersionId || null
    }))
  }));
  app.delete('/api/v1/panels/:panelId', async (request) => ({
    deletion: db.softDeleteStoryboardPanel({
      panelId: request.params.panelId,
      deletedByUserId: request.authUser?.id || null
    })
  }));
  app.get('/api/v1/organization/submissions', async (request) => ({
    organization: request.authUser?.organization || null,
    submissions: db.listOrganizationSubmissions(request.authUser.id)
  }));
  app.get('/api/v1/admin/organizations', async (request) => {
    requireAdmin(request, '只有平台管理员可以管理组织。');
    return { organizations: db.listOrganizations() };
  });
  app.get('/api/v1/admin/dashboard', async (request) => {
    requireAdmin(request, '只有平台管理员可以查看管理后台。');
    return buildAdminDashboard(db.getAdminDashboardSnapshot(), {
      runtimeConfig, storyarkConfig, mainModelConfig, imageModelConfig, storyboardConfig, authConfig
    });
  });
  app.post('/api/v1/admin/organizations', async (request, reply) => {
    requireAdmin(request, '只有平台管理员可以管理组织。');
    const organization = db.createOrganization(request.body?.name);
    reply.status(201);
    return { organization };
  });
  app.post('/api/v1/admin/organizations/:organizationId/members', async (request) => {
    requireAdmin(request, '只有平台管理员可以管理组织成员。');
    const user = db.findUserByEmail(String(request.body?.email || '').trim().toLowerCase());
    if (!user) throw apiError('resource_not_found', '账号不存在。', 404);
    return {
      membership: db.assignUserToOrganization({
        userId: user.id,
        organizationId: request.params.organizationId,
        role: request.body?.role || 'member'
      })
    };
  });
  app.post('/api/v1/batches/:batchId/panels/reorder', async (request) => {
    const panelIds = request.body?.panelIds;
    if (!Array.isArray(panelIds)) throw apiError('invalid_panel_order', 'panelIds must be an array.', 422);
    return db.reorderPanels(request.params.batchId, panelIds);
  });

  app.post('/api/v1/batches/:batchId/panels', async (request, reply) => {
    const batch = db.getBatchDetails(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    const incoming = [];
    let totalBytes = 0;
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      const buffer = await part.toBuffer();
      totalBytes += buffer.length;
      if (totalBytes > maxRequestBytes) throw apiError('batch_upload_too_large', 'This upload is too large for the internal P0 batch limit.', 413);
      incoming.push({ buffer, filename: part.filename, mimeType: part.mimetype });
    }
    if (!incoming.length) throw apiError('files_required', 'Select at least one PNG, JPEG or WebP image.', 422);
    if (batch.panels.length + incoming.length > runtimeConfig.maxUploadFiles) {
      throw apiError('panel_limit_exceeded', `A P0 batch supports at most ${runtimeConfig.maxUploadFiles} panels.`, 422);
    }
    let ordinal = batch.panels.reduce((maximum, panel) => Math.max(maximum, panel.ordinal), 0);
    const prepared = [];
    for (const incomingFile of incoming) {
      ordinal += 1;
      const panelId = randomUUID();
      const normalized = await assetService.normalizeUpload(incomingFile.buffer, {
        batchId: batch.id, panelId, originalFilename: incomingFile.filename
      });
      prepared.push({ incomingFile, panelId, ordinal, normalized });
    }
    const created = db.addPanelsWithSourcesAtomic(prepared.map((item) => ({
      panelId: item.panelId,
      batchId: batch.id,
      ordinal: item.ordinal,
      originalFilename: item.incomingFile.filename || `panel-${item.ordinal}.png`,
      source: {
        blobPath: item.normalized.relativePath,
        sha256: item.normalized.sha256,
        mimeType: item.normalized.mimeType,
        width: item.normalized.width,
        height: item.normalized.height,
        byteSize: item.normalized.byteSize,
        metadata: item.normalized.metadata
      }
    })));
    reply.status(201);
    return { created };
  });

  const assertProviderAllowed = (provider) => {
    if (!['mock', 'miguo'].includes(provider)) throw apiError('provider_not_allowed', 'Provider must be mock or miguo.', 422);
  };

  const assertRealProviderEnabled = (provider, request = null) => {
    if (provider !== 'miguo') return;
    if (authConfig.required && !request?.authUser) throw apiError('authentication_required', '请先登录后继续。', 401);
    if (!runtimeConfig.miguo.accountId || !runtimeConfig.miguo.apiToken
      || !runtimeConfig.miguo.allowRealProvider || !runtimeConfig.miguo.internalUseAcknowledged) {
      throw apiError('real_provider_blocked', 'Real Miguo calls remain locked until credentials and both internal P0 safety gates are enabled.', 409);
    }
  };

  const assertMiguoSlowChannel = (provider, params) => {
    if (provider !== 'miguo') return;
    const channel = params?.channel || runtimeConfig.miguo.channel || 'slow';
    if (channel !== 'slow') {
      throw apiError(
        'invalid_channel',
        'Real Miguo generation is restricted to the recoverable slow channel.',
        422
      );
    }
  };

  const assertStoryarkExecutionEnabled = (request) => {
    if (authConfig.required && !request?.authUser) throw apiError('authentication_required', '请先登录后继续。', 401);
    if (!storyarkConfig.accountId || !storyarkConfig.apiToken
      || !storyarkConfig.allowRealProvider || !storyarkConfig.internalUseAcknowledged) {
      throw apiError(
        'real_provider_blocked',
        'Miguo 3.0 generation remains locked until its credentials and both paid-execution safety gates are enabled.',
        409
      );
    }
  };

  const assertMainModelEnabled = (request) => {
    if (authConfig.required && !request?.authUser) throw apiError('authentication_required', '请先登录后继续。', 401);
    if (!mainModelConfig.baseUrl || !mainModelConfig.apiKey) {
      throw apiError('main_model_not_configured', 'Studio 主模型中转站尚未配置。', 409);
    }
    if (!mainModelConfig.enabled) {
      throw apiError('main_model_disabled', 'Studio 主模型 Agent 尚未开启。', 409);
    }
  };

  const assertImageModelExecutionEnabled = (request) => {
    if (authConfig.required && !request?.authUser) throw apiError('authentication_required', '请先登录后继续。', 401);
    if (!imageModelConfig.baseUrl || !imageModelConfig.apiKey) {
      throw apiError('image_model_not_configured', 'Nano Banana 2 中转站尚未配置。', 409);
    }
    if (!imageModelConfig.enabled || !imageModelConfig.allowGeneration
      || !imageModelConfig.internalUseAcknowledged) {
      throw apiError('real_provider_blocked', 'Nano Banana 2 generation remains locked until both image-generation safety gates are enabled.', 409);
    }
    if (imageModelConfig.model !== 'gemini-3.1-flash-image') {
      throw apiError('image_model_unavailable', 'The configured storyboard image model must be gemini-3.1-flash-image.', 409);
    }
  };

  const executeStoryboardAnalysis = async ({
    panel, referenceAssetId, mode, modificationNote = '', idempotencyKey, requestedByUserId
  }) => {
    const source = db.getCurrentAsset(panel.id, 'source');
    if (!source || source.status !== 'approved') {
      throw apiError('missing_approved_input', 'This panel has no approved storyboard input.', 409);
    }
    const reference = db.getStoryboardReference(referenceAssetId);
    if (!reference) throw apiError('storyboard_reference_not_found', 'Upload a character reference image first.', 422);
    const modelName = providers.mainModel.modelForMode(mode);
    const inputFingerprint = sha256(JSON.stringify({
      panelId: panel.id,
      source: { id: source.id, sha256: source.sha256 },
      reference: { id: reference.id, sha256: reference.sha256 },
      mode,
      modelName,
      modificationNote,
      promptRevision: STORYBOARD_ANALYSIS_PROMPT_REVISION
    }));
    const reusable = db.findReusableStoryboardAnalysis({
      inputFingerprint,
      mode,
      modelName,
      promptRevision: STORYBOARD_ANALYSIS_PROMPT_REVISION
    });
    if (reusable) {
      return {
        analysis: mode === 'single' ? await storyboardPlanService.prepare(reusable.id) : reusable,
        deduplicated: true,
        reused: true
      };
    }
    const queued = db.queueStoryboardAnalysis({
      panelId: panel.id,
      sourceAssetVersionId: source.id,
      referenceAssetId: reference.id,
      mode,
      modelName,
      promptRevision: STORYBOARD_ANALYSIS_PROMPT_REVISION,
      modificationNote,
      idempotencyKey,
      inputFingerprint,
      requestedByUserId
    });
    if (queued.deduplicated) {
      if (mode === 'single' && queued.analysis.status === 'succeeded') {
        return { analysis: await storyboardPlanService.prepare(queued.analysis.id), deduplicated: true };
      }
      if (queued.analysis.status === 'failed') {
        const code = queued.analysis.error_code || 'main_model_unavailable';
        const statusCode = code === 'main_model_rate_limited' ? 429
          : ['main_model_not_configured', 'main_model_disabled'].includes(code) ? 409 : 502;
        throw apiError(
          code,
          queued.analysis.error_message || 'The previous Studio main-model analysis attempt failed.',
          statusCode
        );
      }
      return queued;
    }
    try {
      const completed = await providers.mainModel.analyzeStoryboard({
        mode,
        storyboardAsset: source,
        referenceAsset: reference,
        modificationNote,
        idempotencyKey
      });
      let analysis = db.completeStoryboardAnalysis({
          analysisId: queued.analysis.id,
          result: completed.result,
          responseId: completed.responseId,
          usage: completed.usage
        });
      if (mode === 'single') analysis = await storyboardPlanService.prepare(analysis.id);
      return { analysis, deduplicated: false };
    } catch (error) {
      db.failStoryboardAnalysis({
        analysisId: queued.analysis.id,
        code: error?.code || 'main_model_unavailable',
        message: error?.message || 'The Studio main-model analysis failed.',
        responseId: error?.providerResponseId || null,
        usage: error?.usage || {}
      });
      throw error;
    }
  };

  const assertRealBudget = ({ batchId, stage, params, newRunCount }) => {
    if (!newRunCount) return;
    const realRuns = db.listRunsForBatch(batchId).filter((run) => run.provider === 'miguo' && run.status !== 'cancelled');
    const incurred = realRuns.reduce((total, run) => total + Number(run.cost_points || 0), 0);
    const reserved = realRuns
      .filter((run) => ['queued', 'running'].includes(run.status) || run.cost_source === 'unknown')
      .reduce((total, run) => {
        const frozenEstimate = Number(run.estimated_cost_points || 0);
        return total + (frozenEstimate > 0
          ? frozenEstimate
          : estimateMiguoPoints(run.stage, run.params.channel || runtimeConfig.miguo.channel));
      }, 0);
    const planned = newRunCount * estimateMiguoPoints(stage, params.channel || runtimeConfig.miguo.channel);
    const limit = runtimeConfig.maxPointsPerBatch ?? 2_880;
    if (incurred + reserved + planned > limit) {
      throw apiError('cost_limit_reached', `This batch would exceed the ${limit}-point P0 safety limit.`, 409, {
        incurred, reserved, planned, limit
      });
    }
  };

  const classicReconciliationEvidence = (request, extraFields = []) => {
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw apiError(
        'idempotency_key_required',
        'An explicit Idempotency-Key is required for an audited reconciliation.',
        422
      );
    }
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body : {};
    const allowed = new Set([
      'providerRequestId', 'providerTaskId', 'resultShapeFingerprint',
      'costPoints', 'costSource', 'note', 'evidenceReference', ...extraFields
    ]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw apiError('invalid_reconciliation_evidence', `Unsupported reconciliation fields: ${unknown.join(', ')}`, 422);
    }
    return {
      idempotencyKey,
      providerRequestId: body.providerRequestId ?? null,
      providerTaskId: body.providerTaskId ?? null,
      resultShapeFingerprint: body.resultShapeFingerprint ?? null,
      costPoints: body.costPoints,
      costSource: body.costSource,
      note: body.note,
      evidenceReference: body.evidenceReference
    };
  };

  const queuePanelRun = ({ panelId, stage, provider, params, idempotencyKey, request }) => {
    assertStage(stage, { generatableOnly: true });
    assertProviderAllowed(provider);
    const panel = db.getPanel(panelId);
    if (!panel) throw apiError('panel_not_found', 'Panel not found.', 404);
    const inputs = db.getRequiredInputs(panelId, stage).map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
    const safeParams = allowedParams(stage, params);
    const replay = db.findRunByIdempotencyKey(idempotencyKey);
    if (replay) {
      const sameRequest = replay.panel_id === panelId
        && replay.stage === stage
        && replay.provider === provider
        && JSON.stringify(replay.params) === JSON.stringify(safeParams)
        && JSON.stringify(replay.inputVersions) === JSON.stringify(inputs);
      if (!sameRequest) throw apiError('idempotency_key_conflict', 'This idempotency key is already bound to a different operation.', 409);
      return { run: replay, deduplicated: true };
    }
    assertRealProviderEnabled(provider, request);
    assertMiguoSlowChannel(provider, safeParams);
    if (provider === 'miguo' && db.countAttemptsForInputs(panelId, stage, inputs, provider) >= 2) {
      throw apiError('attempt_limit_reached', '当前素材的真实生成版本已达到安全上限，请更新输入素材或新建任务后继续。', 409);
    }
    if (db.getActiveRun(panelId, stage)) throw apiError('active_run_exists', 'This panel already has an active run for the same stage.', 409);
    if (provider === 'miguo') assertRealBudget({ batchId: panel.batch_id, stage, params: safeParams, newRunCount: 1 });
    return db.queueRun({
      panelId, stage, provider, toolName: toolForStage(stage), params: safeParams,
      idempotencyKey, inputVersions: inputs,
      providerProfile: provider === 'miguo' ? MIGUO_FACTORY_CONNECTION_ID : 'mock',
      providerContractFingerprint: provider === 'miguo' ? MIGUO_FACTORY_CONTRACT_FINGERPRINT : null,
      pricingRevision: provider === 'miguo' ? MIGUO_FACTORY_PRICING_REVISION : null,
      estimatedCostPoints: provider === 'miguo'
        ? estimateMiguoPoints(stage, safeParams.channel || runtimeConfig.miguo.channel) : 0
    });
  };

  app.post('/api/v1/panels/:panelId/runs/:stage', async (request, reply) => {
    const stage = String(request.params.stage).toLowerCase();
    const provider = request.body?.provider || runtimeConfig.defaultProvider;
    const idempotencyKey = request.headers['idempotency-key'] || randomUUID();
    const queued = queuePanelRun({ panelId: request.params.panelId, stage, provider, params: request.body?.params || {}, idempotencyKey, request });
    reply.status(queued.deduplicated ? 200 : 202);
    return { ...queued, run: serializeCreatorRun(queued.run) };
  });

  app.post('/api/v1/batches/:batchId/runs/:stage', async (request, reply) => {
    const batch = db.getBatchDetails(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    const stage = String(request.params.stage).toLowerCase();
    const provider = request.body?.provider || runtimeConfig.defaultProvider;
    assertStage(stage, { generatableOnly: true });
    assertProviderAllowed(provider);
    if (request.body?.panelIds != null && !Array.isArray(request.body.panelIds)) {
      throw apiError('invalid_panel_ids', 'panelIds must be an array.', 422);
    }
    const selectedIds = request.body?.panelIds?.length ? request.body.panelIds : batch.panels.map((panel) => panel.id);
    if (!selectedIds.length) throw apiError('panels_required', 'Upload at least one panel before running a stage.', 422);
    if (new Set(selectedIds).size !== selectedIds.length) throw apiError('duplicate_panel_ids', 'panelIds must not contain duplicates.', 422);
    const selected = selectedIds.map((id) => batch.panels.find((panel) => panel.id === id));
    if (selected.some((panel) => !panel)) throw apiError('panel_batch_mismatch', 'One or more panels do not belong to this batch.', 422);
    const baseKey = request.headers['idempotency-key'] || randomUUID();
    const safeParams = allowedParams(stage, request.body?.params || {});
    const specs = selected.map((panel) => {
      const key = sha256(`${baseKey}:${panel.id}:${stage}`);
      const replay = db.findRunByIdempotencyKey(key);
      if (replay) return { replay, panel };
      assertRealProviderEnabled(provider, request);
      const inputs = db.getRequiredInputs(panel.id, stage).map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
      if (provider === 'miguo' && db.countAttemptsForInputs(panel.id, stage, inputs, provider) >= 2) {
        throw apiError('attempt_limit_reached', `第 ${panel.ordinal} 列的当前素材已达到真实生成安全上限，请更新输入素材或新建任务后继续。`, 409);
      }
      if (db.getActiveRun(panel.id, stage)) {
        throw apiError('active_run_exists', `Panel ${panel.ordinal} already has an active run for this stage.`, 409);
      }
      return { panel, key, inputs };
    });
    if (provider === 'miguo') {
      if (specs.some((spec) => !spec.replay)) assertMiguoSlowChannel(provider, safeParams);
      assertRealBudget({
        batchId: batch.id,
        stage,
        params: safeParams,
        newRunCount: specs.filter((spec) => !spec.replay).length
      });
    }
    const queued = db.queueRunsAtomic(specs.map((spec) => ({
      panelId: spec.panel.id,
      stage,
      provider,
      toolName: toolForStage(stage),
      params: safeParams,
      idempotencyKey: spec.replay?.idempotency_key || spec.key,
      inputVersions: spec.replay?.inputVersions || spec.inputs,
      providerProfile: provider === 'miguo' ? MIGUO_FACTORY_CONNECTION_ID : 'mock',
      providerContractFingerprint: provider === 'miguo' ? MIGUO_FACTORY_CONTRACT_FINGERPRINT : null,
      pricingRevision: provider === 'miguo' ? MIGUO_FACTORY_PRICING_REVISION : null,
      estimatedCostPoints: provider === 'miguo'
        ? estimateMiguoPoints(stage, safeParams.channel || runtimeConfig.miguo.channel) : 0
    })));
    reply.status(queued.every((item) => item.deduplicated) ? 200 : 202);
    return { queued: queued.map((item) => ({ ...item, run: serializeCreatorRun(item.run) })) };
  });

  app.get('/api/v1/runs/:runId', async (request) => {
    const run = db.getRun(request.params.runId);
    if (!run) throw apiError('run_not_found', 'Run not found.', 404);
    return serializeCreatorRun(run);
  });
  app.get('/api/v1/batches/:batchId/costs', async (request) => {
    requireAdmin(request, '只有平台管理员可以查看真实调用账务。');
    if (!db.getBatchRecord(request.params.batchId)) throw apiError('batch_not_found', 'Batch not found.', 404);
    const runs = db.listRunsForBatch(request.params.batchId);
    return {
      totalPoints: runs.filter((run) => run.status !== 'cancelled').reduce((total, run) => total + Number(run.cost_points || 0), 0),
      unknownAttemptCount: runs.filter((run) => run.cost_source === 'unknown').length,
      attempts: runs.map((run) => ({
        id: run.id,
        panelId: run.panel_id,
        stage: run.stage,
        provider: run.provider,
        tool: run.tool_name,
        status: run.status,
        points: run.cost_points,
        source: run.cost_source,
        durationMs: run.duration_ms,
        errorCode: run.error_code,
        createdAt: run.created_at,
        finishedAt: run.finished_at
      }))
    };
  });
  app.post('/api/v1/runs/:runId/retry', async (request, reply) => {
    const idempotencyKey = request.headers['idempotency-key'] || `${request.params.runId}:retry:${randomUUID()}`;
    const original = db.getRun(request.params.runId);
    if (!original) throw apiError('run_not_found', 'Run not found.', 404);
    assertRealProviderEnabled(original.provider, request);
    if (original.status !== 'failed') throw apiError('run_not_retryable', 'Only failed runs can be retried.', 409);
    if (original.error_code === 'output_missing') {
      throw apiError('run_not_retryable', 'A paid provider response had no recognized output; reconcile that attempt instead of retrying it.', 409);
    }
    if (original.error_code === 'unknown_outcome' || original.cost_source === 'unknown') {
      throw apiError('unknown_outcome', 'This run may already have incurred a provider charge and cannot be retried automatically.', 409);
    }
    const currentInputs = db.getRequiredInputs(original.panel_id, original.stage)
      .map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
    if (JSON.stringify(currentInputs) !== JSON.stringify(original.inputVersions)) {
      throw apiError('input_snapshot_changed', 'The selected upstream version changed; start a new run from the current input instead.', 409);
    }
    if (original.provider === 'miguo') {
      const panel = db.getPanel(original.panel_id);
      assertMiguoSlowChannel(original.provider, original.params);
      assertRealBudget({ batchId: panel.batch_id, stage: original.stage, params: original.params, newRunCount: 1 });
    }
    const queued = db.retryRun(original.id, idempotencyKey);
    reply.status(202);
    return { ...queued, run: serializeCreatorRun(queued.run) };
  });
  app.get('/api/v1/runs/:runId/reconciliation-events', async (request) => {
    requireAdmin(request, '只有平台管理员可以查看真实调用对账记录。');
    const run = db.getRun(request.params.runId);
    if (!run) throw apiError('run_not_found', 'Run not found.', 404);
    return { events: db.listRunReconciliationEvents(run.id) };
  });
  app.get('/api/v1/admin/classic-recovery-jobs', async (request) => {
    requireAdmin(request, '只有平台管理员可以查看后台结果恢复任务。');
    const summary = db.getClassicRecoverySummary();
    const jobs = db.listClassicRecoveryJobs()
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, 8)
      .map((job) => {
        const run = db.getRun(job.run_id);
        return {
          stage: ['ink', 'color', 'light'].includes(run?.stage) ? run.stage : 'unknown',
          state: job.state === 'resolved'
            ? 'completed'
            : job.state === 'manual_review' ? 'attention' : 'recovering',
          attempts: Number(job.attempts || 0),
          updatedAt: job.updated_at
        };
      });
    return {
      summary: {
        totalCount: summary.totalCount,
        unresolvedCount: summary.unresolvedCount,
        recoveringCount: Math.max(0, summary.unresolvedCount - summary.manualReviewCount),
        completedCount: summary.stateCounts.resolved,
        attentionCount: summary.manualReviewCount
      },
      jobs
    };
  });
  app.post('/api/v1/runs/:runId/reconcile-cost', async (request) => {
    requireAdmin(request, '只有平台管理员可以对账真实米粿调用。');
    return db.reconcileClassicRunCost({
      runId: request.params.runId,
      actorUserId: request.authUser?.id || null,
      ...classicReconciliationEvidence(request)
    });
  });
  app.post('/api/v1/runs/:runId/attach-existing-output', async (request) => {
    requireAdmin(request, '只有平台管理员可以挂接已核验的米粿结果。');
    const evidence = classicReconciliationEvidence(request, ['outputAssetVersionId']);
    return db.attachExistingOutputToClassicRun({
      runId: request.params.runId,
      outputAssetVersionId: request.body?.outputAssetVersionId,
      actorUserId: request.authUser?.id || null,
      ...evidence
    });
  });
  app.post('/api/v1/runs/:runId/cancel', async (request) => {
    const cancelled = db.cancelQueuedRun(request.params.runId);
    return cancelled?.run ? { ...cancelled, run: serializeCreatorRun(cancelled.run) } : cancelled;
  });

  app.post('/api/v1/assets/:assetId/promote', async (request) => {
    const promoted = db.promoteAsset(request.params.assetId);
    return { ...serializeCreatorPanel(promoted), changed: promoted.changed };
  });

  app.get('/api/v1/assets/:assetId/content', async (request, reply) => {
    const asset = db.getAsset(request.params.assetId);
    if (!asset) throw apiError('asset_not_found', 'Asset not found.', 404);
    const content = await assetService.read(asset.blob_path);
    if (sha256(content) !== asset.sha256) throw apiError('asset_integrity_mismatch', 'The stored asset failed its integrity check.', 409);
    reply.header('content-type', asset.mime_type);
    reply.header('content-length', asset.byte_size);
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(content);
  });

  app.post('/api/v1/batches/:batchId/storyboard-references', async (request, reply) => {
    const batch = db.getBatchRecord(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    let incoming = null;
    let referencePanelId = null;
    let panelFieldSeen = false;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (incoming) throw apiError('single_file_required', 'Upload exactly one character reference image.', 422);
        incoming = {
          buffer: await part.toBuffer(),
          filename: part.filename || 'storyark-reference.png'
        };
        continue;
      }
      if (part.type !== 'field') continue;
      if (part.fieldname !== 'panelId' || panelFieldSeen || typeof part.value !== 'string' || !part.value.trim()) {
        throw apiError(
          'invalid_storyboard_reference_parameters',
          'The optional panelId field must identify exactly one panel in this batch.',
          422
        );
      }
      panelFieldSeen = true;
      referencePanelId = part.value.trim();
    }
    if (!incoming) throw apiError('files_required', 'Select one PNG, JPEG or WebP character reference image.', 422);
    if (referencePanelId) {
      const panel = db.getPanel(referencePanelId);
      if (!panel) throw apiError('panel_not_found', 'Panel not found.', 404);
      if (panel.batch_id !== batch.id) {
        throw apiError(
          'storyboard_reference_batch_mismatch',
          'The StoryArk reference panel must belong to this batch.',
          409
        );
      }
    }
    const referenceId = randomUUID();
    const normalized = await assetService.normalizeUpload(incoming.buffer, {
      batchId: batch.id,
      panelId: `storyboard-reference-${referenceId}`,
      originalFilename: incoming.filename
    });
    const reference = db.createStoryboardReference({
      id: referenceId,
      batchId: batch.id,
      panelId: referencePanelId,
      uploadedByUserId: request.authUser?.id || null,
      blobPath: normalized.relativePath,
      sha256: normalized.sha256,
      mimeType: normalized.mimeType,
      width: normalized.width,
      height: normalized.height,
      byteSize: normalized.byteSize,
      metadata: normalized.metadata
    });
    reply.status(201);
    return { reference };
  });

  app.get('/api/v1/batches/:batchId/storyboard-references', async (request) => {
    const batch = db.getBatchRecord(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    return { references: db.listStoryboardReferences({ batchId: batch.id }) };
  });

  app.post('/api/v1/panels/:panelId/storyboard-clone', async (request, reply) => {
    const sourcePanel = db.getPanel(request.params.panelId);
    if (!sourcePanel) throw apiError('panel_not_found', 'Panel not found.', 404);
    requireBatchAccess(request, sourcePanel.batch_id);
    const targetBatchId = typeof request.body?.targetBatchId === 'string' ? request.body.targetBatchId.trim() : '';
    const referenceAssetId = typeof request.body?.referenceAssetId === 'string' ? request.body.referenceAssetId.trim() : '';
    if (!targetBatchId || !referenceAssetId) {
      throw apiError('storyboard_clone_parameters_required', 'Target batch and legacy reference are required.', 422);
    }
    requireBatchAccess(request, targetBatchId);
    const cloned = db.cloneStoryboardTask({
      sourcePanelId: sourcePanel.id,
      sourceReferenceId: referenceAssetId,
      targetBatchId,
      requestedByUserId: request.authUser?.id || null
    });
    reply.status(201);
    return cloned;
  });

  app.get('/api/v1/storyboard-references/:storyboardReferenceId/content', async (request, reply) => {
    const reference = db.getStoryboardReference(request.params.storyboardReferenceId);
    if (!reference) throw apiError('storyboard_reference_not_found', 'StoryArk reference not found.', 404);
    const content = await assetService.read(reference.blob_path);
    if (sha256(content) !== reference.sha256) {
      throw apiError('asset_integrity_mismatch', 'The stored StoryArk reference failed its integrity check.', 409);
    }
    reply.header('content-type', reference.mime_type);
    reply.header('content-length', reference.byte_size);
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(content);
  });

  app.post('/api/v1/panels/:panelId/storyboard-analysis', async (request, reply) => {
    assertMainModelEnabled(request);
    const panel = db.getPanel(request.params.panelId);
    if (!panel) throw apiError('panel_not_found', 'Panel not found.', 404);
    const body = request.body || {};
    const unknown = Object.keys(body).filter((key) => !['referenceAssetId', 'modificationNote'].includes(key));
    if (unknown.length) throw apiError('invalid_storyboard_analysis_parameters', `Unsupported parameters: ${unknown.join(', ')}`, 422);
    const referenceAssetId = typeof body.referenceAssetId === 'string' ? body.referenceAssetId.trim() : '';
    if (!referenceAssetId) throw apiError('storyboard_reference_not_found', 'Upload a character reference image first.', 422);
    if (body.modificationNote != null && typeof body.modificationNote !== 'string') {
      throw apiError('invalid_storyboard_analysis_parameters', 'modificationNote must be a string.', 422);
    }
    const modificationNote = String(body.modificationNote || '').trim().slice(0, 500);
    const idempotencyKey = request.headers['idempotency-key'] || randomUUID();
    const analyzed = await executeStoryboardAnalysis({
      panel,
      referenceAssetId,
      mode: 'single',
      modificationNote,
      idempotencyKey,
      requestedByUserId: request.authUser?.id || null
    });
    reply.status(analyzed.deduplicated ? 200 : 201);
    return { ...analyzed, analysis: serializeCreatorStoryboardAnalysis(analyzed.analysis) };
  });

  app.post('/api/v1/batches/:batchId/storyboard-analyses', async (request) => {
    assertMainModelEnabled(request);
    const batch = db.getBatchDetails(request.params.batchId);
    if (!batch) throw apiError('batch_not_found', 'Batch not found.', 404);
    const body = request.body || {};
    const unknown = Object.keys(body).filter((key) => key !== 'items');
    if (unknown.length) throw apiError('invalid_storyboard_analysis_parameters', `Unsupported parameters: ${unknown.join(', ')}`, 422);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > mainModelConfig.maxBatchPanels) {
      throw apiError(
        'invalid_storyboard_analysis_parameters',
        `items must contain from 1 to ${mainModelConfig.maxBatchPanels} panel/reference pairs.`,
        422
      );
    }
    const seenPanels = new Set();
    const items = body.items.map((item) => {
      const panel = batch.panels.find((candidate) => candidate.id === item?.panelId);
      const referenceAssetId = typeof item?.referenceAssetId === 'string' ? item.referenceAssetId.trim() : '';
      if (!panel || !referenceAssetId || seenPanels.has(panel.id)) {
        throw apiError('invalid_storyboard_analysis_parameters', 'Each batch-analysis item must identify one unique panel and reference.', 422);
      }
      seenPanels.add(panel.id);
      return { panel, referenceAssetId };
    });
    const baseKey = request.headers['idempotency-key'] || randomUUID();
    const results = [];
    for (const item of items) {
      try {
        const analyzed = await executeStoryboardAnalysis({
          ...item,
          mode: 'batch',
          idempotencyKey: sha256(`${baseKey}:${item.panel.id}:batch-analysis`),
          requestedByUserId: request.authUser?.id || null
        });
        results.push({ panelId: item.panel.id, analysis: serializeCreatorStoryboardAnalysis(analyzed.analysis), deduplicated: analyzed.deduplicated });
      } catch (error) {
        results.push({
          panelId: item.panel.id,
          error: { code: error?.code || 'main_model_unavailable', message: '该分镜的低成本分析未完成，可单独重试。' }
        });
      }
    }
    return { mode: 'batch', results };
  });

  app.get('/api/v1/panels/:panelId/storyboard-analyses', async (request) => {
    const panel = db.getPanel(request.params.panelId);
    if (!panel) throw apiError('panel_not_found', 'Panel not found.', 404);
    return { analyses: db.listStoryboardAnalyses({ panelId: panel.id }).map(serializeCreatorStoryboardAnalysis) };
  });

  app.post('/api/v1/panels/:panelId/storyboard-runs', async (request, reply) => {
    const panel = db.getPanel(request.params.panelId);
    if (!panel) throw apiError('panel_not_found', 'Panel not found.', 404);
    const body = request.body || {};
    const allowed = new Set(['referenceAssetId', 'analysisId', 'projectId', 'imageSize', 'expectedResultCount', 'removeBg', 'modificationNote', 'renderProvider']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw apiError('invalid_storyboard_parameters', `Unsupported parameters: ${unknown.join(', ')}`, 422);
    if (body.renderProvider != null && typeof body.renderProvider !== 'string') {
      throw apiError('invalid_storyboard_parameters', 'renderProvider must be a string when supplied by a legacy client.', 422);
    }
    const imageSize = body.imageSize || '1K';
    const expectedResultCount = body.expectedResultCount ?? 1;
    const requestedRenderProvider = typeof body.renderProvider === 'string' ? body.renderProvider.trim() : '';
    const managedRenderProvider = storyboardManagedConfig
      ? (storyboardConfig.renderProvider === 'storyark' ? 'storyark' : 'nano_banana_2')
      : (requestedRenderProvider || 'storyark');
    const renderProvider = managedRenderProvider;
    const requestedProjectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
    const projectId = renderProvider === 'nano_banana_2'
      ? `studio:${NANO_BANANA_CONNECTION_ID}`
      : String(storyboardManagedConfig ? storyboardConfig.projectId : requestedProjectId).trim();
    const referenceAssetId = typeof body.referenceAssetId === 'string' ? body.referenceAssetId.trim() : '';
    const requestedAnalysisId = typeof body.analysisId === 'string' ? body.analysisId.trim() : '';
    const modificationNote = body.modificationNote == null
      ? ''
      : typeof body.modificationNote === 'string'
        ? body.modificationNote.trim().slice(0, 500)
        : null;
    const idempotencyKey = request.headers['idempotency-key'] || randomUUID();
    const existingRun = db.findStoryboardRunByIdempotencyKey(idempotencyKey);
    if (existingRun) {
      // A retry may arrive after the server's default route, model or provider
      // contract has changed. Idempotency is bound to the original paid
      // operation, so authenticate access and compare only the caller-owned
      // request fields before returning the frozen row unchanged. In
      // particular, never rebuild this request with today's route revision or
      // pass it through a paid-execution gate that could have since closed.
      const existingPanel = db.getPanel(existingRun.panel_id);
      if (!existingPanel) throw apiError('resource_not_found', 'Resource not found.', 404);
      requireBatchAccess(request, existingPanel.batch_id);
      const existingRenderProvider = existingRun.request?.renderProvider
        || (existingRun.provider_connection_id === NANO_BANANA_CONNECTION_ID
          ? 'nano_banana_2' : 'storyark');
      const hasFrozenRequestedProject = Object.hasOwn(existingRun.request || {}, 'requestedProjectId');
      const replayProjectId = existingRenderProvider === 'nano_banana_2'
        ? `studio:${NANO_BANANA_CONNECTION_ID}` : requestedProjectId;
      const sameProject = !Object.hasOwn(body, 'projectId') || (hasFrozenRequestedProject
        ? existingRun.request.requestedProjectId === requestedProjectId
        : existingRun.project_id === replayProjectId);
      const samePublicRequest = existingRun.panel_id === panel.id
        && (!requestedRenderProvider || existingRenderProvider === requestedRenderProvider)
        && sameProject
        && existingRun.image_size === imageSize
        && existingRun.expected_result_count === expectedResultCount
        && Boolean(existingRun.remove_bg) === Boolean(body.removeBg)
        && existingRun.reference_asset_id === referenceAssetId
        && (existingRun.analysis_id || '') === requestedAnalysisId
        && (existingRun.modification_note || '') === modificationNote;
      if (!samePublicRequest) {
        throw apiError(
          'idempotency_key_conflict',
          'This idempotency key is already bound to a different storyboard operation.',
          409
        );
      }
      reply.status(200);
      return { run: serializeCreatorStoryboardRun(existingRun), deduplicated: true };
    }
    if (storyboardManagedConfig && requestedRenderProvider && requestedRenderProvider !== managedRenderProvider) {
      throw apiError('storyboard_renderer_managed', 'The storyboard renderer is managed by the server.', 409);
    }
    if (!['storyark', 'nano_banana_2'].includes(renderProvider)) {
      throw apiError('invalid_storyboard_parameters', 'renderProvider must be storyark or nano_banana_2.', 422);
    }
    if (!['1K', '2K', '4K'].includes(imageSize)) throw apiError('invalid_storyboard_parameters', 'imageSize must be 1K, 2K, or 4K.', 422);
    if (!Number.isInteger(expectedResultCount) || expectedResultCount < 1 || expectedResultCount > 4) {
      throw apiError('invalid_storyboard_parameters', 'expectedResultCount must be an integer from 1 to 4.', 422);
    }
    if (renderProvider === 'nano_banana_2' && expectedResultCount !== 1) {
      throw apiError('invalid_storyboard_parameters', 'Nano Banana 2 currently produces exactly one provider result per task.', 422);
    }
    if (body.removeBg != null && typeof body.removeBg !== 'boolean') {
      throw apiError('invalid_storyboard_parameters', 'removeBg must be true or false.', 422);
    }
    if (body.removeBg === true) {
      throw apiError(
        'invalid_storyboard_parameters',
        'Full-canvas storyboard rendering requires removeBg to be false.',
        422
      );
    }
    if (modificationNote == null) {
      throw apiError('invalid_storyboard_parameters', 'modificationNote must be a string.', 422);
    }
    if (!projectId || projectId.length > 200) throw apiError('storyboard_project_required', 'The server-managed storyboard project is not configured.', 422);
    if (!referenceAssetId) throw apiError('storyboard_reference_not_found', 'Upload a character reference image first.', 422);
    if (renderProvider === 'nano_banana_2') assertImageModelExecutionEnabled(request);
    else assertStoryarkExecutionEnabled(request);
    const source = db.getCurrentAsset(panel.id, 'source');
    if (!source || source.status !== 'approved') throw apiError('missing_approved_input', 'This panel has no approved source draft.', 409);
    if (!requestedAnalysisId) {
      throw apiError('storyboard_analysis_not_ready', 'Run the Terra single-item storyboard analysis before paid generation.', 409);
    }
    const preparedAnalysis = db.getStoryboardAnalysis(requestedAnalysisId);
    if (!preparedAnalysis || preparedAnalysis.status !== 'succeeded' || preparedAnalysis.mode !== 'single'
      || preparedAnalysis.model_name !== mainModelConfig.interactiveModel
      || preparedAnalysis.prompt_revision !== STORYBOARD_ANALYSIS_PROMPT_REVISION
      || preparedAnalysis.panel_id !== panel.id || preparedAnalysis.source_asset_version_id !== source.id
      || preparedAnalysis.reference_asset_id !== referenceAssetId
      || preparedAnalysis.modification_note !== modificationNote
      || !preparedAnalysis.generation_source_asset_version_id
      || preparedAnalysis.generationTarget?.strategy !== 'storyboard-reference-instance-composite-v2') {
      throw apiError(
        'storyboard_analysis_mismatch',
        'The paid task requires a completed Terra selective-mask analysis for these exact storyboard and reference inputs.',
        409
      );
    }
    const analysisId = requestedAnalysisId;
    const queueSpec = {
      panelId: panel.id,
      idempotencyKey,
      contractFingerprint: renderProvider === 'nano_banana_2'
        ? NANO_BANANA_CONTRACT_FINGERPRINT : STORYARK_CONTRACT_FINGERPRINT,
      projectId,
      imageSize,
      expectedResultCount,
      removeBg: Boolean(body.removeBg),
      sourceAssetVersionId: preparedAnalysis.generation_source_asset_version_id,
      referenceAssetId,
      analysisId,
      modificationNote,
      renderProvider,
      maxResultsPerBatch: storyarkConfig.maxResultsPerBatch,
      request: {
        providerConnectionId: renderProvider === 'nano_banana_2'
          ? NANO_BANANA_CONNECTION_ID : STORYARK_CONNECTION_ID,
        requestedProjectId,
        renderProvider,
        renderModel: renderProvider === 'nano_banana_2'
          ? imageModelConfig.model : 'storyboard_inference',
        routeRevision: renderProvider === 'nano_banana_2'
          ? NANO_BANANA_RAW_ROUTE_REVISION
          : 'storyark-v3-instance-chroma-composite-3',
        analysisId,
        analysisModel: preparedAnalysis.model_name,
        analysisPromptRevision: preparedAnalysis.prompt_revision,
        modificationNote,
        analysisTarget: preparedAnalysis.generationTarget
      }
    };
    const safetySummary = db.getStoryboardRunSafetySummary();
    if (safetySummary.unknownCostRunCount) {
      throw apiError(
        'cost_reconciliation_required',
        'A previous Miguo 3.0 task has an unknown coin outcome. Reconcile it before submitting any more paid tasks.',
        409,
        { unknownAttemptCount: safetySummary.unknownCostRunCount }
      );
    }
    // Different storyboard columns may queue independently. The worker keeps
    // paid provider execution serial, while the DB enforces one active run per
    // panel and checks the batch result quota atomically with the INSERT.
    const priorStoryboardRuns = db.listStoryboardRunsForBatch(panel.batch_id)
      .filter((run) => run.status !== 'cancelled');
    const plannedResults = priorStoryboardRuns.reduce(
      (total, run) => total + Number(run.expected_result_count || 0), 0
    ) + expectedResultCount;
    if (plannedResults > storyarkConfig.maxResultsPerBatch) {
      throw apiError(
        'storyboard_result_limit_reached',
        `This batch is limited to ${storyarkConfig.maxResultsPerBatch} requested Miguo 3.0 result images in the MVP.`,
        409,
        { plannedResults, limit: storyarkConfig.maxResultsPerBatch }
      );
    }
    db.confirmStoryboardAnalysis({
      analysisId,
      userId: request.authUser?.id || null
    });
    const queued = db.queueStoryboardRun(queueSpec);
    reply.status(queued.deduplicated ? 200 : 202);
    return { ...queued, run: serializeCreatorStoryboardRun(queued.run) };
  });

  app.get('/api/v1/storyboard-runs/:storyboardRunId', async (request) => {
    const run = db.getStoryboardRun(request.params.storyboardRunId);
    if (!run) throw apiError('storyboard_run_not_found', 'StoryArk run not found.', 404);
    return serializeCreatorStoryboardRun(run);
  });

  app.get('/api/v1/storyboard-safety', async (request) => {
    return {
      ...db.getStoryboardRunSafetySummary(),
      maxResultsPerBatch: storyarkConfig.maxResultsPerBatch
    };
  });

  app.post('/api/v1/storyboard-runs/:storyboardRunId/cancel', async (request) => {
    const cancelled = db.cancelQueuedStoryboard(request.params.storyboardRunId);
    return cancelled?.run
      ? { ...cancelled, run: serializeCreatorStoryboardRun(cancelled.run) }
      : cancelled;
  });

  app.post('/api/v1/panels/:panelId/storyboard-output-selection', async (request) => {
    const outputId = typeof request.body?.outputId === 'string' ? request.body.outputId.trim() : '';
    if (!outputId) throw apiError('storyboard_output_required', '请选择要采用的成稿版本。', 422);
    const selected = db.selectStoryboardOutput({
      panelId: request.params.panelId,
      outputId,
      selectedByUserId: request.authUser?.id || null
    });
    return {
      ...selected,
      output: selected.output ? {
        ...selected.output,
        blob_path: undefined,
        sha256: undefined,
        metadata_json: undefined,
        metadata: sanitizeCreatorMetadata(selected.output.metadata || {})
      } : null
    };
  });

  app.delete('/api/v1/storyboard-outputs/:storyboardOutputId', async (request) => ({
    deletion: db.softDeleteStoryboardOutput({
      outputId: request.params.storyboardOutputId,
      deletedByUserId: request.authUser?.id || null
    })
  }));

  app.get('/api/v1/storyboard-outputs/:storyboardOutputId/content', async (request, reply) => {
    const output = db.getStoryboardOutput(request.params.storyboardOutputId);
    if (!output) throw apiError('storyboard_output_not_found', 'StoryArk output not found.', 404);
    const content = await assetService.read(output.blob_path);
    if (sha256(content) !== output.sha256) throw apiError('asset_integrity_mismatch', 'The stored StoryArk output failed its integrity check.', 409);
    reply.header('content-type', output.mime_type);
    reply.header('content-length', output.byte_size);
    reply.header('cache-control', 'private, max-age=300');
    return reply.send(content);
  });

  app.post('/api/v1/batches/:batchId/exports/grid-2x2', async (request, reply) => {
    const exported = await layoutService.exportBatch(request.params.batchId);
    reply.status(201);
    return exported;
  });
  app.get('/api/v1/exports/:exportId', async (request) => {
    const exported = db.getLayoutExport(request.params.exportId);
    if (!exported) throw apiError('export_not_found', 'Export not found.', 404);
    return exported;
  });
  app.get('/api/v1/exports/:exportId/pages/:pageIndex', async (request, reply) => {
    const exported = db.getLayoutExport(request.params.exportId);
    if (!exported) throw apiError('export_not_found', 'Export not found.', 404);
    const page = exported.pages.find((entry) => entry.pageIndex === Number(request.params.pageIndex));
    if (!page) throw apiError('page_not_found', 'Export page not found.', 404);
    reply.header('content-type', 'image/png');
    return reply.send(await layoutService.readExportFile(page.relativePath));
  });
  app.get('/api/v1/exports/:exportId/manifest', async (request, reply) => {
    const exported = db.getLayoutExport(request.params.exportId);
    if (!exported) throw apiError('export_not_found', 'Export not found.', 404);
    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.send(await layoutService.readExportFile(exported.manifest_path));
  });

  app.post('/api/v1/providers/miguo/probe', async (request) => {
    requireAdmin(request, '只有管理员可以探查真实供应商。');
    const profiles = {};
    try {
      const snapshot = await providers.miguo.probe();
      profiles.factoryClassic = {
        ok: true,
        connectionId: MIGUO_FACTORY_CONNECTION_ID,
        toolCount: snapshot.available?.length || 0,
        required: snapshot.required,
        schemaFingerprint: snapshot.schemaFingerprint,
        contractFingerprint: snapshot.contractFingerprint || MIGUO_FACTORY_CONTRACT_FINGERPRINT
      };
    } catch (error) {
      profiles.factoryClassic = { ok: false, connectionId: MIGUO_FACTORY_CONNECTION_ID, code: error.code || 'provider_unavailable' };
    }
    try {
      const [snapshot, projects] = await Promise.all([providers.storyark.probe(), providers.storyark.listProjects()]);
      profiles.storyarkV3 = {
        ok: true,
        connectionId: STORYARK_CONNECTION_ID,
        toolCount: snapshot.available?.length || 0,
        projectCount: projects.length,
        schemaFingerprint: snapshot.schemaFingerprint,
        contractFingerprint: STORYARK_CONTRACT_FINGERPRINT
      };
    } catch (error) {
      profiles.storyarkV3 = { ok: false, connectionId: STORYARK_CONNECTION_ID, code: error.code || 'provider_unavailable' };
    }
    return {
      ok: Object.values(profiles).every((profile) => profile.ok),
      providerFamily: 'miguo',
      profiles,
      operations: {
        ink: { connectionId: MIGUO_FACTORY_CONNECTION_ID, tool: 'line_art_beautify_v4' },
        color: { connectionId: MIGUO_FACTORY_CONNECTION_ID, tool: 'coloring_v4' },
        light: { connectionId: MIGUO_FACTORY_CONNECTION_ID, tool: 'shadowing_v7' },
        storyboard: { connectionId: STORYARK_CONNECTION_ID, tool: 'storyboard_inference' }
      },
      paidCallPerformed: false
    };
  });

  app.get('/api/v1/providers/miguo/storyark/projects', async (request) => {
    if (!storyarkConfig.accountId || !storyarkConfig.apiToken) {
      throw apiError('provider_not_configured', '米粿 3.0 服务端凭据尚未配置。', 409);
    }
    return { projects: await providers.storyark.listProjects(), paidCallPerformed: false };
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'route_not_found', message: 'API route not found.', requestId: request.id, retryable: false } });
    }
    return reply.sendFile('index.html');
  });

  if (startWorker) {
    worker.start();
    classicRecoveryWorker.start();
    storyboardWorker.start();
  }
  app.addHook('onClose', async () => {
    await Promise.all([worker.stop(), classicRecoveryWorker.stop(), storyboardWorker.stop()]);
    db.close();
  });
  return app;
}
