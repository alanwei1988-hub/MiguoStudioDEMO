import { measureSelectiveStoryboardMask } from './storyboard-composite.mjs';

const TARGET_STRATEGY = 'storyboard-reference-instance-composite-v2';
const MATCH_POLICY_REVISION = 'exact-strong-lookalike-v1';
const REQUIRED_PART_GROUPS = Object.freeze([
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
const NON_GENERIC_IDENTITY_CUES = new Set([
  'hair_design',
  'hair_accessory',
  'costume_construction',
  'carried_prop'
]);

function planError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function incompleteInstance(instanceLocalId, detail) {
  throw planError(
    'storyboard_analysis_incomplete_instance',
    `Matched character instance ${instanceLocalId} is incomplete: ${detail}`
  );
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function pixelPolygon(points, width, height) {
  return points.map((point) => ({
    x: Math.max(0, Math.min(width - 1, Math.round(point.x * width))),
    y: Math.max(0, Math.min(height - 1, Math.round(point.y * height)))
  }));
}

function frozenPolygons(polygons, width, height, label) {
  if (!Array.isArray(polygons) || !polygons.length) {
    throw planError('storyboard_analysis_mask_invalid', `${label} has no usable mask polygons.`);
  }
  return polygons.map((points, polygonIndex) => {
    if (!Array.isArray(points) || points.length < 3 || polygonArea(points) < 0.00001) {
      throw planError('storyboard_analysis_mask_invalid', `${label} polygon ${polygonIndex + 1} is too small or invalid.`);
    }
    return {
      normalized: points.map(({ x, y }) => ({ x, y })),
      pixels: pixelPolygon(points, width, height)
    };
  });
}

function acceptedReferenceInstance(instance) {
  if (instance?.action !== 'apply_reference') return false;
  if (instance.identityClass === 'exact_reference') return instance.identityConfidence >= 0.75;
  if (instance.identityClass !== 'strong_lookalike' || instance.identityConfidence < 0.70) return false;
  const cues = new Set(instance.identityCues || []);
  return cues.size >= 2 && [...cues].some((cue) => NON_GENERIC_IDENTITY_CUES.has(cue));
}

function assertCompleteCoverageChecklist(instance, ownedElements) {
  const checklist = Array.isArray(instance.coverageChecklist) ? instance.coverageChecklist : [];
  const byPartGroup = new Map();
  for (const entry of checklist) {
    if (byPartGroup.has(entry?.partGroup)) {
      incompleteInstance(instance.localId, `coverage group ${entry?.partGroup || '(missing)'} is duplicated.`);
    }
    byPartGroup.set(entry?.partGroup, entry);
  }
  if (checklist.length !== REQUIRED_PART_GROUPS.length
    || REQUIRED_PART_GROUPS.some((partGroup) => !byPartGroup.has(partGroup))) {
    incompleteInstance(instance.localId, 'the fixed ten-part coverage checklist is missing one or more groups.');
  }

  const elementsById = new Map(ownedElements.map((element) => [element.localId, element]));
  for (const partGroup of REQUIRED_PART_GROUPS) {
    const entry = byPartGroup.get(partGroup);
    if (entry.status === 'uncertain') {
      incompleteInstance(instance.localId, `${partGroup} remains uncertain.`);
    }
    if (entry.status === 'masked') {
      if (!Array.isArray(entry.elementLocalIds) || !entry.elementLocalIds.length) {
        incompleteInstance(instance.localId, `${partGroup} is marked masked without any element references.`);
      }
      for (const elementLocalId of entry.elementLocalIds) {
        const element = elementsById.get(elementLocalId);
        if (!element || element.partGroup !== partGroup
          || element.action !== 'apply_reference' || element.confidence < 0.60) {
          incompleteInstance(
            instance.localId,
            `${partGroup} references an absent, mismatched, non-applicable, or low-confidence element (${elementLocalId}).`
          );
        }
      }
    }
  }

  for (const element of ownedElements) {
    const entry = byPartGroup.get(element.partGroup);
    if (element.action === 'apply_reference' && element.confidence >= 0.60) {
      if (entry?.status !== 'masked' || !entry.elementLocalIds.includes(element.localId)) {
        incompleteInstance(instance.localId, `${element.localId} is not accounted for by its masked coverage group.`);
      }
      continue;
    }
    const deliberatelyPreserved = entry?.status === 'preserve' && element.action === 'preserve';
    if (!deliberatelyPreserved && entry?.status !== 'not_visible') {
      incompleteInstance(instance.localId, `${element.localId} is visible but is not safely applicable or deliberately preserved.`);
    }
  }

  return byPartGroup;
}

function assertCoverageAudit(panel, acceptedInstances) {
  const audit = panel.coverageAudit;
  const acceptedIds = new Set(acceptedInstances.map((instance) => instance.localId));
  if (!audit
    || audit.acceptedInstanceCount !== acceptedInstances.length
    || audit.completeAcceptedInstanceCount !== acceptedInstances.length
    || !Array.isArray(audit.incompleteAcceptedInstanceLocalIds)
    || audit.incompleteAcceptedInstanceLocalIds.length !== 0) {
    incompleteInstance(acceptedInstances[0]?.localId || panel.localId, 'the panel coverage audit is incomplete or inconsistent.');
  }
  const incompleteAcceptedId = audit.incompleteAcceptedInstanceLocalIds.find((localId) => acceptedIds.has(localId));
  if (incompleteAcceptedId) incompleteInstance(incompleteAcceptedId, 'the panel coverage audit marks this instance incomplete.');
}

function matchedInstanceRecord(panel, instance, width, height) {
  return {
    panelLocalId: panel.localId,
    localId: instance.localId,
    bbox: { ...instance.bbox },
    identityClass: instance.identityClass,
    identityConfidence: instance.identityConfidence,
    identityCues: [...instance.identityCues],
    action: instance.action,
    evidence: instance.evidence,
    coverageChecklist: instance.coverageChecklist.map((entry) => ({
      partGroup: entry.partGroup,
      status: entry.status,
      evidence: entry.evidence,
      elementLocalIds: [...entry.elementLocalIds]
    })),
    polygons: frozenPolygons(instance.maskPolygons, width, height, `${panel.localId}/${instance.localId}`)
  };
}

function protectedInstanceRecord(panel, instance, width, height) {
  return {
    panelLocalId: panel.localId,
    localId: instance.localId,
    bbox: { ...instance.bbox },
    ownerCharacterLocalId: instance.localId,
    kind: 'unmatched_character',
    reason: 'unaccepted_character_instance',
    hardProtection: true,
    identityClass: instance.identityClass,
    identityConfidence: instance.identityConfidence,
    polygons: frozenPolygons(instance.maskPolygons, width, height, `${panel.localId}/${instance.localId}`)
  };
}

function matchedElementRecord(panel, element, width, height) {
  return {
    panelLocalId: panel.localId,
    localId: element.localId,
    ownerCharacterLocalId: element.ownerCharacterLocalId,
    kind: element.kind,
    partGroup: element.partGroup,
    relationship: element.relationship,
    visibility: element.visibility,
    confidence: element.confidence,
    evidence: element.evidence,
    renderOrder: element.renderOrder,
    polygons: frozenPolygons(element.maskPolygons, width, height, `${panel.localId}/${element.localId}`)
  };
}

export function selectStoryboardGenerationTarget(result, { width = 1_000, height = 1_000 } = {}) {
  if (result?.schemaVersion !== 'storyboard-analysis-v3'
    || result.matchPolicy !== 'exact_and_strong_lookalikes') {
    throw planError(
      'storyboard_analysis_schema_mismatch',
      'A storyboard-analysis-v3 result using the exact-and-strong-lookalike policy is required.'
    );
  }

  const regions = [];
  const protectedRegions = [];
  const matchedInstances = [];
  const matchedPartKindCounts = {};
  for (const panel of result.panels || []) {
    const instances = panel.characterInstances || [];
    const instanceIds = new Set();
    for (const instance of instances) {
      if (instanceIds.has(instance.localId)) {
        throw planError('storyboard_analysis_instance_conflict', `Character instance ${instance.localId} is duplicated in ${panel.localId}.`);
      }
      instanceIds.add(instance.localId);
    }

    const acceptedInstances = instances.filter(acceptedReferenceInstance);
    const acceptedIds = new Set(acceptedInstances.map((instance) => instance.localId));
    assertCoverageAudit(panel, acceptedInstances);

    for (const protectedRegion of panel.protectedRegions || []) {
      if (protectedRegion.kind === 'unmatched_character'
        && protectedRegion.ownerCharacterLocalId
        && acceptedIds.has(protectedRegion.ownerCharacterLocalId)) {
        throw planError(
          'storyboard_analysis_instance_protection_conflict',
          `Accepted character instance ${protectedRegion.ownerCharacterLocalId} is also marked as an unmatched hard protection.`
        );
      }
    }

    for (const instance of instances) {
      if (!acceptedIds.has(instance.localId)) {
        protectedRegions.push(protectedInstanceRecord(panel, instance, width, height));
        continue;
      }
      const ownedElements = (panel.elements || []).filter(
        (element) => element.ownerCharacterLocalId === instance.localId
      );
      assertCompleteCoverageChecklist(instance, ownedElements);
      matchedInstances.push(matchedInstanceRecord(panel, instance, width, height));
      for (const element of ownedElements) {
        if (element.action !== 'apply_reference' || element.confidence < 0.60) continue;
        regions.push(matchedElementRecord(panel, element, width, height));
        matchedPartKindCounts[element.partGroup] = (matchedPartKindCounts[element.partGroup] || 0) + 1;
      }
    }

    for (const protectedRegion of panel.protectedRegions || []) {
      protectedRegions.push({
        panelLocalId: panel.localId,
        localId: protectedRegion.localId,
        ownerCharacterLocalId: protectedRegion.ownerCharacterLocalId,
        kind: protectedRegion.kind,
        reason: 'explicit_protection',
        hardProtection: true,
        polygons: frozenPolygons(
          protectedRegion.maskPolygons,
          width,
          height,
          `${panel.localId}/${protectedRegion.localId}`
        )
      });
    }
  }

  if (!matchedInstances.length || !regions.length) {
    throw planError(
      'storyboard_analysis_no_character_match',
      'The Agent did not find a complete reference-backed character instance that can be changed safely.'
    );
  }
  matchedInstances.sort((left, right) => left.panelLocalId.localeCompare(right.panelLocalId)
    || left.localId.localeCompare(right.localId));
  regions.sort((left, right) => left.renderOrder - right.renderOrder
    || left.panelLocalId.localeCompare(right.panelLocalId)
    || left.localId.localeCompare(right.localId));
  protectedRegions.sort((left, right) => left.panelLocalId.localeCompare(right.panelLocalId)
    || left.localId.localeCompare(right.localId));
  return {
    strategy: TARGET_STRATEGY,
    matchPolicyRevision: MATCH_POLICY_REVISION,
    sourceWidth: width,
    sourceHeight: height,
    usedOriginalImage: true,
    matchedCharacterInstanceCount: matchedInstances.length,
    matchedElementCount: regions.length,
    matchedPartKindCounts,
    incompleteMatchedInstanceCount: 0,
    matchedRegionCount: regions.length,
    protectedRegionCount: protectedRegions.length,
    matchedInstances,
    regions,
    protectedRegions
  };
}

export class StoryboardPlanService {
  constructor({ db, assetService }) {
    this.db = db;
    this.assetService = assetService;
  }

  async prepare(analysisId) {
    let analysis = this.db.getStoryboardAnalysis(analysisId);
    if (!analysis) throw planError('storyboard_analysis_not_found', 'Storyboard analysis not found.');
    if (analysis.status !== 'succeeded' || analysis.mode !== 'single' || !analysis.result) {
      throw planError('storyboard_analysis_not_ready', 'A completed Terra analysis is required before generation input preparation.');
    }
    // Frozen legacy analyses retain their exact previously stored v1 target. New preparation
    // always flows through the v3 instance selector below and can never create another v1 target.
    if (analysis.generation_source_asset_version_id) return analysis;
    const source = this.db.getAsset(analysis.source_asset_version_id);
    const panel = this.db.getPanel(analysis.panel_id);
    if (!source || !panel || source.stage !== 'source' || source.status !== 'approved') {
      throw planError('storyboard_source_mismatch', 'The analyzed storyboard source is no longer current and approved.');
    }
    const target = selectStoryboardGenerationTarget(analysis.result, { width: source.width, height: source.height });
    const measuredMask = await measureSelectiveStoryboardMask(target, source.width, source.height);
    analysis = this.db.attachStoryboardAnalysisGenerationSource({
      analysisId: analysis.id,
      assetVersionId: source.id,
      target: {
        ...target,
        sourceAssetVersionId: source.id,
        sourceSha256: source.sha256,
        plannedMaskCoverage: measuredMask.coverage,
        plannedMaskCoveredPixels: measuredMask.coveredPixels,
        invariant: 'Pixels outside approved masks must equal the original storyboard.'
      }
    });
    return analysis;
  }
}
