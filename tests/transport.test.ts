import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sobolSample } from "../src/transport/sampler";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";
import { makeShaderDataDefinitions } from "webgpu-utils";
import { pathShader } from "../src/transport/shaders";

const bytes = readFileSync(
  new URL("../public/assets/sobol.bin", import.meta.url),
);
const directions = new Uint32Array(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);
describe("Owen-scrambled Sobol", () => {
  it("covers every stratum once and never returns 1", () => {
    for (const dim of [0, 1, 2, 7, 58, 450, 511]) {
      const samples = Array.from({ length: 1024 }, (_, index) =>
        sobolSample(index, dim, 17, 1, directions),
      );
      expect(samples.every((value) => value >= 0 && value < 1)).toBe(true);
      expect(
        new Set(samples.map((value) => Math.floor(value * 1024))).size,
      ).toBe(1024);
    }
  });
  it("changes scrambling across pixels and seeds without changing repeatability", () => {
    const original = sobolSample(100, 5, 17, 1, directions);
    expect(sobolSample(100, 5, 17, 1, directions)).toBe(original);
    expect(sobolSample(100, 5, 18, 1, directions)).not.toBe(original);
    expect(sobolSample(100, 5, 17, 2, directions)).not.toBe(original);
  });
});
describe("RGB transport packing", () => {
  it("packs closed glass and rejects invalid absorption, IOR and open volumes", () => {
    const scene = cornellScene("glass");
    const bvh = buildBvh(bakeTriangles(scene));
    expect(packTransport(scene, bvh).materials.byteLength).toBe(
      5 * definitions.structs.Material!.size,
    );
    scene.materials[4] = { type: "dielectric", ior: 0, absorption: [0, 0, 0] };
    expect(() => packTransport(scene, bvh)).toThrow("Invalid dielectric");
    scene.materials[4] = {
      type: "dielectric",
      ior: 1.5,
      absorption: [-1, 0, 0],
    };
    expect(() => packTransport(scene, bvh)).toThrow("Invalid dielectric");
    scene.materials[4] = {
      type: "dielectric",
      ior: 1.5,
      absorption: [0, 0, 0],
    };
    scene.meshes[6]!.indices = scene.meshes[6]!.indices.slice(3);
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).toThrow(
      "closed",
    );
  });
  it("keeps the path shader within the baseline storage binding limit", () => {
    expect(
      Object.keys(makeShaderDataDefinitions(pathShader).storages).length,
    ).toBeLessThanOrEqual(8);
    expect(definitions.structs.DisplayParams!.size).toBe(16);
    expect(definitions.structs.CameraParams!.fields.tile!.offset).toBe(80);
    expect(definitions.structs.CameraParams!.fields.lightCount!.offset).toBe(
      108,
    );
  });
  it("normalizes area sampling and packs all emitters", () => {
    const scene = cornellScene(),
      packed = packTransport(scene, buildBvh(bakeTriangles(scene)));
    expect(packed.lightCount).toBe(2);
    const floats = new Float32Array(packed.lights);
    const stride = definitions.structs.LightTriangle!.size / 4;
    const probability =
      definitions.structs.LightTriangle!.fields.probability!.offset / 4;
    const cdf = definitions.structs.LightTriangle!.fields.cdf!.offset / 4;
    expect(floats[probability]! + floats[stride + probability]!).toBe(1);
    expect(floats[stride + cdf]).toBe(1);
    expect(packed.materials.byteLength).toBe(
      scene.materials.length * definitions.structs.Material!.size,
    );
  });
  it("rejects energy-creating diffuse materials and missing/duplicated emitters", () => {
    const scene = cornellScene(),
      bvh = buildBvh(bakeTriangles(scene));
    scene.materials[0] = { type: "diffuse", reflectance: [1.1, 0.5, 0.5] };
    expect(() => packTransport(scene, bvh)).toThrow("Invalid material");
    scene.materials[0] = { type: "diffuse", reflectance: [0.5, 0.5, 0.5] };
    scene.lights = [];
    expect(() => packTransport(scene, bvh)).toThrow("missing");
    scene.lights = [{ object: 5 }, { object: 5 }];
    expect(() => packTransport(scene, bvh)).toThrow("Duplicate");
  });
});
