import type { SceneDescription } from '../scene/types';
import type { PackedScene } from '../accel/pack';
import type { PackedTransport } from '../accel/materials';
import { definitions } from '../accel/pack';
import { readCached, writeCached } from './persistent-cache';
import geometry from '../accel/geometry.ts?raw';
import bvh from '../accel/bvh.ts?raw';
import pack from '../accel/pack.ts?raw';
import unpack from '../accel/unpack.ts?raw';
import materials from '../accel/materials.ts?raw';
import layouts from '../transport/layouts.wgsl?raw';
import spectrum from '../transport/spectrum.ts?raw';
import wearSpace from '../scene/wear-space.ts?raw';
import wear from '../scene/surface-wear.ts?raw';
import spectralData from './spectral-data.json?raw';
import spectralMetadata from './spectral-meta.json?raw';
import dependencies from '../../package-lock.json?raw';

async function hash(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
const encoder = new TextEncoder();
const textHash = (value: unknown): Promise<string> => hash(encoder.encode(JSON.stringify(value)).buffer);
let geometryVersion: Promise<string> | undefined, transportVersion: Promise<string> | undefined;

/** Every byte and typed-array interpretation is part of the geometry identity.
 * Material values use a separate identity; material slots remain geometry input. */
export async function sceneKeys(scene: SceneDescription): Promise<{geometry: string; prepared: string}> {
  const meshes = await Promise.all(scene.meshes.map(mesh => Promise.all(
    ['positions', 'indices', 'normals', 'shells'].map(async name => {
      const array = mesh[name as keyof typeof mesh];
      return array ? [array.constructor.name, await hash(array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength) as ArrayBuffer)] : null;
    }))));
  const normalize = (sources: string[]): string[] => sources.map(source => source.replaceAll('\r\n', '\n'));
  geometryVersion ??= textHash(normalize([geometry, bvh, pack, layouts, dependencies]));
  transportVersion ??= textHash(normalize([unpack, materials, layouts, spectrum, wear, wearSpace, spectralData, spectralMetadata, dependencies]));
  const [geometryImplementation, transportImplementation] = await Promise.all([geometryVersion, transportVersion]);
  const geometryKey = 'geometry-2:' + await textHash({ version: scene.version, implementation: geometryImplementation, meshes, objects: scene.objects, materialSlots: Array.from(scene.materials, material => Boolean(material)) });
  const prepared = 'transport-2:' + await textHash({ geometry: geometryKey, implementation: transportImplementation, materials: scene.materials, lights: scene.lights });
  return { geometry: geometryKey, prepared };
}
export async function preparedKey(scene: SceneDescription): Promise<string> {
  return (await sceneKeys(scene)).prepared;
}

/** Serialization owns a copy before its first await, so callers may transfer
 * their source arrays while optional persistence finishes in the worker. */
async function saveRecord(key: string, metadata: object, arrays: ArrayBuffer[]): Promise<void> {
  const json = encoder.encode(JSON.stringify(metadata));
  const offset = Math.ceil((32 + json.length) / 4) * 4;
  const bytes = new ArrayBuffer(offset + arrays.reduce((sum, array) => sum + array.byteLength, 0) + 64);
  const header = new DataView(bytes), target = new Uint8Array(bytes);
  header.setUint32(0, json.length, true); target.set(json, 32);
  let cursor = offset;
  arrays.forEach((array, i) => {
    header.setUint32(4 + i * 4, array.byteLength, true);
    target.set(new Uint8Array(array), cursor); cursor += array.byteLength;
  });
  target.set(encoder.encode(await hash(bytes.slice(0, -64))), cursor);
  await writeCached(key, bytes);
}
async function loadRecord(key: string, arrayCount: number): Promise<{metadata: Record<string, unknown>; arrays: ArrayBuffer[]} | undefined> {
  try {
    const bytes = await readCached(key);
    if (!bytes || bytes.byteLength < 96 || await hash(bytes.slice(0, -64)) !== new TextDecoder().decode(bytes.slice(-64))) return;
    const header = new DataView(bytes), length = header.getUint32(0, true);
    const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 32, length))) as Record<string, unknown>;
    let cursor = Math.ceil((32 + length) / 4) * 4;
    const arrays = Array.from({length: arrayCount}, (_, i) => {
      const size = header.getUint32(4 + i * 4, true);
      if (size % 4 || cursor + size > bytes.byteLength - 64) throw new Error('Invalid cached record');
      const array = bytes.slice(cursor, cursor + size); cursor += size; return array;
    });
    if (cursor !== bytes.byteLength - 64) return;
    return {metadata, arrays};
  } catch { return undefined; }
}
export async function cacheGeometry(key: string, value: PackedScene): Promise<void> {
  const { triangleCount, nodeCount, maxDepth } = value;
  await saveRecord(key, {triangleCount, nodeCount, maxDepth}, [value.nodes, value.triangles]);
}
export async function cachedGeometry(key: string): Promise<PackedScene | undefined> {
  const record = await loadRecord(key, 2);
  if (!record) return;
  const metadata = record.metadata as unknown as Omit<PackedScene, 'nodes' | 'triangles'>;
  const [nodes, triangles] = record.arrays;
  if (!Number.isInteger(metadata.triangleCount) || metadata.triangleCount <= 0 || !Number.isInteger(metadata.nodeCount) || metadata.nodeCount <= 0 ||
      !Number.isInteger(metadata.maxDepth) || metadata.maxDepth < 0 || metadata.maxDepth >= 63 ||
      nodes!.byteLength !== metadata.nodeCount * definitions.structs.BvhNode!.size ||
      triangles!.byteLength !== metadata.triangleCount * definitions.structs.Triangle!.size) return;
  return {...metadata, nodes: nodes!, triangles: triangles!};
}
export async function cacheTransport(key: string, value: PackedTransport): Promise<void> {
  const { lightCount, spectralReady } = value;
  await saveRecord(key, {lightCount, spectralReady}, [value.materials, value.lights, value.spectra]);
}
export async function cachedTransport(key: string): Promise<PackedTransport | undefined> {
  const record = await loadRecord(key, 3);
  if (!record) return;
  const metadata = record.metadata as unknown as Omit<PackedTransport, 'materials' | 'lights' | 'spectra'>;
  const [materials, lights, spectra] = record.arrays;
  if (!Number.isInteger(metadata.lightCount) || metadata.lightCount < 0 || typeof metadata.spectralReady !== 'boolean' ||
      !materials!.byteLength || materials!.byteLength % definitions.structs.Material!.size ||
      lights!.byteLength !== Math.max(1, metadata.lightCount) * definitions.structs.LightTriangle!.size ||
      spectra!.byteLength < 3 * 471 * 4) return;
  return {...metadata, materials: materials!, lights: lights!, spectra: spectra!};
}
