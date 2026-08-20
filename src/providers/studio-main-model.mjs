import { sha256 } from '../security.mjs';

export const STORYBOARD_ANALYSIS_PROMPT_REVISION = 'storyboard-selective-reference-color-v5';
export const STORYBOARD_ANALYSIS_SCHEMA_VERSION = 'storyboard-analysis-v3';

export const STORYBOARD_COVERAGE_PART_GROUPS = Object.freeze([
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
]);

const IDENTITY_CLASSES = Object.freeze([
  'exact_reference', 'strong_lookalike', 'generic_similarity', 'different', 'uncertain'
]);
const IDENTITY_CUES = Object.freeze([
  'hair_design', 'hair_accessory', 'face_proportions', 'costume_construction',
  'body_proportions', 'carried_prop', 'repeated_context'
]);
const DISTINCTIVE_LOOKALIKE_CUES = new Set([
  'hair_design', 'hair_accessory', 'costume_construction', 'carried_prop'
]);
const ELEMENT_PART_GROUPS = Object.freeze([...STORYBOARD_COVERAGE_PART_GROUPS, 'other']);
const INSTANCE_ACTIONS = Object.freeze(['apply_reference', 'confirm', 'preserve']);
const COVERAGE_STATUSES = Object.freeze(['masked', 'preserve', 'uncertain', 'not_visible']);
const ELEMENT_RELATIONSHIPS = Object.freeze([
  'body_part', 'worn_by', 'held_by', 'carried_by', 'adjacent', 'independent'
]);

const MAX_ERROR_RESPONSE_BYTES = 2 * 1024 * 1024;
// Responses SSE may carry value-free reasoning/transport events in addition to
// the bounded structured JSON. Keep error bodies tight, but allow enough stream
// overhead for a full multi-panel instance plan before the strict validator runs.
const MAX_STREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
const RELAY_PROBE_TIMEOUT_MS = 20_000;
const RELAY_PROBE_ATTEMPTS = 4;
const RELAY_PROBE_TTL_MS = 60_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SAFE_PRECONNECT_RETRY_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'
]);

const bboxSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    width: { type: 'number', minimum: 0, maximum: 1 },
    height: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['x', 'y', 'width', 'height']
});

const pointSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['x', 'y']
});

const polygonCollectionSchema = Object.freeze({
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: {
    type: 'array',
    minItems: 3,
    maxItems: 40,
    items: pointSchema
  }
});

export const STORYBOARD_ANALYSIS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [STORYBOARD_ANALYSIS_SCHEMA_VERSION] },
    matchPolicy: { type: 'string', enum: ['exact_and_strong_lookalikes'] },
    summary: { type: 'string', maxLength: 500 },
    overallConfidence: { type: 'number', minimum: 0, maximum: 1 },
    requiresConfirmation: { type: 'boolean' },
    panels: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localId: { type: 'string', maxLength: 80 },
          bbox: bboxSchema,
          composition: { type: 'string', maxLength: 300 },
          characterInstances: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                localId: { type: 'string', maxLength: 80 },
                bbox: bboxSchema,
                identityClass: { type: 'string', enum: IDENTITY_CLASSES },
                identityConfidence: { type: 'number', minimum: 0, maximum: 1 },
                identityCues: {
                  type: 'array', minItems: 1, maxItems: IDENTITY_CUES.length,
                  items: { type: 'string', enum: IDENTITY_CUES }
                },
                action: { type: 'string', enum: INSTANCE_ACTIONS },
                evidence: { type: 'string', maxLength: 300 },
                maskPolygons: polygonCollectionSchema,
                coverageChecklist: {
                  type: 'array',
                  minItems: STORYBOARD_COVERAGE_PART_GROUPS.length,
                  maxItems: STORYBOARD_COVERAGE_PART_GROUPS.length,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      partGroup: { type: 'string', enum: STORYBOARD_COVERAGE_PART_GROUPS },
                      status: { type: 'string', enum: COVERAGE_STATUSES },
                      evidence: { type: 'string', maxLength: 300 },
                      elementLocalIds: {
                        type: 'array', maxItems: 24,
                        items: { type: 'string', maxLength: 80 }
                      }
                    },
                    required: ['partGroup', 'status', 'evidence', 'elementLocalIds']
                  }
                }
              },
              required: [
                'localId', 'bbox', 'identityClass', 'identityConfidence', 'identityCues',
                'action', 'evidence', 'maskPolygons', 'coverageChecklist'
              ]
            }
          },
          elements: {
            type: 'array',
            maxItems: 48,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                localId: { type: 'string', maxLength: 80 },
                kind: {
                  type: 'string',
                  enum: ['character', 'hair', 'skin', 'garment', 'accessory', 'prop', 'other']
                },
                bbox: bboxSchema,
                referenceMatch: { type: 'string', enum: ['matched', 'uncertain', 'not_present'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                evidence: { type: 'string', maxLength: 300 },
                action: { type: 'string', enum: ['apply_reference', 'confirm', 'preserve'] },
                renderOrder: { type: 'integer', minimum: 0, maximum: 100 },
                maskPolygons: polygonCollectionSchema,
                ownerCharacterLocalId: { type: ['string', 'null'], maxLength: 80 },
                partGroup: { type: 'string', enum: ELEMENT_PART_GROUPS },
                relationship: { type: 'string', enum: ELEMENT_RELATIONSHIPS },
                visibility: { type: 'string', enum: ['full', 'partial'] }
              },
              required: [
                'localId', 'kind', 'bbox', 'referenceMatch', 'confidence', 'evidence',
                'action', 'renderOrder', 'maskPolygons', 'ownerCharacterLocalId',
                'partGroup', 'relationship', 'visibility'
              ]
            }
          },
          protectedRegions: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                localId: { type: 'string', maxLength: 80 },
                kind: {
                  type: 'string',
                  enum: ['speech_bubble', 'text', 'panel_border', 'unmatched_character', 'background_detail', 'other']
                },
                bbox: bboxSchema,
                maskPolygons: polygonCollectionSchema,
                ownerCharacterLocalId: { type: ['string', 'null'], maxLength: 80 }
              },
              required: ['localId', 'kind', 'bbox', 'maskPolygons', 'ownerCharacterLocalId']
            }
          },
          coverageAudit: {
            type: 'object',
            additionalProperties: false,
            properties: {
              acceptedInstanceCount: { type: 'integer', minimum: 0, maximum: 32 },
              completeAcceptedInstanceCount: { type: 'integer', minimum: 0, maximum: 32 },
              incompleteAcceptedInstanceLocalIds: {
                type: 'array', maxItems: 32,
                items: { type: 'string', maxLength: 80 }
              },
              notes: { type: 'string', maxLength: 300 }
            },
            required: [
              'acceptedInstanceCount', 'completeAcceptedInstanceCount',
              'incompleteAcceptedInstanceLocalIds', 'notes'
            ]
          },
          risks: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', maxLength: 200 }
          }
        },
        required: [
          'localId', 'bbox', 'composition', 'characterInstances', 'elements',
          'protectedRegions', 'coverageAudit', 'risks'
        ]
      }
    }
  },
  required: [
    'schemaVersion', 'matchPolicy', 'summary', 'overallConfidence',
    'requiresConfirmation', 'panels'
  ]
});

function providerError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = ['main_model_not_configured', 'main_model_disabled'].includes(code) ? 409 : 502;
  error.details = details;
  return error;
}

function normalizedBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw providerError('main_model_not_configured', 'The Studio main-model base URL is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw providerError('main_model_not_configured', 'The Studio main-model base URL must be a credential-free HTTPS URL.');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed;
}

function assertBbox(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('main_model_malformed_response', `${label} must be a normalized bounding box.`);
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) {
      throw providerError('main_model_malformed_response', `${label}.${key} must be from 0 to 1.`);
    }
  }
  if (value.x + value.width > 1.001 || value.y + value.height > 1.001) {
    throw providerError('main_model_malformed_response', `${label} exceeds the source image bounds.`);
  }
}

function assertShortString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw providerError('main_model_malformed_response', `${label} is missing or too long.`);
  }
}

function assertPolygons(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 8) {
    throw providerError('main_model_malformed_response', `${label} must contain from 1 to 8 polygons.`);
  }
  value.forEach((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 40) {
      throw providerError('main_model_malformed_response', `${label}[${polygonIndex}] must contain from 3 to 40 points.`);
    }
    polygon.forEach((point, pointIndex) => {
      if (!point || typeof point !== 'object' || Array.isArray(point)
        || typeof point.x !== 'number' || !Number.isFinite(point.x) || point.x < 0 || point.x > 1
        || typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y < 0 || point.y > 1) {
        throw providerError('main_model_malformed_response', `${label}[${polygonIndex}][${pointIndex}] is invalid.`);
      }
    });
  });
}

function assertNullableLocalId(value, label) {
  if (value !== null) assertShortString(value, label, 80);
}

function assertUniqueLocalIds(values, label) {
  const ids = new Set();
  values.forEach((entry, index) => {
    assertShortString(entry?.localId, `${label}[${index}].localId`, 80);
    if (ids.has(entry.localId)) {
      throw providerError('main_model_malformed_response', `${label}[${index}].localId must be unique.`);
    }
    ids.add(entry.localId);
  });
  return ids;
}

function assertCoverageElementRelationship(element, prefix) {
  if (['hair', 'face_neck_skin', 'arms_hands_skin', 'legs_skin'].includes(element.partGroup)
    && element.relationship !== 'body_part') {
    throw providerError('main_model_malformed_response', `${prefix}.relationship must be body_part for ${element.partGroup}.`);
  }
  if (['garment_top_sleeves', 'garment_collar_neckwear', 'garment_bottom', 'socks_shoes', 'hair_accessories'].includes(element.partGroup)
    && element.relationship !== 'worn_by') {
    throw providerError('main_model_malformed_response', `${prefix}.relationship must be worn_by for ${element.partGroup}.`);
  }
  if (element.partGroup === 'carried_bag' && !['held_by', 'carried_by'].includes(element.relationship)) {
    throw providerError('main_model_malformed_response', `${prefix}.relationship must be held_by or carried_by for carried_bag.`);
  }
}

// The ten-row checklist is a redundant audit index over the authoritative
// element ownership and part-group fields. Long structured generations can
// occasionally place a valid element localId in the neighbouring character's
// checklist row. Rebuild only those pointer arrays from exact owner + part
// metadata; never change identities, actions, polygons, confidence, or
// protections. If no exact owned element exists, validation still fails.
export function canonicalizeCoverageChecklistReferences(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.panels)) return value;
  for (const panel of value.panels) {
    if (!Array.isArray(panel?.elements) || !Array.isArray(panel?.characterInstances)) continue;
    for (const instance of panel.characterInstances) {
      if (typeof instance?.localId !== 'string' || !Array.isArray(instance.coverageChecklist)) continue;
      for (const entry of instance.coverageChecklist) {
        if (entry?.status !== 'masked' || typeof entry.partGroup !== 'string') continue;
        const canonicalIds = panel.elements
          .filter((element) => element?.ownerCharacterLocalId === instance.localId
            && element?.partGroup === entry.partGroup
            && element?.action === 'apply_reference'
            && typeof element?.localId === 'string')
          .map((element) => element.localId);
        if (canonicalIds.length && canonicalIds.length <= 24) entry.elementLocalIds = canonicalIds;
      }
    }
  }
  return value;
}

export function validateStoryboardAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('main_model_malformed_response', 'The Studio main model did not return an analysis object.');
  }
  if (value.schemaVersion !== STORYBOARD_ANALYSIS_SCHEMA_VERSION) {
    throw providerError('main_model_schema_drift', 'The Studio main-model analysis schema revision does not match this release.');
  }
  if (value.matchPolicy !== 'exact_and_strong_lookalikes') {
    throw providerError('main_model_malformed_response', 'matchPolicy must accept exact references and strong lookalikes.');
  }
  assertShortString(value.summary, 'summary', 500);
  if (typeof value.overallConfidence !== 'number' || !Number.isFinite(value.overallConfidence)
    || value.overallConfidence < 0 || value.overallConfidence > 1) {
    throw providerError('main_model_malformed_response', 'overallConfidence must be from 0 to 1.');
  }
  if (typeof value.requiresConfirmation !== 'boolean') {
    throw providerError('main_model_malformed_response', 'requiresConfirmation must be a boolean.');
  }
  if (!Array.isArray(value.panels) || !value.panels.length || value.panels.length > 24) {
    throw providerError('main_model_malformed_response', 'The analysis must contain from 1 to 24 storyboard panels.');
  }
  assertUniqueLocalIds(value.panels, 'panels');
  let analysisNeedsConfirmation = false;
  value.panels.forEach((panel, panelIndex) => {
    assertShortString(panel?.localId, `panels[${panelIndex}].localId`, 80);
    assertBbox(panel.bbox, `panels[${panelIndex}].bbox`);
    if (typeof panel.composition !== 'string' || panel.composition.length > 300) {
      throw providerError('main_model_malformed_response', `panels[${panelIndex}].composition is invalid.`);
    }
    if (!Array.isArray(panel.characterInstances) || panel.characterInstances.length > 32
      || !Array.isArray(panel.elements) || panel.elements.length > 48
      || !Array.isArray(panel.protectedRegions) || panel.protectedRegions.length > 64
      || !Array.isArray(panel.risks) || panel.risks.length > 12) {
      throw providerError('main_model_malformed_response', `panels[${panelIndex}] contains invalid collections.`);
    }
    const instanceIds = assertUniqueLocalIds(panel.characterInstances, `panels[${panelIndex}].characterInstances`);
    const elementIds = assertUniqueLocalIds(panel.elements, `panels[${panelIndex}].elements`);
    const protectedIds = assertUniqueLocalIds(panel.protectedRegions, `panels[${panelIndex}].protectedRegions`);
    for (const id of elementIds) {
      if (instanceIds.has(id)) throw providerError('main_model_malformed_response', `panels[${panelIndex}] entity localIds must be unique.`);
    }
    for (const id of protectedIds) {
      if (instanceIds.has(id) || elementIds.has(id)) {
        throw providerError('main_model_malformed_response', `panels[${panelIndex}] entity localIds must be unique.`);
      }
    }
    const instanceById = new Map(panel.characterInstances.map((instance) => [instance.localId, instance]));
    const elementById = new Map(panel.elements.map((element) => [element.localId, element]));
    panel.elements.forEach((element, elementIndex) => {
      const prefix = `panels[${panelIndex}].elements[${elementIndex}]`;
      assertShortString(element?.localId, `${prefix}.localId`, 80);
      assertBbox(element.bbox, `${prefix}.bbox`);
      assertPolygons(element.maskPolygons, `${prefix}.maskPolygons`);
      if (!['character', 'hair', 'skin', 'garment', 'accessory', 'prop', 'other'].includes(element.kind)
        || !['matched', 'uncertain', 'not_present'].includes(element.referenceMatch)
        || !INSTANCE_ACTIONS.includes(element.action)
        || !Number.isInteger(element.renderOrder) || element.renderOrder < 0 || element.renderOrder > 100
        || typeof element.confidence !== 'number' || !Number.isFinite(element.confidence)
        || element.confidence < 0 || element.confidence > 1
        || typeof element.evidence !== 'string' || !element.evidence.trim() || element.evidence.length > 300
        || !ELEMENT_PART_GROUPS.includes(element.partGroup)
        || !ELEMENT_RELATIONSHIPS.includes(element.relationship)
        || !['full', 'partial'].includes(element.visibility)) {
        throw providerError('main_model_malformed_response', `${prefix} is invalid.`);
      }
      assertNullableLocalId(element.ownerCharacterLocalId, `${prefix}.ownerCharacterLocalId`);
      if (element.ownerCharacterLocalId !== null && !instanceById.has(element.ownerCharacterLocalId)) {
        throw providerError('main_model_malformed_response', `${prefix}.ownerCharacterLocalId does not reference a character instance.`);
      }
      if (element.partGroup !== 'other' && element.ownerCharacterLocalId === null) {
        throw providerError('main_model_malformed_response', `${prefix} must identify the character that owns this covered part.`);
      }
      if (element.partGroup === 'other' && element.action === 'apply_reference') {
        throw providerError('main_model_malformed_response', `${prefix} cannot apply reference color to an unclassified part.`);
      }
      if (element.action === 'apply_reference'
        && (element.referenceMatch !== 'matched' || element.confidence < 0.60)) {
        throw providerError('main_model_malformed_response', `${prefix} lacks the confidence required to apply reference color.`);
      }
      const owner = element.ownerCharacterLocalId === null ? null : instanceById.get(element.ownerCharacterLocalId);
      if (element.action === 'apply_reference'
        && (!owner || owner.action !== 'apply_reference'
          || !['exact_reference', 'strong_lookalike'].includes(owner.identityClass))) {
        throw providerError('main_model_malformed_response', `${prefix} cannot apply reference color without an accepted character owner.`);
      }
      if (element.action === 'confirm' && element.referenceMatch !== 'uncertain') {
        throw providerError('main_model_malformed_response', `${prefix} must mark a confirmation element as uncertain.`);
      }
      if (element.action === 'preserve' && element.referenceMatch === 'matched') {
        throw providerError('main_model_malformed_response', `${prefix} cannot preserve an element declared as matched.`);
      }
      assertCoverageElementRelationship(element, prefix);
    });
    const acceptedInstances = [];
    const incompleteAcceptedInstanceLocalIds = [];
    panel.characterInstances.forEach((instance, instanceIndex) => {
      const prefix = `panels[${panelIndex}].characterInstances[${instanceIndex}]`;
      assertBbox(instance.bbox, `${prefix}.bbox`);
      assertPolygons(instance.maskPolygons, `${prefix}.maskPolygons`);
      assertShortString(instance.evidence, `${prefix}.evidence`, 300);
      if (!IDENTITY_CLASSES.includes(instance.identityClass)
        || typeof instance.identityConfidence !== 'number' || !Number.isFinite(instance.identityConfidence)
        || instance.identityConfidence < 0 || instance.identityConfidence > 1
        || !Array.isArray(instance.identityCues) || !instance.identityCues.length
        || instance.identityCues.length > IDENTITY_CUES.length
        || new Set(instance.identityCues).size !== instance.identityCues.length
        || instance.identityCues.some((cue) => !IDENTITY_CUES.includes(cue))
        || !INSTANCE_ACTIONS.includes(instance.action)
        || !Array.isArray(instance.coverageChecklist)
        || instance.coverageChecklist.length !== STORYBOARD_COVERAGE_PART_GROUPS.length) {
        throw providerError('main_model_malformed_response', `${prefix} is invalid.`);
      }
      const isExact = instance.identityClass === 'exact_reference';
      const isStrongLookalike = instance.identityClass === 'strong_lookalike';
      const isAccepted = isExact || isStrongLookalike;
      if (isExact && (instance.action !== 'apply_reference' || instance.identityConfidence < 0.75)) {
        throw providerError('main_model_malformed_response', `${prefix} exact-reference match must apply at confidence 0.75 or higher.`);
      }
      if (isStrongLookalike) {
        const distinctiveCueCount = instance.identityCues.filter((cue) => DISTINCTIVE_LOOKALIKE_CUES.has(cue)).length;
        if (instance.action !== 'apply_reference' || instance.identityConfidence < 0.70
          || instance.identityCues.length < 2 || distinctiveCueCount < 1) {
          throw providerError('main_model_malformed_response', `${prefix} strong lookalike needs confidence 0.70, two cues, and one distinctive design cue.`);
        }
      }
      if (['generic_similarity', 'different'].includes(instance.identityClass) && instance.action !== 'preserve') {
        throw providerError('main_model_malformed_response', `${prefix} generic or different characters must be preserved.`);
      }
      if (instance.identityClass === 'uncertain' && instance.action !== 'confirm') {
        throw providerError('main_model_malformed_response', `${prefix} uncertain identity must be confirmed before coloring.`);
      }
      if (isAccepted) acceptedInstances.push(instance);
      else if (instance.action === 'confirm') analysisNeedsConfirmation = true;

      const listedElementIds = new Set();
      let incomplete = false;
      instance.coverageChecklist.forEach((entry, checklistIndex) => {
        const checklistPrefix = `${prefix}.coverageChecklist[${checklistIndex}]`;
        if (entry?.partGroup !== STORYBOARD_COVERAGE_PART_GROUPS[checklistIndex]
          || !COVERAGE_STATUSES.includes(entry?.status)
          || typeof entry?.evidence !== 'string' || !entry.evidence.trim() || entry.evidence.length > 300
          || !Array.isArray(entry.elementLocalIds) || entry.elementLocalIds.length > 24
          || new Set(entry.elementLocalIds).size !== entry.elementLocalIds.length) {
          throw providerError('main_model_malformed_response', `${checklistPrefix} is invalid or out of canonical order.`);
        }
        if (entry.status === 'masked' && !entry.elementLocalIds.length) {
          throw providerError('main_model_malformed_response', `${checklistPrefix} must reference every mask used for this visible part.`);
        }
        if (entry.status !== 'masked' && entry.elementLocalIds.length) {
          throw providerError('main_model_malformed_response', `${checklistPrefix} cannot reference masks unless the status is masked.`);
        }
        if (entry.status === 'uncertain') incomplete = true;
        entry.elementLocalIds.forEach((elementLocalId) => {
          if (listedElementIds.has(elementLocalId)) {
            throw providerError('main_model_malformed_response', `${checklistPrefix} repeats an element already used by this character.`);
          }
          listedElementIds.add(elementLocalId);
          const element = elementById.get(elementLocalId);
          if (!element || element.ownerCharacterLocalId !== instance.localId || element.partGroup !== entry.partGroup) {
            throw providerError('main_model_malformed_response', `${checklistPrefix} references an element owned by another character or part group.`);
          }
          if (entry.status === 'masked' && element.action !== 'apply_reference') {
            throw providerError('main_model_malformed_response', `${checklistPrefix} masked elements must apply reference color.`);
          }
        });
      });
      const ownedPlannedElements = panel.elements.filter((element) =>
        element.ownerCharacterLocalId === instance.localId && element.action === 'apply_reference');
      if (ownedPlannedElements.some((element) => !listedElementIds.has(element.localId))) {
        throw providerError('main_model_malformed_response', `${prefix}.coverageChecklist omits a planned character element.`);
      }
      const checklistByPartGroup = new Map(
        instance.coverageChecklist.map((entry) => [entry.partGroup, entry])
      );
      const ownedCoverageElements = panel.elements.filter((element) =>
        element.ownerCharacterLocalId === instance.localId && element.partGroup !== 'other');
      for (const element of ownedCoverageElements) {
        const expectedStatus = element.action === 'apply_reference' ? 'masked'
          : element.action === 'confirm' ? 'uncertain' : 'preserve';
        if (checklistByPartGroup.get(element.partGroup)?.status !== expectedStatus) {
          throw providerError(
            'main_model_malformed_response',
            `${prefix}.coverageChecklist conflicts with ${element.localId}'s planned action.`
          );
        }
      }
      if (isAccepted && incomplete) {
        incompleteAcceptedInstanceLocalIds.push(instance.localId);
        analysisNeedsConfirmation = true;
      }
    });
    panel.protectedRegions.forEach((region, regionIndex) => {
      const prefix = `panels[${panelIndex}].protectedRegions[${regionIndex}]`;
      assertShortString(region?.localId, `${prefix}.localId`, 80);
      assertBbox(region.bbox, `${prefix}.bbox`);
      assertPolygons(region.maskPolygons, `${prefix}.maskPolygons`);
      if (!['speech_bubble', 'text', 'panel_border', 'unmatched_character', 'background_detail', 'other'].includes(region.kind)) {
        throw providerError('main_model_malformed_response', `${prefix}.kind is invalid.`);
      }
      assertNullableLocalId(region.ownerCharacterLocalId, `${prefix}.ownerCharacterLocalId`);
      if (region.ownerCharacterLocalId !== null && !instanceById.has(region.ownerCharacterLocalId)) {
        throw providerError('main_model_malformed_response', `${prefix}.ownerCharacterLocalId does not reference a character instance.`);
      }
      if (region.kind === 'unmatched_character' && region.ownerCharacterLocalId === null) {
        throw providerError('main_model_malformed_response', `${prefix} must identify its unmatched character owner.`);
      }
      if (region.kind === 'unmatched_character' && region.ownerCharacterLocalId !== null
        && acceptedInstances.some((instance) => instance.localId === region.ownerCharacterLocalId)) {
        throw providerError('main_model_malformed_response', `${prefix} conflicts with an accepted character instance.`);
      }
    });
    const audit = panel.coverageAudit;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)
      || !Number.isInteger(audit.acceptedInstanceCount)
      || !Number.isInteger(audit.completeAcceptedInstanceCount)
      || !Array.isArray(audit.incompleteAcceptedInstanceLocalIds)
      || new Set(audit.incompleteAcceptedInstanceLocalIds).size !== audit.incompleteAcceptedInstanceLocalIds.length
      || typeof audit.notes !== 'string' || audit.notes.length > 300) {
      throw providerError('main_model_malformed_response', `panels[${panelIndex}].coverageAudit is invalid.`);
    }
    const expectedIncompleteIds = incompleteAcceptedInstanceLocalIds;
    if (audit.acceptedInstanceCount !== acceptedInstances.length
      || audit.completeAcceptedInstanceCount !== acceptedInstances.length - expectedIncompleteIds.length
      || audit.incompleteAcceptedInstanceLocalIds.length !== expectedIncompleteIds.length
      || audit.incompleteAcceptedInstanceLocalIds.some((id, index) => id !== expectedIncompleteIds[index])) {
      throw providerError('main_model_malformed_response', `panels[${panelIndex}].coverageAudit does not match the accepted instances and checklists.`);
    }
    panel.risks.forEach((risk, riskIndex) => {
      if (typeof risk !== 'string' || risk.length > 200) {
        throw providerError('main_model_malformed_response', `panels[${panelIndex}].risks[${riskIndex}] is invalid.`);
      }
    });
  });
  if (analysisNeedsConfirmation && value.requiresConfirmation !== true) {
    throw providerError('main_model_malformed_response', 'requiresConfirmation must be true while any identity or coverage item needs confirmation.');
  }
  return value;
}

function outputText(payload) {
  if (!Array.isArray(payload?.output)) return '';
  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

async function readLimitedResponseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_ERROR_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw providerError('main_model_response_too_large', 'The Studio main-model response exceeded the safe size limit.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readResponsesEventStream(response, signal) {
  if (!response.body || !String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
    throw providerError('main_model_malformed_response', 'The Studio main-model relay did not return a Responses event stream.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let buffer = '';
  let dataLines = [];
  let deltaText = '';
  let doneText = '';
  let completedResponse = null;

  const dispatch = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch {
      throw providerError('main_model_malformed_response', 'The Studio main-model relay returned an invalid stream event.');
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltaText += event.delta;
    } else if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
      doneText = event.text;
    } else if (event?.type === 'response.completed' && event.response && typeof event.response === 'object') {
      completedResponse = event.response;
    } else if (event?.type === 'response.failed' || event?.type === 'error') {
      throw providerError('main_model_unavailable', 'The Studio main-model relay failed while processing the analysis.');
    }
  };

  const consumeLines = (flush = false) => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) dispatch();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (flush) {
      if (buffer) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      buffer = '';
      dispatch();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_STREAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw providerError('main_model_response_too_large', 'The Studio main-model response exceeded the safe size limit.');
      }
      buffer += decoder.decode(value, { stream: true });
      consumeLines();
    }
    buffer += decoder.decode();
    consumeLines(true);
  } catch (error) {
    // DOMException uses numeric legacy codes (TimeoutError is 23). Those are
    // transport details, not Studio error contracts, so normalize them before
    // persisting or returning the failure. Only our own named provider errors
    // are safe to pass through unchanged.
    if (typeof error?.code === 'string' && error.code.startsWith('main_model_')) throw error;
    const timeoutLike = signal?.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw providerError(timeoutLike ? 'main_model_timeout' : 'main_model_stream_interrupted',
      timeoutLike
        ? 'The Studio main-model analysis timed out.'
        : 'The Studio main-model response stream was interrupted before completion.');
  }

  if (!completedResponse || completedResponse.status !== 'completed') {
    throw providerError('main_model_stream_interrupted', 'The Studio main-model response stream ended before completion.');
  }
  return {
    payload: completedResponse,
    text: outputText(completedResponse) || doneText || deltaText
  };
}

function imageDataUrl(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw providerError('main_model_input_invalid', 'The Studio main model only accepts stored PNG, JPEG, or WebP inputs.');
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function analysisPrompt(mode, modificationNote = '') {
  const fidelity = mode === 'single'
    ? 'Perform a careful, high-quality identity and composition analysis for an interactive generation request.'
    : 'Perform a cost-efficient first-pass analysis suitable for a batch review queue.';
  return `${fidelity}\n
You are the selective reference-color planning Agent for a professional comic studio. The first image is the complete storyboard input. The second image is the only approved character/reference image for this task.\n
Set top-level matchPolicy exactly to exact_and_strong_lookalikes. Treat the reference as an approved character-design and palette guide, not as a one-person quota. Inventory every visible person in characterInstances before planning any element masks. Classify each person as exact_reference, strong_lookalike, generic_similarity, different, or uncertain. An exact_reference needs identityConfidence at least 0.75 and action apply_reference. A strong_lookalike needs identityConfidence at least 0.70, at least two identityCues, and at least one distinctive cue from hair_design, hair_accessory, costume_construction, or carried_prop; it also uses action apply_reference. Multiple people in one panel may legitimately be exact or strong matches and must all be colored. A generic school uniform, face shape, body proportion, or proximity alone is generic_similarity and must be preserved. Use confirm for uncertain identity and preserve for generic_similarity or different.\n
For each characterInstance output localId, bbox, identityClass, identityConfidence, identityCues, action, evidence, silhouette maskPolygons, and coverageChecklist. identityCues may only be hair_design, hair_accessory, face_proportions, costume_construction, body_proportions, carried_prop, and repeated_context. Trace each silhouette closely around the complete visible person, including separated hair, forearms, hands, shoes, bag body, handle, and strap. Studio uses this silhouette only as a permission envelope: the explicit owned element masks are semantic anchors, while reliable provider-only colour evidence may fill small omitted or disconnected parts inside that envelope. It never authorizes changes outside an accepted instance.\n
The coverageChecklist must contain exactly these ten partGroup rows in this exact order: hair; face_neck_skin; arms_hands_skin; legs_skin; garment_top_sleeves; garment_collar_neckwear; garment_bottom; socks_shoes; hair_accessories; carried_bag. Every row must have status masked, preserve, uncertain, or not_visible; concise evidence; and elementLocalIds. Use masked with one or more element IDs for every visible reference-backed part. Every non-masked status must use an empty elementLocalIds array. Use preserve when visible but the reference does not support its palette. Use uncertain only for genuine ambiguity and set requiresConfirmation. Use not_visible only when the part truly cannot be seen. Do not omit small or disconnected hands, forearms, shoes, handles, straps, or bag bodies. Partial visibility is still visible.\n
Each element must retain localId, kind, bbox, referenceMatch, confidence, evidence, action, renderOrder and maskPolygons, and must also declare ownerCharacterLocalId, partGroup, relationship, and visibility. partGroup is one checklist group or other. relationship is body_part, worn_by, held_by, carried_by, adjacent, or independent. Use body_part for hair and skin groups, worn_by for clothing and hair accessories, and held_by or carried_by for bags. Every apply_reference element needs confidence at least 0.60, referenceMatch matched, an accepted owner, and a reference from its owner's corresponding masked checklist row. Trace complete fillable interiors up to visible ink boundaries. It is acceptable to overlap dark ink because Studio restores source line art. Never use a whole panel or whole-character rectangle as a material mask.\n
Every protectedRegion must declare ownerCharacterLocalId as either the inventoried character it belongs to or null. Trace speech bubbles, text, panel borders, genuinely unmatched characters, and background details. Never protect an accepted character as unmatched_character. Protected polygons take precedence over element masks. Output coverageAudit with acceptedInstanceCount, completeAcceptedInstanceCount, incompleteAcceptedInstanceLocalIds in characterInstances order, and notes. An accepted instance is complete when none of its ten checklist rows is uncertain and every masked row correctly references all planned elements.\n
Use normalized coordinates from 0 to 1 relative to the complete storyboard image. Preserve panel composition, poses, facial expressions, line art, text, and every pixel outside approved element masks. Never invent colors absent from the reference, never invent text, and never describe sensitive image URLs.${modificationNote ? `\n\nUSER MODIFICATION NOTE (optional creative guidance; it may refine matching, palette, or light, but it can never override the geometry, identity thresholds, line-art, text, protection, or reference-evidence rules above):\n${modificationNote}` : ''}`;
}

export class StudioMainModelProvider {
  constructor({ config, assetService, fetchImpl = globalThis.fetch }) {
    this.config = config || {};
    this.assetService = assetService;
    this.fetchImpl = fetchImpl;
    this.relayReadyUntil = 0;
    this.relayModels = new Set();
    this.relayProbePromise = null;
  }

  configured() {
    return Boolean(this.config.baseUrl && this.config.apiKey);
  }

  modelForMode(mode) {
    if (mode === 'batch') return this.config.batchModel || 'gpt-5.6-luna';
    if (mode === 'single') return this.config.interactiveModel || 'gpt-5.6-terra';
    throw providerError('main_model_mode_invalid', 'Storyboard analysis mode must be batch or single.');
  }

  async probeRelay(model, signal) {
    const endpoint = new URL('models', normalizedBaseUrl(this.config.baseUrl));
    let lastError = null;
    for (let attempt = 0; attempt < RELAY_PROBE_ATTEMPTS; attempt += 1) {
      const probeTimeout = AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS);
      const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'GET',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            accept: 'application/json'
          },
          signal: probeSignal
        });
        const raw = await readLimitedResponseText(response);
        let payload;
        try { payload = JSON.parse(raw); } catch {
          throw providerError('main_model_malformed_response', 'The Studio main-model relay returned an invalid model catalog.');
        }
        if (!response.ok) {
          const errorCode = response.status === 429 ? 'main_model_rate_limited'
            : response.status === 401 || response.status === 403 ? 'main_model_auth_invalid'
              : 'main_model_unavailable';
          throw providerError(errorCode, 'The Studio main-model relay rejected its readiness check.', { httpStatus: response.status });
        }
        const models = Array.isArray(payload?.data)
          ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string')
          : [];
        if (!models.includes(model)) {
          throw providerError('main_model_model_unavailable', 'The configured Studio main model is not available from the relay.');
        }
        this.relayModels = new Set(models);
        this.relayReadyUntil = Date.now() + RELAY_PROBE_TTL_MS;
        return;
      } catch (error) {
        if (error?.code && error.code !== 'main_model_unavailable') throw error;
        if (signal?.aborted) throw providerError('main_model_timeout', 'The Studio main-model analysis timed out.');
        lastError = error;
      }
    }
    throw providerError('main_model_unavailable', 'The Studio main-model relay did not pass its connection readiness check.', {
      attempts: RELAY_PROBE_ATTEMPTS,
      lastErrorCode: lastError?.cause?.code || lastError?.code || null
    });
  }

  async ensureRelayReady(model, signal) {
    if (Date.now() < this.relayReadyUntil && this.relayModels.has(model)) return;
    if (!this.relayProbePromise) {
      this.relayProbePromise = this.probeRelay(model, signal).finally(() => { this.relayProbePromise = null; });
    }
    await this.relayProbePromise;
    if (!this.relayModels.has(model)) {
      throw providerError('main_model_model_unavailable', 'The configured Studio main model is not available from the relay.');
    }
  }

  async analyzeStoryboard({ mode, storyboardAsset, referenceAsset, modificationNote = '', idempotencyKey, signal }) {
    if (!this.config.enabled) throw providerError('main_model_disabled', 'The Studio main-model Agent is disabled.');
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw providerError('main_model_not_configured', 'The Studio main-model Agent is not configured.');
    }
    if (!storyboardAsset || !referenceAsset) {
      throw providerError('main_model_input_invalid', 'Storyboard and character-reference assets are required.');
    }
    const [storyboardBuffer, referenceBuffer] = await Promise.all([
      this.assetService.read(storyboardAsset.blob_path),
      this.assetService.read(referenceAsset.blob_path)
    ]);
    if (sha256(storyboardBuffer) !== storyboardAsset.sha256 || sha256(referenceBuffer) !== referenceAsset.sha256) {
      throw providerError('asset_integrity_mismatch', 'A main-model input failed its stored integrity check.');
    }
    const model = this.modelForMode(mode);
    const endpoint = new URL('responses', normalizedBaseUrl(this.config.baseUrl));
    const timeout = AbortSignal.timeout(this.config.timeoutMs || 300_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await this.ensureRelayReady(model, combinedSignal);
    const requestBody = JSON.stringify({
      model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: analysisPrompt(mode, modificationNote) },
          { type: 'input_text', text: 'STORYBOARD INPUT:' },
          { type: 'input_image', image_url: imageDataUrl(storyboardBuffer, storyboardAsset.mime_type), detail: mode === 'single' ? 'high' : 'low' },
          { type: 'input_text', text: 'CHARACTER REFERENCE:' },
          { type: 'input_image', image_url: imageDataUrl(referenceBuffer, referenceAsset.mime_type), detail: mode === 'single' ? 'high' : 'low' }
        ]
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'storyboard_character_binding',
          strict: true,
          schema: STORYBOARD_ANALYSIS_JSON_SCHEMA
        }
      },
      reasoning: { effort: mode === 'single' ? 'medium' : 'low' },
      max_output_tokens: this.config.maxOutputTokens || 8_000,
      stream: true
    });
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
          },
          body: requestBody,
          signal: combinedSignal
        });
        break;
      } catch (error) {
        const timeoutLike = combinedSignal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError';
        const preconnectCode = error?.cause?.code || error?.code;
        if (!timeoutLike && attempt === 0 && SAFE_PRECONNECT_RETRY_CODES.has(preconnectCode)) {
          this.relayReadyUntil = 0;
          await this.ensureRelayReady(model, combinedSignal);
          continue;
        }
        throw providerError(timeoutLike ? 'main_model_timeout' : 'main_model_unavailable',
          timeoutLike ? 'The Studio main-model analysis timed out.' : 'The Studio main-model relay is unavailable.');
      }
    }
    if (!response.ok) {
      await readLimitedResponseText(response).catch((error) => {
        if (error?.code === 'main_model_response_too_large') throw error;
      });
      const errorCode = response.status === 429 ? 'main_model_rate_limited'
        : response.status === 401 || response.status === 403 ? 'main_model_auth_invalid'
          : 'main_model_unavailable';
      throw providerError(errorCode, 'The Studio main-model relay rejected the analysis request.', { httpStatus: response.status });
    }
    const { payload, text } = await readResponsesEventStream(response, combinedSignal);
    let result;
    try { result = JSON.parse(text); } catch {
      throw providerError('main_model_malformed_response', 'The Studio main model did not return the required structured analysis.');
    }
    const responseId = typeof payload.id === 'string' ? payload.id : null;
    const usage = {
      inputTokens: Number(payload.usage?.input_tokens || 0),
      outputTokens: Number(payload.usage?.output_tokens || 0),
      totalTokens: Number(payload.usage?.total_tokens || 0)
    };
    try {
      return {
        result: validateStoryboardAnalysis(canonicalizeCoverageChecklistReferences(result)),
        model,
        responseId,
        usage
      };
    } catch (error) {
      // Preserve value-free provider identity and token accounting even when
      // Studio rejects the structured result. The raw response is never stored.
      error.providerResponseId = responseId;
      error.usage = usage;
      throw error;
    }
  }
}
