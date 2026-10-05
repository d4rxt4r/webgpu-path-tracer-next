import { describe, expect, it } from "vitest";
import { mat4, vec3 } from "gl-matrix";
import { makeStructuredView } from "webgpu-utils";
import { cornellScene } from "../src/scene/cornell";
import { defaultDielectric, dielectricMaterial } from "../src/scene/dielectric-settings";
import { cleanSurface, rastagotchiWear } from "../src/scene/surface-wear";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";
import { exportPbrt } from "../src/debug/export-pbrt";

const pack = (scene: ReturnType<typeof cornellScene>) => packTransport(scene, buildBvh(bakeTriangles(scene)));
const view = (buffer: ArrayBuffer) => makeStructuredView(definitions.structs.Material!, buffer, definitions.structs.Material!.size * 4).views as Record<string, Float32Array>;

describe("surface wear", () => {
  it("does not silently omit procedural wear from a PBRT reference", () => {
    const scene = cornellScene("nbk7");
    const material = scene.materials[4]!;
    if (material.type !== "dielectric") throw new Error("Unexpected material");
    material.surfaceWear = rastagotchiWear;
    expect(() => exportPbrt(scene, 32, 24, 16, "reference.pfm")).toThrow(/surface wear/);
    material.surfaceWear = cleanSurface;
    expect(exportPbrt(scene, 32, 24, 16, "reference.pfm")).toContain('Material "dielectric"');
  });
  it("defaults old materials to clean and preserves base roughness and spectra", () => {
    const scene = cornellScene("glass"), original = pack(scene);
    scene.materials[4] = dielectricMaterial({ ...defaultDielectric, ior: 1.5, transmission: [1, 1, 1], surfaceWear: cleanSurface }, true);
    const clean = pack(scene);
    expect(view(original.materials).wearParams).toEqual(view(clean.materials).wearParams);
    expect(view(clean.materials).wearParams!.slice(0, 3)).toEqual(new Float32Array(3));
    expect(clean.spectra).toEqual(original.spectra);
  });

  it("rejects invalid controls both at the editor and packing boundary", () => {
    for (const bad of [{ scratches: -0.1 }, { scuffs: 1.01 }, { fingerprints: NaN }, { seed: 0 }, { seed: 65536 }, { seed: 1.5 }]) {
      const wear = { ...rastagotchiWear, ...bad };
      expect(() => dielectricMaterial({ ...defaultDielectric, surfaceWear: wear }, true)).toThrow(/surface wear/);
      const scene = cornellScene("glass");
      const material = scene.materials[4]!;
      if (material.type !== "dielectric") throw new Error("Unexpected material");
      material.surfaceWear = wear;
      expect(() => pack(scene)).toThrow(/surface wear/);
    }
  });

  it("normalizes object bounds and keeps the same local point through transforms", () => {
    const scene = cornellScene("glass");
    scene.materials[4] = dielectricMaterial({ ...defaultDielectric, surfaceWear: rastagotchiWear }, true);
    const object = scene.objects[6]!, mesh = scene.meshes[object.mesh]!;
    const point = vec3.fromValues(mesh.positions[0]!, mesh.positions[1]!, mesh.positions[2]!);
    const before = view(pack(scene).materials);
    const localBefore = vec3.transformMat4(vec3.create(), vec3.transformMat4(vec3.create(), point, object.transform), before.worldToTexture!);
    const transform = mat4.create();
    mat4.translate(transform, transform, [0.13, 0.8, -0.12]);
    mat4.rotateY(transform, transform, 0.7);
    mat4.rotateX(transform, transform, -0.4);
    mat4.scale(transform, transform, [0.7, 0.7, 0.7]);
    object.transform = Array.from(transform);
    const after = view(pack(scene).materials);
    const localAfter = vec3.transformMat4(vec3.create(), vec3.transformMat4(vec3.create(), point, transform), after.worldToTexture!);
    Array.from(localAfter).forEach((value, i) => expect(value).toBeCloseTo(localBefore[i]!, 6));
    expect(after.wearBounds).toEqual(before.wearBounds);
    expect(after.wearParams).toEqual(new Float32Array([0.5, 0.5, 0.5, 1]));
    expect(Math.max(...after.wearBounds!.slice(0, 3))).toBeCloseTo(0.5);
  });

  it("rejects singular transforms and differently transformed shared instances", () => {
    const scene = cornellScene("glass");
    scene.materials[4] = dielectricMaterial({ ...defaultDielectric, surfaceWear: rastagotchiWear, mode: "thin" }, true);
    scene.objects.push({ ...scene.objects[6]!, transform: Array.from(mat4.create()) });
    expect(() => pack(scene)).toThrow(/separate material/);
    scene.objects.pop();
    scene.objects[6]!.transform = Array(16).fill(0);
    scene.objects[6]!.transform[15] = 1;
    expect(() => pack(scene)).toThrow(/transform/);
  });
});
