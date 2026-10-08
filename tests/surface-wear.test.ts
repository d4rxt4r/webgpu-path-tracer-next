import { describe, expect, it } from "vitest";
import { mat4, vec3 } from "gl-matrix";
import { makeStructuredView } from "webgpu-utils";
import { cornellScene } from "../src/scene/cornell";
import { defaultDielectric, dielectricMaterial } from "../src/scene/dielectric-settings";
import { cleanSurface, rastagotchiWear, normalizeSurfaceWear, surfaceWearMask, validateSurfaceWear, packWearEffect } from "../src/scene/surface-wear";
import { wearMetric } from "../src/scene/wear-space";
import { pathShader } from "../src/transport/shaders";
import { specializeSurfaceWear } from "../src/transport/wear-source";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";
import { exportPbrt } from "../src/debug/export-pbrt";

const pack = (scene: ReturnType<typeof cornellScene>) => packTransport(scene, buildBvh(bakeTriangles(scene)));
const view = (buffer: ArrayBuffer) => makeStructuredView(definitions.structs.Material!, buffer, definitions.structs.Material!.size * 4).views as Record<string, Float32Array>;

describe("surface wear", () => {
  it("migrates legacy settings, owns nested state and retains disabled settings", () => {
    const wear = normalizeSurfaceWear({scratches: .3, scuffs: 0, fingerprints: .7, seed: 37});
    expect(wear.scratches.seed).toBe(37);
    expect(wear.fingerprints.seed).toBe(37);
    expect(wear.scuffs.enabled).toBe(false);
    expect(wear.scuffs.intensity).toBe(.5);
    wear.scuffs.scale = 4; wear.scuffs.seed = 123;
    const copy = normalizeSurfaceWear(wear); copy.scuffs.seed = 8;
    expect(wear.scuffs.seed).toBe(123);
    expect(copy.scuffs.scale).toBe(4);
    expect(surfaceWearMask(wear)).toBe(5);
    wear.scratches.intensity = 0;
    wear.fingerprints.count = 0;
    expect(surfaceWearMask(wear)).toBe(0);
    expect(cleanSurface.scuffs.scale).toBe(1);
    const material = dielectricMaterial({...defaultDielectric, surfaceWear: wear}, true);
    wear.scuffs.scale = 2;
    expect(material.type === "dielectric" && normalizeSurfaceWear(material.surfaceWear).scuffs.scale).toBe(4);
  });

  it("validates new settings even while disabled and packs each independent seed", () => {
    const wear = normalizeSurfaceWear(rastagotchiWear);
    wear.scratches.seed = 11; wear.scuffs.seed = 22; wear.fingerprints.seed = 33;
    expect(packWearEffect("scuffs", wear.scuffs).base[1]).toBe(22);
    for (const bad of [NaN, 0, 65536, 1.5]) {
      wear.scratches.enabled = false; wear.scratches.seed = bad;
      expect(() => validateSurfaceWear(wear)).toThrow(/surface wear/);
    }
    wear.scratches.seed = 11; wear.scratches.scale = .001;
    expect(() => validateSurfaceWear(wear)).toThrow(/scale/);
    wear.scratches.space = "scene";
    expect(() => validateSurfaceWear(wear)).not.toThrow();
  });

  it("physical metric preserves lengths under shear, reflection and rotation", () => {
    for (const reflected of [false, true]) {
      const transform = mat4.fromValues(reflected ? -2 : 2, .1, 0, 0, .7, .5, 0, 0, .2, .3, 3, 0, 1, 2, 3, 1);
      const metric = wearMetric(Array.from(transform), 1);
      for (const v of [[1,0,0], [0,1,0], [0,0,1], [.3,-.7,.2]]) {
        const apply = (m: ArrayLike<number>) => v.map((_, row) => v.reduce((sum, n, col) => sum + m[col*4+row]! * n, 0));
        expect(Math.hypot(...apply(metric))).toBeCloseTo(Math.hypot(...apply(transform)), 10);
      }
      for (let c=0;c<3;c++) for(let r=0;r<3;r++) expect(metric[c*4+r]).toBeCloseTo(metric[r*4+c]!, 10);
      const rotation = mat4.fromYRotation(mat4.create(), .8);
      mat4.multiply(rotation, rotation, transform);
      wearMetric(Array.from(rotation), 1).forEach((v, i) => expect(v).toBeCloseTo(metric[i]!, 6));
    }
  });

  it("strips unused effect code and emits a procedural-free clean variant", () => {
    const clean = specializeSurfaceWear(pathShader, 0);
    expect(clean).not.toContain("fn wearNoise");
    expect(clean).not.toContain("fn wearPlane");
    const scratches = specializeSurfaceWear(pathShader, 1);
    expect(scratches).toContain("let halfLength=");
    expect(scratches).not.toContain("let abrasion=");
    expect(scratches).not.toContain("let ellipse=");
  });
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
      const wear = { scratches: .5, scuffs: .5, fingerprints: .5, seed: 1, ...bad };
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
