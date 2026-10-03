export interface RenderSize { width: number; height: number }

/** Fit the canvas aspect ratio into both a pixel budget and device limits. */
export function fitRenderSize(width: number, height: number, dpr: number, maxPixels = 640 * 480, maxDimension = 8192): RenderSize {
  if (![width, height, dpr, maxPixels, maxDimension].every(Number.isFinite) || width <= 0 || height <= 0 || dpr <= 0 || maxPixels < 1 || maxDimension < 1) {
    throw new RangeError('Invalid render dimensions or budget');
  }
  const w = width * Math.min(dpr, 2);
  const h = height * Math.min(dpr, 2);
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)), maxDimension / w, maxDimension / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}
