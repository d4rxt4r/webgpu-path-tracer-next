import { triangulate, interpolateCorner } from "./polygon";
import type { Corner, Point, EdgeSplit } from "./polygon";
import { meshTopology } from "./mesh-topology";
import type { MeshData } from "../scene/types";

export const OBJ_MAX_BYTES = 128 * 1048576;
export const OBJ_MAX_TRIANGLES = 2000000;
export interface ImportedObj { mesh: MeshData; solid: boolean; triangles: number; shells?: number; skippedDegenerateTriangles?: number }
export interface ObjOptions { maxDimension?: number; skipDegenerateTriangles?: boolean }
export function parseObj(text: string, options: ObjOptions = {}): ImportedObj {
  const maxDimension = options.maxDimension ?? 1.2;
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) throw new Error("Invalid OBJ normalization size");
  const vertices: Point[] = [], sourceNormals: Point[] = [];
  const polygons: { corners: Corner[]; smoothing: string; line: number }[] = [];
  let smoothing = "off", triangleCount = 0, textureCoordinates = 0, skippedDegenerateTriangles = 0;
  const index = (token: string, count: number): number => {
    const value = Number(token), result = value < 0 ? count + value : value - 1;
    if (!token || !Number.isInteger(value) || value === 0 || result < 0 || result >= count) throw new Error("Некорректный индекс OBJ.");
    return result;
  };
  const lines = text.replace(/^\uFEFF/, "").replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    const tokens = lines[line]!.split("#", 1)[0]!.trim().split(/\s+/), tag = tokens.shift();
    try {
      if (tag === "v" || tag === "vn") {
        const p = tokens.slice(0, 3).map(Number);
        if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error("Некорректные координаты OBJ.");
        if (tag === "v" && tokens.length === 4 && Number(tokens[3]) !== 1) throw new Error("Однородные вершины OBJ не поддерживаются.");
        if (tag === "vn") {
          const length = Math.hypot(...p);
          if (!(length > 0)) throw new Error("Нулевая нормаль OBJ.");
          sourceNormals.push(p.map(v => v / length) as Point);
        } else vertices.push(p as Point);
      } else if (tag === "vt") {
        if (!tokens.length || tokens.length > 3 || !tokens.map(Number).every(Number.isFinite)) throw new Error("Некорректные координаты UV OBJ.");
        textureCoordinates++;
      } else if (tag === "s") smoothing = tokens[0] === "0" || tokens[0] === "off" ? "off" : tokens[0] || "off";
      else if (tag === "f") {
        const corners = tokens.map(token => {
          const parts = token.split("/");
          if (parts.length > 3) throw new Error("Некорректная грань OBJ.");
          if (parts[1]) index(parts[1], textureCoordinates);
          return { v: index(parts[0]!, vertices.length), n: parts[2] ? index(parts[2], sourceNormals.length) : undefined };
        });
        polygons.push({ corners, smoothing, line });
      } else if (tag && !["vt", "o", "g", "usemtl", "mtllib", "#"].includes(tag)) {
        throw new Error(`Неподдерживаемая запись OBJ: ${tag}. Экспортируйте полигональную сетку.`);
      }
    } catch (error) { throw new Error(`OBJ, строка ${line + 1}: ${(error as Error).message}`); }
  }
  const faces: { corners: Corner[]; smoothing: string }[] = [];
  const edgeSplits = new Map<string, EdgeSplit[]>();
  for (const polygon of polygons) {
    try {
      let triangles: Corner[][];
      if (options.skipDegenerateTriangles && polygon.corners.length === 3) {
        const [a, b, c] = polygon.corners.map(corner => vertices[corner.v]!) as [Point, Point, Point];
        const u = b.map((x, i) => x - a[i]!), v = c.map((x, i) => x - a[i]!);
        const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
        if (area === 0) { skippedDegenerateTriangles++; continue; }
        triangles = [polygon.corners];
      } else triangles = triangulate(polygon.corners, vertices, { normals: sourceNormals, edgeSplits });
      triangleCount += triangles.length;
      if (triangleCount > OBJ_MAX_TRIANGLES) throw new Error("OBJ превышает предел 2 млн треугольников.");
      faces.push(...triangles.map(corners => ({ corners, smoothing: polygon.smoothing })));
    } catch (error) { throw new Error(`OBJ, строка ${polygon.line + 1}: ${(error as Error).message}`); }
  }
  // Split neighboring triangle edges too, so repaired contours do not leave
  // T-junctions in an otherwise closed mesh. Original OBJ indices were resolved
  // before synthetic vertices/normals were added, including negative indices.
  if (edgeSplits.size) {
    const original = faces.splice(0); triangleCount = 0;
    for (const face of original) {
      const corners: Corner[] = [];
      for (let i = 0; i < 3; i++) {
        const a = face.corners[i]!, b = face.corners[(i + 1) % 3]!;
        corners.push(a);
        const splits = edgeSplits.get(`${Math.min(a.v, b.v)}/${Math.max(a.v, b.v)}`);
        if (splits) for (const split of [...splits].sort((x, y) => a.v < b.v ? x.t - y.t : y.t - x.t))
          corners.push(interpolateCorner(a, b, split.v, a.v < b.v ? split.t : 1 - split.t, sourceNormals));
      }
      const triangles = corners.length === 3 ? [corners] : triangulate(corners, vertices);
      triangleCount += triangles.length;
      if (triangleCount > OBJ_MAX_TRIANGLES) throw new Error("OBJ превышает предел 2 млн треугольников.");
      faces.push(...triangles.map(corners => ({ corners, smoothing: face.smoothing })));
    }
  }
  if (!faces.length) throw new Error("OBJ не содержит полигональной геометрии.");
  const used = new Set<number>();
  for (const face of faces) for (const corner of face.corners) used.add(corner.v);
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const v of used) for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis]!, vertices[v]![axis]!); high[axis] = Math.max(high[axis]!, vertices[v]![axis]!); }
  const size = Math.max(...high.map((v, i) => v - low[i]!));
  if (!Number.isFinite(size) || size <= 0) throw new Error("Некорректные размеры OBJ.");
  for (const v of used) vertices[v] = vertices[v]!.map((p, i) => Math.fround(((p - low[i]!) / size - (high[i]! - low[i]!) / size / 2) * maxDimension)) as Point;
  const faceNormals: Point[] = [];
  const renderableFaces: typeof faces = [];
  for (const face of faces) {
    const [a, b, c] = face.corners.map(c => vertices[c.v]!) as [Point, Point, Point];
    const u = b.map((v, i) => v - a[i]!), w = c.map((v, i) => v - a[i]!);
    const normal: Point = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    if (Math.hypot(...normal) === 0 && options.skipDegenerateTriangles) { skippedDegenerateTriangles++; continue; }
    if (!(Math.hypot(...normal) > 0)) throw new Error("OBJ содержит вырожденный треугольник после нормализации.");
    renderableFaces.push(face);
    faceNormals.push(normal);
  }
  const positions: number[] = [], normals: number[] = [], normalFallbacks: number[] = [], indices: number[] = [], output = new Map<string, number>();
  renderableFaces.forEach((face, f) => {
    for (const corner of face.corners) {
      const key = corner.n !== undefined ? `${corner.v}/n${corner.n}` : `${vertices[corner.v]!.join(",")}/${face.smoothing === "off" ? `flat${f}` : `smooth${face.smoothing}`}`;
      let i = output.get(key);
      if (i === undefined) {
        i = positions.length / 3; output.set(key, i); positions.push(...vertices[corner.v]!); normals.push(0, 0, 0);
        normalFallbacks.push(...faceNormals[f]!);
        if (corner.n !== undefined) sourceNormals[corner.n]!.forEach((v, axis) => { normals[i! * 3 + axis] = v; });
      }
      if (corner.n === undefined) faceNormals[f]!.forEach((v, axis) => { normals[i! * 3 + axis]! += v; });
      indices.push(i);
    }
  });
  for (let i = 0; i < normals.length; i += 3) {
    let length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    // Opposite incident faces may cancel the generated smoothing normal.
    // Use an incident geometric normal instead of rejecting valid geometry.
    if (length === 0) {
      for (let axis = 0; axis < 3; axis++) normals[i + axis] = normalFallbacks[i + axis]!;
      length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    }
    if (!(length > 0)) throw new Error("Не удалось вычислить нормали OBJ.");
    for (let axis = 0; axis < 3; axis++) normals[i + axis]! /= length;
  }
  triangleCount = renderableFaces.length;
  if (!triangleCount) throw new Error("No renderable triangles in OBJ");
  const mesh = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
  const topology = meshTopology(mesh);
  if (topology.solid) {
    for (let face = 0; face < triangleCount; face++) {
      if (topology.volumes[topology.shells[face]!]! >= 0) continue;
      const i = face * 3;
      [mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2]!, mesh.indices[i + 1]!];
    }
  }
  return { mesh: { ...mesh, shells: topology.shells }, solid: topology.solid, triangles: triangleCount, shells: topology.components, ...(skippedDegenerateTriangles ? { skippedDegenerateTriangles } : {}) };
}
