import { expect, it } from 'vitest';
import { cornellScene } from '../src/scene/cornell';
import { preparedKey, sceneKeys, cachedGeometry, cachedTransport } from '../src/assets/prepared-cache';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packBvh } from '../src/accel/pack';
import { unpackBvh } from '../src/accel/unpack';
import { packTransport } from '../src/accel/materials';

it('excludes camera and environment but keys every prepared geometry and material input', async () => {
  const original = cornellScene('nbk7'), key = await preparedKey(original);
  const camera = structuredClone(original); camera.camera.position[0] += 1;
  expect(await preparedKey(camera)).toBe(key);
  for (const change of [
    (scene: typeof original) => { scene.version = 2 as 1; },
    (scene: typeof original) => { scene.meshes[0]!.positions[0]! += 0.1; },
    (scene: typeof original) => { scene.objects[0]!.transform[0]! += 0.1; },
    (scene: typeof original) => { scene.objects[0]!.visible = false; },
    (scene: typeof original) => { scene.materials[0] = { type: 'diffuse', reflectance: [0.2, 0.3, 0.4] }; },
    (scene: typeof original) => { scene.meshes[0]!.shells = new Uint32Array(scene.meshes[0]!.indices.length / 3).fill(7); },
    (scene: typeof original) => { scene.meshes[0]!.normals = new Float32Array(scene.meshes[0]!.positions.length).fill(0.5); },
  ]) { const scene = structuredClone(original); change(scene); expect(await preparedKey(scene)).not.toBe(key); }
});
it('falls back when browser storage is unavailable', async () => {
  expect(await cachedGeometry('missing')).toBeUndefined();
  expect(await cachedTransport('missing')).toBeUndefined();
});

it('reuses geometry identity when only material values change', async () => {
  const scene = cornellScene('nbk7'), before = await sceneKeys(scene);
  scene.materials[0] = {type: 'diffuse', reflectance: [0.2, 0.3, 0.4]};
  const after = await sceneKeys(scene);
  expect(after.geometry).toBe(before.geometry);
  expect(after.prepared).not.toBe(before.prepared);
});

it('restores identical geometry and material buffers from packed Float32 data', () => {
  const scene = cornellScene('nbk7');
  const original = buildBvh(bakeTriangles(scene)), packed = packBvh(original);
  const restored = unpackBvh(packed), repacked = packBvh(restored);
  expect(restored).toEqual(original);
  for (const key of ['nodes', 'triangles'] as const)
    expect(new Uint8Array(repacked[key])).toEqual(new Uint8Array(packed[key]));
  const before = packTransport(scene, original), after = packTransport(scene, restored);
  for (const key of ['materials', 'lights', 'spectra'] as const)
    expect(new Uint8Array(after[key])).toEqual(new Uint8Array(before[key]));
});
