import type { MeshData } from "../scene/types";
import { meshTopology } from "./mesh-topology";

/** Remove overlapping internal faces and collapse microscopic pinched edges.
 * The source arrays are never modified; large ambiguous features stay errors. */
export function cleanAmbiguousMesh(source: MeshData, initial: ReturnType<typeof meshTopology>) {
  const removed = new Set<number>();
  const duplicates = new Map<string, { forward: number[]; backward: number[] }>();
  for (const face of initial.ambiguousFaces) {
    const corners = Array.from(source.indices.subarray(face * 3, face * 3 + 3), v => initial.vertexIds[v]!);
    const sorted = [...corners].sort((a, b) => a - b);
    const key = sorted.join(":");
    let group = duplicates.get(key);
    if (!group) { group = { forward: [], backward: [] }; duplicates.set(key, group); }
    const inversions = Number(corners[0]! > corners[1]!) + Number(corners[0]! > corners[2]!) + Number(corners[1]! > corners[2]!);
    (inversions % 2 ? group.backward : group.forward).push(face);
  }
  for (const group of duplicates.values()) {
    const pairs = Math.min(group.forward.length, group.backward.length);
    for (let i = 0; i < pairs; i++) { removed.add(group.forward[i]!); removed.add(group.backward[i]!); }
    // Repeated faces with the same orientation represent one surface.
    for (const faces of [group.forward, group.backward]) for (let i = pairs + 1; i < faces.length; i++) removed.add(faces[i]!);
  }
  const filter = (mesh: MeshData) => ({ ...mesh, shells: undefined,
    indices: new Uint32Array(Array.from(mesh.indices).filter((_, i) => !removed.has(Math.floor(i / 3)))) });
  let mesh = filter(source);
  let topology = removed.size ? meshTopology(mesh) : initial;
  let collapsedEdges = 0;
  if (!topology.manifold) {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const point of topology.positions) for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis]!, point[axis]!); high[axis] = Math.max(high[axis]!, point[axis]!);
    }
    const tolerance = Math.max(...high.map((v, i) => v - low[i]!)) * 0.001;
    const parent = new Map<number, number>();
    const root = (v: number): number => { let r = v; while (parent.has(r)) r = parent.get(r)!; return r; };
    for (const edge of topology.ambiguousEdges) {
      const a = topology.positions[edge.a]!, b = topology.positions[edge.b]!;
      if (Math.hypot(...a.map((v, i) => v - b[i]!)) > tolerance)
        throw new Error("Неоднозначное ребро слишком велико для локального ремонта.");
      const ra = root(edge.a), rb = root(edge.b);
      if (ra !== rb) { parent.set(rb, ra); collapsedEdges++; }
    }
    const groups = new Map<number, number[]>();
    for (const v of new Set([...parent.keys(), ...parent.values()])) {
      const r = root(v); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(v);
    }
    const targets = new Map<number, number[]>();
    for (const [r, group] of groups) {
      const target = [0, 1, 2].map(axis => group.reduce((sum, v) => sum + topology.positions[v]![axis]!, 0) / group.length);
      for (const v of group) if (Math.hypot(...target.map((x, i) => x - topology.positions[v]![i]!)) > tolerance)
        throw new Error("Локальный ремонт требует слишком большого смещения вершин.");
      targets.set(r, target);
    }
    const positions = mesh.positions.slice();
    for (let v = 0; v < positions.length / 3; v++) {
      const target = targets.get(root(topology.vertexIds[v]!));
      if (target) positions.set(target, v * 3);
    }
    const indices: number[] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const corners = Array.from(mesh.indices.subarray(i, i + 3));
      const [a, b, c] = corners.map(v => positions.subarray(v * 3, v * 3 + 3));
      const u = [0, 1, 2].map(k => b![k]! - a![k]!), w = [0, 1, 2].map(k => c![k]! - a![k]!);
      if (Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) > 0) indices.push(...corners);
    }
    mesh = { ...mesh, positions, indices: new Uint32Array(indices) };
    topology = meshTopology(mesh);
  }
  return { mesh, topology, removedFaces: (source.indices.length - mesh.indices.length) / 3, collapsedEdges };
}
