import type { MeshData, SceneDescription, Vec3 } from "../scene/types";

export function shellBox(min: Vec3, max: Vec3): MeshData {
  const [x,y,z] = min, [X,Y,Z] = max;
  return { positions: new Float32Array([x,y,z,X,y,z,X,Y,z,x,Y,z,x,y,Z,X,y,Z,X,Y,Z,x,Y,Z]),
    indices: new Uint32Array([0,3,2,0,2,1,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]) };
}
export function shellScene(kind: "overlap" | "nested" | "touching" | "disjoint" | "reference", inside = false): SceneDescription {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const boxes = kind === "overlap" ? [shellBox([-2,-2,0],[2,2,2]),shellBox([-1.8,-1.7,1],[2.2,2.3,3])]
    : kind === "nested" ? [shellBox([-2,-2,0],[2,2,3]),shellBox([-1,-1,1],[1,1,2])]
    : kind === "disjoint" ? [shellBox([-2,-2,0],[2,2,1]),shellBox([-1.8,-1.7,2],[2.2,2.3,3])]
    : kind === "touching" ? [shellBox([-2,-2,0],[2,2,1]),shellBox([-2,-2,1],[2,2,3])]
    : [shellBox([-2,-2,0],[2,2,3])];
  const emitter: MeshData = { positions: new Float32Array([-5,-5,4,-5,5,4,5,5,4,5,-5,4]),indices: new Uint32Array([0,1,2,0,2,3]) };
  return { version: 1, meshes: [...boxes,emitter], objects: [...boxes,emitter].map((_,mesh) => ({ mesh,material: mesh===boxes.length ? 1 : 0,transform: identity })),
    materials: [{ type: "dielectric",ior: 1.5,absorption: [0.2,0.5,1] },{ type: "emissive",emission: [1,1,1] }], lights: [{ object: boxes.length }],
    camera: { position: [0.07,0.13,inside ? 1.5 : -1],target: [0.07,0.13,4],up: [0,1,0],verticalFov: 0.01 } };
}
