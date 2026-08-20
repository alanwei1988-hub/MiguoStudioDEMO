import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

import { config, ensureRuntimeDirectories } from '../src/config.mjs';
import { P0Database } from '../src/db.mjs';
import { toolForStage } from '../src/domain.mjs';
import { MockProvider } from '../src/providers/mock.mjs';
import { AssetService } from '../src/services/assets.mjs';
import { RunWorker } from '../src/services/worker.mjs';

const DEMO_BATCH = '《雾港来信》第一话 · 码头相遇';
const scenes = [
  { name: '01_港口远景.png', width: 960, height: 720, palette: ['#a7b7bd','#d8c7ae','#b45c4d'], layout: 'wide' },
  { name: '02_林砚下船.png', width: 720, height: 960, palette: ['#a9b4b8','#c9b99f','#7f473f'], layout: 'single' },
  { name: '03_阿乔回头.png', width: 720, height: 960, palette: ['#b4aaa8','#e0c9b2','#345463'], layout: 'portrait' },
  { name: '04_交换信封.png', width: 800, height: 800, palette: ['#bca99f','#dbc7ad','#3d5961'], layout: 'duo' },
  { name: '05_巡逻队入画.png', width: 960, height: 720, palette: ['#a6b2b3','#c7b79e','#a04d3f'], layout: 'wide' },
  { name: '06_两人争执.png', width: 800, height: 800, palette: ['#aea4a1','#d7bfa2','#446876'], layout: 'duo' },
  { name: '07_穿过集市.png', width: 960, height: 720, palette: ['#c0b7a5','#d6c49f','#8a493d'], layout: 'crowd' },
  { name: '08_雨棚躲避.png', width: 720, height: 960, palette: ['#a6b8bf','#d0bfa4','#aa6248'], layout: 'portrait' }
];

ensureRuntimeDirectories(config);
const db = new P0Database(config.databasePath);
const existing = db.listBatches().find((batch) => batch.name === DEMO_BATCH);
if (existing) {
  process.stdout.write(`Demo batch already exists: ${existing.id}\n`);
  db.close();
  process.exit(0);
}

const assetService = new AssetService({ assetsRoot: config.assetsRoot });
const mockProvider = new MockProvider({ assetService, latencyMs: 1 });
const worker = new RunWorker({ db, assetService, providers: { mock: mockProvider }, concurrency: 1, pollMs: 5 });
const batch = db.createBatch(DEMO_BATCH);
const prepared = [];

for (const [index, scene] of scenes.entries()) {
  const panelId = randomUUID();
  const raw = await renderScene(scene, index + 1);
  const normalized = await assetService.normalizeUpload(raw, {
    batchId: batch.id,
    panelId,
    originalFilename: scene.name
  });
  prepared.push({
    panelId,
    batchId: batch.id,
    ordinal: index + 1,
    originalFilename: scene.name,
    source: {
      blobPath: normalized.relativePath,
      sha256: normalized.sha256,
      mimeType: normalized.mimeType,
      width: normalized.width,
      height: normalized.height,
      byteSize: normalized.byteSize,
      metadata: { ...normalized.metadata, demo: true, scene: scene.layout }
    }
  });
}

const created = db.addPanelsWithSourcesAtomic(prepared);
const panels = db.getBatchDetails(batch.id).panels;

await chain(panels[0], ['ink','color','light']);
await chain(panels[1], ['ink','color','light']);
await generate(panels[1], 'light', false);
await chain(panels[2], ['ink','color']);
await failStage(panels[2], 'light');
await chain(panels[3], ['ink','color']);
await generate(panels[3], 'ink', true);
await generate(panels[4], 'ink', false);
await chain(panels[5], ['ink']);
await chain(panels[7], ['ink','color','light']);

process.stdout.write(`Seeded ${created.length} demo panels into ${batch.id}\n`);
db.close();

async function chain(panel, stages) {
  for (const stage of stages) await generate(panel, stage, true);
}

async function generate(panel, stage, promote) {
  const inputVersions = db.getRequiredInputs(panel.id, stage).map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  const queued = db.queueRun({
    panelId: panel.id,
    stage,
    provider: 'mock',
    toolName: toolForStage(stage),
    params: { demoVariant: randomUUID().slice(0, 8) },
    idempotencyKey: `demo:${panel.id}:${stage}:${randomUUID()}`,
    inputVersions
  }).run;
  const claimed = db.claimNextQueued();
  if (!claimed || claimed.id !== queued.id) throw new Error('The demo task queue lost ordering.');
  await worker.process(claimed);
  const completed = db.getRun(queued.id);
  if (completed.status !== 'succeeded') throw new Error(`Demo ${stage} generation failed.`);
  if (promote) db.promoteAsset(completed.output_asset_version_id);
  return db.getAsset(completed.output_asset_version_id);
}

async function failStage(panel, stage) {
  const inputVersions = db.getRequiredInputs(panel.id, stage).map((asset) => ({ id: asset.id, role: asset.role, sha256: asset.sha256 }));
  const queued = db.queueRun({
    panelId: panel.id,
    stage,
    provider: 'mock',
    toolName: toolForStage(stage),
    params: {},
    idempotencyKey: `demo:failed:${panel.id}:${stage}`,
    inputVersions
  }).run;
  const claimed = db.claimNextQueued();
  if (!claimed || claimed.id !== queued.id) throw new Error('The demo failure task queue lost ordering.');
  db.failRun({ runId: claimed.id, code: 'network_timeout_retryable', message: 'Injected demo timeout.', durationMs: 680, costSource: 'estimate' });
}

async function renderScene(scene, index) {
  const { width, height, palette, layout } = scene;
  const [sky, paper, accent] = palette;
  const horizon = Math.round(height * (layout === 'wide' ? .56 : .42));
  const personOneX = Math.round(width * (layout === 'portrait' ? .48 : .34));
  const personTwoX = Math.round(width * .68);
  const headY = Math.round(height * .38);
  const headRadius = Math.round(Math.min(width,height) * .075);
  const sketch = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${paper}"/></linearGradient>
        <pattern id="rain" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(12)"><path d="M8 0V18 M30 16V39" stroke="#314148" stroke-opacity=".12" stroke-width="2"/></pattern>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#sky)"/>
      <rect y="${horizon}" width="${width}" height="${height-horizon}" fill="${paper}" opacity=".9"/>
      <path d="M0 ${horizon} C ${width*.23} ${horizon-35}, ${width*.48} ${horizon+23}, ${width} ${horizon-16}" fill="none" stroke="#344047" stroke-width="6" opacity=".55"/>
      <path d="M0 ${height*.18} L ${width*.22} ${height*.12} L ${width*.31} ${horizon} M ${width*.82} ${height*.09} L ${width*.68} ${horizon}" fill="none" stroke="#2d3538" stroke-width="7" opacity=".4"/>
      <g fill="none" stroke="#25292a" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="${personOneX}" cy="${headY}" r="${headRadius}" fill="#e2c3aa" stroke-width="7"/>
        <path d="M ${personOneX-headRadius*.75} ${headY-headRadius*.15} Q ${personOneX} ${headY-headRadius*1.45} ${personOneX+headRadius*.82} ${headY-headRadius*.1}" fill="#273238" stroke-width="5"/>
        <path d="M ${personOneX-headRadius*.25} ${headY+headRadius*.1} L ${personOneX-headRadius*.05} ${headY+headRadius*.12} M ${personOneX+headRadius*.25} ${headY+headRadius*.1} L ${personOneX+headRadius*.4} ${headY+headRadius*.08}" stroke-width="5"/>
        <path d="M ${personOneX-headRadius*.22} ${headY+headRadius*.58} Q ${personOneX} ${headY+headRadius*.72} ${personOneX+headRadius*.28} ${headY+headRadius*.53}" stroke-width="4"/>
        <path d="M ${personOneX-headRadius*.52} ${headY+headRadius*.85} Q ${personOneX} ${height*.54} ${personOneX-headRadius*1.15} ${height*.87} L ${personOneX+headRadius*1.35} ${height*.87} Q ${personOneX+headRadius*.9} ${height*.6} ${personOneX+headRadius*.54} ${headY+headRadius*.86}" fill="${accent}" fill-opacity=".72" stroke-width="8"/>
        ${layout === 'duo' || layout === 'wide' || layout === 'crowd' ? `<circle cx="${personTwoX}" cy="${headY+headRadius*.45}" r="${headRadius*.86}" fill="#d9bca6" stroke-width="7"/><path d="M ${personTwoX-headRadius*.72} ${headY+headRadius*.3} Q ${personTwoX} ${headY-headRadius*.72} ${personTwoX+headRadius*.77} ${headY+headRadius*.35}" fill="#4a3936" stroke-width="5"/><path d="M ${personTwoX-headRadius*.45} ${headY+headRadius*1.2} Q ${personTwoX} ${height*.62} ${personTwoX-headRadius} ${height*.88} L ${personTwoX+headRadius*1.1} ${height*.88} Q ${personTwoX+headRadius*.65} ${height*.61} ${personTwoX+headRadius*.43} ${headY+headRadius*1.2}" fill="#435e66" fill-opacity=".74" stroke-width="8"/>` : ''}
        ${layout === 'crowd' ? `<path d="M ${width*.07} ${height*.85} Q ${width*.12} ${height*.52} ${width*.2} ${height*.85} M ${width*.78} ${height*.86} Q ${width*.84} ${height*.5} ${width*.92} ${height*.86}" stroke-width="13" opacity=".55"/>` : ''}
        <path d="M ${width*.08} ${height*.91} Q ${width*.46} ${height*.82} ${width*.92} ${height*.9}" stroke-width="5" opacity=".45"/>
      </g>
      <rect width="${width}" height="${height}" fill="url(#rain)"/>
      <g fill="none" stroke="#4c5557" stroke-width="3" opacity=".34"><path d="M${width*.05} ${height*.73} Q${width*.2} ${height*.68} ${width*.27} ${height*.72}"/><path d="M${width*.7} ${height*.24} Q${width*.82} ${height*.19} ${width*.94} ${height*.27}"/><path d="M${width*.08} ${height*.3} L${width*.22} ${height*.26}"/></g>
      <rect x="16" y="16" width="${width-32}" height="${height-32}" fill="none" stroke="#f8f1e6" stroke-opacity=".55" stroke-width="3"/>
    </svg>`;
  return sharp(Buffer.from(sketch)).png({ compressionLevel: 9, palette: false }).toBuffer();
}
