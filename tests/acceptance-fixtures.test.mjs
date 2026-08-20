import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../samples/p0-acceptance-manifest.template.json', import.meta.url);
const scorecardUrl = new URL('../samples/reviewer-scorecard.template.json', import.meta.url);

const expectedIds = [
  'P0-A01', 'P0-A02', 'P0-A03', 'P0-A04',
  'P0-B01', 'P0-B02', 'P0-B03', 'P0-B04',
  'P0-C01', 'P0-C02', 'P0-C03', 'P0-C04'
];

function aspectClass({ width, height }) {
  const ratio = width / height;
  if (ratio < 0.9) return 'portrait';
  if (ratio > 1.1) return 'landscape';
  return 'square';
}

test('the P0 manifest template fixes exactly 12 balanced, rights-cleared samples', async () => {
  const raw = await fs.readFile(manifestUrl, 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schema_version, 'p0.sample-manifest.v1');
  assert.deepEqual(manifest.pipeline_policy.stages, ['ink', 'color', 'light']);
  assert.equal(manifest.pipeline_policy.max_attempts_per_stage, 2);
  assert.equal(manifest.acceptance_policy.reviewers_required, 2);
  assert.equal(manifest.acceptance_policy.minimum_passed_total, 9);
  assert.equal(manifest.acceptance_policy.minimum_passed_per_group, 3);
  assert.equal(manifest.acceptance_policy.maximum_active_edit_seconds_per_passed_panel, 600);
  assert.equal(manifest.acceptance_policy.maximum_system_active_seconds_per_panel, 2700);
  assert.equal(manifest.acceptance_policy.accepted_panel_credit_median_maximum, 160);
  assert.equal(manifest.acceptance_policy.accepted_panel_credit_p95_maximum, 240);

  assert.equal(manifest.samples.length, 12);
  assert.deepEqual(manifest.samples.map((sample) => sample.sample_id), expectedIds);
  assert.equal(new Set(manifest.samples.map((sample) => sample.sample_id)).size, 12);
  assert.equal(new Set(manifest.samples.map((sample) => sample.source.sha256)).size, 12);
  assert.deepEqual(
    Object.fromEntries(['A', 'B', 'C'].map((group) => [group, manifest.samples.filter((sample) => sample.group === group).length])),
    { A: 4, B: 4, C: 4 }
  );

  for (const sample of manifest.samples) {
    assert.match(sample.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sample.source.mime_type, 'image/png');
    assert.equal(sample.source.color_space, 'sRGB');
    assert.equal(sample.source.orientation, 1);
    assert.ok(Number.isInteger(sample.source.width) && sample.source.width > 0);
    assert.ok(Number.isInteger(sample.source.height) && sample.source.height > 0);
    assert.equal(sample.rights.test_use_allowed, true);
    assert.equal(sample.rights.commercial_processing_allowed, true);
    assert.ok(sample.brief.preserve.includes('character_identity'));
    assert.ok(sample.brief.preserve.includes('composition'));
    assert.ok(sample.brief.preserve.includes('person_count'));
    assert.ok(sample.brief.required_elements.length > 0);
    assert.ok(sample.content.person_count >= 1 && sample.content.person_count <= 3);
  }

  for (const sample of manifest.samples.filter((entry) => entry.group === 'A')) {
    assert.equal(sample.content.person_count, 1);
    assert.equal(sample.content.draft_cleanliness, 'clean');
    assert.ok(['none', 'low'].includes(sample.content.background_complexity));
  }
  for (const sample of manifest.samples.filter((entry) => entry.group === 'B')) {
    assert.equal(sample.content.person_count, 2);
    assert.equal(sample.content.draft_cleanliness, 'rough');
    assert.equal(sample.content.has_occlusion, true);
  }
  for (const sample of manifest.samples.filter((entry) => entry.group === 'C')) {
    assert.equal(sample.content.has_occlusion, true);
    assert.equal(sample.content.background_complexity, 'complex');
    assert.ok(sample.content.key_prop_count >= 1);
  }

  const aspects = new Set(manifest.samples.map((sample) => aspectClass(sample.source)));
  assert.deepEqual(aspects, new Set(['portrait', 'landscape', 'square']));
  assert.doesNotMatch(raw, /api[_ -]?key|authorization|bearer\s+|x-api-token|password|secret/i);
});

test('the reviewer fixture encodes two blind reviewers and the agreed hard gates', async () => {
  const scorecard = JSON.parse(await fs.readFile(scorecardUrl, 'utf8'));
  assert.equal(scorecard.schema_version, 'p0.reviewer-scorecard.v1');
  assert.equal(scorecard.reviewers_required, 2);
  assert.deepEqual(scorecard.stages.map((stage) => stage.stage), ['ink', 'color', 'light']);
  for (const stage of scorecard.stages) assert.equal(stage.criteria.length, 5);
  assert.equal(scorecard.stage_gate.minimum_total_score, 18);
  assert.equal(scorecard.stage_gate.minimum_each_criterion, 3);
  assert.equal(scorecard.stage_gate.fatal_flags_allowed, 0);
  assert.equal(scorecard.stage_gate.can_proceed_must_be_true, true);
  assert.equal(scorecard.panel_gate.both_reviewers_must_pass_all_stages, true);
  assert.equal(scorecard.panel_gate.maximum_active_edit_seconds, 600);
  assert.equal(scorecard.panel_gate.maximum_attempts_per_stage, 2);
  assert.ok(scorecard.blind_fields.includes('other_reviewer_scores'));
  assert.ok(scorecard.fatal_flags.includes('stage_geometry_misaligned'));
});
