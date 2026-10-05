import { describe, expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";
import { definitions } from "../src/accel/pack";
import { makeStructuredView } from "webgpu-utils";
import { fastTransportShader } from "../src/transport/fast-source";
import { pathShader } from "../src/transport/shaders";
import { sppmShader } from "../src/transport/sppm-shader";
import { ObjImporter } from "../src/assets/obj-import";
import { OBJ_MAX_BYTES } from "../src/assets/obj";

const tetrahedron = `v 0 0 0
v 1 0 0
v 0 1 0
v 0 0 1
f 1 3 2
f 1 2 4
f 1 4 3
f 2 3 4`;

describe("OBJ import", () => {
  it.each([false, true])("triangulates a warped quad without flattening coordinates, reverse=%s", reverse => {
    const obj = parseObj(`v 0 0 0\nv 1 0 0\nv 1 1 1\nv 0 1 0\nvn 0 0 1\nvn 0 1 0\nf ${reverse ? "4//2 3//1 2//1 1//1" : "1//1 2//1 3//1 4//2"}`);
    expect(obj.triangles).toBe(2);
    const points = Array.from({ length: obj.mesh.positions.length / 3 }, (_, i) => Array.from(obj.mesh.positions.slice(i * 3, i * 3 + 3)).map(v => Math.round(v * 10) / 10));
    expect(new Set(points.map(p => p.join(",")))).toEqual(new Set(["-0.6,-0.6,-0.6", "0.6,-0.6,-0.6", "0.6,0.6,0.6", "-0.6,0.6,-0.6"]));
    const last = points.findIndex(p => p.join(",") === "-0.6,0.6,-0.6");
    expect(Array.from(obj.mesh.normals!.slice(last * 3, last * 3 + 3))).toEqual([0, 1, 0]);
  });
  it("triangulates a warped concave polygon", () => {
    const obj = parseObj("v 0 0 0\nv 2 0 0\nv 2 2 0.1\nv 1 1 0\nv 0 2 0\nf 1 2 3 4 5");
    expect(obj.triangles).toBe(3);
    expect(Math.max(...Array.from(obj.mesh.positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(0.03);
  });
  it("rejects crossings even when the contour has nonzero signed area", () => {
    expect(() => parseObj("v 0 0 0\nv 3 2 0\nv 0 2 0\nv 2 0 0\nf 1 2 3 4")).toThrow(/строка 5.*пересекает/);
  });
  it("rejects oversized and non-OBJ files before creating a Worker", async () => {
    const importer = new ObjImporter();
    await expect(importer.load({ name: "large.obj", size: OBJ_MAX_BYTES + 1 } as File)).rejects.toThrow(/128 MiB/);
    await expect(importer.load({ name: "model.mtl", size: 10 } as File)).rejects.toThrow(/\.obj/);
  });
  it("keeps fast and precise kernels available after adding thin glass", () => {
    expect(() => fastTransportShader(pathShader)).not.toThrow();
    expect(() => fastTransportShader(sppmShader)).not.toThrow();
  });
  it("normalizes a closed solid and accepts it as volume glass", () => {
    const obj = parseObj(tetrahedron);
    expect(obj.solid).toBe(true);
    expect(obj.triangles).toBe(4);
    expect(Math.max(...obj.mesh.positions)).toBeCloseTo(0.6);
    expect(Math.min(...obj.mesh.positions)).toBeCloseTo(-0.6);
    const scene = cornellScene("glass"); scene.meshes[6] = obj.mesh;
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).not.toThrow();
    const inverted = parseObj(tetrahedron.replace(/f (\d+) (\d+) (\d+)/g, "f $1 $3 $2"));
    scene.meshes[6] = inverted.mesh;
    expect(inverted.solid).toBe(true);
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).not.toThrow();
  });

  it("triangulates a concave polygon with negative and split normal indices", () => {
    const obj = parseObj(`v 0 0 0\nv 2 0 0\nv 2 2 0\nv 1 1 0\nv 0 2 0\nvn 0 0 2\nf -5//1 -4//1 -3//1 -2//1 -1//1`);
    expect(obj.triangles).toBe(3);
    expect(obj.solid).toBe(false);
    const scene = cornellScene("diffuse"); scene.meshes[6] = obj.mesh;
    const triangles = bakeTriangles(scene).filter(t => t.surface === 6);
    const area = triangles.reduce((sum, t) => sum + Math.abs((t.b[0] - t.a[0]) * (t.c[1] - t.a[1]) - (t.b[1] - t.a[1]) * (t.c[0] - t.a[0])) / 2, 0);
    expect(area).toBeCloseTo(3 * 0.6 ** 2);
    expect(obj.mesh.normals!.every((v, i) => v === (i % 3 === 2 ? 1 : 0))).toBe(true);
  });

  it("preserves flat faces and merges normals within smoothing groups", () => {
    const faces = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 4 2";
    const flat = parseObj(faces), smooth = parseObj(faces.replace("f 1 2 3", "s 1\nf 1 2 3"));
    expect(flat.mesh.positions.length / 3).toBe(6);
    expect(smooth.mesh.positions.length / 3).toBe(4);
    expect(smooth.mesh.normals![1]).toBeCloseTo(Math.SQRT1_2);
    expect(smooth.mesh.normals![2]).toBeCloseTo(Math.SQRT1_2);
  });

  it("does not treat separate or open components as one volume", () => {
    const open = parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3");
    expect(open.solid).toBe(false);
    const scene = cornellScene("glass"); scene.meshes[6] = open.mesh;
    const material = scene.materials[4]!;
    if (material.type !== "dielectric") throw new Error("glass fixture");
    const bvh = buildBvh(bakeTriangles(scene));
    expect(() => packTransport(scene, bvh)).toThrow(/closed/);
    material.thin = true;
    const packed = packTransport(scene, bvh);
    const value = makeStructuredView(definitions.structs.Material!, packed.materials, 4 * definitions.structs.Material!.size);
    expect((value.views.kind as Uint32Array)[0]).toBe(5);
  });

  it.each([
    "v 0 0 0\nf 0 1 1", "v NaN 0 0", "v 0 0 0\nv 1 0 0\nv 2 0 0\nf 1 2 3",
    "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4", "v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 0\nf 1 2 3",
    "v 0 0 0\nv 2 2 0\nv 0 2 0\nv 2 0 0\nf 1 2 3 4", "curv 0 1 1 2", "# empty",
  ])("rejects malformed geometry without a partial mesh", obj => { expect(() => parseObj(obj)).toThrow(); });
});
