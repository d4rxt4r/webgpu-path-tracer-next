import { makeStructuredView } from 'webgpu-utils';
import { definitions } from './pack';
import type { Bvh } from './bvh';
import type { SceneDescription } from '../scene/types';

export interface PackedTransport { materials: ArrayBuffer; lights: ArrayBuffer; lightCount: number }
export function packTransport(description: SceneDescription, bvh: Bvh): PackedTransport {
  for (const [surface, object] of description.objects.entries()) {
    if (description.materials[object.material]?.type !== 'dielectric') continue;
    const edges = new Map<string, { count: number; orientation: number }>();
    let volume = 0;
    for (const t of bvh.triangles) {
      if (t.surface !== surface) continue;
      volume += t.a[0] * (t.b[1] * t.c[2] - t.b[2] * t.c[1]) + t.a[1] * (t.b[2] * t.c[0] - t.b[0] * t.c[2]) + t.a[2] * (t.b[0] * t.c[1] - t.b[1] * t.c[0]);
      const vertices = [t.a.join(','), t.b.join(','), t.c.join(',')];
      for (let i = 0; i < 3; i++) {
        const a = vertices[i]!, b = vertices[(i + 1) % 3]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = edges.get(key) ?? { count: 0, orientation: 0 };
        edge.count++; edge.orientation += a < b ? 1 : -1; edges.set(key, edge);
      }
    }
    if (volume <= 0 || edges.size === 0 || [...edges.values()].some(edge => edge.count !== 2 || edge.orientation !== 0)) throw new Error('Dielectric requires a closed, outward-oriented manifold');
  }
  const materialDef = definitions.structs.Material!, lightDef = definitions.structs.LightTriangle!;
  const materials = new ArrayBuffer(materialDef.size * description.materials.length);
  description.materials.forEach((material, i) => {
    if (material.type === 'dielectric') {
      if (!Number.isFinite(Math.fround(material.ior)) || material.ior < 1 || !material.absorption.every(v => Number.isFinite(Math.fround(v)) && v >= 0)) throw new Error('Invalid dielectric material');
      makeStructuredView(materialDef, materials, i * materialDef.size).set({ color: [1, 1, 1], kind: 2, absorption: material.absorption, ior: material.ior });
      return;
    }
    const color = material.type === 'diffuse' ? material.reflectance : material.emission;
    if (!color.every(v => Number.isFinite(v) && v >= 0 && (material.type !== 'diffuse' || v <= 1))) throw new Error('Invalid material spectrum');
    makeStructuredView(materialDef, materials, i * materialDef.size).set({ color, kind: material.type === 'diffuse' ? 0 : 1, absorption: [0, 0, 0], ior: 1 });
  });
  const objects = new Set(description.lights.map(light => light.object));
  if (objects.size !== description.lights.length) throw new Error('Duplicate area light');
  for (const object of objects) if (!description.objects[object] || description.materials[description.objects[object]!.material]?.type !== 'emissive') throw new Error('Invalid area light object');
  // Every emitter must participate in both light and BSDF estimates.
  for (const [i, object] of description.objects.entries()) if (description.materials[object.material]?.type === 'emissive' && !objects.has(i)) throw new Error('Emissive object missing from area lights');
  const lightTriangles = bvh.triangles.filter(triangle => objects.has(triangle.surface));
  const areas = lightTriangles.map(t => {
    const ab = t.b.map((v, i) => v - t.a[i]!), ac = t.c.map((v, i) => v - t.a[i]!);
    return 0.5 * Math.hypot(ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!);
  });
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const lights = new ArrayBuffer(Math.max(1, lightTriangles.length) * lightDef.size);
  let cdf = 0;
  lightTriangles.forEach((triangle, i) => {
    const material = description.materials[triangle.material]!;
    if (material.type !== 'emissive') throw new Error('Invalid emitter');
    const probability = areas[i]! / totalArea; cdf += probability;
    makeStructuredView(lightDef, lights, i * lightDef.size).set({ ...triangle, area: areas[i], probability, emission: material.emission, triangleId: triangle.id, cdf: i === lightTriangles.length - 1 ? 1 : cdf });
  });
  return { materials, lights, lightCount: lightTriangles.length };
}
