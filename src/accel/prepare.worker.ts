/// <reference lib="webworker" />
import { bakeTriangles } from './geometry';
import { buildBvh } from './bvh';
import { packBvh } from './pack';
import type { SceneDescription } from '../scene/types';
import { packTransport } from './materials';
import { sceneKeys, cachedGeometry, cacheGeometry, cachedTransport, cacheTransport } from '../assets/prepared-cache';
import { unpackBvh } from './unpack';
import type { Bvh } from './bvh';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<{ revision: number; scene: SceneDescription }>) => {
  const { revision, scene } = event.data;
  try {
    let keys: Awaited<ReturnType<typeof sceneKeys>> | undefined;
    try { keys = await sceneKeys(scene); } catch { /* Crypto/cache unavailable: build normally. */ }
    let [geometry, transport] = keys
      ? await Promise.all([cachedGeometry(keys.geometry), cachedTransport(keys.prepared)])
      : [undefined, undefined];
    let bvh: Bvh | undefined;
    if (!geometry) {
      bvh = buildBvh(bakeTriangles(scene));
      geometry = packBvh(bvh);
      if (keys) void cacheGeometry(keys.geometry, geometry).catch(() => {});
    }
    if (!transport) {
      bvh ??= unpackBvh(geometry);
      transport = packTransport(scene, bvh);
      if (keys) void cacheTransport(keys.prepared, transport).catch(() => {});
    }
    const packed = {...geometry, ...transport};
    worker.postMessage({ revision, packed }, [packed.nodes, packed.triangles, packed.materials, packed.lights, packed.spectra]);
  } catch (error) { worker.postMessage({ revision, error: error instanceof Error ? error.message : String(error) }); }
};
