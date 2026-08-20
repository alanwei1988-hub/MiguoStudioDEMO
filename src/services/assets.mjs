import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sha256 } from '../security.mjs';

const MIME_BY_FORMAT = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

function safeName(name) {
  return path.basename(name || 'panel.png').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export class AssetService {
  constructor({ assetsRoot }) {
    this.assetsRoot = assetsRoot;
  }

  absolute(relativePath) {
    const absolute = path.resolve(this.assetsRoot, relativePath);
    const root = path.resolve(this.assetsRoot) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('Invalid asset path.');
    return absolute;
  }

  async normalizeUpload(buffer, { batchId, panelId, originalFilename }) {
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: 80_000_000 }).rotate();
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      const error = new Error('Only PNG, JPEG and WebP images are supported.');
      error.code = 'unsupported_media_type';
      error.statusCode = 422;
      throw error;
    }
    if (!metadata.width || !metadata.height) throw new Error('Image dimensions could not be read.');
    const orientedWidth = metadata.autoOrient?.width || metadata.width;
    const orientedHeight = metadata.autoOrient?.height || metadata.height;
    if (orientedWidth < 256 || orientedHeight < 256 || orientedWidth > 8192 || orientedHeight > 8192) {
      const error = new Error('Each image side must be between 256 and 8192 pixels.');
      error.code = 'invalid_image_dimensions';
      error.statusCode = 422;
      throw error;
    }
    const normalized = await image
      .flatten({ background: '#FFFFFF' })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const digest = sha256(normalized);
    const relative = path.join(batchId, panelId, 'source', `${digest.slice(0, 16)}-${safeName(originalFilename)}.png`);
    const absolute = this.absolute(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, normalized, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(absolute);
      if (sha256(existing) !== digest) throw new Error('Asset collision detected.');
    });
    return {
      relativePath: relative.replaceAll('\\', '/'),
      sha256: digest,
      mimeType: 'image/png',
      width: orientedWidth,
      height: orientedHeight,
      byteSize: normalized.length,
      metadata: {
        originalFilename,
        sourceFormat: metadata.format,
        sourceWidth: metadata.width,
        sourceHeight: metadata.height,
        sourceOrientation: metadata.orientation || 1,
        colorSpace: 'sRGB',
        normalized: true
      }
    };
  }

  async ingestGeneratedBuffer(buffer, { batchId, panelId, stage, runId, expectedWidth, expectedHeight, providerMetadata = {} }) {
    const input = sharp(buffer, { failOn: 'warning', limitInputPixels: 80_000_000 }).rotate();
    const metadata = await input.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Provider output has no readable dimensions.');
    const actualWidth = metadata.autoOrient?.width || metadata.width;
    const actualHeight = metadata.autoOrient?.height || metadata.height;
    if (actualWidth / actualHeight !== expectedWidth / expectedHeight) {
      const ratioDelta = Math.abs((actualWidth / actualHeight) - (expectedWidth / expectedHeight));
      if (ratioDelta > 0.0001) {
        const error = new Error(`Provider changed aspect ratio from ${expectedWidth}x${expectedHeight} to ${actualWidth}x${actualHeight}.`);
        error.code = 'geometry_mismatch';
        throw error;
      }
    }
    const normalized = await input
      .resize(expectedWidth, expectedHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .flatten({ background: '#FFFFFF' })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    const digest = sha256(normalized);
    const relative = path.join(batchId, panelId, stage, `${runId}-${digest.slice(0, 16)}.png`);
    const absolute = this.absolute(relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, normalized, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(absolute);
      if (existing.length !== normalized.length || sha256(existing) !== digest) {
        const collision = new Error('Generated asset path already exists with different content.');
        collision.code = 'asset_integrity_mismatch';
        throw collision;
      }
    });
    return {
      relativePath: relative.replaceAll('\\', '/'),
      sha256: digest,
      mimeType: 'image/png',
      width: expectedWidth,
      height: expectedHeight,
      byteSize: normalized.length,
      metadata: {
        providerOriginalWidth: actualWidth,
        providerOriginalHeight: actualHeight,
        workingWidth: expectedWidth,
        workingHeight: expectedHeight,
        colorSpace: 'sRGB',
        transform: actualWidth === expectedWidth && actualHeight === expectedHeight
          ? [1, 0, 0, 1, 0, 0]
          : [expectedWidth / actualWidth, 0, 0, expectedHeight / actualHeight, 0, 0],
        ...providerMetadata
      }
    };
  }

  async read(relativePath) {
    return fs.readFile(this.absolute(relativePath));
  }

  async metadata(relativePath) {
    const info = await sharp(this.absolute(relativePath)).metadata();
    return { width: info.width, height: info.height, format: info.format, mimeType: MIME_BY_FORMAT[info.format] || 'application/octet-stream' };
  }
}
