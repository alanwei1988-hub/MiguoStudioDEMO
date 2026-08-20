import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { buildApp } from '../src/app.mjs';
import { config as baseConfig } from '../src/config.mjs';
import { addPanelWithSource, createApprovedSyntheticChain, queueStage } from './helpers.mjs';

async function createAuthApp(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-auth-'));
  const runtimeConfig = {
    ...baseConfig,
    ...overrides,
    dataRoot: root,
    databasePath: path.join(root, 'p0.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    exportsRoot: path.join(root, 'exports'),
    auth: {
      required: true,
      allowRegistration: true,
      cookieSecure: false,
      cookiePath: '/',
      trustProxy: false,
      sessionDays: 7,
      maxUsers: 10,
      ...(overrides.auth || {})
    },
    miguo: { ...baseConfig.miguo, ...(overrides.miguo || {}) }
  };
  const app = await buildApp({ runtimeConfig, startWorker: false });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

test('every signed-in creator can queue the platform-managed real provider while paid gates stay authoritative', async (t) => {
  const app = await createAuthApp(t, {
    miguo: {
      accountId: 'fixture-account',
      apiToken: 'fixture-token',
      allowRealProvider: true,
      internalUseAcknowledged: true,
      channel: 'slow'
    }
  });
  const creator = await register(app, {
    email: 'real-member@example.com', displayName: '真实生产成员', password: 'real-member-password'
  });
  assert.equal(creator.user.role, 'member');
  const batchResponse = await app.inject({
    method: 'POST', url: '/api/v1/batches',
    headers: { cookie: creator.cookie, 'x-csrf-token': creator.csrfToken },
    payload: { name: '成员真实生产批次' }
  });
  assert.equal(batchResponse.statusCode, 201, batchResponse.body);
  const { panel } = await addPanelWithSource({
    db: app.p0.db, assetService: app.p0.assetService
  }, { batchId: batchResponse.json().id, ordinal: 1, filename: 'member-real.png' });
  const queued = await app.inject({
    method: 'POST', url: `/api/v1/panels/${panel.id}/runs/ink`,
    headers: {
      cookie: creator.cookie,
      'x-csrf-token': creator.csrfToken,
      'idempotency-key': 'member-real-generation-1'
    },
    payload: { provider: 'miguo', params: { channel: 'slow' } }
  });
  assert.equal(queued.statusCode, 202, queued.body);
  assert.equal(queued.json().run.provider, 'miguo');
  assert.equal(app.p0.db.getRun(queued.json().run.id).provider, 'miguo');
});

function cookieOf(response) {
  return String(response.headers['set-cookie']).split(';')[0];
}

async function register(app, { email, displayName, password }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, displayName, password }
  });
  assert.equal(response.statusCode, 201, response.body);
  return { cookie: cookieOf(response), ...response.json() };
}

async function seedStoryboardReference(app, { batchId, uploadedByUserId }) {
  const buffer = await sharp({
    create: { width: 256, height: 320, channels: 3, background: '#d5c7b8' }
  }).png().toBuffer();
  const referenceId = `auth-reference-${batchId}`;
  const normalized = await app.p0.assetService.normalizeUpload(buffer, {
    batchId,
    panelId: referenceId,
    originalFilename: 'character-reference.png'
  });
  const reference = app.p0.db.createStoryboardReference({
    id: referenceId,
    batchId,
    uploadedByUserId,
    blobPath: normalized.relativePath,
    sha256: normalized.sha256,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    byteSize: normalized.byteSize,
    metadata: normalized.metadata
  });
  return { reference, content: await app.p0.assetService.read(reference.blob_path) };
}

test('registration creates a secure session and mutations require CSRF', async (t) => {
  const app = await createAuthApp(t);
  const anonymous = await app.inject({ method: 'GET', url: '/api/v1/batches' });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'authentication_required');

  const weak = await app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { email: 'weak@example.com', displayName: 'Weak', password: 'short' }
  });
  assert.equal(weak.statusCode, 422);
  assert.equal(weak.json().error.code, 'invalid_password');

  const member = await register(app, {
    email: 'artist.one@example.com', displayName: '画师一号', password: 'correct-horse-artist-one'
  });
  assert.equal(member.user.role, 'member');
  assert.match(member.cookie, /^mp\.session=/);

  const withoutCsrf = await app.inject({
    method: 'POST', url: '/api/v1/batches', headers: { cookie: member.cookie }, payload: { name: '私有批次' }
  });
  assert.equal(withoutCsrf.statusCode, 403);
  assert.equal(withoutCsrf.json().error.code, 'csrf_invalid');

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/batches',
    headers: { cookie: member.cookie, 'x-csrf-token': member.csrfToken },
    payload: { name: '私有批次' }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().owner_user_id, member.user.id);

  const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: member.cookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().user.email, 'artist.one@example.com');
});

test('members are isolated while the platform admin can see legacy and member batches', async (t) => {
  const app = await createAuthApp(t);
  const first = await register(app, {
    email: 'first@example.com', displayName: '第一位画师', password: 'first-member-password'
  });
  const second = await register(app, {
    email: 'second@example.com', displayName: '第二位画师', password: 'second-member-password'
  });
  const firstBatchResponse = await app.inject({
    method: 'POST', url: '/api/v1/batches',
    headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken }, payload: { name: '一号工作' }
  });
  const firstBatch = firstBatchResponse.json();

  const secondList = await app.inject({ method: 'GET', url: '/api/v1/batches', headers: { cookie: second.cookie } });
  assert.deepEqual(secondList.json().batches, []);
  const forbiddenLookup = await app.inject({
    method: 'GET', url: `/api/v1/batches/${firstBatch.id}`, headers: { cookie: second.cookie }
  });
  assert.equal(forbiddenLookup.statusCode, 404);

  app.p0.db.createBatch('升级前的管理员批次');
  app.p0.auth.upsertAdmin({
    email: 'platform-admin@example.com', displayName: '平台管理员', password: 'platform-admin-password'
  });
  const adminLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'platform-admin@example.com', password: 'platform-admin-password' }
  });
  assert.equal(adminLogin.statusCode, 200, adminLogin.body);
  const adminList = await app.inject({
    method: 'GET', url: '/api/v1/batches', headers: { cookie: cookieOf(adminLogin) }
  });
  assert.equal(adminList.json().batches.length, 2);

  const memberProbe = await app.inject({
    method: 'POST', url: '/api/v1/providers/miguo/probe',
    headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken }, payload: {}
  });
  assert.equal(memberProbe.statusCode, 403);
  assert.equal(memberProbe.json().error.code, 'admin_required');

  const recoveryPanel = await addPanelWithSource({
    db: app.p0.db,
    assetService: app.p0.assetService
  }, { batchId: firstBatch.id, ordinal: 1, filename: 'admin-safe-recovery.png' });
  const recoveryRun = queueStage({ db: app.p0.db }, {
    panelId: recoveryPanel.panel.id,
    stage: 'ink',
    provider: 'miguo',
    idempotencyKey: 'auth-admin-safe-recovery'
  });
  app.p0.db.claimNextQueued();
  const heldRecovery = app.p0.db.holdRunForRecovery({
    runId: recoveryRun.id,
    code: 'output_missing',
    message: 'accepted result pending automatic recovery',
    providerRequestId: 'private-request-reference',
    providerTaskId: 'private-provider-reference',
    resultShapeFingerprint: `mcp-result-shape-v2:${'c'.repeat(64)}`
  });
  app.p0.db.claimNextClassicRecovery({ leaseOwner: 'auth-contract-worker', leaseMs: 60_000 });
  app.p0.db.deferClassicRecovery({
    runId: recoveryRun.id,
    code: 'history_match_ambiguous',
    manualReview: true,
    leaseOwner: 'auth-contract-worker'
  });
  const memberRecoveryJobs = await app.inject({
    method: 'GET', url: '/api/v1/admin/classic-recovery-jobs', headers: { cookie: first.cookie }
  });
  assert.equal(memberRecoveryJobs.statusCode, 403);
  assert.equal(memberRecoveryJobs.json().error.code, 'admin_required');
  const memberCosts = await app.inject({
    method: 'GET', url: `/api/v1/batches/${firstBatch.id}/costs`, headers: { cookie: first.cookie }
  });
  assert.equal(memberCosts.statusCode, 403);
  assert.equal(memberCosts.json().error.code, 'admin_required');
  const adminRecoveryJobs = await app.inject({
    method: 'GET', url: '/api/v1/admin/classic-recovery-jobs', headers: { cookie: cookieOf(adminLogin) }
  });
  assert.equal(adminRecoveryJobs.statusCode, 200, adminRecoveryJobs.body);
  assert.deepEqual(adminRecoveryJobs.json().summary, {
    totalCount: 1,
    unresolvedCount: 1,
    recoveringCount: 0,
    completedCount: 0,
    attentionCount: 1
  });
  assert.equal(adminRecoveryJobs.json().jobs.length, 1);
  assert.deepEqual(Object.keys(adminRecoveryJobs.json().jobs[0]).sort(),
    ['stage', 'state', 'attempts', 'updatedAt'].sort());
  assert.equal(adminRecoveryJobs.json().jobs[0].stage, 'ink');
  assert.equal(adminRecoveryJobs.json().jobs[0].state, 'attention');
  assert.doesNotMatch(adminRecoveryJobs.body,
    /private-request-reference|private-provider-reference|provider_task|run_id|lease_|matched_|reason_code|last_error|https?:\/\/|token/i,
    'The admin status card endpoint must return operational state without raw provider evidence or credentials.');
  assert.ok(heldRecovery.recoveryJob.id);
  const adminCosts = await app.inject({
    method: 'GET', url: `/api/v1/batches/${firstBatch.id}/costs`, headers: { cookie: cookieOf(adminLogin) }
  });
  assert.equal(adminCosts.statusCode, 200, adminCosts.body);
  assert.ok(Array.isArray(adminCosts.json().attempts));
});

test('production admin dashboard reports real organizations, accounts, tasks and sanitized model state', async (t) => {
  const app = await createAuthApp(t, {
    mainModel: {
      ...baseConfig.mainModel,
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'fixture-main-model-secret',
      batchModel: 'gpt-5.6-luna',
      interactiveModel: 'gpt-5.6-terra',
      enabled: true
    },
    imageModel: {
      ...baseConfig.imageModel,
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'fixture-image-model-secret',
      model: 'gemini-3.1-flash-image',
      enabled: true,
      allowGeneration: true,
      internalUseAcknowledged: true
    }
  });
  const member = await register(app, {
    email: 'dashboard-member@example.com', displayName: '后台成员', password: 'dashboard-member-password'
  });
  const forbidden = await app.inject({
    method: 'GET', url: '/api/v1/admin/dashboard', headers: { cookie: member.cookie }
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, 'admin_required');

  app.p0.auth.upsertAdmin({
    email: 'dashboard-admin@example.com', displayName: '后台管理员', password: 'dashboard-admin-password'
  });
  const login = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'dashboard-admin@example.com', password: 'dashboard-admin-password' }
  });
  assert.equal(login.statusCode, 200, login.body);
  const response = await app.inject({
    method: 'GET', url: '/api/v1/admin/dashboard', headers: { cookie: cookieOf(login) }
  });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.equal(payload.summary.activeUserCount, 2);
  assert.equal(payload.organizations.length, 2);
  assert.equal(payload.users.length, 2);
  assert.equal(payload.models.main.baseUrlHost, 'relay.example.test');
  assert.equal(payload.models.main.batchModel, 'gpt-5.6-luna');
  assert.equal(payload.models.main.interactiveModel, 'gpt-5.6-terra');
  assert.equal(payload.models.image.model, 'gemini-3.1-flash-image');
  assert.equal(payload.policy.creatorAttribution, 'batch_owner');
  assert.equal(payload.policy.balanceLedgerAvailable, false);
  assert.doesNotMatch(response.body, /fixture-main-model-secret|fixture-image-model-secret|apiKey|api_key/i);
});

test('reference history respects batch ownership while paid-work safety state is available to signed-in creators', async (t) => {
  const app = await createAuthApp(t);
  const owner = await register(app, {
    email: 'reference-owner@example.com', displayName: '参考图所有者', password: 'reference-owner-password'
  });
  const outsider = await register(app, {
    email: 'reference-outsider@example.com', displayName: '其他成员', password: 'reference-outsider-password'
  });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/batches',
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: { name: '参考图创作', workflowType: 'reference_creation' }
  });
  assert.equal(created.statusCode, 201, created.body);
  const batch = created.json();
  const { reference, content } = await seedStoryboardReference(app, {
    batchId: batch.id,
    uploadedByUserId: owner.user.id
  });

  const ownerList = await app.inject({
    method: 'GET',
    url: `/api/v1/batches/${batch.id}/storyboard-references`,
    headers: { cookie: owner.cookie }
  });
  assert.equal(ownerList.statusCode, 200, ownerList.body);
  assert.deepEqual(ownerList.json().references.map((entry) => entry.id), [reference.id]);

  const details = await app.inject({
    method: 'GET', url: `/api/v1/batches/${batch.id}`, headers: { cookie: owner.cookie }
  });
  assert.equal(details.statusCode, 200, details.body);
  assert.equal(details.json().storyboardReferences[0].id, reference.id);

  const ownerContent = await app.inject({
    method: 'GET',
    url: `/api/v1/storyboard-references/${reference.id}/content`,
    headers: { cookie: owner.cookie }
  });
  assert.equal(ownerContent.statusCode, 200, ownerContent.body);
  assert.equal(ownerContent.headers['content-type'], 'image/png');
  assert.equal(ownerContent.headers['cache-control'], 'private, max-age=300');
  assert.deepEqual(ownerContent.rawPayload, content);

  const outsiderList = await app.inject({
    method: 'GET',
    url: `/api/v1/batches/${batch.id}/storyboard-references`,
    headers: { cookie: outsider.cookie }
  });
  assert.equal(outsiderList.statusCode, 404);
  const outsiderContent = await app.inject({
    method: 'GET',
    url: `/api/v1/storyboard-references/${reference.id}/content`,
    headers: { cookie: outsider.cookie }
  });
  assert.equal(outsiderContent.statusCode, 404);

  app.p0.db.db.prepare('UPDATE storyboard_reference_assets SET sha256 = ? WHERE id = ?')
    .run('0'.repeat(64), reference.id);
  const corruptContent = await app.inject({
    method: 'GET',
    url: `/api/v1/storyboard-references/${reference.id}/content`,
    headers: { cookie: owner.cookie }
  });
  assert.equal(corruptContent.statusCode, 409);
  assert.equal(corruptContent.json().error.code, 'asset_integrity_mismatch');

  const memberSafety = await app.inject({
    method: 'GET', url: '/api/v1/storyboard-safety', headers: { cookie: owner.cookie }
  });
  assert.equal(memberSafety.statusCode, 200, memberSafety.body);
  assert.deepEqual(memberSafety.json(), {
    totalRunCount: 0,
    unknownCostRunCount: 0,
    activeRunCount: 0,
    maxResultsPerBatch: 20
  });

  app.p0.auth.upsertAdmin({
    email: 'reference-admin@example.com', displayName: '参考图管理员', password: 'reference-admin-password'
  });
  const adminLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { email: 'reference-admin@example.com', password: 'reference-admin-password' }
  });
  const adminSafety = await app.inject({
    method: 'GET', url: '/api/v1/storyboard-safety', headers: { cookie: cookieOf(adminLogin) }
  });
  assert.equal(adminSafety.statusCode, 200, adminSafety.body);
  assert.deepEqual(adminSafety.json(), {
    totalRunCount: 0,
    unknownCostRunCount: 0,
    activeRunCount: 0,
    maxResultsPerBatch: 20
  });
  assert.doesNotMatch(adminSafety.body, /apiToken|accountId|providerTaskId|providerRequestId/i);
});

test('company submissions expose only the frozen result to organization members', async (t) => {
  const app = await createAuthApp(t);
  const owner = await register(app, {
    email: 'submission-owner@example.com', displayName: '排期负责人', password: 'submission-owner-password'
  });
  const colleague = await register(app, {
    email: 'submission-colleague@example.com', displayName: '协作同事', password: 'submission-colleague-password'
  });
  const outsider = await register(app, {
    email: 'submission-outsider@example.com', displayName: '其他公司', password: 'submission-outsider-password'
  });
  assert.ok(owner.user.organization?.id, 'Registration must associate the account with an organization.');
  app.p0.db.assignUserToOrganization({
    userId: colleague.user.id,
    organizationId: owner.user.organization.id,
    role: 'member'
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/batches',
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: { name: '公司提报批次', workflowType: 'reference_creation' }
  });
  assert.equal(created.statusCode, 201, created.body);
  const batch = created.json();
  const { panel, source } = await addPanelWithSource({
    db: app.p0.db,
    assetService: app.p0.assetService
  }, { batchId: batch.id, ordinal: 1, filename: 'company-submission.png' });
  const { reference } = await seedStoryboardReference(app, {
    batchId: batch.id,
    uploadedByUserId: owner.user.id
  });
  const queued = app.p0.db.queueStoryboardRun({
    panelId: panel.id,
    idempotencyKey: 'auth:company-submission:1',
    contractFingerprint: 'sha256:organization-submission-contract',
    projectId: 'organization-submission-project',
    imageSize: '1K',
    expectedResultCount: 1,
    removeBg: false,
    sourceAssetVersionId: source.id,
    referenceAssetId: reference.id,
    request: { routeRevision: 'organization-submission-fixture' }
  }).run;
  assert.equal(app.p0.db.claimNextQueuedStoryboard().id, queued.id);
  const completed = app.p0.db.completeStoryboardRunWithOutputs({
    runId: queued.id,
    outputs: [{
      ordinal: 1,
      blobPath: source.blob_path,
      sha256: source.sha256,
      mimeType: source.mime_type,
      width: source.width,
      height: source.height,
      byteSize: source.byte_size,
      metadata: { deliveryMode: 'provider_raw_resize' }
    }]
  });
  const output = completed.outputs[0];
  const deadlineAt = '2026-09-10T15:59:59.000Z';

  const deadline = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batch.id}/panel-deadlines`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: { updates: [{ panelId: panel.id, deadlineAt }] }
  });
  assert.equal(deadline.statusCode, 200, deadline.body);
  assert.equal(deadline.json().panels[0].deadline_at, deadlineAt);
  const outsiderDeadline = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${batch.id}/panel-deadlines`,
    headers: { cookie: outsider.cookie, 'x-csrf-token': outsider.csrfToken },
    payload: { updates: [{ panelId: panel.id, deadlineAt }] }
  });
  assert.equal(outsiderDeadline.statusCode, 404, outsiderDeadline.body);

  const submitted = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${panel.id}/submit`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: {}
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().panel.submitted_storyboard_output_id, output.id);

  const colleagueList = await app.inject({
    method: 'GET', url: '/api/v1/organization/submissions', headers: { cookie: colleague.cookie }
  });
  assert.equal(colleagueList.statusCode, 200, colleagueList.body);
  assert.equal(colleagueList.json().organization.id, owner.user.organization.id);
  assert.equal(colleagueList.json().submissions.length, 1);
  assert.equal(colleagueList.json().submissions[0].submitted_storyboard_output_id, output.id);
  assert.equal(colleagueList.json().submissions[0].deadline_at, deadlineAt);
  const outsiderList = await app.inject({
    method: 'GET', url: '/api/v1/organization/submissions', headers: { cookie: outsider.cookie }
  });
  assert.equal(outsiderList.statusCode, 200, outsiderList.body);
  assert.deepEqual(outsiderList.json().submissions, []);

  const colleagueContent = await app.inject({
    method: 'GET',
    url: `/api/v1/storyboard-outputs/${output.id}/content`,
    headers: { cookie: colleague.cookie }
  });
  assert.equal(colleagueContent.statusCode, 200, colleagueContent.body);
  assert.deepEqual(colleagueContent.rawPayload, await app.p0.assetService.read(source.blob_path));
  const outsiderContent = await app.inject({
    method: 'GET',
    url: `/api/v1/storyboard-outputs/${output.id}/content`,
    headers: { cookie: outsider.cookie }
  });
  assert.equal(outsiderContent.statusCode, 404, outsiderContent.body);

  const withoutCsrf = await app.inject({
    method: 'DELETE', url: `/api/v1/panels/${panel.id}`, headers: { cookie: owner.cookie }
  });
  assert.equal(withoutCsrf.statusCode, 403);
  const outsiderDelete = await app.inject({
    method: 'DELETE',
    url: `/api/v1/panels/${panel.id}`,
    headers: { cookie: outsider.cookie, 'x-csrf-token': outsider.csrfToken }
  });
  assert.equal(outsiderDelete.statusCode, 404);
  const selectedDelete = await app.inject({
    method: 'DELETE',
    url: `/api/v1/storyboard-outputs/${output.id}`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken }
  });
  assert.equal(selectedDelete.statusCode, 409);
  assert.equal(selectedDelete.json().error.code, 'storyboard_output_selected');
  const panelDelete = await app.inject({
    method: 'DELETE',
    url: `/api/v1/panels/${panel.id}`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken }
  });
  assert.equal(panelDelete.statusCode, 200, panelDelete.body);
  assert.equal(panelDelete.json().deletion.submissionRetained, true);
  const hiddenBatch = await app.inject({
    method: 'GET', url: `/api/v1/batches/${batch.id}`, headers: { cookie: owner.cookie }
  });
  assert.deepEqual(hiddenBatch.json().panels, []);
  const retainedSubmission = await app.inject({
    method: 'GET', url: '/api/v1/organization/submissions', headers: { cookie: colleague.cookie }
  });
  assert.equal(retainedSubmission.json().submissions.length, 1,
    'Removing a workbench column must not erase the frozen company submission.');
  const retainedContent = await app.inject({
    method: 'GET', url: `/api/v1/storyboard-outputs/${output.id}/content`, headers: { cookie: colleague.cookie }
  });
  assert.equal(retainedContent.statusCode, 200);

  const comicCreated = await app.inject({
    method: 'POST',
    url: '/api/v1/batches',
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: { name: '公司漫画提报批次', workflowType: 'comic_pipeline' }
  });
  assert.equal(comicCreated.statusCode, 201, comicCreated.body);
  const comicBatch = comicCreated.json();
  const comicFixture = await addPanelWithSource({
    db: app.p0.db,
    assetService: app.p0.assetService
  }, { batchId: comicBatch.id, ordinal: 1, filename: 'company-comic-submission.png' });
  const { light } = createApprovedSyntheticChain({ db: app.p0.db }, {
    panelId: comicFixture.panel.id,
    source: comicFixture.source
  });
  const comicSubmitted = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${comicFixture.panel.id}/submit`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
    payload: { assetVersionId: comicFixture.source.id }
  });
  assert.equal(comicSubmitted.statusCode, 200, comicSubmitted.body);
  assert.equal(comicSubmitted.json().panel.submitted_asset_version_id, comicFixture.source.id,
    'The API must share the exact stage image selected by the creator.');

  const sharedComic = await app.inject({
    method: 'GET', url: '/api/v1/organization/submissions', headers: { cookie: colleague.cookie }
  });
  const comicSubmission = sharedComic.json().submissions.find((item) => item.submission_kind === 'comic');
  assert.equal(comicSubmission.submitted_asset_version_id, comicFixture.source.id);
  const colleagueComicContent = await app.inject({
    method: 'GET', url: `/api/v1/assets/${comicFixture.source.id}/content`, headers: { cookie: colleague.cookie }
  });
  assert.equal(colleagueComicContent.statusCode, 200, colleagueComicContent.body);
  const outsiderComicContent = await app.inject({
    method: 'GET', url: `/api/v1/assets/${comicFixture.source.id}/content`, headers: { cookie: outsider.cookie }
  });
  assert.equal(outsiderComicContent.statusCode, 404, outsiderComicContent.body);

  const comicDelete = await app.inject({
    method: 'DELETE',
    url: `/api/v1/panels/${comicFixture.panel.id}`,
    headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken }
  });
  assert.equal(comicDelete.statusCode, 200, comicDelete.body);
  assert.equal(comicDelete.json().deletion.submissionRetained, true);
  const retainedComicContent = await app.inject({
    method: 'GET', url: `/api/v1/assets/${comicFixture.source.id}/content`, headers: { cookie: colleague.cookie }
  });
  assert.equal(retainedComicContent.statusCode, 200,
    'The organization must retain read-only access to the frozen final asset after its creator column is removed.');
});

test('login is generic on failure and logout invalidates the server session', async (t) => {
  const app = await createAuthApp(t);
  const member = await register(app, {
    email: 'logout@example.com', displayName: '退出测试', password: 'logout-member-password'
  });
  const badLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', payload: { email: 'missing@example.com', password: 'wrong-password-value' }
  });
  assert.equal(badLogin.statusCode, 401);
  assert.equal(badLogin.json().error.code, 'invalid_credentials');

  const logout = await app.inject({
    method: 'POST', url: '/api/v1/auth/logout',
    headers: { cookie: member.cookie, 'x-csrf-token': member.csrfToken }, payload: {}
  });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  const expired = await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: member.cookie } });
  assert.equal(expired.statusCode, 401);
});
