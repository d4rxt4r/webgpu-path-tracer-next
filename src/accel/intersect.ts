import type { Ray, Triangle } from '../scene/types';
import type { Bvh, BvhNode } from './bvh';
import { BVH_STACK_SIZE } from './bvh';

export interface Hit { t: number; id: number; u: number; v: number; visits: number }
/** Sheared ray-space edge functions: adjacent faces compute the same shared edge. */
export function intersectTriangle(ray: Ray, triangle: Triangle): Omit<Hit, 'visits'> | null {
  const d = ray.direction;
  let kz = 0;
  if (Math.abs(d[1]) > Math.abs(d[kz]!)) kz = 1;
  if (Math.abs(d[2]) > Math.abs(d[kz]!)) kz = 2;
  if (d[kz] === 0) return null;
  let kx = (kz + 1) % 3, ky = (kx + 1) % 3;
  if (d[kz]! < 0) [kx, ky] = [ky, kx];
  const sx = -d[kx]! / d[kz]!, sy = -d[ky]! / d[kz]!, sz = 1 / d[kz]!;
  const projected = [triangle.a, triangle.b, triangle.c].map(vertex => {
    const p = vertex.map((value, i) => value - ray.origin[i]!);
    return [p[kx]! + sx * p[kz]!, p[ky]! + sy * p[kz]!, p[kz]! * sz];
  });
  const [a, b, c] = projected as [number[], number[], number[]];
  const e0 = b[0]! * c[1]! - b[1]! * c[0]!, e1 = c[0]! * a[1]! - c[1]! * a[0]!, e2 = a[0]! * b[1]! - a[1]! * b[0]!;
  if ((e0 < 0 || e1 < 0 || e2 < 0) && (e0 > 0 || e1 > 0 || e2 > 0)) return null;
  const det = e0 + e1 + e2;
  if (det === 0) return null;
  const t = (e0 * a[2]! + e1 * b[2]! + e2 * c[2]!) / det;
  if (t < ray.tMin || t > ray.tMax || !Number.isFinite(t)) return null;
  return { t, id: triangle.id, u: e1 / det, v: e2 / det };
}

export function intersectBounds(ray: Ray, node: BvhNode, limit = ray.tMax): number {
  let near = ray.tMin, far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const origin = ray.origin[axis]!, direction = ray.direction[axis]!;
    if (direction === 0) { if (origin < node.min[axis]! || origin > node.max[axis]!) return Infinity; continue; }
    let a = (node.min[axis]! - origin) / direction, b = (node.max[axis]! - origin) / direction;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return Infinity;
  }
  return near;
}

export function bruteForce(ray: Ray, triangles: Triangle[]): Hit | null {
  let best: Hit | null = null;
  for (const triangle of triangles) {
    const hit = intersectTriangle({ ...ray, tMax: best?.t ?? ray.tMax }, triangle);
    if (hit && (!best || hit.t < best.t || (hit.t === best.t && hit.id < best.id))) best = { ...hit, visits: triangles.length };
  }
  return best;
}

export function traverseBvh(ray: Ray, bvh: Bvh, any = false): Hit | null {
  const stack = [0];
  let best: Hit | null = null, visits = 0;
  while (stack.length) {
    const node = bvh.nodes[stack.pop()!]!;
    visits++;
    if (intersectBounds(ray, node, best?.t ?? ray.tMax) === Infinity) continue;
    if (node.count) {
      for (let i = node.first; i < node.first + node.count; i++) {
        const hit = intersectTriangle({ ...ray, tMax: best?.t ?? ray.tMax }, bvh.triangles[i]!);
        if (hit && (!best || hit.t < best.t || (hit.t === best.t && hit.id < best.id))) {
          best = { ...hit, visits };
          if (any) return best;
        }
      }
    } else {
      const a = intersectBounds(ray, bvh.nodes[node.first]!, best?.t ?? ray.tMax);
      const b = intersectBounds(ray, bvh.nodes[node.first + 1]!, best?.t ?? ray.tMax);
      if (a !== Infinity && b !== Infinity) { stack.push(a <= b ? node.first + 1 : node.first, a <= b ? node.first : node.first + 1); }
      else if (a !== Infinity) stack.push(node.first);
      else if (b !== Infinity) stack.push(node.first + 1);
      if (stack.length > BVH_STACK_SIZE) throw new Error('BVH stack overflow');
    }
  }
  return best ? { ...best, visits } : null;
}
