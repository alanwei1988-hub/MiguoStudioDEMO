import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectStoryboardGenerationTarget,
  StoryboardPlanService
} from '../src/services/storyboard-plan.mjs';

const PART_GROUPS = [
  'hair',
  'face_neck_skin',
  'arms_hands_skin',
  'legs_skin',
  'garment_top_sleeves',
  'garment_collar_neckwear',
  'garment_bottom',
  'socks_shoes',
  'hair_accessories',
  'carried_bag'
];

function polygon(x, y, width = 0.08, height = 0.08) {
  return [[
    { x, y }, { x: x + width, y },
    { x: x + width, y: y + height }, { x, y: y + height }
  ]];
}

function coverageChecklist(masked = {}) {
  return PART_GROUPS.map((partGroup) => ({
    partGroup,
    status: masked[partGroup]?.length ? 'masked' : 'not_visible',
    evidence: masked[partGroup]?.length ? `${partGroup} is visible and reference-backed.` : `${partGroup} is not visible.`,
    elementLocalIds: masked[partGroup] || []
  }));
}

function instance({
  localId,
  identityClass,
  identityConfidence,
  identityCues,
  action,
  masks,
  x
}) {
  return {
    localId,
    bbox: { x, y: 0.1, width: 0.2, height: 0.7 },
    identityClass,
    identityConfidence,
    identityCues,
    action,
    evidence: `${localId} identity evidence.`,
    maskPolygons: polygon(x, 0.1, 0.2, 0.7),
    coverageChecklist: coverageChecklist(masks)
  };
}

function element({ localId, ownerCharacterLocalId, partGroup, kind, relationship, x, renderOrder }) {
  return {
    localId,
    kind,
    bbox: { x, y: 0.2, width: 0.06, height: 0.12 },
    ownerCharacterLocalId,
    partGroup,
    relationship,
    visibility: 'full',
    referenceMatch: 'matched',
    confidence: 0.88,
    evidence: `${partGroup} matches the reference.`,
    action: 'apply_reference',
    renderOrder,
    maskPolygons: polygon(x, 0.2, 0.06, 0.12)
  };
}

function validAnalysis() {
  const elements = [
    element({
      localId: 'a-hair', ownerCharacterLocalId: 'character-a', partGroup: 'hair',
      kind: 'hair', relationship: 'body_part', x: 0.08, renderOrder: 1
    }),
    element({
      localId: 'a-arms-hands', ownerCharacterLocalId: 'character-a', partGroup: 'arms_hands_skin',
      kind: 'skin', relationship: 'body_part', x: 0.12, renderOrder: 2
    }),
    element({
      localId: 'a-bag', ownerCharacterLocalId: 'character-a', partGroup: 'carried_bag',
      kind: 'prop', relationship: 'carried_by', x: 0.18, renderOrder: 3
    }),
    element({
      localId: 'b-hair', ownerCharacterLocalId: 'character-b', partGroup: 'hair',
      kind: 'hair', relationship: 'body_part', x: 0.38, renderOrder: 4
    }),
    element({
      localId: 'b-arms-hands', ownerCharacterLocalId: 'character-b', partGroup: 'arms_hands_skin',
      kind: 'skin', relationship: 'body_part', x: 0.42, renderOrder: 5
    }),
    element({
      localId: 'c-hair', ownerCharacterLocalId: 'character-c', partGroup: 'hair',
      kind: 'hair', relationship: 'body_part', x: 0.72, renderOrder: 6
    })
  ];
  return {
    schemaVersion: 'storyboard-analysis-v3',
    matchPolicy: 'exact_and_strong_lookalikes',
    summary: 'Two reference-backed lookalikes and one unmatched person.',
    overallConfidence: 0.9,
    requiresConfirmation: false,
    panels: [{
      localId: 'panel-1',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      composition: 'Three people in one panel.',
      characterInstances: [
        instance({
          localId: 'character-a', identityClass: 'exact_reference', identityConfidence: 0.92,
          identityCues: ['hair_design'], action: 'apply_reference', x: 0.04,
          masks: {
            hair: ['a-hair'], arms_hands_skin: ['a-arms-hands'], carried_bag: ['a-bag']
          }
        }),
        instance({
          localId: 'character-b', identityClass: 'strong_lookalike', identityConfidence: 0.76,
          identityCues: ['hair_design', 'costume_construction'], action: 'apply_reference', x: 0.34,
          masks: { hair: ['b-hair'], arms_hands_skin: ['b-arms-hands'] }
        }),
        instance({
          localId: 'character-c', identityClass: 'generic_similarity', identityConfidence: 0.95,
          identityCues: ['face_proportions', 'body_proportions'], action: 'preserve', x: 0.68,
          masks: {}
        })
      ],
      elements,
      protectedRegions: [{
        localId: 'speech-1', kind: 'speech_bubble', ownerCharacterLocalId: null,
        bbox: { x: 0.82, y: 0.01, width: 0.16, height: 0.1 },
        maskPolygons: polygon(0.82, 0.01, 0.16, 0.1)
      }],
      coverageAudit: {
        acceptedInstanceCount: 2,
        completeAcceptedInstanceCount: 2,
        incompleteAcceptedInstanceLocalIds: [],
        notes: 'Both accepted instances have complete coverage checklists.'
      },
      risks: []
    }]
  };
}

test('instance target accepts two similar people, includes arms and bag, and hard-protects the third person', () => {
  const target = selectStoryboardGenerationTarget(validAnalysis(), { width: 540, height: 720 });

  assert.equal(target.strategy, 'storyboard-reference-instance-composite-v2');
  assert.equal(target.matchPolicyRevision, 'exact-strong-lookalike-v1');
  assert.equal(target.matchedCharacterInstanceCount, 2);
  assert.equal(target.matchedElementCount, 5);
  assert.equal(target.incompleteMatchedInstanceCount, 0);
  assert.deepEqual(target.matchedInstances.map(({ localId }) => localId), ['character-a', 'character-b']);
  assert.ok(target.matchedInstances.every(({ polygons }) => polygons[0].pixels.length === 4),
    'accepted instances keep their full-instance contours for provenance');
  assert.deepEqual(
    target.regions.map(({ localId }) => localId),
    ['a-hair', 'a-arms-hands', 'a-bag', 'b-hair', 'b-arms-hands']
  );
  assert.ok(target.regions.some((region) => region.partGroup === 'arms_hands_skin'));
  assert.ok(target.regions.some((region) => region.partGroup === 'carried_bag' && region.relationship === 'carried_by'));
  assert.deepEqual(target.matchedPartKindCounts, { hair: 2, arms_hands_skin: 2, carried_bag: 1 });

  const unmatched = target.protectedRegions.find(({ localId }) => localId === 'character-c');
  assert.equal(unmatched.kind, 'unmatched_character');
  assert.equal(unmatched.ownerCharacterLocalId, 'character-c');
  assert.equal(unmatched.hardProtection, true);
  assert.ok(unmatched.polygons[0].pixels.length === 4, 'the entire rejected character instance is protected');
  assert.equal(target.protectedRegions.find(({ localId }) => localId === 'speech-1').reason, 'explicit_protection');
  assert.equal(target.regions.some(({ ownerCharacterLocalId }) => ownerCharacterLocalId === 'character-c'), false);
});

test('instance target rejects an uncertain or structurally incomplete accepted character', () => {
  const uncertain = validAnalysis();
  uncertain.panels[0].characterInstances[0].coverageChecklist
    .find(({ partGroup }) => partGroup === 'carried_bag').status = 'uncertain';
  uncertain.panels[0].coverageAudit.completeAcceptedInstanceCount = 1;
  uncertain.panels[0].coverageAudit.incompleteAcceptedInstanceLocalIds = ['character-a'];
  assert.throws(
    () => selectStoryboardGenerationTarget(uncertain),
    (error) => error?.code === 'storyboard_analysis_incomplete_instance'
  );

  const missingElement = validAnalysis();
  missingElement.panels[0].elements = missingElement.panels[0].elements
    .filter(({ localId }) => localId !== 'a-bag');
  assert.throws(
    () => selectStoryboardGenerationTarget(missingElement),
    (error) => error?.code === 'storyboard_analysis_incomplete_instance'
  );
});

test('instance target rejects an accepted owner that is also an unmatched explicit protection', () => {
  const analysis = validAnalysis();
  analysis.panels[0].protectedRegions.push({
    localId: 'conflicting-character-a',
    kind: 'unmatched_character',
    ownerCharacterLocalId: 'character-a',
    bbox: { x: 0.04, y: 0.1, width: 0.2, height: 0.7 },
    maskPolygons: polygon(0.04, 0.1, 0.2, 0.7)
  });
  assert.throws(
    () => selectStoryboardGenerationTarget(analysis),
    (error) => error?.code === 'storyboard_analysis_instance_protection_conflict'
  );
});

test('a frozen legacy generation target is returned unchanged but cannot be created by the new selector', async () => {
  const frozen = {
    id: 'analysis-legacy',
    status: 'succeeded',
    mode: 'single',
    result: { schemaVersion: 'storyboard-analysis-v2', panels: [] },
    generation_source_asset_version_id: 'asset-frozen',
    generationTarget: { strategy: 'storyark-full-page-selective-composite-v1' }
  };
  const service = new StoryboardPlanService({
    db: { getStoryboardAnalysis: () => frozen },
    assetService: {}
  });
  assert.equal(await service.prepare(frozen.id), frozen);
  assert.throws(
    () => selectStoryboardGenerationTarget(frozen.result),
    (error) => error?.code === 'storyboard_analysis_schema_mismatch'
  );
});
