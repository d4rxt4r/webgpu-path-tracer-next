import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseSuzanne } from '../src/assets/suzanne';
import metadata from '../src/assets/suzanne-meta.json';
import { cornellScene } from '../src/scene/cornell';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packTransport } from '../src/accel/materials';

const bytes = readFileSync(new URL('../public/assets/suzanne.bin', import.meta.url));
const data = (): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

it('preserves the shipped solid, dimensions, orientation and dielectric preparation', () => {
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
  const mesh = parseSuzanne(data());
  expect(mesh.indices.length / 3).toBe(98736);
  const scene = cornellScene('nbk7');
  scene.meshes[6] = mesh;
  scene.objects[6]!.transform = [1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,1];
  const triangles = bakeTriangles(scene);
  const bvh = buildBvh(triangles);
  // Production packing independently checks edge incidence and signed volume.
  expect(() => packTransport(scene, bvh)).not.toThrow();
  expect(bvh.maxDepth).toBeLessThan(48);
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const axis = i % 3;
    bounds[axis] = Math.min(bounds[axis]!, mesh.positions[i]!);
    bounds[axis + 3] = Math.max(bounds[axis + 3]!, mesh.positions[i]!);
  }
  expect(bounds[3]! - bounds[0]!).toBeCloseTo(1.2, 6);
  for (let axis = 0; axis < 3; axis++) expect(bounds[axis]! + bounds[axis + 3]!).toBeCloseTo(0, 7);
}, 20000);

it('rejects damaged mesh headers, layout, indices and normals', () => {
  expect(() => parseSuzanne(data().slice(0, 100))).toThrow('header');
  const layout = data(); new DataView(layout).setUint32(20, 0, true);
  expect(() => parseSuzanne(layout)).toThrow('layout');
  const indices = data(); new DataView(indices).setUint32(new DataView(indices).getUint32(24, true), 0xffffffff, true);
  expect(() => parseSuzanne(indices)).toThrow('values');
  const normals = data(); new Float32Array(normals, new DataView(normals).getUint32(20, true), 3).fill(0);
  expect(() => parseSuzanne(normals)).toThrow('normal');
});
