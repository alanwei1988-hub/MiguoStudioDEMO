import assert from 'node:assert/strict';
import test from 'node:test';

import { factoryClassicContract } from '../src/providers/factory-contracts.mjs';
import { FactoryClassicRecoveryClient } from '../src/providers/factory-recovery.mjs';
import { sha256 } from '../src/security.mjs';

const FACTORY_ORIGIN = 'https://factory.miguocomics.com';
const OSS_ORIGIN = 'https://oss.miguocomics.com';
const CREATED_AT = '2026-08-14T08:00:10.000Z';
const TASK_IDS = Object.freeze([
  '019fff81-1111-7111-8111-111111111111',
  '019fff81-2222-7222-8222-222222222222'
]);

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function fixtureFor({
  toolName,
  taskIds = [TASK_IDS[0]],
  taskStatus = 2,
  ledgerAmount = 0,
  providerInputOverrides = {},
  outputBuffer = Buffer.from(`not-an-image:${toolName}`),
  mutateMeta = null,
  historyItems = null
}) {
  const profile = factoryClassicContract(toolName);
  assert.ok(profile);
  const inputBuffers = Object.fromEntries(profile.inputFields.map(({ role }) => [
    role,
    Buffer.from(`${toolName}:${role}:frozen-input`)
  ]));
  const inputs = profile.inputFields.map(({ role }) => ({
    id: `${role}-asset`,
    role,
    sha256: sha256(inputBuffers[role]),
    byte_size: inputBuffers[role].length
  }));
  const inputUrls = Object.fromEntries(profile.inputFields.map(({ role }) => [
    role,
    `${OSS_ORIGIN}/${toolName}-${role}-input.png?fixture=signed-input`
  ]));
  const outputUrl = `${OSS_ORIGIN}/${toolName}-finished-output.png?fixture=signed-output`;
  const rawUrls = {
    shadow: `${OSS_ORIGIN}/${toolName}-raw-shadow.png?fixture=raw`,
    overlay: `${OSS_ORIGIN}/${toolName}-overlay.png?fixture=overlay`,
    cropped: `${OSS_ORIGIN}/${toolName}-cropped.png?fixture=cropped`
  };
  const details = new Map(taskIds.map((taskId) => {
    const meta = {
      status: taskStatus,
      progress: taskStatus === 2 ? 100 : 0,
      ...Object.fromEntries(profile.inputFields.map(({ role, metaKey }) => [metaKey, inputUrls[role]]))
    };
    if (taskStatus === 2) {
      if (profile.historyOutputKind === 'url') meta[profile.historyOutputKey] = outputUrl;
      else meta[profile.historyOutputKey] = [outputUrl];
    }
    if (toolName === 'shadowing_v7') {
      Object.assign(meta, {
        style: 'nvpin',
        color: 'nvpin_rule',
        light: 'top_left',
        shadowStrength: 0.5
      });
      if (taskStatus === 2) Object.assign(meta, {
        outputShadowImageUrls: [rawUrls.shadow],
        outputOverlayImageUrl: rawUrls.overlay,
        outputCroppedShadowImages: [{ imageUrl: rawUrls.cropped, x: 7, y: 9 }]
      });
    }
    mutateMeta?.(meta, taskId);
    return [taskId, {
      code: 0,
      data: {
        taskId,
        type: profile.taskType,
        version: profile.taskVersion,
        inferenceChannel: 1,
        meta: JSON.stringify(meta)
      }
    }];
  }));
  const listedItems = historyItems ?? taskIds.map((taskId) => ({
    taskId,
    type: profile.taskType,
    version: profile.taskVersion,
    inferenceChannel: 'slow',
    createAt: CREATED_AT
  }));
  const servedBytes = new Map([
    ...profile.inputFields.map(({ role }) => [
      inputUrls[role],
      providerInputOverrides[role] ?? inputBuffers[role]
    ]),
    [outputUrl, outputBuffer]
  ]);
  const requests = [];
  const guarded = [];
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    requests.push({ href: url.href, method: init.method, headers: init.headers || {}, body: init.body });
    if (url.pathname === '/api/task-history/v1/list/1') {
      assert.equal(url.search, `?type=${profile.taskType}&pageSize=100`);
      return jsonResponse({ code: 0, data: { list: listedItems } });
    }
    if (url.pathname.startsWith('/api/task-history/v1/detail/')) {
      const taskId = url.pathname.split('/').at(-1);
      const detail = details.get(taskId);
      if (!detail) throw new Error(`Unexpected detail task: ${taskId}`);
      return jsonResponse(detail);
    }
    if (url.pathname.startsWith(profile.directTaskPath)) {
      const taskId = url.pathname.split('/').at(-1);
      const detail = details.get(taskId);
      const meta = detail ? JSON.parse(detail.data.meta) : null;
      return jsonResponse({ code: 0, data: {
        taskId,
        type: profile.taskType,
        version: profile.taskVersion,
        status: meta?.status
      } });
    }
    if (url.pathname === '/api/coins/v1/transactions/1') {
      assert.equal(url.search, '?pageSize=100&type=2');
      return jsonResponse({ code: 0, data: { items: [{
        correlationId: taskIds[0],
        type: 2,
        reason: 6,
        amount: ledgerAmount,
        createAt: CREATED_AT
      }] } });
    }
    const bytes = servedBytes.get(url.href);
    if (bytes) return new Response(bytes, { status: 200 });
    throw new Error(`Unexpected recovery fixture request: ${url.href}`);
  };
  const urlGuard = async (rawUrl, hosts) => {
    const url = new URL(rawUrl);
    guarded.push({ href: url.href, hosts: [...hosts] });
    assert.deepEqual(hosts, ['oss.miguocomics.com']);
    assert.equal(url.hostname, 'oss.miguocomics.com');
    return url;
  };
  const client = new FactoryClassicRecoveryClient({
    config: {
      accountId: 'factory-recovery-fixture',
      apiToken: 'factory-recovery-token-never-sent',
      mcpUrl: `${FACTORY_ORIGIN}/api/mcp/v1`
    },
    fetchImpl,
    urlGuard
  });
  const run = {
    stage: profile.stage,
    tool_name: toolName,
    params: toolName === 'shadowing_v7'
      ? { style: 'nvpin', color: 'nvpin_rule', light: 'top_left', shadow_strength: 0.5, channel: 'slow' }
      : { channel: 'slow' },
    created_at: '2026-08-14T08:00:00.000Z',
    started_at: '2026-08-14T08:00:01.000Z',
    provider_result_observed_at: '2026-08-14T08:01:10.000Z'
  };
  return {
    client, run, inputs, profile, inputBuffers, inputUrls, outputUrl, outputBuffer,
    rawUrls, requests, guarded
  };
}

for (const specification of [
  { toolName: 'line_art_beautify_v4', expectedCost: 0, expectedSource: 'no_charge_confirmed' },
  { toolName: 'coloring_v4', expectedCost: 30, expectedSource: 'provider_statement' },
  { toolName: 'shadowing_v7', expectedCost: 0, expectedSource: 'no_charge_confirmed' }
]) {
  test(`Factory recovery uniquely restores ${specification.toolName} using GET evidence only`, async () => {
    const fixture = fixtureFor({
      toolName: specification.toolName,
      ledgerAmount: specification.expectedCost
    });
    const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });

    assert.equal(result.buffer.equals(fixture.outputBuffer), true,
      'Recovery intentionally leaves image geometry validation to downstream ingestion.');
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.providerTaskId, TASK_IDS[0]);
    assert.equal(result.providerTaskType, fixture.profile.taskType);
    assert.equal(result.providerTaskVersion, fixture.profile.taskVersion);
    assert.equal(result.outputHost, 'oss.miguocomics.com');
    assert.equal(result.outputRawSha256, sha256(fixture.outputBuffer));
    assert.equal(result.costPoints, specification.expectedCost);
    assert.equal(result.costSource, specification.expectedSource);
    assert.match(result.evidenceReference, new RegExp(`${fixture.profile.evidenceLabel};ledger:type2:reason6$`));

    assert.ok(fixture.requests.length >= 6);
    assert.ok(fixture.requests.every(({ method }) => method === 'GET'));
    assert.equal(fixture.requests.some(({ href }) => href.includes('/api/mcp/')), false);
    assert.equal(fixture.requests.some(({ href }) => href.includes('tools/call')), false);
    assert.equal(fixture.requests.filter(({ href }) => href === fixture.outputUrl).length, 1);
    assert.equal(fixture.guarded.filter(({ href }) => href === fixture.outputUrl).length, 1);
    if (specification.toolName === 'shadowing_v7') {
      assert.equal(fixture.inputs.length, 2, 'Shadow recovery must freeze both color and line-art inputs.');
      for (const rawUrl of Object.values(fixture.rawUrls)) {
        assert.equal(fixture.requests.some(({ href }) => href === rawUrl), false,
          'Raw shadow layers, overlays, and crops must never be treated as the finished image.');
      }
    }
  });
}

test('Factory recovery reconciles one explicit status=3 task from ledger-only GET evidence', async () => {
  const fixture = fixtureFor({
    toolName: 'coloring_v4',
    taskStatus: 3,
    ledgerAmount: 30
  });
  const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });

  assert.deepEqual(result, {
    outcome: 'failed',
    providerTaskId: TASK_IDS[0],
    providerTaskType: fixture.profile.taskType,
    providerTaskVersion: fixture.profile.taskVersion,
    evidenceReference: `factory-task:${TASK_IDS[0]}:${fixture.profile.evidenceLabel}:failed;ledger:type2:reason6`,
    costPoints: 30,
    costSource: 'provider_statement'
  });
  assert.equal('buffer' in result, false, 'An explicitly failed task must never materialize an output asset.');
  assert.ok(fixture.requests.every(({ method }) => method === 'GET'));
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/mcp/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes('tools/call')), false);
  assert.equal(fixture.requests.some(({ href }) => href === fixture.outputUrl), false);
  assert.equal(fixture.requests.filter(({ href }) => href.includes(fixture.profile.directTaskPath)).length, 1);
  assert.equal(fixture.requests.filter(({ href }) => href.includes('/api/coins/')).length, 1);
});

test('Factory recovery fails closed when two explicit status=3 tasks match the frozen input', async () => {
  const fixture = fixtureFor({
    toolName: 'coloring_v4',
    taskIds: [...TASK_IDS],
    taskStatus: 3,
    ledgerAmount: 30
  });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_ambiguous' && error.retryableRecovery === false
  );
  assert.equal(fixture.requests.some(({ href }) => href === fixture.outputUrl), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/coins/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(fixture.profile.directTaskPath)), false);
});

test('Factory shadow recovery rejects a task when either frozen input SHA does not match', async () => {
  const fixture = fixtureFor({
    toolName: 'shadowing_v7',
    providerInputOverrides: { ink: Buffer.from('different-provider-ink-bytes') }
  });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_pending' && error.retryableRecovery === true
  );
  assert.equal(fixture.requests.filter(({ href }) => href === fixture.inputUrls.color).length, 1);
  assert.equal(fixture.requests.filter(({ href }) => href === fixture.inputUrls.ink).length, 1);
  assert.equal(fixture.requests.some(({ href }) => href === fixture.outputUrl), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/coins/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(fixture.profile.directTaskPath)), false);
});

test('Factory recovery keeps zero history candidates pending without any follow-up read', async () => {
  const fixture = fixtureFor({ toolName: 'coloring_v4', taskIds: [], historyItems: [] });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_pending' && error.retryableRecovery === true
  );
  assert.equal(fixture.requests.length, 1);
  assert.equal(new URL(fixture.requests[0].href).pathname, '/api/task-history/v1/list/1');
});

test('Factory recovery reads only a provider task ID already recorded by Studio', async () => {
  const fixture = fixtureFor({ toolName: 'coloring_v4', taskIds: [...TASK_IDS], ledgerAmount: 30 });
  fixture.run.provider_task_id = TASK_IDS[0];

  const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });
  assert.equal(result.providerTaskId, TASK_IDS[0]);
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/task-history/v1/list/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(`/detail/${TASK_IDS[0]}`)), true);
  assert.equal(fixture.requests.some(({ href }) => href.includes(`/detail/${TASK_IDS[1]}`)), false);
});

test('Factory recovery fails closed when two completed tasks match the same frozen input', async () => {
  const fixture = fixtureFor({ toolName: 'coloring_v4', taskIds: [...TASK_IDS] });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_ambiguous' && error.retryableRecovery === false
  );
  assert.equal(fixture.requests.filter(({ href }) => href.includes('/api/task-history/v1/detail/')).length, 2);
  assert.equal(fixture.requests.filter(({ href }) => href === fixture.inputUrls.ink).length, 2);
  assert.equal(fixture.requests.some(({ href }) => href === fixture.outputUrl), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/coins/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(fixture.profile.directTaskPath)), false);
});

test('Factory recovery ignores an overlapping unfinished task and selects the sole completed match', async () => {
  const fixture = fixtureFor({
    toolName: 'line_art_beautify_v4',
    taskIds: [...TASK_IDS],
    mutateMeta: (meta, taskId) => {
      if (taskId === TASK_IDS[0]) delete meta.outputImageUrl;
    }
  });
  // The ledger belongs to the one completed candidate rather than the first
  // overlapping task returned by history.
  const originalFetch = fixture.client.fetch;
  fixture.client.fetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/coins/v1/transactions/1') {
      fixture.requests.push({ href: url.href, method: init.method, headers: init.headers || {}, body: init.body });
      return jsonResponse({ code: 0, data: { items: [{
        correlationId: TASK_IDS[1], type: 2, reason: 6, amount: 0, createAt: CREATED_AT
      }] } });
    }
    return originalFetch(rawUrl, init);
  };

  const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });
  assert.equal(result.providerTaskId, TASK_IDS[1]);
  assert.equal(fixture.requests.filter(({ href }) => href === fixture.outputUrl).length, 1);
});

test('Factory recovery rejects null or textual ledger amounts instead of treating them as zero', async () => {
  for (const invalidAmount of [null, '0']) {
    const fixture = fixtureFor({ toolName: 'coloring_v4', ledgerAmount: invalidAmount });
    await assert.rejects(
      fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
      (error) => error.code === 'factory_ledger_invalid'
    );
  }
});

test('Factory recovery requires a persisted end-of-call timestamp for its bounded task window', async () => {
  const fixture = fixtureFor({ toolName: 'coloring_v4' });
  fixture.run.provider_result_observed_at = null;
  fixture.run.finished_at = null;

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'recovery_evidence_incomplete'
  );
  assert.equal(fixture.requests.length, 0);
});

test('Factory recovery rejects a finished output that merely echoes an input URL', async () => {
  const fixture = fixtureFor({
    toolName: 'shadowing_v7',
    mutateMeta: (meta) => { meta.outputPreviewImageUrls = [meta.colorImageUrl]; }
  });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_output_invalid'
  );
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/coins/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(fixture.profile.directTaskPath)), false);
});

test('persisted Factory task identity bypasses history and cannot be substituted by a neighbouring task', async () => {
  const fixture = fixtureFor({ toolName: 'coloring_v4', taskIds: [...TASK_IDS], ledgerAmount: 30 });
  fixture.run.provider_task_id = TASK_IDS[0];

  const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });
  assert.equal(result.providerTaskId, TASK_IDS[0]);
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/task-history/v1/list/')), false);
  assert.deepEqual(
    fixture.requests.filter(({ href }) => href.includes('/api/task-history/v1/detail/'))
      .map(({ href }) => new URL(href).pathname.split('/').at(-1)),
    [TASK_IDS[0]]
  );
});

test('persisted Factory task identity fails closed instead of falling back to a matching history task', async () => {
  const fixture = fixtureFor({
    toolName: 'coloring_v4',
    taskIds: [...TASK_IDS],
    providerInputOverrides: { ink: Buffer.from('not-the-frozen-input') }
  });
  fixture.run.provider_task_id = TASK_IDS[0];

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_conflict' && error.retryableRecovery === false
  );
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/task-history/v1/list/')), false);
  assert.equal(fixture.requests.some(({ href }) => href.includes(TASK_IDS[1])), false);
});

test('Factory direct task identity conflicts are non-retryable and never reach ledger or output download', async () => {
  const fixture = fixtureFor({ toolName: 'line_art_beautify_v4' });
  const originalFetch = fixture.client.fetch;
  fixture.client.fetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname.startsWith(fixture.profile.directTaskPath)) {
      fixture.requests.push({ href: url.href, method: init.method, headers: init.headers || {}, body: init.body });
      return jsonResponse({ code: 0, data: {
        taskId: TASK_IDS[1], type: fixture.profile.taskType,
        version: fixture.profile.taskVersion, status: 2
      } });
    }
    return originalFetch(rawUrl, init);
  };

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_task_conflict' && error.retryableRecovery === false
  );
  assert.equal(fixture.requests.some(({ href }) => href.includes('/api/coins/')), false);
  assert.equal(fixture.requests.some(({ href }) => href === fixture.outputUrl), false);
});

test('Factory recovery rejects byte-identical input echo even when the output URL has a different signature and path', async () => {
  const echoed = Buffer.from('coloring_v4:ink:frozen-input');
  const fixture = fixtureFor({ toolName: 'coloring_v4', outputBuffer: echoed });

  await assert.rejects(
    fixture.client.recover({ run: fixture.run, inputs: fixture.inputs }),
    (error) => error.code === 'factory_output_invalid' && error.retryableRecovery === false
  );
  assert.equal(fixture.requests.filter(({ href }) => href === fixture.outputUrl).length, 1);
});

test('Factory history locator is bounded-paged and can find a task displaced from the first 100 rows', async () => {
  const newer = Array.from({ length: 100 }, (_, index) => ({
    taskId: `019fff82-0000-7000-8000-${String(index).padStart(12, '0')}`,
    type: 2, version: 'v4', inferenceChannel: 'slow', createAt: '2026-08-14T08:02:00.000Z'
  }));
  const fixture = fixtureFor({ toolName: 'coloring_v4', ledgerAmount: 30 });
  const originalFetch = fixture.client.fetch;
  fixture.client.fetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === '/api/task-history/v1/list/1' || url.pathname === '/api/task-history/v1/list/2') {
      fixture.requests.push({ href: url.href, method: init.method, headers: init.headers || {}, body: init.body });
      return jsonResponse({ code: 0, data: {
        totalPage: 2,
        list: url.pathname.endsWith('/1') ? newer : [{
          taskId: TASK_IDS[0], type: 2, version: 'v4', inferenceChannel: 'slow', createAt: CREATED_AT
        }]
      } });
    }
    return originalFetch(rawUrl, init);
  };

  const result = await fixture.client.recover({ run: fixture.run, inputs: fixture.inputs });
  assert.equal(result.providerTaskId, TASK_IDS[0]);
  assert.deepEqual(
    fixture.requests.filter(({ href }) => href.includes('/api/task-history/v1/list/'))
      .map(({ href }) => new URL(href).pathname),
    ['/api/task-history/v1/list/1', '/api/task-history/v1/list/2']
  );
});

test('unknown-task recovery also matches tool parameters before accepting byte-identical inputs', async () => {
  const lineart = fixtureFor({
    toolName: 'line_art_beautify_v4',
    mutateMeta: (meta) => { meta.strength = 0.75; }
  });
  await assert.rejects(
    lineart.client.recover({ run: lineart.run, inputs: lineart.inputs }),
    (error) => error.code === 'factory_task_pending'
  );
  assert.equal(lineart.requests.some(({ href }) => href.includes(lineart.profile.directTaskPath)), false);

  const color = fixtureFor({
    toolName: 'coloring_v4',
    mutateMeta: (meta) => { meta.referImageUrls = ['https://oss.miguocomics.com/external-reference.png']; }
  });
  await assert.rejects(
    color.client.recover({ run: color.run, inputs: color.inputs }),
    (error) => error.code === 'factory_task_pending'
  );
  assert.equal(color.requests.some(({ href }) => href.includes(color.profile.directTaskPath)), false);
});
