import type { ImportedObj } from "./obj";
import { OBJ_MAX_TRIANGLES } from "./obj";
import { meshTopology } from "./mesh-topology";
import { triangulate } from "./polygon";
import type { Point } from "./polygon";
import { cleanAmbiguousMesh } from "./mesh-cleanup";

export interface ComponentRepair { shell: number; success: boolean; closedHoles: number; reason?: string }
export interface RepairReport { success: boolean; closedHoles: number; removedFaces?: number; collapsedEdges?: number; reason?: string; components?: ComponentRepair[] }
export interface RepairedObj extends ImportedObj { repair: RepairReport }

/** Repairs are atomic: a failed component leaves the entire source untouched. */
export function repairMesh(source: ImportedObj): RepairedObj {
  let failedShell = 0;
  try {
    let topology = meshTopology(source.mesh);
    let working = source.mesh;
    let removedFaces = 0, collapsedEdges = 0;
    if (!topology.manifold) {
      failedShell = topology.shells[topology.invalidFace ?? 0] ?? 0;
      const cleaned = cleanAmbiguousMesh(working, topology);
      working = cleaned.mesh; topology = cleaned.topology;
      removedFaces = cleaned.removedFaces; collapsedEdges = cleaned.collapsedEdges;
    }
    if (!topology.manifold || !topology.orientable) {
      failedShell = topology.shells[topology.invalidFace ?? 0]!;
      throw new Error("Поверхность содержит неоднозначные рёбра или не допускает согласованную ориентацию.");
    }
    const shellHoles = Array<number>(topology.components).fill(0);
    const indices = Array.from(working.indices);
    let changedOrientation = false;
    for (let face = 0; face < topology.flips.length; face++) {
      if (topology.flips[face] === 1) {
        [indices[face * 3 + 1], indices[face * 3 + 2]] = [indices[face * 3 + 2]!, indices[face * 3 + 1]!];
        changedOrientation = true;
      }
    }
    if (changedOrientation) topology = meshTopology({ ...working, indices: new Uint32Array(indices) });
    const outgoing = new Map<string, number>(), incoming = new Set<string>();
    for (const edge of topology.boundary) {
      failedShell = topology.shells[edge.face]!;
      const from = `${failedShell}:${edge.a}`, to = `${failedShell}:${edge.b}`;
      if (outgoing.has(from) || incoming.has(to)) throw new Error("Контур отверстия содержит ветвления.");
      outgoing.set(from, edge.b); incoming.add(to);
    }
    for (const key of outgoing.keys()) if (!incoming.has(key)) {
      failedShell = Number(key.split(":")[0]);
      throw new Error("Граница отверстия не образует замкнутый контур.");
    }
    const positions = Array.from(working.positions);
    const normals = working.normals ? Array.from(working.normals) : undefined;
    const capShells = Array.from(topology.shells);
    let closedHoles = 0;
    const visited = new Set<string>();
    for (const key of outgoing.keys()) {
      if (visited.has(key)) continue;
      const [shell, start] = key.split(":").map(Number) as [number, number];
      failedShell = shell;
      const loop: number[] = [];
      let v = start;
      do {
        const nextKey = `${shell}:${v}`;
        if (visited.has(nextKey)) throw new Error("Контуры отверстий пересекаются.");
        visited.add(nextKey); loop.push(v);
        if (loop.length > 4096) throw new Error("Контур отверстия превышает 4096 вершин.");
        v = outgoing.get(nextKey)!;
      } while (v !== start);
      const cap = triangulate(loop.reverse().map(v => ({ v })), topology.positions);
      if (indices.length / 3 + cap.length > OBJ_MAX_TRIANGLES) throw new Error("Ремонт превышает предел 2 млн треугольников.");
      for (const triangle of cap) {
        capShells.push(shell);
        const [a, b, c] = triangle.map(corner => topology.positions[corner.v]!) as [Point, Point, Point];
        const u = b.map((value, i) => value - a[i]!), w = c.map((value, i) => value - a[i]!);
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
        const length = Math.hypot(...n);
        if (!(length > 0)) throw new Error("Закрытие отверстия создаёт вырожденную грань.");
        for (const point of [a, b, c]) {
          indices.push(positions.length / 3); positions.push(...point);
          normals?.push(...n.map(v => v / length));
        }
      }
      closedHoles++; shellHoles[shell]!++;
    }
    const mesh = { positions: new Float32Array(positions), normals: normals ? new Float32Array(normals) : undefined, indices: new Uint32Array(indices), shells: new Uint32Array(capShells) };
    if (closedHoles) topology = meshTopology(mesh);
    if (!topology.solid) {
      failedShell = Math.max(0, topology.volumes.findIndex((v, i) => Math.abs(v) <= topology.volumeThresholds[i]!));
      throw new Error("После закрытия отверстий не получены замкнутые объёмы.");
    }
    mesh.shells = topology.shells;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      if (topology.volumes[topology.shells[i / 3]!]! < 0) [mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2]!, mesh.indices[i + 1]!];
    }
    return { ...source, mesh, solid: true, triangles: mesh.indices.length / 3, shells: topology.components,
      repair: { success: true, closedHoles, ...(removedFaces ? { removedFaces } : {}), ...(collapsedEdges ? { collapsedEdges } : {}), components: shellHoles.map((holes, shell) => ({ shell: shell + 1, success: true, closedHoles: holes })) } };
  } catch (error) {
    const reason = `Оболочка ${failedShell + 1}: ${(error as Error).message}`;
    return { ...source, repair: { success: false, closedHoles: 0, reason, components: [{ shell: failedShell + 1, success: false, closedHoles: 0, reason }] } };
  }
}
