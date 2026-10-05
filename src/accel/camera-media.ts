import { definitions, type PackedScene } from "./pack";
import type { PackedTransport } from "./materials";
import { intersectBounds, intersectTriangle } from "./intersect";
import type { Vec3, Triangle } from "../scene/types";

/** Classify one camera origin using the same world-space, packed BVH as the GPU. */
export function cameraShells(scene: PackedScene & PackedTransport, eye: Vec3): Uint32Array {
  const nodes = new Float32Array(scene.nodes), nodeIds = new Uint32Array(scene.nodes);
  const triangles = new Float32Array(scene.triangles), ids = new Uint32Array(scene.triangles);
  const materials = new Uint32Array(scene.materials);
  const stride = definitions.structs.Triangle!.size / 4;
  const materialStride = definitions.structs.Material!.size / 4;
  const kind = definitions.structs.Material!.fields.kind!.offset / 4;
  const boundaryOffset = definitions.structs.Triangle!.fields.padding0!.offset / 4;
  const directions: Vec3[] = [[0.81371, 0.37139, 0.44713], [0.21917, 0.91731, 0.33279], [0.53719, 0.17389, 0.82513]];
  for (const direction of directions) {
    const ray = { origin: eye, direction, tMin: 0, tMax: Infinity };
    const shells = new Map<number, { winding: number; triangle: number }>();
    const stack = [0];
    let ambiguous = false;
    while (stack.length && !ambiguous) {
      const base = stack.pop()! * 8;
      const node = { min: Array.from(nodes.subarray(base, base + 3)) as Vec3, max: Array.from(nodes.subarray(base + 4, base + 7)) as Vec3, first: nodeIds[base + 3]!, count: nodeIds[base + 7]! };
      if (intersectBounds(ray, node) === Infinity) continue;
      if (!node.count) { stack.push(node.first, node.first + 1); continue; }
      for (let index = node.first; index < node.first + node.count; index++) {
        const t = index * stride;
        if (materials[ids[t + 3]! * materialStride + kind] !== 2) continue;
        const triangle = { a: Array.from(triangles.subarray(t, t + 3)), b: Array.from(triangles.subarray(t + 4, t + 7)), c: Array.from(triangles.subarray(t + 8, t + 11)), id: index } as Triangle;
        const hit = intersectTriangle(ray, triangle);
        if (!hit) continue;
        // Retry a different direction rather than double-count shared edges.
        if (Math.min(hit.u, hit.v, 1 - hit.u - hit.v) < 1e-9 || hit.t < 1e-9) { ambiguous = true; break; }
        const a = triangle.b.map((v, axis) => v - triangle.a[axis]!), b = triangle.c.map((v, axis) => v - triangle.a[axis]!);
        const normal = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
        const outward = normal.reduce((sum, v, axis) => sum + v * direction[axis]!, 0) > 0;
        const boundary = ids[t + boundaryOffset]!;
        const shell = shells.get(boundary) ?? { winding: 0, triangle: index };
        shell.winding += outward ? 1 : -1; shells.set(boundary, shell);
      }
    }
    if (ambiguous) continue;
    const active: number[] = [];
    for (const [boundary, shell] of [...shells].sort(([a], [b]) => a - b)) {
      if (shell.winding !== 0 && shell.winding !== 1) throw new Error(`Неоднозначное положение камеры внутри оболочки ${boundary}: обход ${shell.winding}.`);
      if (shell.winding === 1) active.push(shell.triangle);
    }
    if (active.length > 32) throw new Error("Камера находится внутри более 32 оболочек.");
    return new Uint32Array(active);
  }
  throw new Error("Камера находится на неоднозначной границе стекла.");
}
