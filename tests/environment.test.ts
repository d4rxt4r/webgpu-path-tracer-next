import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeHdr, hdrDistribution, hdrMipmaps, solidAngle } from '../src/assets/hdr';
import { arrangeScene } from '../src/scene/environment';
import { cornellScene } from '../src/scene/cornell';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packTransport } from '../src/accel/materials';
import { rgbIlluminantSpectrum } from '../src/transport/environment-spectrum';
import { integrateXyz, xyzToLinearRgb } from '../src/transport/spectrum';
import type { SpectrumTable } from '../src/scene/types';

function flat(width: number, height: number, data: number[], axes = `-Y ${height} +X ${width}`): ArrayBuffer {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n${axes}\n`);
  const bytes = new Uint8Array(header.length + data.length); bytes.set(header); bytes.set(data, header.length); return bytes.buffer;
}
describe('HDR environment', () => {
  it('normalizes white spectral illumination and keeps colored HDR spectra nonnegative', () => {
    const white = Array.from({ length: 471 }, (_, i) => [360 + i, rgbIlluminantSpectrum([1, 1, 1], 360 + i)]) as SpectrumTable;
    expect(integrateXyz(white)[1]).toBeCloseTo(1, 6);
    xyzToLinearRgb(integrateXyz(white)).forEach(v => expect(v).toBeCloseTo(1, 1));
    for (const color of [[1, 0, 0], [.1, 10, 2], [0, 0, 0]] as [number, number, number][]) for (let wavelength = 360; wavelength <= 830; wavelength++) expect(rgbIlluminantSpectrum(color, wavelength)).toBeGreaterThanOrEqual(0);
  });
  it('preserves values above one and RGBE black', () => {
    const image = decodeHdr(flat(2, 1, [128, 64, 32, 130, 200, 200, 200, 0]));
    expect([...image.pixels]).toEqual([2, 1, .5, 1, 0, 0, 0, 1]);
  });
  it('handles reversed and X-first axis orientation', () => {
    const row = [128, 0, 0, 129, 0, 128, 0, 129];
    expect([...decodeHdr(flat(2, 1, row, '+Y 1 -X 2')).pixels]).toEqual([0, 1, 0, 1, 1, 0, 0, 1]);
    expect([...decodeHdr(flat(2, 1, row, '+X 2 -Y 1')).pixels]).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
  });
  it('decodes scanline RLE and rejects overrun, truncation and impossible sizes', () => {
    const image = decodeHdr(flat(8, 4, Array.from({ length: 4 }, () => [2, 2, 0, 8, 136, 128, 136, 64, 136, 32, 136, 130]).flat()));
    expect(image.pixels[0]).toBe(2);
    expect(() => decodeHdr(flat(8, 4, [2, 2, 0, 8, 137, 128]))).toThrow(/RLE/);
    expect(() => decodeHdr(flat(2, 1, []))).toThrow();
    expect(() => decodeHdr(flat(16384, 8192, []))).toThrow();
    expect(() => decodeHdr(flat(2, 2, []))).toThrow();
  });
  it('normalizes exact solid-angle PDFs including black maps and poles', () => {
    for (const bright of [false, true]) {
      const width = 8, height = 4, pixels = new Float32Array(width * height * 4); if (bright) pixels[0] = 10000;
      const cdf = hdrDistribution({ width, height, pixels }); let integral = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) integral += cdf.pixels[(y * width + x) * 4 + 2]! * solidAngle(width, height, y);
      expect(integral).toBeCloseTo(1, 6);
      expect(cdf.pixels[(width * height - 1) * 4 + 1]).toBe(1);
      expect(cdf.pixels.every(Number.isFinite)).toBe(true);
    }
  });
  it('retains float32 sampling support at dark polar rows beside a very bright texel', () => {
    const width = 8, height = 2048, pixels = new Float32Array(width * height * 4); pixels[0] = 1e20;
    const distribution = hdrDistribution({ width, height, pixels }); let previous = 0;
    for (let y = 0; y < height; y++) {
      const cdf = distribution.pixels[y * width * 4 + 1]!;
      expect(cdf).toBeGreaterThan(previous); previous = cdf;
      for (let x = 0; x < width; x++) expect(distribution.pixels[(y * width + x) * 4 + 2]).toBeGreaterThan(0);
    }
  });
  it('keeps spherical energy through background mip levels', () => {
    const energy = (width: number, height: number, values: Float32Array) => {
      const total = [0, 0, 0]; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) total[k] = total[k]! + values[(y * width + x) * 4 + k]! * solidAngle(width, height, y); return total;
    };
    for (const [width, height] of [[8, 4], [10, 5]] as const) {
      const pixels = new Float32Array(width * height * 4); pixels[0] = 50; pixels[width * (height - 1) * 4 + 1] = 20;
      const expected = energy(width, height, pixels);
      for (const level of hdrMipmaps({ width, height, pixels })) for (let k = 0; k < 3; k++) expect(energy(level.width, level.height, level.pixels)[k]).toBeCloseTo(expected[k]!, 5);
    }
  });
  it('opens the scene without deleting editor object indices or retaining a hidden emitter', () => {
    const scene = cornellScene('diffuse'); const old = bakeTriangles(scene).length;
    arrangeScene(scene, true, false, false);
    expect(scene.objects).toHaveLength(7);
    expect(bakeTriangles(scene)).toHaveLength(old - 12);
    expect(scene.lights).toHaveLength(0);
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).not.toThrow();
  });
  it('decodes every bundled original HDR', () => {
    for (const name of ['studio_small_09', 'kiara_1_dawn', 'venice_sunset']) {
      const file = readFileSync(`assets/hdr/${name}.hdr`), image = decodeHdr(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), 1024);
      expect([image.width, image.height]).toEqual([1024, 512]);
      expect(image.pixels.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(image.pixels.some(v => v > 1)).toBe(true);
    }
  }, 30000);
});
