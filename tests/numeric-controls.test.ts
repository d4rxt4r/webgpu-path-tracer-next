import { describe, expect, it, vi } from 'vitest';
import { numericLimits, validNumeric } from '../src/app/numeric-controls';
import { GpuEnvironment } from '../src/gpu/environment';
import { defaultEnvironment } from '../src/scene/environment';

describe('numeric limits independent of slider scales', () => {
  it('accepts extended values and rejects invalid or unsafe values', () => {
    for (const [id, value] of Object.entries({ 'memory-budget': 16384, 'light-power': 80, 'environment-strength': 128, 'lava-power': 60, exposure: 16, 'denoise-strength': 10, radius: .5, 'texture-width': 1, 'wall-neutral': 1, fov: 178.9 }))
      expect(validNumeric(id, String(value)), id).toBe(true);
    for (const id of Object.keys(numericLimits)) {
      for (const value of ['', ' ', 'NaN', 'Infinity', '1e300']) expect(validNumeric(id, value), id).toBe(false);
      expect(validNumeric(id, String(numericLimits[id]![0] - 1)), id).toBe(false);
    }
    expect(validNumeric('fov', '179')).toBe(false);
    expect(validNumeric('memory-budget', String(Number.MAX_SAFE_INTEGER))).toBe(false);
  });
  it('validates derived and packed environment values before writing GPU data', () => {
    const writeBuffer = vi.fn();
    const environment = Object.assign(Object.create(GpuEnvironment.prototype), {
      device: { queue: { writeBuffer } }, uniform: {}, integral: 1, bounds: [0, 1, 0, 1], areaPower: 1,
      map: { mipLevelCount: 1, width: 1, height: 1 },
    }) as GpuEnvironment;
    environment.update({ ...defaultEnvironment, source: 'color', strength: 128 });
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(() => environment.update({ ...defaultEnvironment, strength: 1e100 })).toThrow();
    Object.assign(environment, { bounds: [0, 0, 0, 1e150] });
    expect(() => environment.update({ ...defaultEnvironment, source: 'color', strength: 1e30 })).toThrow();
    expect(writeBuffer).toHaveBeenCalledTimes(1);
  });
});
