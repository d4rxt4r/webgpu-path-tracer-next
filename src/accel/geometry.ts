import { mat3, mat4, vec3 } from "gl-matrix";
import type { SceneDescription, Triangle, Vec3 } from "../scene/types";

export function bakeTriangles(scene: SceneDescription): Triangle[] {
  if (scene.version !== 1) throw new Error("Unsupported scene version");
  const triangles: Triangle[] = [];
  let boundaryOffset = 1;
  for (const [surface, object] of scene.objects.entries()) {
    const mesh = scene.meshes[object.mesh];
    if (!mesh || !scene.materials[object.material])
      throw new Error("Invalid mesh or material index");
    if (
      mesh.positions.length % 3 ||
      !mesh.positions.length ||
      mesh.indices.length % 3 ||
      !mesh.indices.length ||
      !mesh.positions.every(Number.isFinite)
    )
      throw new Error("Invalid mesh arrays");
    if (
      mesh.normals &&
      (mesh.normals.length !== mesh.positions.length ||
        !mesh.normals.every(Number.isFinite))
    )
      throw new Error("Invalid normals");
    if (
      object.transform.length !== 16 ||
      !object.transform.every(Number.isFinite) ||
      object.transform[3] !== 0 ||
      object.transform[7] !== 0 ||
      object.transform[11] !== 0 ||
      object.transform[15] !== 1
    )
      throw new Error("Object transform must be finite and affine");
    if (mesh.shells && mesh.shells.length !== mesh.indices.length / 3) throw new Error("Invalid shell IDs");
    const shellCount = mesh.shells ? mesh.shells.reduce((max, id) => Math.max(max, id + 1), 0) : 1;
    if (boundaryOffset + shellCount >= 0xffffffff) throw new Error("Too many shell IDs");
    const matrix = mat4.clone(object.transform);
    const determinant = mat4.determinant(matrix);
    if (Math.abs(determinant) < 1e-12)
      throw new Error("Singular object transform");
    const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix)!;
    // Cache referenced vertices only, preserving validation and gl-matrix f32 rounding.
    const positions: Vec3[] = [],
      normals: Vec3[] = [];
    const position = (index: number): Vec3 => {
      if (index >= mesh.positions.length / 3)
        throw new Error("Mesh index out of range");
      if (!positions[index]) {
        const p = vec3.transformMat4(
          vec3.create(),
          mesh.positions.subarray(index * 3, index * 3 + 3),
          matrix,
        );
        if (!Array.from(p).every(Number.isFinite))
          throw new Error("Non-finite world position");
        positions[index] = Array.from(p) as Vec3;
      }
      return positions[index]!.slice() as Vec3;
    };
    const normal = (index: number, fallback: Vec3): Vec3 => {
      if (!mesh.normals) return fallback;
      if (!normals[index]) {
        const n = vec3.transformMat3(
          vec3.create(),
          mesh.normals.subarray(index * 3, index * 3 + 3),
          normalMatrix,
        );
        if (!Array.from(n).every(Number.isFinite) || vec3.length(n) < 1e-8)
          throw new Error("Invalid shading normal");
        vec3.normalize(n, n);
        normals[index] = Array.from(n) as Vec3;
      }
      const n = normals[index]!;
      return vec3.dot(n, fallback) < 0
        ? (n.map((value) => -value) as Vec3)
        : (n.slice() as Vec3);
    };
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ia = mesh.indices[i]!,
        ib = mesh.indices[i + (determinant < 0 ? 2 : 1)]!,
        ic = mesh.indices[i + (determinant < 0 ? 1 : 2)]!;
      const a = position(ia),
        b = position(ib),
        c = position(ic);
      const n = vec3.cross(
        vec3.create(),
        vec3.subtract(vec3.create(), b, a),
        vec3.subtract(vec3.create(), c, a),
      );
      if (!Array.from(n).every(Number.isFinite) || vec3.length(n) < 1e-12)
        throw new Error(`Degenerate or non-finite triangle ${i / 3}`);
      vec3.normalize(n, n);
      const geometric = Array.from(n) as Vec3;
      triangles.push({
        a,
        b,
        c,
        na: normal(ia, geometric),
        nb: normal(ib, geometric),
        nc: normal(ic, geometric),
        id: triangles.length,
        material: object.material,
        surface,
        boundary: boundaryOffset + (mesh.shells?.[i / 3] ?? 0),
      });
    }
    boundaryOffset += shellCount;
  }
  if (!triangles.length) throw new Error("Scene has no triangles");
  return triangles;
}
