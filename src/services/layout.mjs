import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sha256, stableJson } from '../security.mjs';

export const GRID_2X2_V1 = Object.freeze({
  id: 'p0-grid-2x2-v1',
  canvas: { width: 2400, height: 3200, background: '#FFFFFF', colorSpace: 'sRGB' },
  slot: { width: 1050, height: 1450, fit: 'contain' },
  positions: [
    { x: 120, y: 120 },
    { x: 1230, y: 120 },
    { x: 120, y: 1630 },
    { x: 1230, y: 1630 }
  ],
  renderer: { name: 'sharp', version: sharp.versions.sharp }
});

export class LayoutService {
  constructor({ db, assetService, exportsRoot }) {
    this.db = db;
    this.assetService = assetService;
    this.exportsRoot = exportsRoot;
  }

  safeExportPath(relativePath) {
    const absolute = path.resolve(this.exportsRoot, relativePath);
    const root = path.resolve(this.exportsRoot) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('Invalid export path.');
    return absolute;
  }

  async exportBatch(batchId) {
    const batch = this.db.getBatchDetails(batchId);
    if (!batch) throw Object.assign(new Error('Batch not found.'), { code: 'batch_not_found' });
    if (!batch.panels.length) throw Object.assign(new Error('Batch has no panels.'), { code: 'export_input_not_ready' });
    const selections = batch.panels.map((panel) => {
      const asset = panel.current.light;
      if (!asset || asset.status !== 'approved') {
        throw Object.assign(new Error(`Panel ${panel.ordinal} has no current approved lighting version.`), { code: 'export_input_not_ready' });
      }
      return { panelId: panel.id, ordinal: panel.ordinal, assetId: asset.id, assetSha256: asset.sha256, blobPath: asset.blob_path };
    });
    const inputSnapshot = { template: GRID_2X2_V1, selections };
    const manifestHash = sha256(stableJson(inputSnapshot));
    const existing = batch.exports.find((entry) => entry.manifest_hash === manifestHash);
    if (existing) return existing;

    const relativeDir = path.join(batchId, manifestHash);
    const absoluteDir = this.safeExportPath(relativeDir);
    await fs.mkdir(absoluteDir, { recursive: true });
    const pages = [];
    const pageManifests = [];

    for (let offset = 0; offset < selections.length; offset += 4) {
      const pageIndex = Math.floor(offset / 4) + 1;
      const pageItems = selections.slice(offset, offset + 4);
      const composites = [];
      const slots = [];
      for (let index = 0; index < pageItems.length; index += 1) {
        const item = pageItems[index];
        const source = await this.assetService.read(item.blobPath);
        if (sha256(source) !== item.assetSha256) {
          throw Object.assign(new Error(`Panel ${item.ordinal} failed the asset integrity check.`), {
            code: 'asset_integrity_mismatch',
            statusCode: 409
          });
        }
        const sourceInfo = await sharp(source).metadata();
        const scale = Math.min(GRID_2X2_V1.slot.width / sourceInfo.width, GRID_2X2_V1.slot.height / sourceInfo.height);
        const renderedWidth = Math.max(1, Math.round(sourceInfo.width * scale));
        const renderedHeight = Math.max(1, Math.round(sourceInfo.height * scale));
        const image = await sharp(source)
          .resize(renderedWidth, renderedHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
          .toColourspace('srgb')
          .png({ compressionLevel: 9, adaptiveFiltering: false })
          .toBuffer();
        const position = GRID_2X2_V1.positions[index];
        const left = position.x + Math.floor((GRID_2X2_V1.slot.width - renderedWidth) / 2);
        const top = position.y + Math.floor((GRID_2X2_V1.slot.height - renderedHeight) / 2);
        composites.push({ input: image, left, top });
        slots.push({
          slotIndex: index,
          panelId: item.panelId,
          ordinal: item.ordinal,
          assetVersionId: item.assetId,
          assetSha256: item.assetSha256,
          slotRect: { ...position, width: GRID_2X2_V1.slot.width, height: GRID_2X2_V1.slot.height },
          renderedRect: { x: left, y: top, width: renderedWidth, height: renderedHeight },
          scale
        });
      }
      const pipeline = sharp({
        create: {
          width: GRID_2X2_V1.canvas.width,
          height: GRID_2X2_V1.canvas.height,
          channels: 4,
          background: GRID_2X2_V1.canvas.background
        }
      }).composite(composites).toColourspace('srgb');
      const png = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
      const pixelBuffer = await sharp(png).ensureAlpha().raw().toBuffer();
      const fileName = `page-${String(pageIndex).padStart(3, '0')}.png`;
      const pageRelativePath = path.join(relativeDir, fileName).replaceAll('\\', '/');
      await fs.writeFile(this.safeExportPath(pageRelativePath), png);
      const page = {
        pageIndex,
        fileName,
        relativePath: pageRelativePath,
        sha256: sha256(png),
        pixelSha256: sha256(pixelBuffer),
        width: GRID_2X2_V1.canvas.width,
        height: GRID_2X2_V1.canvas.height,
        slots
      };
      pages.push(page);
      pageManifests.push(page);
    }

    const manifest = {
      schemaVersion: 'p0.layout-manifest.v1',
      batchId,
      inputHash: manifestHash,
      template: GRID_2X2_V1,
      pages: pageManifests
    };
    const manifestRelativePath = path.join(relativeDir, 'manifest.json').replaceAll('\\', '/');
    await fs.writeFile(this.safeExportPath(manifestRelativePath), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return this.db.saveLayoutExport({ batchId, manifestHash, manifestPath: manifestRelativePath, pages });
  }

  async readExportFile(relativePath) {
    return fs.readFile(this.safeExportPath(relativePath));
  }
}
