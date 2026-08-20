export const STAGES = Object.freeze(['source', 'ink', 'color', 'light']);
export const GENERATABLE_STAGES = Object.freeze(['ink', 'color', 'light']);

export const STAGE_LABELS = Object.freeze({
  source: '原始草稿',
  ink: '勾线',
  color: '底色',
  light: '光影'
});

export const CURRENT_COLUMN = Object.freeze({
  source: 'current_source_version_id',
  ink: 'current_ink_version_id',
  color: 'current_color_version_id',
  light: 'current_light_version_id'
});

export function assertStage(stage, { generatableOnly = false } = {}) {
  const values = generatableOnly ? GENERATABLE_STAGES : STAGES;
  if (!values.includes(stage)) {
    const error = new Error(`Unsupported stage: ${stage}`);
    error.code = 'invalid_stage';
    error.statusCode = 422;
    throw error;
  }
  return stage;
}

export function downstreamStages(stage) {
  if (stage === 'source') return ['ink', 'color', 'light'];
  if (stage === 'ink') return ['color', 'light'];
  if (stage === 'color') return ['light'];
  return [];
}

export function requiredInputStages(stage) {
  if (stage === 'ink') return ['source'];
  if (stage === 'color') return ['ink'];
  if (stage === 'light') return ['color', 'ink'];
  return [];
}

export function toolForStage(stage) {
  if (stage === 'ink') return 'line_art_beautify_v4';
  if (stage === 'color') return 'coloring_v4';
  if (stage === 'light') return 'shadowing_v7';
  throw new Error(`No provider tool for stage: ${stage}`);
}

export function defaultStageParameters(stage) {
  if (stage === 'ink') return { strength: 0.5, style: 'none', thickness: 0.5, facialSeparation: false };
  if (stage === 'color') return {};
  if (stage === 'light') {
    return { style: 'nvpin', color: 'nvpin_rule', light: 'top_left', shadow_strength: 0.5 };
  }
  return {};
}
