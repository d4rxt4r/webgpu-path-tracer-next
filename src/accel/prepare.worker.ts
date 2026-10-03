/// <reference lib="webworker" />
import { bakeTriangles } from './geometry';
import { buildBvh } from './bvh';
import { packBvh } from './pack';
import type { SceneDescription } from '../scene/types';
import { packTransport } from './materials';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<{ revision: number; scene: SceneDescription }>) => {
  const { revision, scene } = event.data;
  try {
    const bvh = buildBvh(bakeTriangles(scene));
    const packed = { ...packBvh(bvh), ...packTransport(scene, bvh) };
    worker.postMessage({ revision, packed }, [packed.nodes, packed.triangles, packed.materials, packed.lights]);
  } catch (error) { worker.postMessage({ revision, error: error instanceof Error ? error.message : String(error) }); }
};
