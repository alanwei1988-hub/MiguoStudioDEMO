import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildApp } from '../src/app.mjs';
import { config as baseConfig } from '../src/config.mjs';
import {
  NANO_BANANA_CONNECTION_ID,
  NANO_BANANA_CONTRACT_FINGERPRINT,
  NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION,
  NANO_BANANA_RAW_ROUTE_REVISION
} from '../src/providers/nano-banana.mjs';
import {
  canonicalizeCoverageChecklistReferences,
  StudioMainModelProvider,
  STORYBOARD_ANALYSIS_JSON_SCHEMA,
  STORYBOARD_ANALYSIS_SCHEMA_VERSION,
  STORYBOARD_COVERAGE_PART_GROUPS,
  validateStoryboardAnalysis
} from '../src/providers/studio-main-model.mjs';
import { addPanelWithSource, createHarness } from './helpers.mjs';

function analysisResult({ confidence = 0.82 } = {}) {
  const polygon = [
    { x: 0.2, y: 0.1 }, { x: 0.7, y: 0.1 },
    { x: 0.7, y: 0.9 }, { x: 0.2, y: 0.9 }
  ];
  const elementSpec = {
    hair: ['hair', 'body_part'],
    face_neck_skin: ['skin', 'body_part'],
    arms_hands_skin: ['skin', 'body_part'],
    legs_skin: ['skin', 'body_part'],
    garment_top_sleeves: ['garment', 'worn_by'],
    garment_collar_neckwear: ['garment', 'worn_by'],
    garment_bottom: ['garment', 'worn_by'],
    socks_shoes: ['garment', 'worn_by'],
    hair_accessories: ['accessory', 'worn_by'],
    carried_bag: ['prop', 'carried_by']
  };
  return {
    schemaVersion: STORYBOARD_ANALYSIS_SCHEMA_VERSION,
    matchPolicy: 'exact_and_strong_lookalikes',
    summary: 'The reference character appears in the main storyboard region.',
    overallConfidence: confidence,
    requiresConfirmation: false,
    panels: [{
      localId: 'panel-1',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      composition: 'Full-height character composition.',
      characterInstances: [{
        localId: 'character-1',
        bbox: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 },
        identityClass: 'exact_reference',
        identityConfidence: Math.max(confidence, 0.75),
        identityCues: ['hair_design', 'costume_construction'],
        action: 'apply_reference',
        evidence: 'Hair silhouette and costume outline are consistent.',
        maskPolygons: [polygon],
        coverageChecklist: STORYBOARD_COVERAGE_PART_GROUPS.map((partGroup) => ({
          partGroup,
          status: 'masked',
          evidence: `Visible ${partGroup} matches the reference.`,
          elementLocalIds: [`${partGroup}-1`]
        }))
      }],
      elements: STORYBOARD_COVERAGE_PART_GROUPS.map((partGroup, index) => ({
        localId: `${partGroup}-1`,
        kind: elementSpec[partGroup][0],
        bbox: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 },
        referenceMatch: 'matched',
        confidence: Math.max(confidence, 0.70),
        evidence: `The visible ${partGroup} design is supported by the reference.`,
        action: 'apply_reference',
        renderOrder: index + 1,
        maskPolygons: [polygon],
        ownerCharacterLocalId: 'character-1',
        partGroup,
        relationship: elementSpec[partGroup][1],
        visibility: 'full'
      })),
      protectedRegions: [{
        localId: 'bubble-1', kind: 'speech_bubble',
        bbox: { x: 0.72, y: 0.02, width: 0.2, height: 0.16 },
        maskPolygons: [[
          { x: 0.72, y: 0.02 }, { x: 0.92, y: 0.02 },
          { x: 0.92, y: 0.18 }, { x: 0.72, y: 0.18 }
        ]],
        ownerCharacterLocalId: null
      }],
      coverageAudit: {
        acceptedInstanceCount: 1,
        completeAcceptedInstanceCount: 1,
        incompleteAcceptedInstanceLocalIds: [],
        notes: 'All visible reference-backed parts are accounted for.'
      },
      risks: ['Confirm the partially occluded accessory.']
    }]
  };
}

test('analysis schema stays within the relay structured-output subset', () => {
  assert.doesNotMatch(JSON.stringify(STORYBOARD_ANALYSIS_JSON_SCHEMA), /uniqueItems/);
});

test('Studio main-model production default allows the detailed Terra contract to finish', () => {
  assert.equal(baseConfig.mainModel.timeoutMs, 600_000);
});

test('analysis schema v3 accepts multiple exact and strong-lookalike instances with complete owned coverage', () => {
  const result = analysisResult();
  const panel = result.panels[0];
  // Small, separated anatomy and props are intentionally allowed at the
  // planner's 0.60 part threshold once their character owner is accepted.
  panel.elements.find((element) => element.partGroup === 'arms_hands_skin').confidence = 0.62;
  panel.elements.find((element) => element.partGroup === 'carried_bag').confidence = 0.62;
  const lookalike = structuredClone(panel.characterInstances[0]);
  lookalike.localId = 'character-2';
  lookalike.identityClass = 'strong_lookalike';
  lookalike.identityConfidence = 0.72;
  lookalike.identityCues = ['hair_design', 'face_proportions'];
  lookalike.evidence = 'The second person repeats the distinctive hair design and matching face proportions.';
  lookalike.coverageChecklist.forEach((entry) => {
    entry.elementLocalIds = [`${entry.partGroup}-2`];
  });
  const lookalikeElements = panel.elements.map((sourceElement) => ({
    ...structuredClone(sourceElement),
    localId: `${sourceElement.partGroup}-2`,
    ownerCharacterLocalId: 'character-2'
  }));
  panel.characterInstances.push(lookalike);
  panel.elements.push(...lookalikeElements);
  panel.coverageAudit.acceptedInstanceCount = 2;
  panel.coverageAudit.completeAcceptedInstanceCount = 2;

  assert.equal(validateStoryboardAnalysis(result), result);
});

test('Studio repairs only redundant checklist pointers from exact owner and part metadata', () => {
  const repairable = analysisResult();
  repairable.panels[0].characterInstances[0].coverageChecklist[1].elementLocalIds = ['hair-1'];
  const repaired = canonicalizeCoverageChecklistReferences(repairable);
  assert.deepEqual(
    repaired.panels[0].characterInstances[0].coverageChecklist[1].elementLocalIds,
    ['face_neck_skin-1']
  );
  assert.equal(validateStoryboardAnalysis(repaired), repaired);

  const unsafe = analysisResult();
  unsafe.panels[0].elements = unsafe.panels[0].elements
    .filter((element) => element.partGroup !== 'face_neck_skin');
  unsafe.panels[0].characterInstances[0].coverageChecklist[1].elementLocalIds = ['hair-1'];
  assert.throws(
    () => validateStoryboardAnalysis(canonicalizeCoverageChecklistReferences(unsafe)),
    (error) => error?.code === 'main_model_malformed_response'
      && /(repeats an element|another character or part group)/.test(error.message)
  );
});

test('analysis schema v3 rejects weak lookalikes, ownership mistakes, incomplete checklists, protection conflicts, and false audits', () => {
  const rejects = (mutate, expectedMessage) => {
    const result = analysisResult();
    mutate(result.panels[0], result);
    assert.throws(
      () => validateStoryboardAnalysis(result),
      (error) => error?.code === 'main_model_malformed_response' && expectedMessage.test(error.message)
    );
  };

  rejects((panel) => {
    const instance = panel.characterInstances[0];
    instance.identityClass = 'strong_lookalike';
    instance.identityConfidence = 0.69;
    instance.identityCues = ['face_proportions', 'repeated_context'];
  }, /strong lookalike/);

  rejects((panel) => {
    panel.elements[0].ownerCharacterLocalId = 'missing-character';
  }, /does not reference a character instance/);

  rejects((panel) => {
    panel.characterInstances[0].coverageChecklist[0].partGroup = 'arms_hands_skin';
  }, /canonical order/);

  rejects((panel) => {
    panel.characterInstances[0].coverageChecklist[0].elementLocalIds = ['missing-element'];
  }, /owned by another character or part group/);

  rejects((panel) => {
    panel.characterInstances[0].coverageChecklist[1].status = 'uncertain';
    panel.characterInstances[0].coverageChecklist[1].evidence = 'The neck is obscured.';
    panel.characterInstances[0].coverageChecklist[1].elementLocalIds = [];
    panel.elements[1].action = 'confirm';
    panel.elements[1].referenceMatch = 'uncertain';
    panel.coverageAudit.completeAcceptedInstanceCount = 0;
    panel.coverageAudit.incompleteAcceptedInstanceLocalIds = ['character-1'];
  }, /requiresConfirmation/);

  rejects((panel) => {
    panel.protectedRegions[0].kind = 'unmatched_character';
    panel.protectedRegions[0].ownerCharacterLocalId = 'character-1';
  }, /conflicts with an accepted character instance/);

  rejects((panel) => {
    panel.coverageAudit.acceptedInstanceCount = 0;
  }, /coverageAudit does not match/);
});

function responsesStream(result, {
  id = 'response-stream',
  usage = { input_tokens: 21, output_tokens: 34, total_tokens: 55 },
  completed = true,
  transportNoiseBytes = 0
} = {}) {
  const text = JSON.stringify(result);
  const response = {
    id,
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage
  };
  const events = [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    ...(transportNoiseBytes ? [{
      type: 'response.reasoning_summary_text.delta', delta: 'x'.repeat(transportNoiseBytes)
    }] : []),
    { type: 'response.output_text.delta', delta: text.slice(0, Math.ceil(text.length / 2)) },
    { type: 'response.output_text.delta', delta: text.slice(Math.ceil(text.length / 2)) },
    { type: 'response.output_text.done', text },
    ...(completed ? [{ type: 'response.completed', response }] : [])
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function modelsResponse() {
  return new Response(JSON.stringify({
    object: 'list', data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-terra' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Studio main-model provider pins Luna for batch and Terra for interactive vision analysis', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Agent provider fixture', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const reference = harness.db.createStoryboardReference({
    batchId: batch.id,
    panelId: panel.id,
    blobPath: source.blob_path,
    sha256: source.sha256,
    mimeType: source.mime_type,
    width: source.width,
    height: source.height,
    byteSize: source.byte_size
  });
  const requests = [];
  const accepts = [];
  const provider = new StudioMainModelProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key-never-logged', enabled: true,
      batchModel: 'gpt-5.6-luna', interactiveModel: 'gpt-5.6-terra', timeoutMs: 5_000
    },
    assetService: harness.assetService,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return modelsResponse();
      requests.push(JSON.parse(options.body));
      accepts.push(options.headers.accept);
      return responsesStream(analysisResult(), {
        id: `response-${requests.length}`,
        // Real relays may stream value-free reasoning/transport events beyond
        // the final JSON. This remains bounded but must not revive the old 2 MB cutoff.
        transportNoiseBytes: requests.length === 2 ? (2 * 1024 * 1024) + 16_384 : 0
      });
    }
  });

  const batchResult = await provider.analyzeStoryboard({
    mode: 'batch', storyboardAsset: source, referenceAsset: reference, idempotencyKey: 'batch-key'
  });
  const singleResult = await provider.analyzeStoryboard({
    mode: 'single', storyboardAsset: source, referenceAsset: reference,
    modificationNote: '领巾红色更接近参考图', idempotencyKey: 'single-key'
  });
  assert.equal(batchResult.model, 'gpt-5.6-luna');
  assert.equal(singleResult.model, 'gpt-5.6-terra');
  assert.equal(requests[0].model, 'gpt-5.6-luna');
  assert.equal(requests[1].model, 'gpt-5.6-terra');
  assert.equal(requests[0].reasoning.effort, 'low');
  assert.equal(requests[1].reasoning.effort, 'medium');
  assert.equal(requests[0].input[0].content.filter((item) => item.type === 'input_image').length, 2);
  assert.equal(requests[0].input[0].content.find((item) => item.type === 'input_image').detail, 'low');
  assert.equal(requests[1].input[0].content.find((item) => item.type === 'input_image').detail, 'high');
  assert.match(requests[1].input[0].content.find((item) => item.type === 'input_text').text, /USER MODIFICATION NOTE[\s\S]*?领巾红色更接近参考图/);
  assert.match(requests[1].input[0].content.find((item) => item.type === 'input_text').text,
    /Multiple people in one panel may legitimately be exact or strong matches and must all be colored/,
    'the Agent must allow one reference design to match multiple similar storyboard instances');
  assert.match(requests[1].input[0].content.find((item) => item.type === 'input_text').text,
    /arms_hands_skin[\s\S]*?carried_bag[\s\S]*?hands, forearms, shoes, handles, straps, or bag bodies/,
    'the Agent must plan complete skin, garment and carried-prop coverage');
  assert.equal(requests[0].text.format.strict, true);
  assert.equal(requests[0].stream, true);
  assert.deepEqual(accepts, ['text/event-stream', 'text/event-stream']);
  assert.equal(singleResult.result.matchPolicy, 'exact_and_strong_lookalikes');
  assert.equal(singleResult.result.panels[0].characterInstances[0].action, 'apply_reference');
  assert.deepEqual(singleResult.usage, { inputTokens: 21, outputTokens: 34, totalTokens: 55 });
});

test('Studio main-model provider retries one proven pre-connect failure and never retries an incomplete stream', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Agent streaming fixture', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const reference = harness.db.createStoryboardReference({
    batchId: batch.id, panelId: panel.id, blobPath: source.blob_path, sha256: source.sha256,
    mimeType: source.mime_type, width: source.width, height: source.height, byteSize: source.byte_size
  });
  let connectionAttempts = 0;
  const recoveredProvider = new StudioMainModelProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key-never-logged', enabled: true,
      interactiveModel: 'gpt-5.6-terra', timeoutMs: 5_000
    },
    assetService: harness.assetService,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return modelsResponse();
      connectionAttempts += 1;
      if (connectionAttempts === 1) {
        const error = new TypeError('fetch failed');
        error.cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
        throw error;
      }
      return responsesStream(analysisResult());
    }
  });
  const recovered = await recoveredProvider.analyzeStoryboard({
    mode: 'single', storyboardAsset: source, referenceAsset: reference, idempotencyKey: 'safe-connect-retry'
  });
  assert.equal(connectionAttempts, 2);
  assert.equal(recovered.result.schemaVersion, STORYBOARD_ANALYSIS_SCHEMA_VERSION);

  let interruptedCalls = 0;
  const interruptedProvider = new StudioMainModelProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key-never-logged', enabled: true,
      interactiveModel: 'gpt-5.6-terra', timeoutMs: 5_000
    },
    assetService: harness.assetService,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return modelsResponse();
      interruptedCalls += 1;
      return responsesStream(analysisResult(), { completed: false });
    }
  });
  await assert.rejects(
    interruptedProvider.analyzeStoryboard({
      mode: 'single', storyboardAsset: source, referenceAsset: reference, idempotencyKey: 'incomplete-stream'
    }),
    (error) => error?.code === 'main_model_stream_interrupted'
  );
  assert.equal(interruptedCalls, 1, 'A stream that already started must never be retried automatically.');

  let readinessCalls = 0;
  const unavailableProvider = new StudioMainModelProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key-never-logged', enabled: true,
      interactiveModel: 'gpt-5.6-terra', timeoutMs: 5_000
    },
    assetService: harness.assetService,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET', 'A failed readiness check must prevent the paid analysis POST.');
      readinessCalls += 1;
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      throw error;
    }
  });
  await assert.rejects(
    unavailableProvider.analyzeStoryboard({
      mode: 'single', storyboardAsset: source, referenceAsset: reference, idempotencyKey: 'readiness-failed'
    }),
    (error) => error?.code === 'main_model_unavailable'
  );
  assert.equal(readinessCalls, 4, 'Read-only readiness checks may retry without ever submitting inference.');
});

test('Studio main-model provider normalizes native numeric TimeoutError code 23 without retrying inference', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Agent timeout fixture', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const reference = harness.db.createStoryboardReference({
    batchId: batch.id, panelId: panel.id, blobPath: source.blob_path, sha256: source.sha256,
    mimeType: source.mime_type, width: source.width, height: source.height, byteSize: source.byte_size
  });
  let inferenceCalls = 0;
  const provider = new StudioMainModelProvider({
    config: {
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-key-never-logged', enabled: true,
      interactiveModel: 'gpt-5.6-terra', timeoutMs: 5_000
    },
    assetService: harness.assetService,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return modelsResponse();
      inferenceCalls += 1;
      const body = new ReadableStream({
        start(controller) {
          controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        }
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      });
    }
  });

  await assert.rejects(
    provider.analyzeStoryboard({
      mode: 'single', storyboardAsset: source, referenceAsset: reference,
      idempotencyKey: 'native-timeout-code-23'
    }),
    (error) => error?.code === 'main_model_timeout'
      && error?.message === 'The Studio main-model analysis timed out.'
  );
  assert.equal(inferenceCalls, 1, 'A response stream that timed out after acceptance must never be retried.');
});

async function apiHarness(t, {
  mainModelOverride = null,
  nanoBananaOverride = null,
  imageModelEnabled = true,
  renderProvider = 'nano_banana_2'
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-agent-api-'));
  const calls = [];
  const mainModel = mainModelOverride || {
    modelForMode(mode) { return mode === 'batch' ? 'gpt-5.6-luna' : 'gpt-5.6-terra'; },
    async analyzeStoryboard({ mode }) {
      calls.push(mode);
      const result = analysisResult({ confidence: mode === 'batch' ? 0.76 : 0.91 });
      if (mode === 'single') {
        result.panels[0].bbox = { x: 0.08, y: 0.1, width: 0.48, height: 0.78 };
      }
      return {
        result,
        model: this.modelForMode(mode),
        responseId: `fixture-${mode}-${calls.length}`,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
      };
    }
  };
  const runtimeConfig = {
    ...baseConfig,
    dataRoot: root,
    databasePath: path.join(root, 'p0.sqlite'),
    assetsRoot: path.join(root, 'assets'),
    exportsRoot: path.join(root, 'exports'),
    storyark: {
      ...baseConfig.storyark,
      accountId: 'fixture-storyark-account', apiToken: 'fixture-storyark-token',
      allowRealProvider: true, internalUseAcknowledged: true
    },
    storyboard: { renderProvider, projectId: 'project-1' },
    mainModel: {
      ...baseConfig.mainModel,
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-relay-token', enabled: true,
      batchModel: 'gpt-5.6-luna', interactiveModel: 'gpt-5.6-terra', maxBatchPanels: 20
    },
    imageModel: {
      ...baseConfig.imageModel,
      baseUrl: 'https://relay.example/v1', apiKey: 'fixture-image-token',
      model: 'gemini-3.1-flash-image', enabled: imageModelEnabled,
      allowGeneration: imageModelEnabled, internalUseAcknowledged: imageModelEnabled
    }
  };
  const app = await buildApp({
    runtimeConfig,
    startWorker: false,
    providerOverrides: {
      mainModel,
      ...(nanoBananaOverride ? { nanoBanana: nanoBananaOverride } : {})
    }
  });
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, calls };
}

test('a failed Terra analysis replays its exact error while a deliberate new key can retry', async (t) => {
  let calls = 0;
  const mainModel = {
    modelForMode(mode) { return mode === 'batch' ? 'gpt-5.6-luna' : 'gpt-5.6-terra'; },
    async analyzeStoryboard() {
      calls += 1;
      throw Object.assign(new Error('The Studio main-model relay is unavailable.'), {
        code: 'main_model_unavailable', statusCode: 502
      });
    }
  };
  const { app } = await apiHarness(t, { mainModelOverride: mainModel });
  const fixture = await seedApi(app);
  const request = (key) => app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': key },
    payload: { referenceAssetId: fixture.reference.id, modificationNote: '制服蓝色更接近参考图' }
  });

  const first = await request('failed-terra-attempt-1');
  assert.equal(first.statusCode, 502);
  assert.equal(first.json().error.code, 'main_model_unavailable');
  assert.equal(calls, 1);

  const replay = await request('failed-terra-attempt-1');
  assert.equal(replay.statusCode, 502);
  assert.equal(replay.json().error.code, 'main_model_unavailable');
  assert.equal(calls, 1, 'An exact replay must not create a second model request.');

  const deliberateRetry = await request('failed-terra-attempt-2');
  assert.equal(deliberateRetry.statusCode, 502);
  assert.equal(calls, 2, 'A user-triggered retry uses a fresh key and may call the model once.');
});

test('an identical successful Terra understanding is reused across regenerate attempts', async (t) => {
  const { app, calls } = await apiHarness(t);
  const fixture = await seedApi(app);
  const request = (key, modificationNote = '') => app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': key },
    payload: { referenceAssetId: fixture.reference.id, modificationNote }
  });

  const first = await request('successful-terra-attempt-1');
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().reused, undefined);
  assert.equal(calls.length, 1);

  const reused = await request('successful-terra-attempt-2');
  assert.equal(reused.statusCode, 200, reused.body);
  assert.equal(reused.json().reused, true);
  assert.equal(reused.json().deduplicated, true);
  assert.equal(reused.json().analysis.id, first.json().analysis.id);
  assert.equal(calls.length, 1, 'Unchanged source, reference, note, model and prompt must not call the relay again.');

  const changedNote = await request('successful-terra-attempt-3', '让制服蓝色更深');
  assert.equal(changedNote.statusCode, 201, changedNote.body);
  assert.notEqual(changedNote.json().analysis.id, first.json().analysis.id);
  assert.equal(calls.length, 2, 'A changed optional note must produce a fresh model understanding.');
});

test('a rejected structured result retains value-free response identity and token accounting', async (t) => {
  const mainModel = {
    modelForMode(mode) { return mode === 'batch' ? 'gpt-5.6-luna' : 'gpt-5.6-terra'; },
    async analyzeStoryboard() {
      throw Object.assign(new Error('The checklist pointer failed strict validation.'), {
        code: 'main_model_malformed_response',
        statusCode: 502,
        providerResponseId: 'response-value-free-fixture',
        usage: { inputTokens: 101, outputTokens: 202, totalTokens: 303 }
      });
    }
  };
  const { app } = await apiHarness(t, { mainModelOverride: mainModel });
  const fixture = await seedApi(app);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': 'rejected-structured-result' },
    payload: { referenceAssetId: fixture.reference.id }
  });
  assert.equal(response.statusCode, 502);
  const stored = app.p0.db.db.prepare(`
    SELECT * FROM storyboard_analyses WHERE idempotency_key = ?
  `).get('rejected-structured-result');
  assert.equal(stored.status, 'failed');
  assert.equal(stored.provider_response_id, 'response-value-free-fixture');
  assert.equal(stored.input_tokens, 101);
  assert.equal(stored.output_tokens, 202);
  assert.equal(stored.total_tokens, 303);
  assert.equal(stored.result_json, null, 'the rejected raw model result must never be persisted');
});

async function seedApi(app) {
  const batch = app.p0.db.createBatch('Agent API fixture', null, 'reference_creation');
  const harness = { db: app.p0.db, assetService: app.p0.assetService };
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id });
  const reference = app.p0.db.createStoryboardReference({
    batchId: batch.id, panelId: panel.id,
    blobPath: source.blob_path, sha256: source.sha256, mimeType: source.mime_type,
    width: source.width, height: source.height, byteSize: source.byte_size
  });
  return { batch, panel, source, reference };
}

test('API routes batch work to Luna, interactive work to Terra, and gate StoryArk on the exact Terra analysis', async (t) => {
  const { app, calls } = await apiHarness(t, { renderProvider: 'storyark' });
  const fixture = await seedApi(app);

  const batchResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/batches/${fixture.batch.id}/storyboard-analyses`,
    headers: { 'idempotency-key': 'batch-analysis-request' },
    payload: { items: [{ panelId: fixture.panel.id, referenceAssetId: fixture.reference.id }] }
  });
  assert.equal(batchResponse.statusCode, 200);
  assert.equal(batchResponse.json().results[0].analysis.model_name, undefined);
  assert.equal(app.p0.db.getStoryboardAnalysis(batchResponse.json().results[0].analysis.id).model_name, 'gpt-5.6-luna');

  const singleResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': 'single-analysis-request' },
    payload: {
      referenceAssetId: fixture.reference.id,
      modificationNote: '制服蓝色更接近参考图'
    }
  });
  assert.equal(singleResponse.statusCode, 201);
  const single = singleResponse.json().analysis;
  assert.equal(single.model_name, undefined);
  assert.equal(app.p0.db.getStoryboardAnalysis(single.id).model_name, 'gpt-5.6-terra');
  assert.equal(single.modification_note, '制服蓝色更接近参考图');
  assert.equal(single.generation_source_asset_version_id, fixture.source.id);
  assert.equal(single.generationTarget.strategy, 'storyboard-reference-instance-composite-v2');
  assert.equal(single.generationTarget.usedOriginalImage, true);
  assert.equal(single.generationTarget.matchedRegionCount, 10);
  assert.equal(single.generationTarget.protectedRegionCount, 1);
  assert.equal(single.generationTarget.regions[0].localId, 'hair-1');
  assert.equal(single.generationTarget.sourceSha256, fixture.source.sha256);
  assert.deepEqual(calls, ['batch', 'single']);

  const replay = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': 'single-analysis-request' },
    payload: { referenceAssetId: fixture.reference.id, modificationNote: '制服蓝色更接近参考图' }
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(calls, ['batch', 'single'], 'An idempotent replay must not spend main-model tokens again.');

  const wrongAnalysis = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-with-luna' },
    payload: {
      projectId: 'project-1', referenceAssetId: fixture.reference.id,
      analysisId: batchResponse.json().results[0].analysis.id,
      imageSize: '1K', expectedResultCount: 1, removeBg: false
    }
  });
  assert.equal(wrongAnalysis.statusCode, 409);
  assert.equal(wrongAnalysis.json().error.code, 'storyboard_analysis_mismatch');

  const accepted = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'storyark-with-terra' },
    payload: {
      projectId: 'project-1', referenceAssetId: fixture.reference.id, analysisId: single.id,
      imageSize: '1K', expectedResultCount: 1, removeBg: false,
      modificationNote: '制服蓝色更接近参考图'
    }
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().run.analysis_id, single.id);
  assert.equal(accepted.json().run.modification_note, '制服蓝色更接近参考图');
  assert.equal(accepted.json().run.request.modificationNote, '制服蓝色更接近参考图');
  assert.equal(accepted.json().run.request.analysisModel, undefined);
  assert.equal(accepted.json().run.source_asset_version_id, single.generation_source_asset_version_id);
  assert.equal(accepted.json().run.request.routeRevision, undefined);
  const acceptedInternal = app.p0.db.getStoryboardRun(accepted.json().run.id);
  assert.equal(acceptedInternal.request.analysisModel, 'gpt-5.6-terra');
  assert.equal(acceptedInternal.request.routeRevision, 'storyark-v3-instance-chroma-composite-3');

  const details = await app.inject({ method: 'GET', url: `/api/v1/batches/${fixture.batch.id}` });
  assert.equal(details.json().storyboardAnalyses.length, 2);
  assert.doesNotMatch(details.body, /fixture-relay-token|fixture-storyark-token/);
});

test('API pins Nano Banana 2 to one Terra-analyzed result and the exact optional note', async (t) => {
  const { app } = await apiHarness(t);
  const fixture = await seedApi(app);
  const note = '只补充参考图中可确认的颜色，光影柔和';
  const analyzed = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': 'nano-terra-analysis' },
    payload: { referenceAssetId: fixture.reference.id, modificationNote: note }
  });
  assert.equal(analyzed.statusCode, 201);
  const analysis = analyzed.json().analysis;

  const rejectedCount = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'nano-count-invalid' },
    payload: {
      renderProvider: 'nano_banana_2', referenceAssetId: fixture.reference.id,
      analysisId: analysis.id, imageSize: '1K', expectedResultCount: 2,
      removeBg: false, modificationNote: note
    }
  });
  assert.equal(rejectedCount.statusCode, 422);

  const queued = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'nano-queue-exact' },
    payload: {
      referenceAssetId: fixture.reference.id,
      analysisId: analysis.id, imageSize: '1K', expectedResultCount: 1,
      removeBg: false, modificationNote: note
    }
  });
  assert.equal(queued.statusCode, 202);
  assert.equal(queued.json().run.modification_note, note);
  assert.equal(queued.json().run.request.renderProvider, undefined);
  assert.equal(queued.json().run.request.renderModel, undefined);
  assert.equal(queued.json().run.request.routeRevision, undefined);
  assert.equal(queued.json().run.contract_fingerprint, undefined);
  const queuedInternal = app.p0.db.getStoryboardRun(queued.json().run.id);
  assert.equal(queuedInternal.request.renderProvider, 'nano_banana_2');
  assert.equal(queuedInternal.request.renderModel, 'gemini-3.1-flash-image');
  assert.equal(queuedInternal.request.routeRevision, NANO_BANANA_RAW_ROUTE_REVISION);
  assert.equal(queuedInternal.contract_fingerprint, NANO_BANANA_CONTRACT_FINGERPRINT);
  assert.match(queued.json().run.project_id, /^studio:studio_relay_nano_banana_2$/);

  const exactReplay = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'nano-queue-exact' },
    payload: {
      referenceAssetId: fixture.reference.id,
      analysisId: analysis.id, imageSize: '1K', expectedResultCount: 1,
      removeBg: false, modificationNote: note
    }
  });
  assert.equal(exactReplay.statusCode, 200);
  assert.equal(exactReplay.json().run.id, queued.json().run.id);
  assert.equal(exactReplay.json().run.request.routeRevision, undefined);

  const changedProject = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'nano-queue-exact' },
    payload: {
      renderProvider: 'nano_banana_2', projectId: 'a-different-client-project',
      referenceAssetId: fixture.reference.id, analysisId: analysis.id,
      imageSize: '1K', expectedResultCount: 1, removeBg: false, modificationNote: note
    }
  });
  assert.equal(changedProject.statusCode, 409);
  assert.equal(changedProject.json().error.code, 'idempotency_key_conflict');

  const changedNote = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': 'nano-note-mismatch' },
    payload: {
      renderProvider: 'nano_banana_2', referenceAssetId: fixture.reference.id,
      analysisId: analysis.id, imageSize: '1K', expectedResultCount: 1,
      removeBg: false, modificationNote: '改成其他意见'
    }
  });
  assert.equal(changedNote.statusCode, 409);
  assert.equal(changedNote.json().error.code, 'storyboard_analysis_mismatch');
});

test('a legacy Nano key replays its frozen paid run across the Raw route deployment with closed gates', async (t) => {
  let providerCalls = 0;
  const nanoBanana = {
    async renderStoryboard() {
      providerCalls += 1;
      throw new Error('The provider must not be called by an API idempotency replay.');
    }
  };
  const { app } = await apiHarness(t, {
    nanoBananaOverride: nanoBanana,
    imageModelEnabled: false
  });
  const fixture = await seedApi(app);
  const note = '保持原分镜构图，只补充参考色';
  const analyzed = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-analysis`,
    headers: { 'idempotency-key': 'legacy-nano-analysis' },
    payload: { referenceAssetId: fixture.reference.id, modificationNote: note }
  });
  assert.equal(analyzed.statusCode, 201);
  const analysis = analyzed.json().analysis;
  const legacyFingerprint = 'e'.repeat(64);
  const idempotencyKey = 'legacy-nano-before-raw-deployment';
  const legacy = app.p0.db.queueStoryboardRun({
    panelId: fixture.panel.id,
    idempotencyKey,
    contractFingerprint: legacyFingerprint,
    projectId: `studio:${NANO_BANANA_CONNECTION_ID}`,
    imageSize: '1K',
    expectedResultCount: 1,
    removeBg: false,
    sourceAssetVersionId: analysis.generation_source_asset_version_id,
    referenceAssetId: fixture.reference.id,
    analysisId: analysis.id,
    modificationNote: note,
    renderProvider: 'nano_banana_2',
    request: {
      providerConnectionId: NANO_BANANA_CONNECTION_ID,
      renderProvider: 'nano_banana_2',
      renderModel: 'gemini-legacy-image',
      routeRevision: NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION,
      analysisId: analysis.id,
      analysisModel: analysis.model_name,
      analysisPromptRevision: analysis.prompt_revision,
      modificationNote: note,
      analysisTarget: analysis.generationTarget
    }
  }).run;
  const payload = {
    renderProvider: 'nano_banana_2',
    projectId: 'client-project-visible-before-deployment',
    referenceAssetId: fixture.reference.id,
    analysisId: analysis.id,
    imageSize: '1K',
    expectedResultCount: 1,
    removeBg: false,
    modificationNote: note
  };

  const replay = await app.inject({
    method: 'POST',
    url: `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
    headers: { 'idempotency-key': idempotencyKey },
    payload
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().deduplicated, true);
  assert.equal(replay.json().run.id, legacy.id);
  assert.equal(replay.json().run.contract_fingerprint, undefined);
  assert.equal(replay.json().run.request.routeRevision, undefined);
  assert.equal(replay.json().run.request.renderModel, undefined);
  const replayInternal = app.p0.db.getStoryboardRun(legacy.id);
  assert.equal(replayInternal.contract_fingerprint, legacyFingerprint);
  assert.equal(replayInternal.request.routeRevision, NANO_BANANA_LEGACY_COMPOSITE_ROUTE_REVISION);
  assert.equal(replayInternal.request.renderModel, 'gemini-legacy-image');

  const secondPanel = await addPanelWithSource(
    { db: app.p0.db, assetService: app.p0.assetService },
    { batchId: fixture.batch.id, ordinal: 2 }
  );
  const changedRequests = [
    { label: 'panel', url: `/api/v1/panels/${secondPanel.panel.id}/storyboard-runs`, payload },
    { label: 'reference', payload: { ...payload, referenceAssetId: 'changed-reference' } },
    { label: 'analysis', payload: { ...payload, analysisId: 'changed-analysis' } },
    { label: 'note', payload: { ...payload, modificationNote: 'changed note' } },
    { label: 'size', payload: { ...payload, imageSize: '2K' } },
    { label: 'count', payload: { ...payload, expectedResultCount: 2 } },
    { label: 'removeBg', payload: { ...payload, removeBg: true } },
    { label: 'provider', payload: { ...payload, renderProvider: 'storyark' } },
    { label: 'wrong provider type', payload: { ...payload, renderProvider: { invalid: true } } }
  ];
  for (const changed of changedRequests) {
    const response = await app.inject({
      method: 'POST',
      url: changed.url || `/api/v1/panels/${fixture.panel.id}/storyboard-runs`,
      headers: { 'idempotency-key': idempotencyKey },
      payload: changed.payload
    });
    const invalidType = changed.label === 'wrong provider type';
    assert.equal(response.statusCode, invalidType ? 422 : 409, `${changed.label}: ${response.body}`);
    assert.equal(response.json().error.code, invalidType ? 'invalid_storyboard_parameters' : 'idempotency_key_conflict', changed.label);
  }
  assert.equal(app.p0.db.listStoryboardRuns().length, 1, 'Replays and conflicts must not insert another run.');
  assert.equal(providerCalls, 0, 'The API replay path must never call the paid provider.');
});
