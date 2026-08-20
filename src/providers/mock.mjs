import sharp from 'sharp';

const COST_POINTS = Object.freeze({ ink: 20, color: 30, light: 30 });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class MockProvider {
  constructor({ assetService, latencyMs = 80, faultMode = 'none' }) {
    this.assetService = assetService;
    this.latencyMs = latencyMs;
    this.faultMode = faultMode;
    this.injected = new Set();
  }

  async execute({ run, inputs }) {
    const faultKey = `${this.faultMode}:${run.stage}`;
    if (this.faultMode === 'network_once' && !this.injected.has(faultKey)) {
      this.injected.add(faultKey);
      const error = new Error('Injected pre-submit network timeout.');
      error.code = 'network_timeout_retryable';
      throw error;
    }

    await sleep(this.latencyMs);
    const primary = inputs[0];
    const source = await this.assetService.read(primary.blob_path);
    let pipeline = sharp(source).ensureAlpha();

    if (run.stage === 'ink') {
      pipeline = pipeline
        .grayscale()
        .normalize()
        .linear(1.35, -24)
        .threshold(142);
    } else if (run.stage === 'color') {
      pipeline = pipeline
        .tint({ r: 218, g: 190, b: 166 })
        .modulate({ saturation: 0.92, brightness: 1.04 });
    } else if (run.stage === 'light') {
      const overlay = Buffer.from(`<svg width="${primary.width}" height="${primary.height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(255,238,188,0.18)"/><stop offset="1" stop-color="rgba(42,36,78,0.24)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
      pipeline = pipeline.composite([{ input: overlay, blend: 'soft-light' }]);
    }

    const buffer = await pipeline
      .resize(primary.width, primary.height, { fit: 'fill' })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();

    return {
      buffer,
      providerRequestId: `mock-${run.id}`,
      costPoints: COST_POINTS[run.stage] || 0,
      costSource: 'mock',
      metadata: { provider: 'mock', tool: run.tool_name, deterministic: true }
    };
  }
}
