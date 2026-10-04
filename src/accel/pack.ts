import { makeShaderDataDefinitions } from "webgpu-utils";
import layouts from "../transport/layouts.wgsl?raw";
import type { Bvh } from "./bvh";

export const definitions = makeShaderDataDefinitions(layouts);
export interface PackedScene {
  nodes: ArrayBuffer;
  triangles: ArrayBuffer;
  triangleCount: number;
  nodeCount: number;
  maxDepth: number;
}

export function packBvh(bvh: Bvh): PackedScene {
  const nodeDefinition = definitions.structs.BvhNode!;
  const triangleDefinition = definitions.structs.Triangle!;
  const nodes = new ArrayBuffer(bvh.nodes.length * nodeDefinition.size);
  const triangles = new ArrayBuffer(
    bvh.triangles.length * triangleDefinition.size,
  );
  const nodeFloats = new Float32Array(nodes),
    nodeInts = new Uint32Array(nodes);
  const triangleFloats = new Float32Array(triangles),
    triangleInts = new Uint32Array(triangles);
  for (let i = 0; i < bvh.nodes.length; i++) {
    const node = bvh.nodes[i]!,
      base = (i * nodeDefinition.size) / 4;
    for (const key of ["min", "max"] as const)
      nodeFloats.set(node[key], base + nodeDefinition.fields[key]!.offset / 4);
    for (const key of ["first", "count"] as const)
      nodeInts[base + nodeDefinition.fields[key]!.offset / 4] = node[key];
  }
  for (let i = 0; i < bvh.triangles.length; i++) {
    const triangle = bvh.triangles[i]!,
      base = (i * triangleDefinition.size) / 4;
    for (const key of ["a", "b", "c", "na", "nb", "nc"] as const)
      triangleFloats.set(
        triangle[key],
        base + triangleDefinition.fields[key]!.offset / 4,
      );
    for (const key of ["material", "id", "surface"] as const)
      triangleInts[base + triangleDefinition.fields[key]!.offset / 4] =
        triangle[key];
  }
  // A binary BVH has at most 2*T-1 nodes. Its escape links therefore fit
  // into two unused u32 normal-padding fields per triangle, without a buffer
  // or binding increase. Geometry, material IDs and the 96-byte layout stay intact.
  if (bvh.nodes.length > 2 * bvh.triangles.length)
    throw new Error("BVH escape links exceed triangle padding capacity");
  const visited = new Uint8Array(bvh.nodes.length);
  const link = (index: number, escape: number, depth: number): void => {
    if (index >= bvh.nodes.length || depth >= 64 || visited[index])
      throw new Error("Invalid BVH escape tree");
    visited[index] = 1;
    const field = index % 2 ? "padding2" : "padding1";
    triangleInts[Math.floor(index / 2) * triangleDefinition.size / 4 +
      triangleDefinition.fields[field]!.offset / 4] = escape;
    const node = bvh.nodes[index]!;
    if (node.count === 0) {
      link(node.first, node.first + 1, depth + 1);
      link(node.first + 1, escape, depth + 1);
    }
  };
  link(0, 0xffffffff, 0);
  return {
    nodes,
    triangles,
    triangleCount: bvh.triangles.length,
    nodeCount: bvh.nodes.length,
    maxDepth: bvh.maxDepth,
  };
}
