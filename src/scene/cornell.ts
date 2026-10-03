import { mat4 } from 'gl-matrix';
import type { MeshData, SceneDescription, Vec3 } from './types';

function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): MeshData {
  return { positions: new Float32Array([...a, ...b, ...c, ...d]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

/** Closed, outward-oriented control sphere; Suzanne is introduced at stage 8. */
export function sphereMesh(segments = 32, rings = 16, radius = 0.45): MeshData {
  const positions: number[] = [0, radius, 0];
  const indices: number[] = [];
  for (let ring = 1; ring < rings; ring++) {
    const theta = ring * Math.PI / rings;
    for (let i = 0; i < segments; i++) {
      const phi = i * 2 * Math.PI / segments;
      positions.push(radius * Math.sin(theta) * Math.cos(phi), radius * Math.cos(theta), radius * Math.sin(theta) * Math.sin(phi));
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, -radius, 0);
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.push(0, 1 + next, 1 + i);
    for (let ring = 0; ring < rings - 2; ring++) {
      const a = 1 + ring * segments + i, b = 1 + ring * segments + next;
      const c = a + segments, d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
    const last = 1 + (rings - 2) * segments;
    indices.push(last + i, last + next, bottom);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(positions.map(value => value / radius)), indices: new Uint32Array(indices) };
}

export function cornellScene(sphere: 'diffuse' | 'glass' = 'diffuse'): SceneDescription {
  const meshes = [
    quad([-1, 0, 1], [1, 0, 1], [1, 0, -1], [-1, 0, -1]),
    quad([-1, 2, -1], [1, 2, -1], [1, 2, 1], [-1, 2, 1]),
    quad([-1, 0, -1], [1, 0, -1], [1, 2, -1], [-1, 2, -1]),
    quad([-1, 0, 1], [-1, 0, -1], [-1, 2, -1], [-1, 2, 1]),
    quad([1, 0, -1], [1, 0, 1], [1, 2, 1], [1, 2, -1]),
    quad([-0.3, 1.99, -0.3], [0.3, 1.99, -0.3], [0.3, 1.99, 0.3], [-0.3, 1.99, 0.3]),
    sphereMesh(),
  ];
  const identity = Array.from(mat4.create());
  const sphereTransform = Array.from(mat4.fromTranslation(mat4.create(), [0, 0.65, 0]));
  return {
    version: 1, meshes,
    objects: meshes.map((_, mesh) => ({ mesh, material: mesh === 3 ? 1 : mesh === 4 ? 2 : mesh === 5 ? 3 : mesh === 6 ? 4 : 0, transform: mesh === 6 ? sphereTransform : identity })),
    materials: [ { type: 'diffuse', reflectance: [0.73, 0.73, 0.73] }, { type: 'diffuse', reflectance: [0.65, 0.05, 0.05] }, { type: 'diffuse', reflectance: [0.05, 0.65, 0.05] }, { type: 'emissive', emission: [12, 12, 12] }, sphere === 'glass' ? { type: 'dielectric', ior: 1.5, absorption: [0.15, 0.03, 0.01] } : { type: 'diffuse', reflectance: [0.65, 0.65, 0.65] } ],
    lights: [{ object: 5 }],
    camera: { position: [0, 1, 3.7], target: [0, 1, 0], up: [0, 1, 0], verticalFov: 40 },
  };
}
