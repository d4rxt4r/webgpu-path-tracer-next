import { describe, expect, it } from "vitest";
import { cauchyCoefficients, defaultDielectric, dielectricMaterial, hexToLinear, linearToHex } from "../src/scene/dielectric-settings";
import { buildBvh } from "../src/accel/bvh";
import { bakeTriangles } from "../src/accel/geometry";
import { packTransport } from "../src/accel/materials";
import { cornellScene } from "../src/scene/cornell";

describe("dielectric controls", () => {
  it("reconstructs reference IOR and the specified Abbe number", () => {
    for (const ior of [1, 1.5, 2.5]) for (const abbe of [10, 64, 1000]) {
      const [a, b] = cauchyCoefficients(ior, abbe), n = (nm: number) => a + b / (nm / 1000) ** 2;
      expect(n(587.6)).toBeCloseTo(ior, 12);
      if (ior > 1) expect((n(587.6) - 1) / (n(486.13) - n(656.27))).toBeCloseTo(abbe, 8);
      expect(n(360)).toBeGreaterThanOrEqual(n(830));
    }
  });
  it("keeps the default blue coefficients and changes attenuation with thickness", () => {
    const material = dielectricMaterial(defaultDielectric, true);
    if (material.type !== "dielectric") throw new Error("Unexpected material");
    material.absorption.forEach((sigma, i) => expect(sigma).toBeCloseTo([7, 4, 0.08][i]!, 12));
    const thicker = dielectricMaterial({ ...defaultDielectric, depth: 0.2 }, true);
    if (thicker.type !== "dielectric") throw new Error("Unexpected material");
    expect(thicker.absorption[0]).toBeCloseTo(3.5);
    expect(linearToHex(hexToLinear("#bad6fe"))).toBe("#bad6fe");
  });
  it("selects thin automatically, rejects forced volume for open geometry and clamps black", () => {
    expect(dielectricMaterial(defaultDielectric, false)).toMatchObject({ thin: true, absorption: [0, 0, 0] });
    expect(dielectricMaterial({ ...defaultDielectric, mode: "thin" }, true)).toMatchObject({ thin: true });
    expect(() => dielectricMaterial({ ...defaultDielectric, mode: "volume" }, false)).toThrow(/замкнутую/);
    const black = dielectricMaterial({ ...defaultDielectric, transmission: [0, 0, 0], depth: 0.0001 }, true);
    if (black.type !== "dielectric") throw new Error("Unexpected material");
    expect(black.absorption.every(Number.isFinite)).toBe(true);
  });
  it("packs finite colored spectral transport without changing material stride", () => {
    const scene = cornellScene("glass");
    scene.materials[4] = dielectricMaterial({ ...defaultDielectric, dispersion: true, roughness: 0.4 }, true);
    const packed = packTransport(scene, buildBvh(bakeTriangles(scene)));
    expect(packed.spectralReady).toBe(true);
    expect(new Float32Array(packed.spectra).every(Number.isFinite)).toBe(true);
    if (scene.materials[4]!.type !== "dielectric") throw new Error("Unexpected material");
    scene.materials[4].roughness = -1;
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).toThrow(/surface parameters/);
  });
});
