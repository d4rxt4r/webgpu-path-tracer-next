import type { Triangle, Vec3 } from '../scene/types';

export const MAX_BVH_DEPTH = 48;
export const BVH_STACK_SIZE = 64;
export interface BvhNode { min: Vec3; max: Vec3; first: number; count: number }
export interface Bvh { nodes: BvhNode[]; triangles: Triangle[]; maxDepth: number }
function empty(): BvhNode { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], first: 0, count: 0 }; }
function include(bounds: BvhNode, triangle: Triangle): void {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis]!, triangle.a[axis]!, triangle.b[axis]!, triangle.c[axis]!);
    bounds.max[axis] = Math.max(bounds.max[axis]!, triangle.a[axis]!, triangle.b[axis]!, triangle.c[axis]!);
  }
}
function merge(a: BvhNode, b: BvhNode): BvhNode {
  return { ...empty(), min: a.min.map((v, i) => Math.min(v, b.min[i]!)) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i]!)) as Vec3 };
}
function area(node: BvhNode): number {
  const [x, y, z] = node.max.map((value, i) => Math.max(0, value - node.min[i]!));
  return 2 * (x! * y! + y! * z! + z! * x!);
}
function centroid(triangle: Triangle, axis: number): number { return (triangle.a[axis]! + triangle.b[axis]! + triangle.c[axis]!) / 3; }

/** World-space binary binned SAH. Sibling nodes occupy consecutive slots. */
export function buildBvh(input: Triangle[], depthLimit = MAX_BVH_DEPTH): Bvh {
  if (!input.length || !Number.isInteger(depthLimit) || depthLimit < 0 || depthLimit >= BVH_STACK_SIZE - 1) throw new Error('Invalid BVH input or depth limit');
  const nodes = [empty()];
  const triangles: Triangle[] = [];
  let maxDepth = 0;
  const build = (items: Triangle[], nodeIndex: number, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    const node = nodes[nodeIndex]!;
    items.forEach(triangle => include(node, triangle));
    let bestCost = Infinity, bestAxis = -1, bestSplit = -1, bestMin = 0, bestScale = 0;
    if (items.length > 4 && depth < depthLimit) {
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity, max = -Infinity;
        for (const triangle of items) { const c = centroid(triangle, axis); min = Math.min(min, c); max = Math.max(max, c); }
        if (max <= min) continue;
        const scale = 16 / (max - min);
        const bins = Array.from({ length: 16 }, () => ({ bounds: empty(), count: 0 }));
        for (const triangle of items) { const bin = bins[Math.min(15, Math.floor((centroid(triangle, axis) - min) * scale))]!; include(bin.bounds, triangle); bin.count++; }
        const suffix = Array.from({ length: 16 }, empty);
        const counts = new Uint32Array(16);
        let right = empty(), rightCount = 0;
        for (let i = 15; i >= 0; i--) { right = merge(right, bins[i]!.bounds); rightCount += bins[i]!.count; suffix[i] = right; counts[i] = rightCount; }
        let left = empty(), leftCount = 0;
        for (let split = 0; split < 15; split++) {
          left = merge(left, bins[split]!.bounds); leftCount += bins[split]!.count;
          if (!leftCount || !counts[split + 1]) continue;
          const cost = area(left) * leftCount + area(suffix[split + 1]!) * counts[split + 1]!;
          if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = split; bestMin = min; bestScale = scale; }
        }
      }
    }
    if (bestAxis < 0) {
      node.first = triangles.length; node.count = items.length;
      for (const triangle of items) triangles.push(triangle);
      return;
    }
    const left: Triangle[] = [], right: Triangle[] = [];
    for (const triangle of items) (Math.min(15, Math.floor((centroid(triangle, bestAxis) - bestMin) * bestScale)) <= bestSplit ? left : right).push(triangle);
    if (!left.length || !right.length) throw new Error('SAH produced an empty child');
    node.first = nodes.length;
    nodes.push(empty(), empty());
    build(left, node.first, depth + 1); build(right, node.first + 1, depth + 1);
  };
  build(input, 0, 0);
  // Conservative bounds for f32 slab arithmetic, including zero-thickness faces.
  for (const node of nodes) for (let axis = 0; axis < 3; axis++) {
    const epsilon = 2e-6 * Math.max(1, Math.abs(node.min[axis]!), Math.abs(node.max[axis]!));
    node.min[axis] = Math.fround(node.min[axis]! - epsilon);
    node.max[axis] = Math.fround(node.max[axis]! + epsilon);
  }
  return { nodes, triangles, maxDepth };
}
