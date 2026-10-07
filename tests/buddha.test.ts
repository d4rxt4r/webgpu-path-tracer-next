import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mat4 } from "gl-matrix";
import { expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";
import { repairMesh } from "../src/assets/mesh-repair";
import { meshTopology } from "../src/assets/mesh-topology";
import metadata from "../assets/Buddha-source.json";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";

// Source provenance uses Git's canonical LF bytes, including on CRLF checkouts.
const bytes = Buffer.from(readFileSync(new URL("../assets/Buddha.obj", import.meta.url), "utf8").replace(/\r\n/g, "\n"));
it("ships the full original Buddha as OBJ with its source geometry intact", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(metadata.objSha256);
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  expect(lines.filter(line => line.startsWith("v "))).toHaveLength(543652);
  expect(lines.filter(line => line.startsWith("f "))).toHaveLength(1087716);
  const obj = parseObj(text, { maxDimension: 1.7, skipDegenerateTriangles: true });
  expect(obj.triangles + (obj.skippedDegenerateTriangles ?? 0)).toBe(metadata.triangles);
  expect(obj.skippedDegenerateTriangles).toBe(242);
  const positions = obj.mesh.positions;
  let low = Infinity, high = -Infinity;
  for (let i = 1; i < positions.length; i += 3) { low = Math.min(low, positions[i]!); high = Math.max(high, positions[i]!); }
  expect(high - low).toBeCloseTo(1.7, 6);
  const repaired = repairMesh(obj);
  expect(repaired.repair, JSON.stringify(repaired.repair)).toMatchObject({ success: true, removedFaces: 50, collapsedEdges: 1 });
  expect(repaired.solid).toBe(true);
  expect(meshTopology(repaired.mesh).solid).toBe(true);
  expect(repaired.triangles).toBe(1087424);
  expect(obj.triangles).toBe(1087474);
}, 120000);

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
