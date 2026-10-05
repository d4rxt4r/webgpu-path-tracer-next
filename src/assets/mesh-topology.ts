import type { MeshData } from "../scene/types";
import type { Point } from "./polygon";

interface Edge { a: number; b: number; face: number; secondFace?: number; count: number; direction: number }
export function meshTopology(mesh: MeshData) {
  const ids = new Uint32Array(mesh.positions.length / 3), positions: Point[] = [];
  const canonical = new Map<string, number>();
  for (const v of mesh.indices) {
    const point = Array.from(mesh.positions.subarray(v * 3, v * 3 + 3)) as Point;
    const key = point.join(",");
    if (!canonical.has(key)) { canonical.set(key, positions.length); positions.push(point); }
    ids[v] = canonical.get(key)!;
  }
  const edges = new Map<string, Edge>();
  const neighbors: number[][] = Array.from({ length: mesh.indices.length / 3 }, () => []);
  const ambiguousFaces = new Set<number>();
  let volume = 0, manifold = true, consistent = true, invalidFace: number | undefined;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const face = i / 3, corners = [ids[mesh.indices[i]!]!, ids[mesh.indices[i + 1]!]!, ids[mesh.indices[i + 2]!]!];
    for (let j = 0; j < 3; j++) {
      const a = corners[j]!, b = corners[(j + 1) % 3]!, direction = a < b ? 1 : -1;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key);
      if (!edge) edges.set(key, { a, b, face, count: 1, direction });
      else {
        edge.count++;
        if (edge.count === 2) edge.secondFace = face;
        if (edge.count > 2) {
          manifold = false; invalidFace ??= face;
          ambiguousFaces.add(edge.face); ambiguousFaces.add(edge.secondFace!); ambiguousFaces.add(face);
        }
        const same = edge.direction === direction;
        if (same) consistent = false;
        neighbors[face]!.push((edge.face + 1) * (same ? -1 : 1));
        neighbors[edge.face]!.push((face + 1) * (same ? -1 : 1));
      }
    }
  }
  const flips = new Int8Array(neighbors.length).fill(-1);
  const shells = new Uint32Array(neighbors.length), volumes: number[] = [];
  const volumeThresholds: number[] = [];
  let components = 0, orientable = true;
  for (let start = 0; start < neighbors.length; start++) {
    if (flips[start] !== -1) continue;
    const shell = components++; volumes.push(0); flips[start] = 0;
    // A local origin avoids cancellation for tiny shells far from the origin.
    const origin = positions[ids[mesh.indices[start * 3]!]!]!;
    const low = [...origin], high = [...origin];
    let compensation = 0;
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const face = queue[cursor]!; shells[face] = shell;
      const corners = [0, 1, 2].map(k => positions[ids[mesh.indices[face * 3 + k]!]!]!);
      for (const point of corners) for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis]!, point[axis]!); high[axis] = Math.max(high[axis]!, point[axis]!);
      }
      const [a, b, c] = corners.map(point => point.map((x, axis) => x - origin[axis]!)) as [Point, Point, Point];
      const term = a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      const corrected = term - compensation, sum = volumes[shell]! + corrected;
      compensation = (sum - volumes[shell]!) - corrected; volumes[shell] = sum;
      for (const link of neighbors[face]!) {
        const neighbor = Math.abs(link) - 1, expected = flips[face]! ^ Number(link < 0);
        if (flips[neighbor] === -1) { flips[neighbor] = expected; queue.push(neighbor); }
        else if (flips[neighbor] !== expected) { orientable = false; invalidFace ??= face; }
      }
    }
    volumeThresholds.push(Math.max(...high.map((x, i) => x - low[i]!)) ** 3 * 1e-12);
  }
  const boundary = [...edges.values()].filter(edge => edge.count === 1);
  volume = volumes.reduce((sum, value) => sum + value, 0);
  const solid = manifold && orientable && consistent && components > 0 && boundary.length === 0 && volumes.every((v, i) => Math.abs(v) > volumeThresholds[i]!);
  const ambiguousEdges = [...edges.values()].filter(edge => edge.count > 2);
  return { solid, volume, manifold, orientable, components, boundary, flips, positions, vertexIds: ids, shells, volumes, volumeThresholds, invalidFace, ambiguousFaces, ambiguousEdges };
}
