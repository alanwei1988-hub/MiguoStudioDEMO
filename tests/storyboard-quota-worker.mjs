import { parentPort, workerData } from 'node:worker_threads';

import { P0Database } from '../src/db.mjs';

const db = new P0Database(workerData.filename);

parentPort.once('message', ({ type }) => {
  if (type !== 'queue') return;
  try {
    const queued = db.queueStoryboardRun(workerData.spec);
    parentPort.postMessage({ ok: true, runId: queued.run.id });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: error?.code || 'unexpected_error',
      message: error?.message || String(error)
    });
  } finally {
    db.close();
  }
});

parentPort.postMessage({ type: 'ready' });
