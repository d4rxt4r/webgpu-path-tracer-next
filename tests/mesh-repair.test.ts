import { describe, expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";
import { repairMesh } from "../src/assets/mesh-repair";
import { meshTopology } from "../src/assets/mesh-topology";
import { cornellScene } from "../src/scene/cornell";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packTransport } from "../src/accel/materials";

const openTetra = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3";
describe("mesh hole repair", () => {
  it("caps an open solid, preserves source arrays and supports volume glass", () => {
    const source = parseObj(openTetra), before = structuredClone(source);
    const repaired = repairMesh(source);
    expect(repaired.repair).toMatchObject({ success: true, closedHoles: 1 });
    expect(repaired.solid).toBe(true);
    expect(repaired.triangles).toBe(4);
    expect(source).toEqual(before);
    expect(Array.from(repaired.mesh.positions.slice(0, source.mesh.positions.length))).toEqual(Array.from(source.mesh.positions));
    expect(Array.from(repaired.mesh.normals!.slice(0, source.mesh.normals!.length))).toEqual(Array.from(source.mesh.normals!));
    expect(meshTopology(repaired.mesh).volume).toBeGreaterThan(0);
    const scene = cornellScene("glass"); scene.meshes[6] = repaired.mesh;
    expect(() => packTransport(scene, buildBvh(bakeTriangles(scene)))).not.toThrow();
  });
  it("fixes inconsistent winding before finding the boundary", () => {
    const repaired = repairMesh(parseObj(openTetra.replace("f 1 2 4", "f 1 4 2")));
    expect(repaired.repair.success).toBe(true);
    expect(meshTopology(repaired.mesh).solid).toBe(true);
  });
  it("closes two holes in a connected tube", () => {
    const obj = parseObj("v -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1");
    const repaired = repairMesh(obj);
    expect(repaired.repair).toMatchObject({ success: true, closedHoles: 2 });
    expect(repaired.triangles).toBe(12);
    expect(repaired.solid).toBe(true);
  });
  it("leaves an already closed model unchanged", () => {
    const obj = parseObj(openTetra + "\nf 2 3 4");
    const repaired = repairMesh(obj);
    expect(repaired.repair).toMatchObject({ success: true, closedHoles: 0 });
    expect(repaired.mesh).toEqual(obj.mesh);
  });
  it("returns the exact source after a zero-volume cap or nonmanifold failure", () => {
    for (const text of ["v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3", openTetra + "\nf 1 3 2"]) {
      const obj = parseObj(text), repaired = repairMesh(obj);
      expect(repaired.repair.success).toBe(false);
      expect(repaired.repair.closedHoles).toBe(0);
      expect(repaired.mesh).toBe(obj.mesh);
    }
  });
});
