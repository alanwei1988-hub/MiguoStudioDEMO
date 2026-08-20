import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const readWorkbench = () => fs.readFile(htmlUrl, 'utf8');

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function sourceSlice(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing source boundary: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `Missing source boundary: ${endNeedle}`);
  return source.slice(start, end);
}

function functionSource(source, functionName) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = declaration.exec(source);
  assert.ok(match, `Missing function: ${functionName}`);
  const nextDeclaration = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/g;
  nextDeclaration.lastIndex = match.index + match[0].length;
  const next = nextDeclaration.exec(source);
  return source.slice(match.index, next?.index ?? source.length);
}

function dynamicOdAnchor(html, prefix) {
  return [...html.matchAll(/data-od-id=["']([^"']+)["']/g)].find((match) => (
    new RegExp(`^${prefix}-\\$\\{\\s*[A-Za-z_$][\\w$]*\\s*\\+\\s*1\\s*\\}$`).test(match[1])
  ));
}

test('single-file workbench keeps its native P0, auth, modal, and state contracts', async () => {
  const html = await readWorkbench();

  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet/i);
  assert.doesNotMatch(html, /scrollIntoView|\/api\/v1\/jobs|\bapiKey\b/);
  assert.match(html, /new FormData\(\)/);
  assert.match(html, /\/api\/v1\/batches\/.*\/panels/);
  assert.match(html, /\/api\/v1\/panels\/.*\/runs\//);
  assert.match(html, /\/api\/v1\/assets\/.*\/promote/);
  assert.match(html, /location\.origin \+ '\/miguo-studio'/);
  assert.match(html, /localStorage\.getItem\('mp\.theme'\)/);
  assert.match(html, /localStorage\.getItem\('mp\.settings'\)/);
  assert.match(html, /\/api\/v1\/auth\/register/);
  assert.match(html, /\/api\/v1\/auth\/login/);
  assert.match(html, /credentials: 'include'/);
  assert.match(html, /X-CSRF-Token/);
  assert.match(html, /data-od-id="auth-dialog"/);
  assert.match(html, /data-od-id="storyboard-dialog"/);
  assert.match(html, /data-od-id="miguo-connections-card"/);
  assert.match(html, /data-od-id="storyboard-result-prev"/);
  assert.match(html, /data-od-id="storyboard-result-next"/);
  assert.match(html, /memberCannotProbe/);
  assert.match(html, /#redoDialog\[open\], #settingsDialog\[open\], #authDialog\[open\]/);
  assert.match(html, /transform: translate\(-50%, -50%\)/);
  assert.match(html, /max-height: calc\(100dvh - 32px\)/);
  assert.match(html, /#lightbox\[open\]\s*\{[\s\S]*?top:\s*50%;\s*left:\s*50%;[\s\S]*?max-width:\s*calc\(100vw - 32px\);[\s\S]*?transform:\s*translate\(-50%, -50%\);[\s\S]*?\}/);
  assert.match(html, /class="brand-lockup"[\s\S]*?assets\/miguo-mark\.png[\s\S]*?<span class="app">米粿Studio<\/span>/,
    'The global product name must be preceded by the bundled Miguo brand mark.');
  assert.ok((await fs.stat(new URL('../public/assets/miguo-mark.png', import.meta.url))).size > 0,
    'The local Miguo brand mark asset must ship with the workbench.');

  for (const state of ['locked', 'ready', 'running', 'done', 'error']) {
    assert.match(html, new RegExp(`status === '${state}'`));
  }

  const domIds = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  const dataIds = [...html.matchAll(/data-od-id=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(duplicateValues(domIds), [], 'Every declared DOM id must be unique in the single-file app.');
  assert.deepEqual(duplicateValues(dataIds), [], 'Every Open Design anchor declaration must be unique.');
  const retainedOpenDesignAnchors = [
    'topbar', 'chip-count', 'chip-connection', 'search', 'status-filter', 'theme-toggle',
    'settings-btn', 'account-chip', 'logout-btn', 'toolbar', 'upload-btn', 'demo-btn',
    'batch-lineart', 'batch-color', 'batch-light', 'overall-progress', 'pulse-sidebar',
    'stage-stats', 'board', 'redo-dialog', 'auth-dialog', 'settings-dialog',
    'miguo-connections-card', 'admin-recovery-card', 'storyboard-dialog', 'storyboard-result-prev',
    'storyboard-result-next', 'empty-dropzone', 'no-result', 'flagged-callout',
    'error-callout', 'workflow-nav', 'workflow-comic-entry', 'workflow-reference-entry',
    'comic-workflow-view', 'reference-workflow-view', 'reference-new-workspace',
    'reference-source-picker', 'reference-image-input', 'reference-image-file',
    'reference-output-settings', 'reference-project-select', 'reference-submit',
    'reference-task-status', 'reference-results-gallery'
  ];
  for (const anchor of retainedOpenDesignAnchors) {
    assert.ok(dataIds.includes(anchor), `Existing Open Design anchor must not be removed: ${anchor}`);
  }
  assert.ok(dynamicOdAnchor(html, 'draft-col'), 'The existing per-draft Open Design anchor must remain.');
});

test('comic multi-file selection snapshots every file and creates one independently verified task column per upload', async () => {
  const html = await readWorkbench();
  const uploadApi = sourceSlice(html, 'async uploadPanels(batchId, files)', 'reorder(batchId, panelIds)');
  const addFiles = functionSource(html, 'addFiles');
  const inputBinding = sourceSlice(html,
    "const fileInput = document.getElementById('fileInput');",
    'function bindDropzone');

  assert.match(html, /id="fileInput"[^>]*\bmultiple\b/,
    'The comic file picker must allow selecting more than one draft in a single dialog.');
  assert.match(inputBinding, /const files = \[\.\.\.\(event\.currentTarget\.files \|\| \[\]\)\]/,
    'The browser FileList must be copied before the input value is cleared.');
  assert.match(inputBinding, /event\.currentTarget\.value = ''[\s\S]*?addFiles\(files\)/,
    'The cleared native input must not be passed into the asynchronous upload path.');
  assert.match(uploadApi, /for \(const file of \[\.\.\.files\]\)[\s\S]*?new FormData\(\)[\s\S]*?form\.append\('files', file, file\.name\)/,
    'Every selected file must receive its own deterministic multipart request.');
  assert.match(uploadApi, /response\.created\.length !== 1[\s\S]*?panel_upload_count_mismatch/,
    'Each request must verify that the backend created exactly one task column.');
  assert.match(uploadApi, /failures\.push\(\{ name: file\.name[\s\S]*?return \{ created, failures \}/,
    'A failed file must be reported without dropping the remaining selected files or blindly retrying.');
  assert.match(addFiles, /AgentAPI\.uploadPanels\(batchId, imgs\)[\s\S]*?refreshFromBackend\(\{ force: true/,
    'The comic board must refresh from persisted backend state after the whole selected set finishes.');
  assert.match(addFiles, /已创建 \$\{result\.created\.length\} \/ \$\{imgs\.length\} 列/,
    'Partial failure feedback must state how many of the selected files became task columns.');
});

test('left navigation exposes two isolated workflows with the approved product names', async () => {
  const html = await readWorkbench();

  assert.match(html, /data-od-id="workflow-nav"/);
  assert.match(html, /data-od-id="workflow-nav-comic"/);
  assert.match(html, /data-od-id="workflow-nav-storyboard"/);
  assert.match(html, />漫画创作工作流</);
  assert.match(html, />分镜到成稿工作流</);
  assert.match(html, /<section(?=[^>]*\bid="comicWorkflowView")(?=[^>]*data-od-id="comic-workflow-view")[^>]*>/);
  assert.match(html, /<section(?=[^>]*\bid="storyboardWorkflowView")(?=[^>]*data-od-id="storyboard-workflow-view")(?=[^>]*\bhidden\b)[^>]*>/);
  assert.match(html, /<button(?=[^>]*\bid="workflowComicEntry")(?=[^>]*aria-current="page")[^>]*>/);
  assert.match(html, /function switchWorkflow\(workflow/);
  assert.match(html, /\[\s*['"]comic['"]\s*,\s*['"]storyboard['"]\s*\]\.includes\(workflow\)/);
  assert.match(html, /localStorage\.(?:getItem|setItem)\(['"]mp\.activeWorkflow['"]/);

  assert.doesNotMatch(html, />参考图创作工作流</);
  assert.match(html, /data-od-id="workflow-reference-entry"/,
    'The renamed workflow must retain the previous Open Design entry anchor for compatibility.');
  assert.match(html, /data-od-id="reference-workflow-view"/,
    'The redesigned board must retain the previous Open Design view anchor for compatibility.');

  const comicView = sourceSlice(html, 'id="comicWorkflowView"', 'id="storyboardWorkflowView"');
  assert.match(comicView, /data-od-id="board"/);
  assert.doesNotMatch(comicView, /StoryArk|分镜到成稿|storyboard-task-col|storyboard-reference-cell|storyboard-source-cell|storyboard-result-cell/);
});

test('workflow selector presents equal peer buttons and a compact batch-processing count', async () => {
  const html = await readWorkbench();

  const entryRule = html.match(/\.workflow-entry\s*\{([^}]+)\}/)?.[1];
  assert.ok(entryRule, 'The shared workflow-entry button rule must remain declared.');
  assert.match(entryRule, /\b(?:min-)?height\s*:\s*\d+(?:\.\d+)?(?:px|rem)\s*;/,
    'Both workflow buttons need an explicit shared height so their size is equal.');
  assert.match(entryRule, /\bborder\s*:\s*1px\s+solid\s+(?!transparent\b)[^;]+;/,
    'The shared workflow selector should read as a bordered button even when inactive.');
  assert.match(entryRule, /\bbackground\s*:\s*(?!transparent\b)[^;]+;/,
    'The shared workflow selector should have a visible button surface even when inactive.');
  assert.match(html, /@media \(max-width:\s*1120px\)[\s\S]*?\.topbar #chip-count, \.topbar #chip-running\s*\{\s*display:\s*none !important;/,
    'The desktop breakpoint must keep the top bar inside the viewport.');
  assert.match(html, /\.topbar #logoutBtn\s*\{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap;/,
    'The compact top bar must keep the logout action on one line.');
  assert.match(html, /CLASSIC_PROVIDER_MODE_REVISION\s*=\s*'factory-classic-real-v2-all-users'/,
    'Production provider preference migrations must be explicit and revisioned.');
  assert.match(html, /useMock:\s*hasCurrentModeRevision\s*\?\s*saved\.useMock\s*!==\s*false\s*:\s*location\.protocol\s*===\s*'file:'/, 
    'Hosted production must default to the real classic provider while file previews remain mock-safe.');

  const comicEntry = html.match(/<button(?=[^>]*\bid=["']workflowComicEntry["'])[^>]*>[\s\S]*?<\/button>/)?.[0];
  const storyboardEntry = html.match(/<button(?=[^>]*\bid=["']workflowStoryboardEntry["'])[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(comicEntry && storyboardEntry, 'Both peer workflow selectors must be button elements.');
  for (const [name, entry] of [['comic', comicEntry], ['storyboard', storyboardEntry]]) {
    assert.match(entry, /\bclass=["'][^"']*\bworkflow-entry\b[^"']*["']/,
      `${name} selector must use the shared workflow-entry component.`);
    assert.match(entry, /\bclass=["'][^"']*\bwf-icon\b[^"']*["']/,
      `${name} selector must keep the shared icon slot.`);
    assert.match(entry, /\bclass=["'][^"']*\bwf-copy\b[^"']*["']/,
      `${name} selector must keep the shared copy slot.`);
    assert.match(entry, /\bclass=["'][^"']*\bwf-title\b[^"']*["']/,
      `${name} selector must keep the shared title slot.`);
    assert.match(entry, /\bclass=["'][^"']*\bwf-sub\b[^"']*["']/,
      `${name} selector must keep the shared description slot.`);
  }

  const sidebarContext = sourceSlice(html, 'id="storyboardWorkflowContext"', '</aside>');
  assert.doesNotMatch(sidebarContext, /storyboardContextConnection|服务(?:端)?未配置/,
    'The StoryArk sidebar must not render a redundant unconfigured-service card.');
  assert.doesNotMatch(html, /全平台同时只运行一个\s*3\.0\s*任务/,
    'The sidebar must not expose the platform-wide single-task implementation detail.');
  assert.match(sidebarContext, /id=["']storyboardContextActive["']/,
    'The sidebar must expose only the number of active batch tasks.');
  assert.match(sidebarContext, /批量处理/);
  assert.doesNotMatch(sidebarContext, /storyboardContextTask|storyboardContextQuota|任务完成进度|候选额度/,
    'Completion and quota cards must not be confused with active batch work.');
  assert.match(storyboardEntry, /参考图\s*→\s*分镜\s*→\s*成稿/,
    'The workflow selector must use the concise customer-facing three-step label.');
  assert.doesNotMatch(storyboardEntry, /米粿Studio|wf-tag/,
    'A workflow selector must not repeat the global 米粿Studio product brand.');

  const renderer = functionSource(html, 'renderStoryboardWorkflow');
  assert.match(renderer, /storyboardHistoryRuns\(\)[\s\S]*?isStoryarkActive\(run\.status\)/,
    'The active count must be derived from only currently processing runs.');
  assert.match(renderer, /storyboardContextActive['"]?\)\.textContent\s*=\s*String\(activeTasks\)/,
    'The sidebar value must render the number of active tasks, not completed work.');
});

test('storyboard first paint waits for its own workspace instead of flashing legacy comic output', async () => {
  const html = await readWorkbench();
  const displayPanels = functionSource(html, 'storyboardDisplayPanels');
  const historyRuns = functionSource(html, 'storyboardHistoryRuns');
  const loadWorkspace = functionSource(html, 'loadStoryboardWorkspace');
  const renderWorkflow = functionSource(html, 'renderStoryboardWorkflow');

  assert.match(html, /let storyboardWorkspaceLoadState = ['"]idle['"]/,
    'The reference workflow needs an explicit initial loading state.');
  assert.match(displayPanels, /storyboardWorkspaceLoadState !== ['"]ready['"]\) return \[\]/,
    'Legacy comic panels must not be rendered before the current reference workspace is ready.');
  assert.match(historyRuns, /storyboardRunIndex\.clear\(\);[\s\S]*?storyboardWorkspaceLoadState !== ['"]ready['"]\) return \[\]/,
    'Legacy run history must also remain hidden during the first workspace load.');
  assert.match(loadWorkspace, /storyboardWorkspaceLoadState = ['"]loading['"][\s\S]*?AgentAPI\.listBatches\(['"]reference_creation['"]\)[\s\S]*?storyboardWorkspaceLoadState = ['"]ready['"]/,
    'The loading gate must stay closed until the reference batch has been fetched.');
  assert.match(renderWorkflow, /data-od-id=["']storyboard-loading-board["'][\s\S]*?正在加载当前任务/,
    'The first paint should show a stable loading placeholder rather than an old column.');
});

test('classic provider mode fails closed and completed assets retain provider provenance', async () => {
  const html = await readWorkbench();
  const runtimeState = functionSource(html, 'classicRuntimeState');
  const connectBackend = functionSource(html, 'connectBackend');

  assert.match(runtimeState, /userAllowed\s*=\s*!authRequired\s*\|\|\s*Boolean\(currentUser\)/,
    'Every authenticated creator must be eligible for the platform-managed real provider.');
  assert.doesNotMatch(html, /currentUser\.role !== ['"]admin['"] && !AgentAPI\.settings\.useMock/,
    'Signing in as a member must never silently switch a hosted production session back to Mock.');
  assert.match(runtimeState, /connections\?\.factoryClassic/,
    'Effective real mode must use the sanitized Factory Classic connection state.');
  assert.match(runtimeState, /factory\?\.configured/);
  assert.match(runtimeState, /factory\?\.executionEnabled/);
  assert.match(runtimeState, /backendAvailable/);
  assert.match(runtimeState, /runtimeHealthStatus/);
  assert.match(runtimeState, /label:\s*['"]真实未启用['"]/,
    'A selected but gated real provider must be visibly blocked.');
  assert.match(runtimeState, /label:\s*['"]离线['"]/,
    'Real mode must have an explicit offline state.');
  assert.match(runtimeState, /label:\s*['"]真实生产['"]/,
    'Only the fully enabled state may identify itself as real production.');
  assert.match(runtimeState, /kind:\s*['"]ready['"][\s\S]*?canSubmit:\s*true[\s\S]*?chipState:\s*['"]real['"]/,
    'The real chip and submission permission must only coexist in the ready branch.');
  assert.match(connectBackend, /finally\s*\{[\s\S]*?backendConnectBusy\s*=\s*false;[\s\S]*?updateClassicConnectionChip\(\);[\s\S]*?render\(\);/,
    'The final connection state must be rendered after the busy guard is released.');

  const enqueue = functionSource(html, 'enqueue');
  assert.match(enqueue, /classicRuntimeState\(\)/);
  assert.match(enqueue, /!runtimeState\.canSubmit/,
    'Programmatic classic submissions must fail closed in addition to disabled buttons.');
  const eligible = functionSource(html, 'eligible');
  assert.match(eligible, /!classicRuntimeState\(\)\.canSubmit/,
    'Batch badges and batch actions must exclude blocked real tasks.');
  assert.match(html, /updateClassicConnectionChip\(\)/,
    'Classic workflow chrome must render the effective provider state.');

  const hydrate = functionSource(html, 'hydrateBatch');
  assert.match(hydrate, /current\.metadata\?\.provider\s*\|\|\s*currentRun\?\.provider/,
    'Hydration must recover the provider from the immutable asset or its producing run.');
  assert.match(hydrate, /s\.displayState\s*=\s*['"]succeeded['"]/,
    'Hydration must consume the creator-safe display contract rather than private run evidence.');
  assert.doesNotMatch(hydrate, /cost_points|cost_source|provider_phase|provider_task|provider_request/,
    'The creator workbench must not depend on accounting or provider evidence fields.');
  const completedCell = functionSource(html, 'cellHTML');
  assert.match(completedCell, /classicStageSubmissionControl\(col, key\)/,
    'Completed stage headers must prioritize the concise team submission action.');
  assert.doesNotMatch(completedCell, /statusChip\s*=\s*s\.flagged[\s\S]*?待重做/,
    'An existing image must keep its submission action even when it is marked unsatisfactory.');
  assert.doesNotMatch(completedCell, /米粿真实|模拟结果|classicResultLabel/,
    'Creator-facing stage headers must not expose internal provider provenance.');
});

test('accepted classic outcomes recover automatically without exposing reconciliation to creators', async () => {
  const html = await readWorkbench();
  const classifier = functionSource(html, 'isClassicAutoRecovery');
  const presentation = functionSource(html, 'classicErrorPresentation');
  const actions = functionSource(html, 'classicErrorActionsHTML');
  const cell = functionSource(html, 'cellHTML');
  const enqueue = functionSource(html, 'enqueue');
  const runJob = functionSource(html, 'runJob');
  const realPolling = sourceSlice(html, 'async _real({ stage, col, note, onProgress, ctl }) {', 'async cancel(runId)');
  const hydrate = functionSource(html, 'hydrateBatch');
  const stats = functionSource(html, 'renderStats');
  const render = functionSource(html, 'render');
  const polling = sourceSlice(html, 'setInterval(() => {', '</script>');

  assert.match(html, /errorCode:\s*['"]{2}/,
    'Each classic stage must retain the backend error code separately from its user-facing message.');
  assert.match(html, /displayState:\s*null/,
    'Classic stage state must retain only the creator-safe display state.');
  assert.match(html, /displayMessage:\s*['"]{2}/);
  assert.match(html, /canRetry:\s*null/);
  assert.match(classifier, /stageState\?\.displayState\s*===\s*['"]recovering['"]/,
    'Only the server-derived creator display state may enter output auto-recovery.');
  assert.doesNotMatch(classifier, /providerPhase|costSource|output_missing|unknown_outcome/,
    'The creator recovery classifier must not receive provider or accounting evidence.');

  assert.match(presentation, /isClassicAutoRecovery\(stageState\)[\s\S]*?系统正在后台恢复，无需重新提交/);
  assert.match(presentation, /输入与修改意见已保留，完成后会自动显示结果/);
  assert.match(presentation, /cost_reconciliation_required[\s\S]*?图像服务正在恢复上一任务，输入已保留/,
    'The global fail-closed state must be described as a background service recovery.');
  assert.match(presentation, /network_timeout_retryable[\s\S]*?本次可安全重试/,
    'A deterministic retryable failure must retain an explicit recovery action.');

  assert.match(actions, /if \(isClassicAutoRecovery\(stageState\)\)[\s\S]*?disabled[\s\S]*?>恢复中<\/button>/,
    'Automatic recovery must render a disabled action so it cannot be submitted twice.');
  assert.match(actions, /onclick="enqueue\('\$\{colId\}','\$\{key\}'\)">重试<\/button>/,
    'Ordinary deterministic failures must still expose retry.');
  assert.match(cell, /autoRecovery[\s\S]*?status recovering[\s\S]*?恢复中/);
  assert.match(cell, /autoRecovery[\s\S]*?正在自动取回结果/,
    'Accepted unresolved outcomes must be presented as an automatic recovery.');
  assert.match(cell, /classicErrorActionsHTML\(col\.id, key, s, submitGuard\)/);

  assert.match(enqueue, /s\.status\s*===\s*['"]error['"]\s*&&\s*isClassicAutoRecovery\(s\)[\s\S]*?return;/,
    'Programmatic enqueue must also fail closed for unresolved provider outcomes.');
  assert.match(runJob, /s\.errorCode\s*=\s*e\.code/);
  assert.match(runJob, /s\.displayState\s*=\s*e\.displayState/);
  assert.match(runJob, /s\.canRetry\s*=\s*e\.canRetry/);
  assert.match(realPolling, /const displayState\s*=\s*current\.displayState\s*\|\|\s*current\.status/);
  assert.match(realPolling, /displayState\s*===\s*['"]recovering['"][\s\S]*?onProgress\(72\)/,
    'A creator request must keep polling while the server is recovering an accepted result.');
  assert.match(hydrate, /latestDisplayState\s*===\s*['"]recovering['"]/);
  assert.match(hydrate, /s\.displayState\s*=\s*['"]recovering['"]/,
    'A refresh must preserve the creator-safe automatic recovery state.');
  assert.match(stats, /status\s*===\s*['"]error['"]\s*&&\s*!isClassicAutoRecovery\(c\.stages\[k\]\)/,
    'Automatic recovery must not be counted as a creator-actionable failure.');
  assert.match(render, /case ['"]running['"]:[\s\S]*?isClassicAutoRecovery\(s\)/);
  assert.match(render, /case ['"]error['"]:[\s\S]*?!isClassicAutoRecovery\(s\)/);
  assert.match(polling, /status\s*===\s*['"]running['"]\s*\|\|\s*isClassicAutoRecovery\(col\.stages\[key\]\)/,
    'The workbench must keep refreshing while a background recovery is pending.');

  const creatorMarkup = sourceSlice(html, 'id="comicWorkflowView"', '<dialog id="redoDialog"');
  assert.doesNotMatch(creatorMarkup, /待对账|积分待对账|等待管理员(?:核对|完成)|管理员对账|积分|付费|扣费|记账/,
    'Cost and provider-reconciliation language belongs in operations tooling, not the creative UI.');
  assert.doesNotMatch(html, /provider_task_id|provider_request_id|cost_source|cost_points|output_missing/,
    'Raw provider, accounting and parser evidence must not be embedded in the creator application.');
});

test('the settings dialog requests sanitized recovery status for administrators only', async () => {
  const html = await readWorkbench();
  const card = sourceSlice(html, 'id="adminRecoveryCard"', '<div class="foot">');
  const loader = functionSource(html, 'loadAdminRecoveryStatus');

  assert.match(html, /id="adminRecoveryCard"[^>]*data-od-id="admin-recovery-card"[^>]*hidden/);
  assert.match(card, />后台任务恢复与记账</);
  assert.match(card, />自动恢复中</);
  assert.match(card, />已完成</);
  assert.match(card, />需管理员关注</);
  assert.doesNotMatch(card, /task.?id|provider|https?:\/\/|token|签名/i,
    'The admin card must not embed provider identifiers, credentials or signed links.');

  assert.match(html, /classicRecoveryJobs\(\)\s*\{[\s\S]*?\/api\/v1\/admin\/classic-recovery-jobs/);
  assert.match(loader, /currentUser\?\.role\s*!==\s*['"]admin['"][\s\S]*?adminRecoveryCard\.hidden\s*=\s*true;[\s\S]*?return;/,
    'Members must be rejected locally before the admin endpoint is requested.');
  assert.match(loader, /AgentAPI\.classicRecoveryJobs\(\)/);
  assert.match(html, /adminRecoveryCard\.hidden\s*=\s*currentUser\?\.role\s*!==\s*['"]admin['"]/,
    'Opening settings must reveal the operations card only to administrators.');
  assert.match(html, /if\s*\(currentUser\?\.role\s*===\s*['"]admin['"]\)\s*void loadAdminRecoveryStatus\(\)/,
    'Opening settings must avoid even a background status request for members.');
});

test('the storyboard workflow uses a concise column ordered as reference, storyboard, then finished result', async () => {
  const html = await readWorkbench();

  assert.match(html, /function renderStoryboardWorkflow\(/);
  assert.match(html, /function storyboardColHTML\(/);
  assert.match(html, /function setStoryboardReference\(/);
  assert.match(html, /function submitStoryboardColumn\(/);

  const column = dynamicOdAnchor(html, 'storyboard-task-col');
  const reference = dynamicOdAnchor(html, 'storyboard-reference-cell');
  const storyboard = dynamicOdAnchor(html, 'storyboard-source-cell');
  const result = dynamicOdAnchor(html, 'storyboard-result-cell');
  assert.ok(column, 'Every StoryArk task column needs a stable data-od-id anchor.');
  assert.ok(reference, 'The top character-reference cell needs a stable data-od-id anchor.');
  assert.ok(storyboard, 'The middle storyboard-input cell needs a stable data-od-id anchor.');
  assert.ok(result, 'The bottom finished-result cell needs a stable data-od-id anchor.');

  const rendererStart = html.indexOf('function storyboardColHTML(');
  assert.ok(rendererStart < column.index, 'The column anchors must be emitted by storyboardColHTML.');
  assert.ok(column.index < reference.index, 'The column wrapper must precede its cells.');
  assert.ok(reference.index < storyboard.index, 'Character reference must be the top cell.');
  assert.ok(storyboard.index < result.index, 'Storyboard input must precede the finished result.');

  const storyboardColumnRenderer = functionSource(html, 'storyboardColHTML');
  const referenceLabel = storyboardColumnRenderer.indexOf('参考图');
  const storyboardLabel = storyboardColumnRenderer.indexOf('分镜输入');
  const resultLabel = storyboardColumnRenderer.indexOf('成稿');
  assert.ok(referenceLabel !== -1 && storyboardLabel !== -1 && resultLabel !== -1,
    'Each storyboard column must visibly label all three customer stages.');
  assert.ok(referenceLabel < storyboardLabel && storyboardLabel < resultLabel,
    'The customer workflow must visibly follow 参考图 → 分镜输入 → 成稿.');
  assert.doesNotMatch(storyboardColumnRenderer, /story-meta[\s\S]*?referenceName|story-reference-select|更换人设图|上传人设图/,
    'Reference cards must not repeat filename metadata, dimensions, a dropdown, or a separate change button below the image.');
  assert.match(storyboardColumnRenderer, /story-reference-trigger[\s\S]*?openStoryboardReferenceLibrary/,
    'Clicking the reference image itself must open the project reference library.');
  assert.doesNotMatch(storyboardColumnRenderer, /人设参考图/,
    'The creator-facing stage label must support people, objects, clothing, and scene references.');
  assert.match(html, /data-od-id="storyboard-reference-library-dialog"[\s\S]*?本项目常用的参考图[\s\S]*?上传新参考图/,
    'The single-file workbench must include a reusable project reference library dialog.');
  assert.match(html, /#storyboardReferenceLibraryDialog\[open\][\s\S]*?top:\s*50%[\s\S]*?left:\s*50%[\s\S]*?translate\(-50%,\s*-50%\)/,
    'The project reference library must open centered in the viewport.');
  assert.doesNotMatch(storyboardColumnRenderer, /storyboard-analysis-cell|米粿Studio处理/,
    'Internal preparation must not occupy a visible customer workflow row.');
  assert.doesNotMatch(storyboardColumnRenderer, /Agent 创作理解|对象匹配与保护|renderProvider/,
    'The customer column must not expose internal analysis or renderer branches.');
  assert.match(storyboardColumnRenderer, /storyboardDeadlinePanelIds\.has\(panel\.id\)/,
    'Each current column must be independently selectable for batch scheduling.');
  assert.match(storyboardColumnRenderer, /panel\.deadline_at/,
    'Persisted deadlines must render on their own task columns.');
  assert.match(storyboardColumnRenderer, /panel\.submission_status\s*===\s*['"]submitted['"]/,
    'Submitted columns must visibly expose their organization-sharing state.');

  const classicCellRenderer = sourceSlice(html, 'function cellHTML(', 'function patchCell(');
  assert.doesNotMatch(classicCellRenderer, /StoryArk|storyboard|3\.0/i,
    'Classic draft/lineart/color/light cells must not contain StoryArk controls or state.');
  assert.doesNotMatch(html, /function storyboardButtonHTML\(/,
    'The legacy per-draft StoryArk button must not return to the classic board.');
  assert.match(html, /const files = \[\.\.\.event\.target\.files\];\s*event\.target\.value = '';\s*if \(files\.length\) uploadStoryboardFiles\(files\)/,
    'The multi-file chooser must snapshot its FileList before clearing the input value.');
});

test('the independent storyboard board retains safe routes while renderer choice remains server-managed', async () => {
  const html = await readWorkbench();

  assert.match(html, /\/api\/v1\/providers\/miguo\/storyark\/projects/);
  assert.match(html, /\/api\/v1\/batches\/.*\/storyboard-references/);
  assert.match(html, /\/api\/v1\/storyboard-references\/.*\/content/);
  assert.match(html, /\/api\/v1\/storyboard-safety/);
  assert.match(html, /\/api\/v1\/panels\/.*\/storyboard-analysis/);
  assert.match(html, /\/api\/v1\/panels\/.*\/storyboard-clone/);
  assert.match(html, /\/api\/v1\/batches\/.*\/storyboard-analyses/);
  assert.match(html, /\/api\/v1\/panels\/.*\/storyboard-runs/);
  assert.match(html, /\/api\/v1\/storyboard-runs\/.*\/cancel/);
  assert.match(html, /\/api\/v1\/storyboard-outputs\/.*\/content/);
  assert.match(html, /['"]Idempotency-Key['"]\s*:/);
  const referenceUpload = sourceSlice(html, 'async uploadStoryboardReference(', 'storyboardReferences(batchId)');
  assert.match(referenceUpload, /form\.append\(['"]panelId['"], panelId\)/,
    'Each character reference upload must persist its target storyboard column.');

  const submit = functionSource(html, 'submitStoryboardColumn');
  const payload = functionSource(html, 'storyboardPayload');
  assert.match(submit, /storyboardPayload\(/,
    'The paid submit action must use the fixed StoryArk payload builder.');
  for (const argument of ['referenceAssetId', 'analysisId', 'imageSize', 'expectedResultCount', 'removeBg']) {
    assert.match(payload, new RegExp(`\\b${argument}\\b`), `Storyboard submit must preserve ${argument}.`);
  }
  assert.doesNotMatch(payload, /renderProvider|projectId|renderModel/,
    'The customer request must not select or reveal the server-managed renderer.');
  assert.doesNotMatch(payload, /\b(?:prompt|note|reviewNote)\s*:/,
    'The UI must not send unsupported prompt or review-note fields to storyboard_inference.');
  assert.doesNotMatch(html, /gpt-5\.|gemini-|Nano Banana/,
    'The customer workbench must not expose internal model identifiers.');
  assert.doesNotMatch(html, />复制并再次生成</,
    'The internal legacy-clone migration must not leak into the creator-facing regenerate label.');

  for (const errorCode of [
    'admin_required',
    'real_provider_blocked',
    'active_storyboard_run_exists',
    'cost_reconciliation_required',
    'storyboard_result_limit_reached',
    'idempotency_key_conflict',
    'storyboard_reference_batch_mismatch',
    'asset_integrity_mismatch',
    'storyboard_analysis_mask_invalid',
    'main_model_unavailable',
    'main_model_stream_interrupted',
    'main_model_model_unavailable',
    'main_model_analysis_in_progress',
    'storyboard_composite_geometry_mismatch',
    'storyboard_composite_invariant_failed'
  ]) {
    assert.match(html, new RegExp(`['"]?${errorCode}['"]?\\s*:`), `Missing localized recovery message for ${errorCode}.`);
  }

  assert.match(html, /maxResultsPerBatch/);
  assert.match(html, /delete storyboardPendingAnalysisKeys\[panelId\]/,
    'A terminal Terra failure must release its idempotency key so a deliberate retry can run once.');
  assert.match(html, /timeoutMs:\s*660000/,
    'the browser must wait beyond the server 10-minute Terra budget instead of aborting at the legacy limit');
  assert.match(html, /main_model_timeout:\s*'分镜理解超过本次等待时限/,
    'normalized Terra timeouts must explain that no image-generation task was submitted');
  assert.match(html, /'23\.0':\s*'分镜理解曾在旧版 5 分钟时限处终止/,
    'legacy persisted DOMException code 23 must remain understandable and retryable');
  assert.match(html, /error\.code === '23\.0'/,
    'legacy timeout rows must release their old attempt key when the user explicitly retries');
  assert.match(html, /unknown_response|unknown_outcome/);
  assert.match(html, /currentUser\?\.role\s*!==\s*'admin'/);
  assert.match(html, /storyboardOutputUrl\(output\.id\)/,
    'Finished images must be loaded from the Studio output-content route, not provider URLs.');
});

test('Studio generation remains preparation-gated while the customer UI hides renderer and model details', async () => {
  const html = await readWorkbench();
  const runtimeState = functionSource(html, 'mainModelRuntimeState');
  const mode = functionSource(html, 'storyboardUsesMainModel');
  const gate = functionSource(html, 'canSubmitStoryboardPanel');
  const confirmation = functionSource(html, 'openStoryboardConfirmation');
  const submit = functionSource(html, 'submitStoryboardColumn');
  const payload = functionSource(html, 'storyboardPayload');
  const renderer = functionSource(html, 'renderStoryboardWorkflow');
  const analysisBody = functionSource(html, 'storyboardAnalysisBody');
  const presentation = functionSource(html, 'storyboardOutputPresentation');

  assert.match(runtimeState, /configured[\s\S]*?enabled[\s\S]*?kind:\s*['"]ready['"]/,
    'The browser must treat the main model as ready only after the sanitized server flags are both true.');
  assert.match(mode, /mainModelRuntimeState\(\)\.kind\s*===\s*['"]ready['"]/);
  assert.match(gate, /storyboardUsesMainModel\(\)/,
    'Real storyboard generation must remain locked until the main-model Agent is ready.');
  assert.match(confirmation, /const useMainModel\s*=\s*storyboardUsesMainModel\(\)/);
  assert.match(confirmation, /if \(!useMainModel\)[\s\S]*?真实生成已锁定/,
    'The UI must fail closed instead of bypassing Studio Agent understanding.');
  assert.match(confirmation, /AgentAPI\.analyzeStoryboard/,
    'Every individual generate or regenerate action must first run Studio preparation.');
  assert.match(confirmation, /generation_source_asset_version_id/,
    'Confirmation must require the server-prepared immutable full-storyboard input.');
  assert.match(confirmation, /storyboard-reference-instance-composite-v2/,
    'Confirmation must require the current multi-instance character plan.');
  assert.doesNotMatch(confirmation, /StoryArk 3\.0 直接生成|delete storyboardConfirmedAnalysisIds\[panelId\]/);
  assert.match(submit, /const analysisId\s*=\s*storyboardConfirmedAnalysisIds\[panelId\]/);
  assert.match(submit, /if \(!analysisId\)/,
    'A confirmed Terra analysis is mandatory for every paid submission.');
  assert.match(payload, /\.\.\.\(analysisId \? \{ analysisId \} : \{\}\)/,
    'The request payload must carry the confirmed analysis identity.');
  assert.match(payload, /removeBg:\s*false/,
    'The fixed provider request must continue to carry its approved background argument.');
  assert.match(renderer, /创作处理服务尚未就绪[\s\S]*?真实提交已锁定/,
    'The workspace must explain that Studio preparation is a production safety gate.');
  assert.match(renderer, /米粿Studio成稿服务已就绪[\s\S]*?参考图[\s\S]*?完整分镜/,
    'The customer UI must describe the Studio-owned workflow without naming its renderer.');
  assert.match(analysisBody, /创作准备完成[\s\S]*?当前采用成稿已关联本次实际使用的处理记录/,
    'Stage three must summarize only the Studio-owned preparation state.');
  assert.doesNotMatch(presentation, /renderProvider|renderModel|providerOriginal|模型|Nano|StoryArk|gemini/,
    'Completed-result presentation must not expose internal provider or model provenance.');
  assert.match(presentation, /metadata\.deliveryMode[\s\S]*?provider_raw_resize[\s\S]*?selective_composite/,
    'Raw-resized and old selective-composite deliveries must remain distinguishable.');
  assert.doesNotMatch(presentation, /output\.width\s*===|exactSize/,
    'Historical provenance must not be inferred from the live dropdown or final dimensions.');
  assert.doesNotMatch(renderer, /可直接生成成稿/,
    'No direct-generation copy may imply that the Agent can be bypassed.');
});

test('storyboard tasks support optional feedback, exact-size results, and persisted script ordering', async () => {
  const html = await readWorkbench();
  assert.match(html, /data-od-id="storyboard-redo-dialog"/);
  assert.match(html, /id="storyboardRedoNote"[\s\S]*?maxlength="500"/);
  assert.match(html, /修改意见（可选）/);
  assert.match(functionSource(html, 'openStoryboardGenerationDialog'), /run\?\.modification_note[\s\S]*?storyboardRedoNote/,
    'A repeat generation must recover the previous optional note.');
  assert.match(functionSource(html, 'openStoryboardGenerationDialog'), /米粿Studio[\s\S]*?重新处理[\s\S]*?检查人物、线条与文字细节/,
    'The redo dialog must describe Studio-owned processing and its limitations without exposing the downstream engine.');
  assert.match(functionSource(html, 'storyboardPayload'), /modificationNote[\s\S]*?imageSize/,
    'The optional note and generation specification must be frozen into the submitted payload.');
  assert.doesNotMatch(functionSource(html, 'storyboardPayload'), /renderProvider|renderModel|projectId/,
    'The browser must not choose the internal renderer.');
  const confirmation = functionSource(html, 'openStoryboardConfirmation');
  assert.match(confirmation, /米粿Studio[\s\S]*?生成本列成稿/,
    'The confirmation dialog must describe Studio-owned generation.');
  assert.match(confirmation, /处理方式[\s\S]*?参考图[\s\S]*?完整分镜/,
    'The confirmation card must visibly explain the execution and delivery contract in product language.');
  assert.doesNotMatch(confirmation, /模型|引擎|Nano|StoryArk|gemini|gpt-5/,
    'The confirmation must not expose model or provider details.');
  const resultBody = functionSource(html, 'storyboardResultBody');
  assert.match(resultBody, /storyboardOutputPresentation\(selected\.run, selected\.output\)[\s\S]*?data-delivery-mode/,
    'Finished cards must render the immutable raw/selective provenance presentation.');
  assert.match(resultBody, /当前采用[\s\S]*?story-version-history[\s\S]*?历史成稿[\s\S]*?采用此版本/,
    'The adopted result must be explicit while older immutable generations remain collapsed and selectable.');
  assert.match(resultBody, /run\?\.status === ['"]failed['"][\s\S]*?失败任务没有覆盖历史成稿/,
    'A failed new attempt must not masquerade the previously adopted result as newly generated.');
  assert.match(functionSource(html, 'selectStoryboardVersion'), /AgentAPI\.selectStoryboardOutput[\s\S]*?selected_storyboard_output_id[\s\S]*?loadStoryboardWorkspace/,
    'Selecting a historical generation must persist on the server and refresh only the adopted presentation.');
  assert.match(html, /storyboard-output-selection/,
    'The single-file client must use the dedicated adopted-output API instead of deleting old results.');
  assert.match(html, /\.story-candidate:only-child\s*\{\s*grid-column:\s*1\s*\/\s*-1/,
    'A single finished candidate must use the full storyboard-column width.');
  assert.match(html, /\.story-candidate img\s*\{[^}]*height:\s*156px;[^}]*object-fit:\s*contain/,
    'Finished pages must use the same-height frame as the storyboard input without cover-cropping.');
  assert.match(functionSource(html, 'storyboardOutputPresentation'), /米粿Studio 成稿[\s\S]*?成稿 \$\{finalSize\}/,
    'Results must use provider-neutral Studio wording and show only final saved dimensions.');
  assert.match(functionSource(html, 'persistStoryboardOrder'), /AgentAPI\.reorder\(storyboardBatch\.id, panelIds\)/);
  assert.match(functionSource(html, 'moveStoryboardTask'), /persistStoryboardOrder\(panelIds\)/);
  assert.match(functionSource(html, 'dropStoryboardTask'), /persistStoryboardOrder\(panelIds\)/);
  assert.match(html, /story-drag-handle/);
  assert.match(html, /拖动调整剧本顺序/);
  assert.match(html, /id="storyboardEngineSelect"[^>]*hidden[^>]*aria-hidden="true"/,
    'The legacy engine control must remain non-interactive and invisible while the server manages rendering.');
  assert.doesNotMatch(html, /<option[^>]*>[^<]*(?:Nano Banana|StoryArk|gemini|gpt-5\.)/,
    'No customer-facing option may expose a provider or model identifier.');
});

test('storyboard generation is independently busy per column and keeps provider cloning behind Studio wording', async () => {
  const html = await readWorkbench();
  const column = functionSource(html, 'storyboardColHTML');
  const actions = functionSource(html, 'storyboardRunActions');
  const canSubmit = functionSource(html, 'canSubmitStoryboardPanel');
  const analyze = functionSource(html, 'openStoryboardConfirmation');
  const submit = functionSource(html, 'submitStoryboardColumn');
  const clone = functionSource(html, 'cloneLegacyStoryboardTask');
  const redoDialog = functionSource(html, 'openStoryboardGenerationDialog');
  const submitLabel = functionSource(html, 'storyboardConfirmationSubmitLabel');
  const confirmation = functionSource(html, 'openStoryboardConfirmation');
  const redoMarkup = sourceSlice(html, '<dialog id="storyboardRedoDialog"', '</dialog>');

  assert.match(html, /const storyboardSubmittingPanelIds\s*=\s*new Set\(\)/,
    'Submission busy state must be a set keyed by panel id, not one workspace-wide panel scalar.');
  assert.match(html, /const storyboardAnalyzingPanelIds\s*=\s*new Set\(\)/,
    'Interactive Terra busy state must be independently keyed by panel id.');
  assert.match(html, /const storyboardCloningPanelIds\s*=\s*new Set\(\)/,
    'Legacy migration busy state must be independently keyed by panel id.');
  assert.doesNotMatch(html, /let storyboard(?:Submitting|Analyzing|Cloning)PanelId\s*=\s*null/,
    'No individual column operation may fall back to a shared scalar busy flag.');

  assert.match(canSubmit, /storyboardSubmittingPanelIds\.has\(panel\.id\)/);
  assert.match(canSubmit, /storyboardAnalyzingPanelIds\.has\(panel\.id\)/);
  assert.match(canSubmit, /storyboardCloningPanelIds\.has\(panel\.id\)/);
  assert.doesNotMatch(canSubmit, /storyboardSafety\.activeRunCount|!storyboardSubmittingPanelIds\.size|!storyboardAnalyzingPanelIds\.size|!storyboardCloningPanelIds\.size/,
    'A run or interaction in another column must not disable this column.');

  assert.match(analyze, /storyboardAnalyzingPanelIds\.has\(panelId\)/);
  assert.match(analyze, /storyboardAnalyzingPanelIds\.add\(panelId\)/);
  assert.match(analyze, /storyboardAnalyzingPanelIds\.delete\(panelId\)/);
  assert.match(submit, /storyboardSubmittingPanelIds\.has\(panelId\)/);
  assert.match(submit, /storyboardSubmittingPanelIds\.add\(panelId\)/);
  assert.match(submit, /storyboardSubmittingPanelIds\.delete\(panelId\)/);
  assert.match(clone, /storyboardCloningPanelIds\.has\(panelId\)/);
  assert.match(clone, /storyboardCloningPanelIds\.add\(panelId\)/);
  assert.match(clone, /storyboardCloningPanelIds\.delete\(panelId\)/);
  for (const [name, source] of [['column renderer', column], ['run actions', actions]]) {
    assert.doesNotMatch(source, /storyboard(?:Submitting|Analyzing|Cloning)PanelIds\.size/,
      `${name} must never use the existence of another column's operation as its busy state.`);
  }

  assert.match(actions, /panel\.storyboardLegacy[\s\S]*?cloneLegacyStoryboardTask\('\$\{panel\.id\}',true\)[\s\S]*?>再次生成<\/button>/,
    'A historical column must keep its internal clone path while presenting the simple 再次生成 action.');
  assert.doesNotMatch(actions, /复制(?:并)?再次生成|正在复制/,
    'Legacy implementation details must not leak into the result-cell action label.');

  for (const [name, source] of [
    ['redo dialog markup', redoMarkup],
    ['redo dialog behavior', redoDialog],
    ['confirmation submit label', submitLabel],
    ['generation confirmation', confirmation],
  ]) {
    assert.match(source, /米粿Studio/, `${name} must present 米粿Studio as the task owner.`);
    assert.doesNotMatch(source, /Nano Banana(?: 2)?|交给\s*(?:Nano|图像模型)|StoryArk 3\.0/,
      `${name} must not describe handing the user's task to a downstream image provider.`);
  }

  const provenance = functionSource(html, 'storyboardOutputPresentation');
  assert.doesNotMatch(provenance, /renderProvider|renderModel|Nano Banana|StoryArk|gemini|gpt-5/,
    'Completed results must present only Studio-owned provenance to creators.');
});

test('storyboard columns and historical versions expose guarded soft-delete controls', async () => {
  const html = await readWorkbench();
  const column = functionSource(html, 'storyboardColHTML');
  const results = functionSource(html, 'storyboardResultBody');
  const deletion = functionSource(html, 'confirmStoryboardDelete');
  const versions = functionSource(html, 'storyboardVersionsForPanel');
  const comicColumn = functionSource(html, 'colHTML');
  const classicCellRenderer = functionSource(html, 'cellHTML');
  const comicDelete = functionSource(html, 'delCol');
  const comicSubmit = functionSource(html, 'submitComicAsset');
  const comicStageSubmission = functionSource(html, 'classicStageSubmissionControl');

  assert.match(html, /data-od-id="storyboard-delete-dialog"/);
  assert.match(html, /#storyboardDeleteDialog\[open\]/,
    'The destructive confirmation dialog must use the same centered modal contract.');
  assert.match(column, /删除本列[\s\S]*?openStoryboardPanelDeleteDialog/,
    'Every editable storyboard column needs an explicit delete control.');
  assert.match(column, /panel\.storyboardLegacy\s*\?\s*''/,
    'Legacy compatibility columns must not expose deletion for another workflow.');
  assert.doesNotMatch(comicColumn, /comic-column-actions|classicSubmissionAction/,
    'Comic submission must not consume an extra footer row beneath the column.');
  assert.match(classicCellRenderer, /classicStageSubmissionControl\(col, key\)/,
    'Each completed comic stage must render its submission control in the stage status slot.');
  assert.match(comicStageSubmission, /title="提报后团队均可见该图"/,
    'Hovering the concise submission control must explain the team visibility effect.');
  assert.match(comicStageSubmission, /assetId[\s\S]*?sourceAssetId[\s\S]*?stages\[key\][\s\S]*?label\s*=\s*busy\s*\?\s*'提报中…'[\s\S]*?submitComicAsset/,
    'Draft and generated stages must submit their own immutable current asset.');
  assert.doesNotMatch(comicStageSubmission, /提报给公司|完成光影后提报/,
    'The stage control must use the concise product wording requested by creators.');
  assert.match(comicDelete, /kind:\s*'comic-panel'[\s\S]*?storyboardDeleteDialog[\s\S]*?showModal\(\)/,
    'Comic deletion must use the centered audited soft-delete confirmation flow.');
  assert.doesNotMatch(comicDelete, /P0[^'"\n]*不提供删除|暂不提供删除/,
    'The production MVP must not retain the old P0 deletion placeholder.');
  assert.match(comicSubmit, /submitStoryboardPanel\(panelId, assetVersionId\)[\s\S]*?loadOrganizationSubmissions/,
    'Comic submission must persist the exact stage asset and refresh the organization inbox.');
  assert.match(results, /采用此版本[\s\S]*?删除此版本/,
    'Each historical output must place selection and deletion actions together.');
  assert.match(html, /deleteStoryboardPanel\(panelId\)[\s\S]*?method:\s*'DELETE'/);
  assert.match(html, /deleteStoryboardOutput\(outputId\)[\s\S]*?method:\s*'DELETE'/);
  assert.match(deletion, /storyboardDeletingPanelIds\.add\(target\.panelId\)/);
  assert.match(deletion, /storyboardDeletingOutputIds\.add\(target\.outputId\)/);
  assert.match(deletion, /任务与审计记录仍保留|历史成稿中隐藏/,
    'Deletion feedback must describe soft deletion instead of physical erasure.');
  assert.match(versions, /Number\(version\.output\.version_number\)/,
    'Creator-visible version numbers must remain immutable after earlier versions are hidden.');
  for (const errorCode of [
    'storyboard_panel_analysis_active',
    'storyboard_output_selected',
    'storyboard_output_submitted'
  ]) assert.match(html, new RegExp(`${errorCode}\\s*:`));
});

test('production chrome hides P0 branding and exposes team submissions globally', async () => {
  const html = await readWorkbench();
  const topbar = html.match(/<header class="topbar"[\s\S]*?<\/header>/)?.[0] || '';
  const organizationList = functionSource(html, 'renderOrganizationSubmissions');
  const displayName = functionSource(html, 'customerFacingBatchName');
  const hydrate = functionSource(html, 'hydrateBatch');

  assert.match(topbar, /<span hidden id="chip-connection"/,
    'The backend connection state may remain as a compatibility hook but must be visually hidden.');
  assert.doesNotMatch(topbar, /P0\s*(?:真实生产|真实|Mock)/,
    'Creator-facing navigation must not expose internal P0 environment labels.');
  assert.match(displayName, /MVP[\s\S]*?上线验收[\s\S]*?return\s+['"]测试版['"]/,
    'Legacy internal acceptance batches must be presented as a customer-facing test version.');
  assert.match(hydrate, /comicBatchLabel\s*=\s*customerFacingBatchName\(batch\.name\)/);
  assert.doesNotMatch(hydrate, /batchCrumb['"]\)\.textContent\s*=\s*`\$\{batch\.name\}/,
    'The breadcrumb must never render the raw internal MVP batch name.');
  assert.match(topbar, /id="organizationSubmissionsBtn"[\s\S]*?团队提报/,
    'The team submission inbox must be available from both workflows.');
  assert.match(organizationList, /submitted_asset_version_id[\s\S]*?submitted_storyboard_output_id/,
    'The shared inbox must support both classic final assets and storyboard outputs.');
  assert.match(organizationList, /openSubmittedOrganizationAsset/);
});
