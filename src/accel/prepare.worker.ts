/// <reference lib="webworker" />
import { bakeTriangles } from './geometry';
import { buildBvh } from './bvh';
import { packBvh } from './pack';
import type { SceneDescription } from '../scene/types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<{ revision: number; scene: SceneDescription }>) => {
  const { revision, scene } = event.data;
  try {
    const packed = packBvh(buildBvh(bakeTriangles(scene)));
    worker.postMessage({ revision, packed }, [packed.nodes, packed.triangles]);
  } catch (error) { worker.postMessage({ revision, error: error instanceof Error ? error.message : String(error) }); }
};
