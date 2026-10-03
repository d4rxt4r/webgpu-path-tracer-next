import { describe, expect, it } from 'vitest';
import { bakeSpectrum, cie, constantSpectrum, d65Spectrum, integrateXyz, nbk7Absorption, nbk7Ior, spectrumValue, xyzToLinearRgb } from '../src/transport/spectrum';
import { cornellScene } from '../src/scene/cornell';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packTransport } from '../src/accel/materials';
import metadata from '../public/assets/spectra.json';

describe('spectral resources and physical units', () => {
  it('integrates D65 to neutral linear sRGB and preserves narrow-band negative RGB', () => {
    expect(cie.every(channel => channel.length === 471 && channel.every(v => Number.isFinite(v) && v >= 0))).toBe(true);
    const white = xyzToLinearRgb(integrateXyz(d65Spectrum));
    white.forEach(value => expect(value).toBeCloseTo(1, 3));
    const red = xyzToLinearRgb(integrateXyz([[360,0],[649,0],[650,1],[651,0],[830,0]]));
    expect(red[0]).toBeGreaterThan(0); expect(red[1]).toBeLessThan(0);
    expect(integrateXyz(constantSpectrum(1))[1]).toBeCloseTo(1, 5);
  });
  it('matches SCHOTT Fraunhofer indices and Abbe number with nm to micrometer conversion', () => {
    expect(nbk7Ior(587.6)).toBeCloseTo(1.51680, 5);
    expect(nbk7Ior(486.1)).toBeCloseTo(1.52238, 5);
    expect(nbk7Ior(656.3)).toBeCloseTo(1.51432, 5);
    expect((nbk7Ior(587.6)-1)/(nbk7Ior(486.1)-nbk7Ior(656.3))).toBeCloseTo(64.17, 1);
    expect(nbk7Ior(360)).toBeGreaterThan(nbk7Ior(830));
    expect(() => nbk7Ior(0.55)).toThrow('outside');
  });
  it('recovers manufacturer internal transmittance at 10 mm and compounds over meters', () => {
    for (const [nm,tau] of metadata.glass.internalTransmittance) {
      const sigma = spectrumValue(nbk7Absorption,nm!);
      expect(Math.exp(-sigma*0.01)).toBeCloseTo(tau!, 12);
      expect(Math.exp(-sigma)).toBeCloseTo(tau! ** 100, 12);
    }
  });
  it('rejects invalid spectral bounds and ordered tables; packs only explicit non-neutral spectra', () => {
    for (const table of [[[360,0],[830,-1]],[[360,0],[360,1],[830,0]],[[400,1],[700,1]],[[360,1],[830,Infinity]]]) expect(() => bakeSpectrum(table as [number,number][])).toThrow('Invalid spectrum');
    expect(() => bakeSpectrum([[360,1.1],[830,1]],true)).toThrow('Invalid spectrum');
    const scene = cornellScene('nbk7'), bvh = buildBvh(bakeTriangles(scene));
    expect(packTransport(scene,bvh).spectralReady).toBe(true);
    const red = scene.materials[1]!; if (red.type !== 'diffuse') throw new Error('fixture'); delete red.spectrum;
    expect(packTransport(scene,bvh).spectralReady).toBe(false);
  });
  it('disabling dispersion keeps the same absorption and d-line IOR', () => {
    const dispersive = cornellScene('nbk7').materials[4]!, constant = cornellScene('nbk7-constant').materials[4]!;
    expect(dispersive.type).toBe('dielectric'); expect(constant.type).toBe('dielectric');
    if (dispersive.type !== 'dielectric' || constant.type !== 'dielectric') throw new Error('fixture');
    expect(dispersive.absorptionSpectrum).toEqual(constant.absorptionSpectrum);
    expect(dispersive.ior).toBe(constant.ior); expect(constant.iorModel).toBe('constant');
  });
});
