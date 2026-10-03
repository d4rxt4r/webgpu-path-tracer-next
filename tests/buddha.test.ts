import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mat4 } from "gl-matrix";
import { expect, it } from "vitest";
import { parseBuddha } from "../src/assets/buddha";
import metadata from "../src/assets/buddha-meta.json";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";

const bytes = readFileSync(
  new URL("../public/assets/buddha.bin", import.meta.url),
);
const data = () =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

it("ships a checked, closed Buddha within the detailed mesh budget", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    metadata.sha256,
  );
  const scene = cornellScene("glass");
  scene.meshes[6] = parseBuddha(data());
  scene.objects[6]!.transform = Array.from(
    mat4.fromTranslation(mat4.create(), [0, 0.86, 0]),
  );
  expect(scene.meshes[6]!.indices.length / 3).toBe(metadata.triangles);
  expect(metadata.triangles).toBeLessThanOrEqual(96000);
  const bvh = buildBvh(bakeTriangles(scene));
  expect(bvh.maxDepth).toBeLessThan(48);
  expect(() => packTransport(scene, bvh)).not.toThrow();
  expect(() => parseBuddha(data().slice(0, 100))).toThrow("header");
}, 20000);

it("registers every lava triangle as a sampled emitter with object-local coordinates", () => {
  const scene = cornellScene("lava");
  scene.objects[6]!.transform = Array.from(
    mat4.fromTranslation(mat4.create(), [0.2, 0.65, 0]),
  );
  const packed = packTransport(scene, buildBvh(bakeTriangles(scene)));
  expect(packed.spectralReady).toBe(true);
  expect(packed.lightCount).toBe(scene.meshes[6]!.indices.length / 3 + 2);
  const values = new Float32Array(packed.lights),
    words = new Uint32Array(packed.lights);
  const def = definitions.structs.LightTriangle!,
    stride = def.size / 4;
  let probability = 0,
    lastId = -1;
  for (let i = 0; i < packed.lightCount; i++) {
    probability += values[i * stride + def.fields.probability!.offset / 4]!;
    const id = words[i * stride + def.fields.triangleId!.offset / 4]!;
    expect(id).toBeGreaterThan(lastId);
    lastId = id;
  }
  expect(probability).toBeCloseTo(1, 6);
  const materialDef = definitions.structs.Material!;
  const matrix = new Float32Array(
    packed.materials,
    4 * materialDef.size + materialDef.fields.worldToTexture!.offset,
    16,
  );
  expect(matrix[12]).toBeCloseTo(-0.2);
  expect(matrix[13]).toBeCloseTo(-0.65);
  scene.lights.pop();
  expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).toThrow(
    "missing",
  );
  scene.lights.push({ object: 6 });
  if (scene.materials[4]!.type === "lava") scene.materials[4]!.coating = 1.1;
  expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).toThrow(
    "Invalid textured",
  );
});
