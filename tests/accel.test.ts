import { describe, expect, it } from 'vitest';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { bruteForce, intersectBounds, intersectTriangle, traverseBvh } from '../src/accel/intersect';
import { definitions, packBvh } from '../src/accel/pack';
import { cornellScene } from '../src/scene/cornell';
import { cameraBasis } from '../src/scene/camera';
import { fixedRays } from '../src/debug/intersection-fixture';
import type { Ray, Triangle } from '../src/scene/types';

const scene = cornellScene();
const triangles = bakeTriangles(scene);
const bvh = buildBvh(triangles);

// Independent Möller–Trumbore implementation for random, non-edge rays.
function independentDistance(ray: Ray, triangle: Triangle): number | null {
  const sub = (a: number[], b: number[]): number[] => a.map((v, i) => v - b[i]!);
  const cross = (a: number[], b: number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
  const ab = sub(triangle.b, triangle.a), ac = sub(triangle.c, triangle.a);
  const p = cross(ray.direction, ac), det = dot(ab, p);
  if (Math.abs(det) < 1e-12) return null;
  const delta = sub(ray.origin, triangle.a), u = dot(delta, p) / det;
  if (u < 0 || u > 1) return null;
  const q = cross(delta, ab), v = dot(ray.direction, q) / det;
  if (v < 0 || u + v > 1) return null;
  const t = dot(ac, q) / det;
  return t >= ray.tMin && t <= ray.tMax ? t : null;
}

describe('world-space SAH BVH', () => {
  it("ignores unused zero normals and keeps baked triangle vertices independent", () => {
    const description = cornellScene();
    const mesh = description.meshes[0]!;
    const positions = new Float32Array(mesh.positions.length + 3);
    positions.set(mesh.positions);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) normals[i + 1] = 1;
    mesh.positions = positions;
    mesh.normals = normals;
    const baked = bakeTriangles(description);
    const other = baked[1]!.a.slice();
    baked[0]!.a[0] += 10;
    expect(baked[1]!.a).toEqual(other);
    mesh.indices[0] = positions.length / 3 - 1;
    expect(() => bakeTriangles(description)).toThrow();
  });
  it('matches brute force closest/any hit for fixed random and boundary rays', () => {
    for (const ray of fixedRays()) {
      const expected = bruteForce(ray, triangles), actual = traverseBvh(ray, bvh);
      expect(actual?.id ?? null).toBe(expected?.id ?? null);
      if (expected) expect(actual!.t).toBeCloseTo(expected.t, 10);
      expect(Boolean(traverseBvh(ray, bvh, true))).toBe(Boolean(expected));
    }
  });
  it('matches an independent triangle algorithm away from shared edges', () => {
    for (const ray of fixedRays(128).slice(0, 128)) {
      const distances = triangles.map(triangle => independentDistance(ray, triangle)).filter((t): t is number => t !== null);
      const hit = bruteForce(ray, triangles);
      if (!distances.length) expect(hit).toBeNull();
      else expect(hit!.t).toBeCloseTo(Math.min(...distances), 8);
    }
  });
  it('retains every primitive and respects the traversal depth bound', () => {
    expect(new Set(bvh.triangles.map(triangle => triangle.id)).size).toBe(triangles.length);
    expect(bvh.maxDepth).toBeLessThanOrEqual(48);
    expect(bvh.nodes.filter(node => node.count > 0).every(node => node.count <= 4)).toBe(true);
    const shallow = buildBvh(triangles, 2);
    expect(shallow.maxDepth).toBe(2);
    for (const ray of fixedRays(32)) expect(traverseBvh(ray, shallow)?.t).toBe(bruteForce(ray, triangles)?.t);
  });
  it('keeps slab face rays without division by zero and covers shared triangle edges', () => {
    const bounds = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number], first: 0, count: 0 };
    expect(intersectBounds({ origin: [-1, 0, 3], direction: [0, 0, -1], tMin: 0, tMax: 100 }, bounds)).toBe(2);
    expect(intersectBounds({ origin: [-2, 0, 3], direction: [0, 0, -1], tMin: 0, tMax: 100 }, bounds)).toBe(Infinity);
    for (const point of [[0, 0, 0], [-1, 0, -1], [1, 0, 1]] as [number, number, number][]) {
      const ray: Ray = { origin: [point[0], 1, point[2]], direction: [0, -1, 0], tMin: 0.001, tMax: 2 };
      expect(triangles.slice(0, 2).some(triangle => intersectTriangle(ray, triangle) !== null)).toBe(true);
    }
  });
  it('validates meshes and correctly bakes mirrored object transforms', () => {
    const invalid = cornellScene(); invalid.meshes[0]!.indices[0] = 999;
    expect(() => bakeTriangles(invalid)).toThrow('out of range');
    const mirrored = cornellScene(); mirrored.objects[0]!.transform[0] = -1;
    expect(bakeTriangles(mirrored)[0]!.na[1]).toBe(1);
    const degenerate = cornellScene(); degenerate.meshes[0]!.positions.fill(0);
    expect(() => bakeTriangles(degenerate)).toThrow('Degenerate');
    for (const triangle of triangles.filter(triangle => triangle.surface === 6)) {
      // A closed sphere must point away from its centre.
      const centre = triangle.a.map((v, i) => (v + triangle.b[i]! + triangle.c[i]!) / 3 - [0, 0.65, 0][i]!);
      expect(centre.reduce((sum, v, i) => sum + v * triangle.na[i]!, 0)).toBeGreaterThan(0);
    }
  });
});

describe('WGSL reflection and camera', () => {
  it('packs the 32-byte BVH node and 96-byte triangle at reflected offsets', () => {
    const node = definitions.structs.BvhNode!, triangle = definitions.structs.Triangle!;
    expect(node.size).toBe(32); expect(triangle.size).toBe(96);
    expect(node.fields.first!.offset).toBe(12); expect(node.fields.max!.offset).toBe(16); expect(node.fields.count!.offset).toBe(28);
    expect(triangle.fields.material!.offset).toBe(12); expect(triangle.fields.id!.offset).toBe(28); expect(triangle.fields.na!.offset).toBe(48);
    expect(definitions.structs.CameraParams!.size).toBe(256);
    const packed = packBvh(bvh), floats = new Float32Array(packed.nodes), integers = new Uint32Array(packed.nodes);
    expect(floats[0]).toBe(bvh.nodes[0]!.min[0]); expect(integers[3]).toBe(bvh.nodes[0]!.first);
    expect(packed.triangles.byteLength).toBe(triangles.length * 96);
  });
  it('produces the expected camera frame and rejects undefined directions', () => {
    const basis = cameraBasis(scene.camera);
    expect(basis.forward).toEqual([0, 0, -1]); expect(basis.right[0]).toBeGreaterThan(0); expect(basis.up[1]).toBeGreaterThan(0);
    expect(() => cameraBasis({ ...scene.camera, target: scene.camera.position })).toThrow('must differ');
    expect(() => cameraBasis({ ...scene.camera, up: [0, 0, 1] })).toThrow('parallel');
  });
});
