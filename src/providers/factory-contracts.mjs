const freezeProfile = (profile) => Object.freeze({
  ...profile,
  inputFields: Object.freeze(profile.inputFields.map((item) => Object.freeze({ ...item }))),
  mcpPrimaryUrlKeys: Object.freeze([...(profile.mcpPrimaryUrlKeys || [])]),
  mcpPrimaryArrayKeys: Object.freeze([...(profile.mcpPrimaryArrayKeys || [])])
});

export const FACTORY_CLASSIC_TOOL_CONTRACTS = Object.freeze({
  line_art_beautify_v4: freezeProfile({
    stage: 'ink',
    taskType: 5,
    taskVersion: 'v4',
    directTaskPath: '/api/lineart-beautify/v4/task/',
    inputFields: [{ role: 'source', metaKey: 'inputImageUrl' }],
    historyOutputKind: 'url',
    historyOutputKey: 'outputImageUrl',
    mcpPrimaryUrlKeys: ['outputImageUrl', 'OutputImageUrl'],
    mcpPrimaryArrayKeys: [],
    evidenceLabel: 'lineart-v4'
  }),
  coloring_v4: freezeProfile({
    stage: 'color',
    taskType: 2,
    taskVersion: 'v4',
    directTaskPath: '/api/coloring/v4/task/',
    inputFields: [{ role: 'ink', metaKey: 'inputImageUrl' }],
    historyOutputKind: 'url',
    historyOutputKey: 'compositedImageUrl',
    mcpPrimaryUrlKeys: ['compositedImageUrl', 'OutputImageUrl'],
    mcpPrimaryArrayKeys: ['OutputImageUrls'],
    evidenceLabel: 'coloring-v4'
  }),
  shadowing_v7: freezeProfile({
    stage: 'light',
    taskType: 3,
    taskVersion: 'v7',
    directTaskPath: '/api/shadow/v7/task/',
    inputFields: [
      { role: 'color', metaKey: 'colorImageUrl' },
      { role: 'ink', metaKey: 'lineArtImageUrl' }
    ],
    // Shadow v7's direct endpoint exposes layer assets. The task-history detail
    // additionally exposes the single composited preview that Factory itself
    // presents to users; Studio must ingest that preview rather than guessing a
    // blend algorithm or mistaking an overlay/layer for the finished result.
    historyOutputKind: 'single-item-array',
    historyOutputKey: 'outputPreviewImageUrls',
    mcpPrimaryUrlKeys: ['OutputImageUrl'],
    mcpPrimaryArrayKeys: ['outputPreviewImageUrls', 'OutputImageUrls'],
    evidenceLabel: 'shadow-v7-preview'
  })
});

export function factoryClassicContract(toolName, stage = null) {
  const profile = FACTORY_CLASSIC_TOOL_CONTRACTS[toolName] || null;
  if (!profile || (stage && profile.stage !== stage)) return null;
  return profile;
}

