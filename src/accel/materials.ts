import { makeStructuredView } from 'webgpu-utils';
import { definitions } from './pack';
import type { Bvh } from './bvh';
import type { SceneDescription } from '../scene/types';

export interface PackedTransport { materials: ArrayBuffer; lights: ArrayBuffer; lightCount: number }
export function packTransport(description: SceneDescription, bvh: Bvh): PackedTransport {
  const materialDef = definitions.structs.Material!, lightDef = definitions.structs.LightTriangle!;
  const materials = new ArrayBuffer(materialDef.size * description.materials.length);
  description.materials.forEach((material, i) => {
    if (material.type === 'dielectric') throw new Error('Стекло будет доступно на этапе 4; RGB PT пока принимает diffuse/emissive.');
    const color = material.type === 'diffuse' ? material.reflectance : material.emission;
    if (!color.every(v => Number.isFinite(v) && v >= 0 && (material.type !== 'diffuse' || v <= 1))) throw new Error('Invalid material spectrum');
    makeStructuredView(materialDef, materials, i * materialDef.size).set({ color, kind: material.type === 'diffuse' ? 0 : 1 });
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
