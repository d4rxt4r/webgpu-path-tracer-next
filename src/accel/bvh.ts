import type { Triangle, Vec3 } from "../scene/types";

export const MAX_BVH_DEPTH = 48;
export const BVH_STACK_SIZE = 64;
export interface BvhNode {
  min: Vec3;
  max: Vec3;
  first: number;
  count: number;
}
export interface Bvh {
  nodes: BvhNode[];
  triangles: Triangle[];
  maxDepth: number;
}
function empty(): BvhNode {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    first: 0,
    count: 0,
  };
}
function area(bounds: Float64Array, offset = 0): number {
  const x = Math.max(0, bounds[offset + 3]! - bounds[offset]!);
  const y = Math.max(0, bounds[offset + 4]! - bounds[offset + 1]!);
  const z = Math.max(0, bounds[offset + 5]! - bounds[offset + 2]!);
  return 2 * (x * y + x * z + y * z);
}
function clearBounds(bounds: Float64Array): void {
  for (let i = 0; i < bounds.length; i++)
    bounds[i] = i % 6 < 3 ? Infinity : -Infinity;
}
function include(
  bounds: Float64Array,
  offset: number,
  other: Float64Array,
  source: number,
): void {
  for (let axis = 0; axis < 3; axis++) {
    bounds[offset + axis] = Math.min(
      bounds[offset + axis]!,
      other[source + axis]!,
    );
    bounds[offset + axis + 3] = Math.max(
      bounds[offset + axis + 3]!,
      other[source + axis + 3]!,
    );
  }
}

/** Stable binned SAH using cached primitive bounds and reusable typed scratch arrays. */
export function buildBvh(
  input: Triangle[],
  depthLimit = MAX_BVH_DEPTH,
  leafSize = 4,
): Bvh {
  if (
    !input.length ||
    !Number.isInteger(depthLimit) ||
    depthLimit < 0 ||
    depthLimit >= BVH_STACK_SIZE - 1 ||
    !Number.isInteger(leafSize) ||
    leafSize < 1 ||
    leafSize > 16
  )
    throw new Error("Invalid BVH input or depth limit");
  const primitiveBounds = new Float64Array(input.length * 6);
  const centroids = new Float64Array(input.length * 3);
  const order = Uint32Array.from(input, (_, i) => i),
    scratch = new Uint32Array(input.length);
  input.forEach((triangle, i) => {
    for (let axis = 0; axis < 3; axis++) {
      primitiveBounds[i * 6 + axis] = Math.min(
        triangle.a[axis]!,
        triangle.b[axis]!,
        triangle.c[axis]!,
      );
      primitiveBounds[i * 6 + axis + 3] = Math.max(
        triangle.a[axis]!,
        triangle.b[axis]!,
        triangle.c[axis]!,
      );
      centroids[i * 3 + axis] =
        (triangle.a[axis]! + triangle.b[axis]! + triangle.c[axis]!) / 3;
    }
  });
  const bins = new Float64Array(16 * 6),
    binCounts = new Uint32Array(16);
  const suffix = new Float64Array(16 * 6),
    suffixCounts = new Uint32Array(16);
  const running = new Float64Array(6);
  const nodes = [empty()],
    triangles: Triangle[] = [];
  let maxDepth = 0;
  const build = (
    start: number,
    end: number,
    nodeIndex: number,
    depth: number,
  ): void => {
    maxDepth = Math.max(maxDepth, depth);
    const node = nodes[nodeIndex]!;
    for (let i = start; i < end; i++)
      for (let axis = 0; axis < 3; axis++) {
        const offset = order[i]! * 6;
        node.min[axis] = Math.min(
          node.min[axis]!,
          primitiveBounds[offset + axis]!,
        );
        node.max[axis] = Math.max(
          node.max[axis]!,
          primitiveBounds[offset + axis + 3]!,
        );
      }
    let bestCost = Infinity,
      bestAxis = -1,
      bestSplit = -1,
      bestMin = 0,
      bestScale = 0;
    if (end - start > leafSize && depth < depthLimit) {
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity,
          max = -Infinity;
        for (let i = start; i < end; i++) {
          const c = centroids[order[i]! * 3 + axis]!;
          min = Math.min(min, c);
          max = Math.max(max, c);
        }
        if (max <= min) continue;
        const scale = 16 / (max - min);
        clearBounds(bins);
        binCounts.fill(0);
        for (let i = start; i < end; i++) {
          const index = order[i]!,
            bin = Math.min(
              15,
              Math.floor((centroids[index * 3 + axis]! - min) * scale),
            );
          include(bins, bin * 6, primitiveBounds, index * 6);
          binCounts[bin] = binCounts[bin]! + 1;
        }
        clearBounds(running);
        let count = 0;
        for (let i = 15; i >= 0; i--) {
          include(running, 0, bins, i * 6);
          count += binCounts[i]!;
          suffix.set(running, i * 6);
          suffixCounts[i] = count;
        }
        clearBounds(running);
        count = 0;
        for (let split = 0; split < 15; split++) {
          include(running, 0, bins, split * 6);
          count += binCounts[split]!;
          if (!count || !suffixCounts[split + 1]) continue;
          const cost =
            area(running) * count +
            area(suffix, (split + 1) * 6) * suffixCounts[split + 1]!;
          if (cost < bestCost) {
            bestCost = cost;
            bestAxis = axis;
            bestSplit = split;
            bestMin = min;
            bestScale = scale;
          }
        }
      }
    }
    if (bestAxis < 0) {
      node.first = triangles.length;
      node.count = end - start;
      for (let i = start; i < end; i++) triangles.push(input[order[i]!]!);
      return;
    }
    const belongsLeft = (index: number): boolean =>
      Math.min(
        15,
        Math.floor((centroids[index * 3 + bestAxis]! - bestMin) * bestScale),
      ) <= bestSplit;
    let leftCount = 0;
    for (let i = start; i < end; i++) if (belongsLeft(order[i]!)) leftCount++;
    const middle = start + leftCount;
    if (middle === start || middle === end)
      throw new Error("SAH produced an empty child");
    let left = start,
      right = middle;
    for (let i = start; i < end; i++) {
      const index = order[i]!;
      scratch[belongsLeft(index) ? left++ : right++] = index;
    }
    order.set(scratch.subarray(start, end), start);
    node.first = nodes.length;
    nodes.push(empty(), empty());
    build(start, middle, node.first, depth + 1);
    build(middle, end, node.first + 1, depth + 1);
  };
  build(0, input.length, 0, 0);
  for (const node of nodes)
    for (let axis = 0; axis < 3; axis++) {
      const epsilon =
        2e-6 *
        Math.max(1, Math.abs(node.min[axis]!), Math.abs(node.max[axis]!));
      node.min[axis] = Math.fround(node.min[axis]! - epsilon);
      node.max[axis] = Math.fround(node.max[axis]! + epsilon);
    }
  return { nodes, triangles, maxDepth };
}
