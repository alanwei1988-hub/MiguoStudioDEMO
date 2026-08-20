import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { P0Database } from '../src/db.mjs';
import { addPanelWithSource, createApprovedSyntheticChain, createHarness, queueStage } from './helpers.mjs';

function createReference(harness, { batchId, panelId, source, metadata = { kind: 'character-reference' } }) {
  return harness.db.createStoryboardReference({
    batchId,
    panelId,
    blobPath: source.blob_path,
    sha256: source.sha256,
    mimeType: source.mime_type,
    width: source.width,
    height: source.height,
    byteSize: source.byte_size,
    metadata
  });
}

function storyboardSpec({ panelId, source, reference, key = 'storyboard:idempotency:1', overrides = {} }) {
  return {
    panelId,
    idempotencyKey: key,
    contractFingerprint: 'sha256:storyark-contract-v1',
    projectId: 'project-fixture-1',
    imageSize: '1K',
    expectedResultCount: 2,
    removeBg: false,
    sourceAssetVersionId: source.id,
    referenceAssetId: reference.id,
    request: { routeRevision: 'storyark-route-v1', prompt: { language: 'zh-CN' } },
    ...overrides
  };
}

function outputFrom(source, ordinal, metadata = {}) {
  return {
    ordinal,
    blobPath: source.blob_path,
    sha256: `${source.sha256.slice(0, -2)}${String(ordinal).padStart(2, '0')}`,
    mimeType: source.mime_type,
    width: source.width,
    height: source.height,
    byteSize: source.byte_size,
    metadata
  };
}

test('batch workflow types default safely, filter independently, and include StoryArk references', async (t) => {
  const harness = await createHarness(t);
  const comic = harness.db.createBatch('Comic workflow');
  const referenceWorkflow = harness.db.createBatch('Reference workflow', null, 'reference_creation');
  assert.equal(comic.workflow_type, 'comic_pipeline');
  assert.equal(referenceWorkflow.workflow_type, 'reference_creation');
  assert.deepEqual(
    harness.db.listBatches({ workflowType: 'reference_creation' }).map((batch) => batch.id),
    [referenceWorkflow.id]
  );
  assert.deepEqual(
    harness.db.listBatches({ workflowType: 'comic_pipeline' }).map((batch) => batch.id),
    [comic.id]
  );
  assert.throws(
    () => harness.db.createBatch('Invalid workflow', null, 'storyboard'),
    (error) => error.code === 'invalid_workflow_type' && error.statusCode === 422
  );

  const { panel, source } = await addPanelWithSource(harness, { batchId: referenceWorkflow.id });
  const reference = createReference(harness, {
    batchId: referenceWorkflow.id,
    panelId: panel.id,
    source,
    metadata: { kind: 'persistent-reference' }
  });
  const details = harness.db.getBatchDetails(referenceWorkflow.id);
  assert.equal(details.workflow_type, 'reference_creation');
  assert.equal(details.storyboardReferences.length, 1);
  assert.equal(details.storyboardReferences[0].id, reference.id);
  assert.deepEqual(details.storyboardReferences[0].metadata, { kind: 'persistent-reference' });
});

test('StoryArk records freeze routing, deduplicate exact requests, and enforce one active run per panel', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk persistence');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  assert.deepEqual(reference.metadata, { kind: 'character-reference' });
  assert.equal('metadata_json' in reference, false);

  const spec = storyboardSpec({ panelId: panel.id, source, reference });
  const queued = harness.db.queueStoryboardRun(spec);
  assert.equal(queued.deduplicated, false);
  assert.equal(queued.run.provider_family, 'miguo');
  assert.equal(queued.run.provider_connection_id, 'storyark_v3');
  assert.equal(queued.run.tool_name, 'storyboard_inference');
  assert.equal(queued.run.contract_fingerprint, spec.contractFingerprint);
  assert.deepEqual(queued.run.request, spec.request);
  assert.deepEqual(queued.run.outputs, []);
  assert.equal('request_json' in queued.run, false);
  assert.deepEqual(harness.db.getStoryboardRunSafetySummary(), {
    totalRunCount: 1,
    unknownCostRunCount: 0,
    activeRunCount: 1
  });

  const replay = harness.db.queueStoryboardRun(spec);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.run.id, queued.run.id);
  assert.equal(harness.db.findStoryboardRunByIdempotencyKey(spec.idempotencyKey).id, queued.run.id);
  assert.throws(
    () => harness.db.queueStoryboardRun({ ...spec, projectId: 'different-project' }),
    (error) => error.code === 'idempotency_key_conflict' && error.statusCode === 409
  );
  assert.throws(
    () => harness.db.queueStoryboardRun({ ...spec, idempotencyKey: 'storyboard:active:2' }),
    (error) => error.code === 'panel_storyboard_run_active' && error.statusCode === 409
  );
  const other = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const otherReference = createReference(harness, {
    batchId: batch.id, panelId: other.panel.id, source: other.source
  });
  const independentlyQueued = harness.db.queueStoryboardRun(storyboardSpec({
    panelId: other.panel.id,
    source: other.source,
    reference: otherReference,
    key: 'storyboard:independent-panel:2'
  }));
  assert.equal(independentlyQueued.deduplicated, false);
  assert.equal(independentlyQueued.run.status, 'queued');
  assert.notEqual(independentlyQueued.run.id, queued.run.id);

  harness.db.failStoryboardRun({
    runId: queued.run.id,
    code: 'unknown_outcome',
    message: 'safe fixture',
    costSource: 'unknown'
  });
  assert.deepEqual(harness.db.getStoryboardRunSafetySummary(), {
    totalRunCount: 2,
    unknownCostRunCount: 1,
    activeRunCount: 1
  });
});

test('StoryArk queues independent panels but claims only one paid task until it is terminal', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk independent queue lanes');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const firstReference = createReference(harness, {
    batchId: batch.id, panelId: first.panel.id, source: first.source
  });
  const firstRun = harness.db.queueStoryboardRun(storyboardSpec({
    panelId: first.panel.id,
    source: first.source,
    reference: firstReference,
    key: 'storyboard:serial-claim:first'
  })).run;

  const claimedFirst = harness.db.claimNextQueuedStoryboard();
  assert.equal(claimedFirst.id, firstRun.id);
  assert.equal(claimedFirst.status, 'running');

  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const secondReference = createReference(harness, {
    batchId: batch.id, panelId: second.panel.id, source: second.source
  });
  const secondRun = harness.db.queueStoryboardRun(storyboardSpec({
    panelId: second.panel.id,
    source: second.source,
    reference: secondReference,
    key: 'storyboard:serial-claim:second'
  })).run;
  assert.equal(secondRun.status, 'queued');
  assert.equal(harness.db.claimNextQueuedStoryboard(), undefined,
    'A running paid task must prevent a second provider claim without cancelling its queue row.');
  assert.equal(harness.db.getStoryboardRun(secondRun.id).status, 'queued');

  harness.db.failStoryboardRun({
    runId: firstRun.id,
    code: 'provider_tool_error',
    message: 'terminal fixture',
    costSource: 'unpriced'
  });
  const claimedSecond = harness.db.claimNextQueuedStoryboard();
  assert.equal(claimedSecond.id, secondRun.id,
    'The next independent panel becomes claimable after the prior paid task is terminal.');

  const third = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 3 });
  const thirdReference = createReference(harness, {
    batchId: batch.id, panelId: third.panel.id, source: third.source
  });
  const thirdRun = harness.db.queueStoryboardRun(storyboardSpec({
    panelId: third.panel.id,
    source: third.source,
    reference: thirdReference,
    key: 'storyboard:serial-claim:third'
  })).run;
  harness.db.failStoryboardRun({
    runId: secondRun.id,
    code: 'unknown_outcome',
    message: 'provider outcome requires reconciliation',
    costSource: 'unknown'
  });
  assert.equal(harness.db.claimNextQueuedStoryboard(), undefined,
    'An unknown paid outcome must trip the claim-time fuse before another provider call starts.');
  assert.equal(harness.db.getStoryboardRun(thirdRun.id).status, 'queued',
    'The claim-time fuse must preserve the waiting panel for later reconciliation.');
});

test('StoryArk enforces the per-batch result quota inside the queue transaction', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk atomic batch quota');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const firstReference = createReference(harness, {
    batchId: batch.id, panelId: first.panel.id, source: first.source
  });
  const firstSpec = storyboardSpec({
    panelId: first.panel.id,
    source: first.source,
    reference: firstReference,
    key: 'storyboard:atomic-quota:first',
    overrides: { expectedResultCount: 3, maxResultsPerBatch: 4 }
  });
  const firstRun = harness.db.queueStoryboardRun(firstSpec).run;
  assert.equal(firstRun.expected_result_count, 3);
  assert.equal(harness.db.queueStoryboardRun(firstSpec).run.id, firstRun.id,
    'An exact replay must not consume the batch quota twice.');

  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const secondReference = createReference(harness, {
    batchId: batch.id, panelId: second.panel.id, source: second.source
  });
  assert.throws(
    () => harness.db.queueStoryboardRun(storyboardSpec({
      panelId: second.panel.id,
      source: second.source,
      reference: secondReference,
      key: 'storyboard:atomic-quota:second',
      overrides: { expectedResultCount: 2, maxResultsPerBatch: 4 }
    })),
    (error) => error.code === 'storyboard_result_limit_reached' && error.statusCode === 409
  );
  assert.equal(harness.db.findStoryboardRunByIdempotencyKey('storyboard:atomic-quota:second'), undefined,
    'A rejected quota reservation must not leave a partial queue row.');
  assert.deepEqual(
    harness.db.listStoryboardRunsForBatch(batch.id).map((run) => run.id),
    [firstRun.id]
  );
});

test('StoryArk atomically reserves a shared batch quota across database connections', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk concurrent batch quota');
  const first = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const second = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 2 });
  const firstReference = createReference(harness, {
    batchId: batch.id, panelId: first.panel.id, source: first.source
  });
  const secondReference = createReference(harness, {
    batchId: batch.id, panelId: second.panel.id, source: second.source
  });
  const workerUrl = new URL('./storyboard-quota-worker.mjs', import.meta.url);
  const workers = [
    new Worker(workerUrl, {
      workerData: {
        filename: path.join(harness.root, 'p0.sqlite'),
        spec: storyboardSpec({
          panelId: first.panel.id,
          source: first.source,
          reference: firstReference,
          key: 'storyboard:concurrent-quota:first',
          overrides: { expectedResultCount: 3, maxResultsPerBatch: 4 }
        })
      }
    }),
    new Worker(workerUrl, {
      workerData: {
        filename: path.join(harness.root, 'p0.sqlite'),
        spec: storyboardSpec({
          panelId: second.panel.id,
          source: second.source,
          reference: secondReference,
          key: 'storyboard:concurrent-quota:second',
          overrides: { expectedResultCount: 3, maxResultsPerBatch: 4 }
        })
      }
    })
  ];
  t.after(async () => Promise.all(workers.map((worker) => worker.terminate())));

  const ready = await Promise.all(workers.map((worker) => once(worker, 'message')));
  assert.deepEqual(ready.map(([message]) => message.type), ['ready', 'ready']);
  const resultsPending = workers.map((worker) => once(worker, 'message'));
  workers.forEach((worker) => worker.postMessage({ type: 'queue' }));
  const results = (await Promise.all(resultsPending)).map(([message]) => message);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.code === 'storyboard_result_limit_reached').length, 1);
  const persisted = harness.db.listStoryboardRunsForBatch(batch.id);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].expected_result_count, 3);
  assert.ok([
    'storyboard:concurrent-quota:first',
    'storyboard:concurrent-quota:second'
  ].includes(persisted[0].idempotency_key));
});

test('StoryArk polling leases and output completion are atomic', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk atomic completion');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  const queued = harness.db.queueStoryboardRun(storyboardSpec({ panelId: panel.id, source, reference })).run;

  assert.equal(harness.db.claimNextQueuedStoryboard().id, queued.id);
  const processing = harness.db.markStoryboardProcessing({
    runId: queued.id,
    providerTaskId: 'provider-task-1',
    providerRequestId: 'provider-request-1',
    costPoints: 17,
    costSource: 'provider',
    nextPollAt: new Date(0).toISOString()
  });
  assert.equal(processing.status, 'processing');
  assert.equal(harness.db.claimNextProcessingStoryboard({ pollIntervalMs: 60_000 }).id, queued.id);
  assert.equal(harness.db.claimNextProcessingStoryboard({ pollIntervalMs: 60_000 }), undefined,
    'A processing run must be leased once per polling interval.');

  assert.throws(
    () => harness.db.completeStoryboardRunWithOutputs({
      runId: queued.id,
      outputs: [outputFrom(source, 1), outputFrom(source, 1)]
    })
  );
  assert.equal(harness.db.getStoryboardRun(queued.id).status, 'processing');
  assert.deepEqual(harness.db.getStoryboardRun(queued.id).outputs, [], 'A failed insert must roll back every output.');

  const completed = harness.db.completeStoryboardRunWithOutputs({
    runId: queued.id,
    outputs: [
      outputFrom(source, 1, { signedUrlPersisted: false }),
      outputFrom(source, 2, { signedUrlPersisted: false })
    ],
    providerTaskId: 'provider-task-1',
    costPoints: 17,
    costSource: 'provider',
    durationMs: 321
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.outputs.length, 2);
  assert.deepEqual(completed.outputs[0].metadata, { signedUrlPersisted: false });
  assert.equal(harness.db.getStoryboardOutput(completed.outputs[1].id).ordinal, 2);

  const details = harness.db.getBatchDetails(batch.id);
  assert.equal(details.storyboardRuns.length, 1);
  assert.equal(details.storyboardRuns[0].id, queued.id);
  assert.equal(details.panels.length, 1, 'The existing pipeline detail contract remains intact.');
});

test('storyboard generations are preserved as versions and the selected result is auditable', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Storyboard version history', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  const complete = (key, metadata) => {
    const queued = harness.db.queueStoryboardRun(storyboardSpec({
      panelId: panel.id,
      source,
      reference,
      key,
      overrides: { expectedResultCount: 1 }
    })).run;
    assert.equal(harness.db.claimNextQueuedStoryboard().id, queued.id);
    return harness.db.completeStoryboardRunWithOutputs({
      runId: queued.id,
      outputs: [outputFrom(source, 1, metadata)]
    });
  };

  const oldRun = complete('storyboard:version:old', {
    renderProvider: 'storyark', deliveryMode: 'selective_composite'
  });
  assert.equal(harness.db.getPanel(panel.id).selected_storyboard_output_id, oldRun.outputs[0].id);

  const rawRun = complete('storyboard:version:raw', {
    renderProvider: 'nano_banana_2', deliveryMode: 'provider_raw_resize'
  });
  assert.equal(harness.db.getPanel(panel.id).selected_storyboard_output_id, rawRun.outputs[0].id,
    'A newly completed generation must become the adopted result automatically.');
  assert.equal(harness.db.listStoryboardRunsForBatch(batch.id).length, 2,
    'The previous generation remains immutable history.');

  const selected = harness.db.selectStoryboardOutput({ panelId: panel.id, outputId: oldRun.outputs[0].id });
  assert.equal(selected.changed, true);
  assert.equal(harness.db.getPanel(panel.id).selected_storyboard_output_id, oldRun.outputs[0].id);
  const replay = harness.db.selectStoryboardOutput({ panelId: panel.id, outputId: oldRun.outputs[0].id });
  assert.equal(replay.changed, false, 'Selecting the adopted version again must be idempotent.');

  const events = harness.db.db.prepare(`
    SELECT output_id, previous_output_id, reason
      FROM storyboard_output_selections
     WHERE panel_id = ?
     ORDER BY created_at, rowid
  `).all(panel.id);
  assert.deepEqual(events.map((event) => event.reason), [
    'generation_completed', 'generation_completed', 'user_selected'
  ]);
  assert.equal(events[2].output_id, oldRun.outputs[0].id);
  assert.equal(events[2].previous_output_id, rawRun.outputs[0].id);
  assert.throws(() => harness.db.db.prepare(
    'UPDATE storyboard_output_selections SET reason = reason WHERE panel_id = ?'
  ).run(panel.id), /append-only/);
  assert.throws(() => harness.db.db.prepare(
    'DELETE FROM storyboard_output_selections WHERE panel_id = ?'
  ).run(panel.id), /append-only/);
});

test('storyboard columns and historical versions are soft-deleted with stable version numbers', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Storyboard deletion', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  const complete = (key) => {
    const run = harness.db.queueStoryboardRun(storyboardSpec({
      panelId: panel.id, source, reference, key, overrides: { expectedResultCount: 1 }
    })).run;
    assert.equal(harness.db.claimNextQueuedStoryboard().id, run.id);
    return harness.db.completeStoryboardRunWithOutputs({
      runId: run.id,
      outputs: [outputFrom(source, 1, { key })]
    });
  };

  const first = complete('storyboard:delete:first');
  const second = complete('storyboard:delete:second');
  assert.deepEqual([first.outputs[0].version_number, second.outputs[0].version_number], [1, 2]);
  assert.throws(
    () => harness.db.softDeleteStoryboardOutput({ outputId: second.outputs[0].id }),
    (error) => error.code === 'storyboard_output_selected'
  );
  const deletedVersion = harness.db.softDeleteStoryboardOutput({ outputId: first.outputs[0].id });
  assert.equal(deletedVersion.changed, true);
  assert.equal(deletedVersion.versionNumber, 1);
  assert.equal(harness.db.getStoryboardOutput(first.outputs[0].id), undefined);
  assert.ok(harness.db.getStoryboardOutput(first.outputs[0].id, { includeDeleted: true }).deleted_at);
  assert.deepEqual(harness.db.getStoryboardRun(first.id).outputs, []);

  const third = complete('storyboard:delete:third');
  assert.equal(third.outputs[0].version_number, 3,
    'Removing version 1 must not renumber or reuse its immutable version number.');

  const deletedPanel = harness.db.softDeleteStoryboardPanel({ panelId: panel.id });
  assert.equal(deletedPanel.changed, true);
  assert.equal(harness.db.getBatchDetails(batch.id).panels.length, 0);
  assert.equal(harness.db.listStoryboardRunsForBatch(batch.id).length, 0,
    'Removed columns disappear from the active creator workspace.');
  assert.ok(harness.db.getPanel(panel.id).deleted_at);
  assert.equal(harness.db.getStoryboardOutput(third.outputs[0].id).id, third.outputs[0].id,
    'Soft deletion preserves immutable output records and blobs for audit.');
  assert.equal(harness.db.softDeleteStoryboardPanel({ panelId: panel.id }).changed, false);
});

test('an active storyboard column cannot be removed', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Active storyboard deletion guard', null, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  harness.db.queueStoryboardRun(storyboardSpec({ panelId: panel.id, source, reference }));
  assert.throws(
    () => harness.db.softDeleteStoryboardPanel({ panelId: panel.id }),
    (error) => error.code === 'panel_storyboard_run_active'
  );
  assert.equal(harness.db.getBatchDetails(batch.id).panels.length, 1);
});

test('deadlines persist and organization submissions freeze the adopted result for company members', async (t) => {
  const harness = await createHarness(t);
  const createUser = (email, displayName) => harness.db.createUser({
    email,
    displayName,
    passwordHash: `hash-${email}`,
    passwordSalt: `salt-${email}`,
    role: 'member'
  });
  const owner = createUser('schedule-owner@example.com', '排期负责人');
  const colleague = createUser('schedule-colleague@example.com', '制作同事');
  const outsider = createUser('schedule-outsider@example.com', '外部成员');
  const studio = harness.db.createOrganization('联合漫画工作室');
  harness.db.assignUserToOrganization({ userId: owner.id, organizationId: studio.id, role: 'scheduler' });
  harness.db.assignUserToOrganization({ userId: colleague.id, organizationId: studio.id, role: 'member' });

  const batch = harness.db.createBatch('公司排期批次', owner.id, 'reference_creation');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const reference = createReference(harness, { batchId: batch.id, panelId: panel.id, source });
  const complete = (key, suffix) => {
    const run = harness.db.queueStoryboardRun(storyboardSpec({
      panelId: panel.id,
      source,
      reference,
      key,
      overrides: { expectedResultCount: 1 }
    })).run;
    assert.equal(harness.db.claimNextQueuedStoryboard().id, run.id);
    return harness.db.completeStoryboardRunWithOutputs({
      runId: run.id,
      outputs: [{
        ordinal: 1,
        blobPath: source.blob_path,
        sha256: `${source.sha256.slice(0, -2)}${suffix}`,
        mimeType: source.mime_type,
        width: source.width,
        height: source.height,
        byteSize: source.byte_size,
        metadata: { deliveryMode: 'provider_raw_resize' }
      }]
    });
  };

  const first = complete('organization:submission:first', 'a1');
  const deadlineAt = '2026-09-01T15:59:59.000Z';
  const [scheduled] = harness.db.setPanelDeadlines({
    batchId: batch.id,
    updates: [{ panelId: panel.id, deadlineAt }],
    actorUserId: owner.id
  });
  assert.equal(scheduled.deadline_at, deadlineAt);

  const submitted = harness.db.submitStoryboardPanel({ panelId: panel.id, actorUserId: owner.id });
  assert.equal(submitted.submission_status, 'submitted');
  assert.equal(submitted.submitted_organization_id, studio.id);
  assert.equal(submitted.submitted_storyboard_output_id, first.outputs[0].id);
  assert.equal(harness.db.listOrganizationSubmissions(colleague.id)[0].submitted_storyboard_output_id,
    first.outputs[0].id);
  assert.equal(harness.db.canUserReadSubmittedOutput(colleague.id, first.outputs[0].id), true);
  assert.equal(harness.db.canUserReadSubmittedOutput(outsider.id, first.outputs[0].id), false);

  const second = complete('organization:submission:second', 'a2');
  assert.equal(harness.db.getPanel(panel.id).selected_storyboard_output_id, second.outputs[0].id);
  assert.equal(harness.db.listOrganizationSubmissions(colleague.id)[0].submitted_storyboard_output_id,
    first.outputs[0].id,
    'A later generation must not silently replace the version already submitted to the company.');
  assert.throws(
    () => harness.db.softDeleteStoryboardOutput({ outputId: first.outputs[0].id }),
    (error) => error.code === 'storyboard_output_submitted',
    'The frozen company submission must remain available even after another version becomes current.'
  );

  const updated = harness.db.submitStoryboardPanel({ panelId: panel.id, actorUserId: owner.id });
  assert.equal(updated.submitted_storyboard_output_id, second.outputs[0].id);
  assert.equal(harness.db.canUserReadSubmittedOutput(colleague.id, first.outputs[0].id), false,
    'Company access follows the explicitly adopted submission snapshot.');
  assert.equal(harness.db.canUserReadSubmittedOutput(colleague.id, second.outputs[0].id), true);
  const events = harness.db.db.prepare(`
    SELECT storyboard_output_id, deadline_at FROM panel_submission_events
    WHERE panel_id = ? ORDER BY created_at, rowid
  `).all(panel.id);
  assert.deepEqual(events.map((event) => event.storyboard_output_id), [first.outputs[0].id, second.outputs[0].id]);
  assert.deepEqual(events.map((event) => event.deadline_at), [deadlineAt, deadlineAt]);
  assert.throws(() => harness.db.db.prepare(
    'UPDATE panel_submission_events SET deadline_at = deadline_at WHERE panel_id = ?'
  ).run(panel.id), /append-only/);
});

test('comic submissions freeze the explicitly selected current stage asset for team members after column removal', async (t) => {
  const harness = await createHarness(t);
  const createUser = (email, displayName) => harness.db.createUser({
    email,
    displayName,
    passwordHash: `hash-${email}`,
    passwordSalt: `salt-${email}`,
    role: 'member'
  });
  const owner = createUser('comic-owner@example.com', '漫画负责人');
  const colleague = createUser('comic-colleague@example.com', '漫画同事');
  const outsider = createUser('comic-outsider@example.com', '外部账号');
  const studio = harness.db.createOrganization('漫画生产工作室');
  harness.db.assignUserToOrganization({ userId: owner.id, organizationId: studio.id, role: 'owner' });
  harness.db.assignUserToOrganization({ userId: colleague.id, organizationId: studio.id, role: 'member' });

  const batch = harness.db.createBatch('漫画提报批次', owner.id, 'comic_pipeline');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const { light } = createApprovedSyntheticChain(harness, { panelId: panel.id, source });
  const deadlineAt = '2026-09-20T15:59:59.000Z';
  harness.db.setPanelDeadlines({
    batchId: batch.id,
    updates: [{ panelId: panel.id, deadlineAt }],
    actorUserId: owner.id
  });

  const sourceSubmitted = harness.db.submitStoryboardPanel({
    panelId: panel.id,
    actorUserId: owner.id,
    assetVersionId: source.id
  });
  assert.equal(sourceSubmitted.submitted_asset_version_id, source.id,
    'A creator may submit the current draft even when later stages already exist.');
  assert.equal(harness.db.canUserReadSubmittedAsset(colleague.id, source.id), true);

  const submitted = harness.db.submitStoryboardPanel({
    panelId: panel.id,
    actorUserId: owner.id,
    assetVersionId: light.id
  });
  assert.equal(submitted.submission_status, 'submitted');
  assert.equal(submitted.submitted_asset_version_id, light.id);
  assert.equal(submitted.submitted_storyboard_output_id, null);
  const [companyItem] = harness.db.listOrganizationSubmissions(colleague.id);
  assert.equal(companyItem.submission_kind, 'comic');
  assert.equal(companyItem.submitted_asset_version_id, light.id);
  assert.equal(companyItem.deadline_at, deadlineAt);
  assert.equal(harness.db.canUserReadSubmittedAsset(colleague.id, light.id), true);
  assert.equal(harness.db.canUserReadSubmittedAsset(outsider.id, light.id), false);

  const deletion = harness.db.softDeleteStoryboardPanel({ panelId: panel.id, deletedByUserId: owner.id });
  assert.equal(deletion.changed, true);
  assert.equal(deletion.submissionRetained, true);
  assert.deepEqual(harness.db.getBatchDetails(batch.id).panels, []);
  assert.equal(harness.db.listOrganizationSubmissions(colleague.id)[0].submitted_asset_version_id, light.id,
    'Removing a creator column must retain the frozen company submission snapshot.');
  assert.equal(harness.db.canUserReadSubmittedAsset(colleague.id, light.id), true);
  const events = harness.db.db.prepare(`
    SELECT asset_version_id, deadline_at FROM panel_asset_submission_events WHERE panel_id = ? ORDER BY rowid
  `).all(panel.id);
  assert.deepEqual(events.map((event) => ({ ...event })), [
    { asset_version_id: source.id, deadline_at: deadlineAt },
    { asset_version_id: light.id, deadline_at: deadlineAt }
  ]);
  assert.throws(() => harness.db.db.prepare(
    'DELETE FROM panel_asset_submission_events WHERE panel_id = ?'
  ).run(panel.id), /append-only/);
});

test('comic columns with active generation cannot be removed', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Active comic deletion guard', null, 'comic_pipeline');
  const { panel } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  queueStage(harness, { panelId: panel.id, stage: 'ink', idempotencyKey: 'comic:delete:active' });
  assert.throws(
    () => harness.db.softDeleteStoryboardPanel({ panelId: panel.id }),
    (error) => error.code === 'panel_storyboard_run_active'
  );
  assert.equal(harness.db.getBatchDetails(batch.id).panels.length, 1);
});

test('StoryArk restart recovery fails unknown submissions, preserves polling, and restores ingested outputs', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('StoryArk recovery');
  const fixtures = [];
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const item = await addPanelWithSource(harness, { batchId: batch.id, ordinal });
    const reference = createReference(harness, { batchId: batch.id, panelId: item.panel.id, source: item.source });
    const run = harness.db.queueStoryboardRun(storyboardSpec({
      panelId: item.panel.id,
      source: item.source,
      reference,
      key: `storyboard:recovery:${ordinal}`,
      overrides: { expectedResultCount: 1 }
    })).run;
    harness.db.claimNextQueuedStoryboard();
    harness.db.db.prepare("UPDATE storyboard_runs SET status = 'failed' WHERE id = ?").run(run.id);
    fixtures.push({ ...item, reference, run });
  }

  harness.db.db.prepare("UPDATE storyboard_runs SET status = 'running', finished_at = NULL WHERE id IN (?, ?, ?)")
    .run(fixtures[0].run.id, fixtures[1].run.id, fixtures[2].run.id);
  harness.db.markStoryboardProcessing({ runId: fixtures[1].run.id, providerTaskId: 'poll-me' });
  const timestamp = new Date().toISOString();
  const persistedOutputId = 'persisted-storyboard-output';
  harness.db.db.prepare(`
    INSERT INTO storyboard_outputs (
      id, storyboard_run_id, ordinal, blob_path, sha256, mime_type,
      width, height, byte_size, metadata_json, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    persistedOutputId,
    fixtures[2].run.id,
    fixtures[2].source.blob_path,
    fixtures[2].source.sha256,
    fixtures[2].source.mime_type,
    fixtures[2].source.width,
    fixtures[2].source.height,
    fixtures[2].source.byte_size,
    JSON.stringify({ recovered: true }),
    timestamp
  );

  assert.equal(harness.db.recoverInterruptedStoryboardRuns(), 2);
  const unknown = harness.db.getStoryboardRun(fixtures[0].run.id);
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.error_code, 'unknown_outcome');
  assert.equal(unknown.cost_source, 'unknown');
  assert.equal(unknown.recovered_count, 1);

  const polling = harness.db.getStoryboardRun(fixtures[1].run.id);
  assert.equal(polling.status, 'processing');
  assert.equal(polling.provider_task_id, 'poll-me');
  assert.equal(polling.recovered_count, 0);

  const recovered = harness.db.getStoryboardRun(fixtures[2].run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.error_code, 'recovered_after_ingest');
  assert.equal(recovered.outputs[0].id, persistedOutputId);
  assert.deepEqual(recovered.outputs[0].metadata, { recovered: true });
});

test('legacy run_attempt databases migrate provider routing columns without losing rows', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-legacy-db-'));
  const filename = path.join(root, 'legacy.sqlite');

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      owner_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO batches (id, name, status, owner_user_id, created_at, updated_at)
    VALUES ('legacy-batch', 'Legacy comic batch', 'active', NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    CREATE TABLE run_attempts (
      id TEXT PRIMARY KEY,
      panel_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      provider TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      input_versions_json TEXT NOT NULL DEFAULT '[]',
      output_asset_version_id TEXT,
      provider_request_id TEXT,
      cost_points REAL NOT NULL DEFAULT 0,
      cost_source TEXT NOT NULL DEFAULT 'estimate',
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      recovered_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    INSERT INTO run_attempts (
      id, panel_id, stage, provider, tool_name, idempotency_key, status, created_at
    ) VALUES ('legacy-run', 'legacy-panel', 'ink', 'miguo', 'line_art_beautify_v4',
      'legacy-key', 'failed', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const migrated = new P0Database(filename);
  t.after(async () => {
    migrated.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const row = migrated.getRun('legacy-run');
  assert.equal(row.provider_profile, 'factory_classic');
  assert.equal(row.provider_contract_fingerprint, null);
  assert.equal(row.pricing_revision, null);
  assert.equal(row.estimated_cost_points, 0);
  assert.equal(row.provider_phase, 'preflight');
  assert.deepEqual(row.params, {});
  assert.deepEqual(row.inputVersions, []);
  assert.equal(migrated.getBatchRecord('legacy-batch').workflow_type, 'comic_pipeline');
});

test('legacy StoryArk rows with a null request payload migrate without losing history', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-p0-legacy-storyboard-db-'));
  const filename = path.join(root, 'legacy-storyboard.sqlite');
  const seeded = new P0Database(filename);
  const batch = seeded.createBatch('Legacy StoryArk', null, 'reference_creation');
  const panel = seeded.addPanel({
    panelId: 'legacy-story-panel', batchId: batch.id, ordinal: 1,
    originalFilename: 'legacy-story.png'
  });
  const source = seeded.createAssetVersion({
    panelId: panel.id, stage: 'source', blobPath: 'legacy/source.png', sha256: 'a'.repeat(64),
    mimeType: 'image/png', width: 320, height: 384, byteSize: 1024,
    status: 'approved', metadata: { legacy: true }
  });
  const reference = seeded.createStoryboardReference({
    batchId: batch.id, panelId: panel.id, blobPath: source.blob_path, sha256: source.sha256,
    mimeType: source.mime_type, width: source.width, height: source.height,
    byteSize: source.byte_size, metadata: { legacy: true }
  });
  const original = seeded.queueStoryboardRun(storyboardSpec({
    panelId: panel.id, source, reference, key: 'legacy-storyboard-null-request'
  })).run;
  seeded.close();

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE storyboard_runs_legacy (
      id TEXT PRIMARY KEY,
      panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
      provider_family TEXT NOT NULL DEFAULT 'miguo' CHECK(provider_family = 'miguo'),
      provider_connection_id TEXT NOT NULL DEFAULT 'storyark_v3' CHECK(provider_connection_id = 'storyark_v3'),
      tool_name TEXT NOT NULL DEFAULT 'storyboard_inference' CHECK(tool_name = 'storyboard_inference'),
      contract_fingerprint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','running','processing','succeeded','failed','cancelled')),
      project_id TEXT NOT NULL,
      image_size TEXT NOT NULL CHECK(image_size IN ('1K','2K','4K')),
      expected_result_count INTEGER NOT NULL CHECK(expected_result_count BETWEEN 1 AND 4),
      remove_bg INTEGER NOT NULL DEFAULT 0 CHECK(remove_bg IN (0,1)),
      source_asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
      reference_asset_id TEXT NOT NULL REFERENCES storyboard_reference_assets(id),
      analysis_id TEXT REFERENCES storyboard_analyses(id),
      modification_note TEXT NOT NULL DEFAULT '',
      request_json TEXT,
      provider_task_id TEXT,
      provider_request_id TEXT,
      cost_points REAL NOT NULL DEFAULT 0,
      cost_source TEXT NOT NULL DEFAULT 'unpriced',
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      recovered_count INTEGER NOT NULL DEFAULT 0,
      last_polled_at TEXT,
      next_poll_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    INSERT INTO storyboard_runs_legacy (
      id, panel_id, provider_family, provider_connection_id, tool_name,
      contract_fingerprint, idempotency_key, status, project_id, image_size,
      expected_result_count, remove_bg, source_asset_version_id, reference_asset_id,
      analysis_id, modification_note, request_json, provider_task_id, provider_request_id,
      cost_points, cost_source, duration_ms, error_code, error_message, recovered_count,
      last_polled_at, next_poll_at, created_at, started_at, finished_at
    )
    SELECT
      id, panel_id, provider_family, provider_connection_id, tool_name,
      contract_fingerprint, idempotency_key, status, project_id, image_size,
      expected_result_count, remove_bg, source_asset_version_id, reference_asset_id,
      analysis_id, modification_note, NULL, provider_task_id, provider_request_id,
      cost_points, cost_source, duration_ms, error_code, error_message, recovered_count,
      last_polled_at, next_poll_at, created_at, started_at, finished_at
    FROM storyboard_runs;
    DROP TABLE storyboard_runs;
    ALTER TABLE storyboard_runs_legacy RENAME TO storyboard_runs;
    PRAGMA foreign_keys = ON;
  `);
  legacy.close();

  const migrated = new P0Database(filename);
  t.after(async () => {
    migrated.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const restored = migrated.getStoryboardRun(original.id);
  assert.deepEqual(restored.request, {});
  assert.equal(restored.provider_connection_id, 'storyark_v3');
  assert.equal(restored.tool_name, 'storyboard_inference');
  assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
  const definition = migrated.db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='storyboard_runs'"
  ).get().sql;
  assert.match(definition, /studio_relay_nano_banana_2/);
  assert.match(definition, /images_edits/);
});

test('pipeline idempotency freezes provider contract and pricing fields', async (t) => {
  const harness = await createHarness(t);
  const batch = harness.db.createBatch('Provider routing persistence');
  const { panel, source } = await addPanelWithSource(harness, { batchId: batch.id, ordinal: 1 });
  const spec = {
    panelId: panel.id,
    stage: 'ink',
    provider: 'miguo',
    providerProfile: 'factory_classic',
    providerContractFingerprint: 'sha256:factory-contract-v1',
    toolName: 'line_art_beautify_v4',
    params: { channel: 'slow' },
    idempotencyKey: 'pipeline:frozen-routing:1',
    inputVersions: [{ id: source.id, role: 'source', sha256: source.sha256 }],
    pricingRevision: 'factory-pricing-2026-08',
    estimatedCostPoints: 20,
    providerPhase: 'preflight'
  };
  const queued = harness.db.queueRun(spec);
  assert.equal(queued.run.provider_profile, 'factory_classic');
  assert.equal(queued.run.provider_contract_fingerprint, spec.providerContractFingerprint);
  assert.equal(queued.run.pricing_revision, spec.pricingRevision);
  assert.equal(queued.run.estimated_cost_points, 20);
  assert.equal(harness.db.queueRun(spec).deduplicated, true);
  assert.throws(
    () => harness.db.queueRun({ ...spec, pricingRevision: 'changed-pricing' }),
    (error) => error.code === 'idempotency_key_conflict'
  );
});
