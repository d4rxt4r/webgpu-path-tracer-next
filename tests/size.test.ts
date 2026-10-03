import { describe, expect, it } from 'vitest';
import { fitRenderSize } from '../src/render/size';

describe('render size budget', () => {
  it('preserves aspect ratio and caps high DPR by pixel budget', () => {
    const result = fitRenderSize(1920, 1080, 4);
    expect(result.width * result.height).toBeLessThanOrEqual(640 * 480);
    expect(result.width / result.height).toBeCloseTo(1920 / 1080, 2);
  });
  it('respects device texture dimensions', () => {
    expect(fitRenderSize(10000, 100, 1, 1000000, 512)).toEqual({ width: 512, height: 5 });
  });
  it('keeps small canvases and rejects invalid inputs', () => {
    expect(fitRenderSize(100, 75, 1)).toEqual({ width: 100, height: 75 });
    expect(() => fitRenderSize(0, 10, 1)).toThrow(RangeError);
    expect(() => fitRenderSize(10, 10, NaN)).toThrow(RangeError);
  });
});
