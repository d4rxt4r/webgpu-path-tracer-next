import { makeShaderDataDefinitions, makeStructuredView } from 'webgpu-utils';
import layouts from '../transport/layouts.wgsl?raw';
import type { Bvh } from './bvh';

export const definitions = makeShaderDataDefinitions(layouts);
export interface PackedScene { nodes: ArrayBuffer; triangles: ArrayBuffer; triangleCount: number; nodeCount: number; maxDepth: number }

export function packBvh(bvh: Bvh): PackedScene {
  const nodeDefinition = definitions.structs.BvhNode!;
  const triangleDefinition = definitions.structs.Triangle!;
  const nodes = new ArrayBuffer(bvh.nodes.length * nodeDefinition.size);
  const triangles = new ArrayBuffer(bvh.triangles.length * triangleDefinition.size);
  bvh.nodes.forEach((node, i) => makeStructuredView(nodeDefinition, nodes, i * nodeDefinition.size).set(node));
  bvh.triangles.forEach((triangle, i) => makeStructuredView(triangleDefinition, triangles, i * triangleDefinition.size).set(triangle));
  return { nodes, triangles, triangleCount: bvh.triangles.length, nodeCount: bvh.nodes.length, maxDepth: bvh.maxDepth };
}
