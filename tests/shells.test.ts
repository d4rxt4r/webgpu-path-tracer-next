import { describe, expect, it } from "vitest";
import { parseObj } from "../src/assets/obj";
import { repairMesh } from "../src/assets/mesh-repair";
import { meshTopology } from "../src/assets/mesh-topology";
import { cameraShells } from "../src/accel/camera-media";
import { bakeTriangles } from "../src/accel/geometry";
import { buildBvh } from "../src/accel/bvh";
import { packBvh } from "../src/accel/pack";
import { packTransport } from "../src/accel/materials";
import { shellBox } from "../src/debug/shell-fixture";
import { mat4 } from "gl-matrix";
import type { SceneDescription, Vec3 } from "../src/scene/types";

function tetra(offset: Vec3, index: number, closed = true, reversed = false) {
  const vertices = [[0,0,0],[1,0,0],[0,1,0],[0,0,1]].map(p => `v ${p.map((v,i) => v + offset[i]!).join(" ")}`);
  const faces = [[1,3,2],[1,2,4],[1,4,3],...[closed ? [2,3,4] : []]].filter(f => f.length);
  return [...vertices, ...faces.map(f => `f ${(reversed ? f.reverse() : f).map(v => v + index).join(" ")}`)].join("\n");
}
function packedObj(text: string) {
  const obj = parseObj(text);
  const scene: SceneDescription = { version: 1, meshes: [obj.mesh], objects: [{ mesh: 0, material: 0, transform: Array.from(mat4.create()) }], materials: [{ type: "dielectric", ior: 1.5, absorption: [0.2,0.2,0.2] }], lights: [], camera: { position: [3,3,3], target: [0,0,0], up: [0,1,0], verticalFov: 40 } };
  const bvh = buildBvh(bakeTriangles(scene));
  return { obj, bvh, packed: { ...packBvh(bvh), ...packTransport(scene, bvh) } };
}
describe("independent OBJ shells", () => {
  it("imports disconnected closed shells with opposite winding and normalizes each volume", () => {
    const { obj, bvh } = packedObj(tetra([0,0,0],0) + "\n" + tetra([2,0,0],4,true,true));
    expect(obj.solid).toBe(true); expect(obj.shells).toBe(2);
    expect(meshTopology(obj.mesh).volumes.every(v => v > 0)).toBe(true);
    expect(new Set(bvh.triangles.map(t => t.boundary)).size).toBe(2);
  });
  it("repairs multiple components and leaves already closed components alone", () => {
    const source = parseObj(tetra([0,0,0],0,false) + "\n" + tetra([2,0,0],4,false,true) + "\n" + tetra([4,0,0],8));
    const before = structuredClone(source), result = repairMesh(source);
    expect(result.solid).toBe(true); expect(result.shells).toBe(3); expect(result.triangles).toBe(12);
    expect(result.repair.components?.map(c => c.closedHoles)).toEqual([1,1,0]);
    expect(source).toEqual(before);
  });
  it("rolls back all components when one cannot be repaired", () => {
    const source = parseObj(tetra([0,0,0],0,false) + "\nv 2 0 0\nv 3 0 0\nv 2 1 0\nf 5 6 7");
    const result = repairMesh(source);
    expect(result.mesh).toBe(source.mesh); expect(result.repair.success).toBe(false);
    expect(result.repair.reason).toContain("Оболочка 2");
  });
  it("classifies a camera outside, inside one shell and inside an overlap", () => {
    const { obj, packed } = packedObj(tetra([0,0,0],0) + "\n" + tetra([0.2,0.1,0.1],4));
    expect(cameraShells(packed,[4,4,4])).toHaveLength(0);
    // Recover the actual normalized coordinates rather than assuming centering.
    const base = Array.from(obj.mesh.positions.slice(0,3)) as Vec3;
    expect(cameraShells(packed,base.map(v => v + 0.04) as Vec3)).toHaveLength(1);
    expect(cameraShells(packed,base.map((v,i) => v + [0.25,0.15,0.15][i]!) as Vec3)).toHaveLength(2);
  });
  it("supports nested initial media and diagnoses more than 32 simultaneous shells", () => {
    const meshes = Array.from({length:33},(_,i) => shellBox([-2-i/10,-2-i/10,-2-i/10],[2+i/10,2+i/10,2+i/10]));
    const scene: SceneDescription = {version:1,meshes,objects:meshes.map((_,mesh)=>({mesh,material:0,transform:Array.from(mat4.create())})),materials:[{type:"dielectric",ior:1.5,absorption:[0,0,0]}],lights:[],camera:{position:[0,0,0],target:[0,0,1],up:[0,1,0],verticalFov:40}};
    const bvh=buildBvh(bakeTriangles(scene)),packed={...packBvh(bvh),...packTransport(scene,bvh)};
    expect(()=>cameraShells(packed,[0.03,0.07,0.11])).toThrow("32 оболочек");
    scene.objects.pop();const small=buildBvh(bakeTriangles(scene));
    expect(cameraShells({...packBvh(small),...packTransport(scene,small)},[0.03,0.07,0.11])).toHaveLength(32);
  });
});
