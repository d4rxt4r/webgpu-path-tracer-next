export type Corner = { v: number; n?: number };
export type Point = [number, number, number];
export type EdgeSplit = { v: number; t: number };
export type PolygonContext = { normals: Point[]; edgeSplits: Map<string, EdgeSplit[]> };

export function interpolateCorner(a: Corner, b: Corner, v: number, t: number, normals: Point[]): Corner {
  if (a.n === undefined || b.n === undefined) return { v };
  const na = normals[a.n]!, nb = normals[b.n]!;
  const normal = na.map((x, i) => x * (1 - t) + nb[i]! * t) as Point;
  const length = Math.hypot(...normal);
  if (length < 1e-12) return { v };
  const n = normals.length; normals.push(normal.map(x => x / length) as Point);
  return { v, n };
}

/** Clip the projected contour, retaining original 3D corners and normal indices. */
export function triangulate(face: Corner[], positions: Point[], context?: PolygonContext): Corner[][] {
  if (face.length < 3 || face.length > 4096) throw new Error("Грань OBJ должна содержать от 3 до 4096 вершин.");
  const normal = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = positions[face[i]!.v]!, b = positions[face[(i + 1) % face.length]!.v]!;
    normal[0]! += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1]! += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2]! += (a[0] - b[0]) * (a[1] + b[1]);
  }
  let length = Math.hypot(...normal);
  if (length === 0 && context) {
    for (let i = 1; i + 1 < face.length; i++) {
      const candidate = vectorCross(subtract(positions[face[i]!.v]!, positions[face[0]!.v]!), subtract(positions[face[i + 1]!.v]!, positions[face[0]!.v]!));
      const size = Math.hypot(...candidate);
      if (size > length) { length = size; normal.splice(0, 3, ...candidate); }
    }
  }
  if (!(length > 0)) throw new Error("Вырожденная грань OBJ.");
  // A warped contour can cross itself in one projection while remaining
  // simple in another. Prefer Newell's dominant plane, then try the others.
  const projectionAxes = [0, 1, 2].sort((a, b) => Math.abs(normal[b]!) - Math.abs(normal[a]!));
  let firstError: unknown;
  for (const axis of projectionAxes) {
    try { return triangulateProjected(face, positions, axis); }
    catch (error) { firstError ??= error; }
  }
  const origin = positions[face[0]!.v]!;
  const scale = Math.max(...face.map(c => Math.hypot(...positions[c.v]!.map((v, i) => v - origin[i]!))));
  const deviation = Math.max(...face.map(c => Math.abs(positions[c.v]!.reduce((sum, v, i) => sum + (v - origin[i]!) * normal[i]!, 0)) / length));
  if ((context || deviation > scale * 1e-6) && face.length <= 256) return triangulateSpatial(face, positions, scale, context);
  throw firstError;
}

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vectorCross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const u = subtract(b, a), v = subtract(d, c), w = subtract(c, a), n = vectorCross(u, v);
  const n2 = dot(n, n), u2 = dot(u, u), v2 = dot(v, v), epsilon = 1e-10;
  if (n2 <= 1e-24 * u2 * v2) {
    if (Math.hypot(...vectorCross(w, u)) > epsilon * Math.sqrt(u2)) return false;
    const t0 = dot(w, u) / u2, t1 = dot(subtract(d, a), u) / u2;
    return Math.max(Math.min(t0, t1), 0) <= Math.min(Math.max(t0, t1), 1) + epsilon;
  }
  const t = dot(vectorCross(w, v), n) / n2, s = dot(vectorCross(w, u), n) / n2;
  return t >= -epsilon && t <= 1 + epsilon && s >= -epsilon && s <= 1 + epsilon &&
    Math.hypot(...u.map((value, i) => t * value - w[i]! - s * v[i]!)) <= epsilon;
}

/** Minimum-area triangulation of a genuinely warped contour, without flattening it. */
function triangulateSpatial(face: Corner[], positions: Point[], scale: number, context?: PolygonContext): Corner[][] {
  const base = positions[face[0]!.v]!;
  const points = face.map(c => subtract(positions[c.v]!, base).map(v => v / scale) as Point);
  const n = points.length;
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    if (Math.hypot(...subtract(points[a]!, points[b]!)) <= 1e-10) throw new Error("Вырожденное ребро грани OBJ.");
    for (let c = a + 1; c < n; c++) {
      const d = (c + 1) % n;
      if (b === c || d === a || !segmentsMeet(points[a]!, points[b]!, points[c]!, points[d]!)) continue;
      const u = subtract(points[b]!, points[a]!), v = subtract(points[d]!, points[c]!), w = subtract(points[c]!, points[a]!);
      const normal = vectorCross(u, v), denominator = dot(normal, normal);
      if (!context || denominator <= 1e-24 * dot(u, u) * dot(v, v))
        throw new Error("Грань OBJ содержит пересекающиеся или наложенные рёбра.");
      const t = dot(vectorCross(w, v), normal) / denominator, s = dot(vectorCross(w, u), normal) / denominator;
      if (t <= 1e-10 || t >= 1 - 1e-10 || s <= 1e-10 || s >= 1 - 1e-10)
        throw new Error("Грань OBJ содержит касание несмежных рёбер.");
      const point = positions.length;
      positions.push(positions[face[a]!.v]!.map((x, i) => x + t * (positions[face[b]!.v]![i]! - x)) as Point);
      for (const [start, end, fraction] of [[a, b, t], [c, d, s]]) {
        const av = face[start!]!.v, bv = face[end!]!.v, key = `${Math.min(av, bv)}/${Math.max(av, bv)}`;
        const splits = context.edgeSplits.get(key) ?? [];
        splits.push({ v: point, t: av < bv ? fraction! : 1 - fraction! }); context.edgeSplits.set(key, splits);
      }
      const first = [interpolateCorner(face[a]!, face[b]!, point, t, context.normals), ...face.slice(b, c + 1)];
      const rest = d === 0 ? face.slice(0, a + 1) : [...face.slice(d), ...face.slice(0, a + 1)];
      const second = [interpolateCorner(face[c]!, face[d]!, point, s, context.normals), ...rest];
      return [...triangulate(first, positions, context), ...triangulate(second, positions, context)];
    }
  }
  const costs = new Float64Array(n * n).fill(Infinity), splits = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < n - 1; i++) costs[i * n + i + 1] = 0;
  for (let span = 2; span < n; span++) for (let a = 0; a + span < n; a++) {
    const c = a + span;
    for (let b = a + 1; b < c; b++) {
      const area = Math.hypot(...vectorCross(subtract(points[b]!, points[a]!), subtract(points[c]!, points[a]!)));
      if (area <= 1e-12) continue;
      const cost = costs[a * n + b]! + costs[b * n + c]! + area;
      if (cost < costs[a * n + c]!) { costs[a * n + c] = cost; splits[a * n + c] = b; }
    }
  }
  if (!Number.isFinite(costs[n - 1])) throw new Error("Не удалось разбить неплоскую грань OBJ без вырожденных треугольников.");
  const triangles: number[][] = [], pending = [[0, n - 1]];
  while (pending.length) {
    const [a, c] = pending.pop()!;
    if (c! - a! < 2) continue;
    const b = splits[a! * n + c!]!;
    triangles.push([a!, b, c!]); pending.push([a!, b], [b, c!]);
  }
  // Keep a malformed spatial contour from producing crossing diagonals.
  const edges = new Map<string, [number, number]>();
  for (const triangle of triangles) for (let i = 0; i < 3; i++) {
    const a = triangle[i]!, b = triangle[(i + 1) % 3]!;
    edges.set(`${Math.min(a, b)}/${Math.max(a, b)}`, [a, b]);
  }
  const list = [...edges.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [a, b] = list[i]!, [c, d] = list[j]!;
    if (a !== c && a !== d && b !== c && b !== d && segmentsMeet(points[a]!, points[b]!, points[c]!, points[d]!))
      throw new Error("Триангуляция неплоской грани OBJ создаёт пересечение рёбер.");
  }
  return triangles.map(t => t.map(i => face[i]!));
}

function triangulateProjected(face: Corner[], positions: Point[], axis: number): Corner[][] {
  const origin = positions[face[0]!.v]!;
  const scale = Math.max(...face.map(c => Math.hypot(...positions[c.v]!.map((v, i) => v - origin[i]!))));
  const axes = [0, 1, 2].filter(i => i !== axis);
  const points = face.map(c => axes.map(i => positions[c.v]![i]! - origin[i]!));
  const cross = (a: number, b: number, c: number) => (points[b]![0]! - points[a]![0]!) * (points[c]![1]! - points[a]![1]!) - (points[b]![1]! - points[a]![1]!) * (points[c]![0]! - points[a]![0]!);
  const area = points.reduce((sum, a, i) => sum + a[0]! * points[(i + 1) % points.length]![1]! - a[1]! * points[(i + 1) % points.length]![0]!, 0);
  const sign = Math.sign(area), epsilon = scale * scale * 1e-12;
  if (Math.abs(area) <= epsilon) throw new Error("Проекция грани OBJ имеет нулевую площадь.");
  const coordinateEpsilon = scale * 1e-12;
  const onSegment = (a: number, b: number, p: number) =>
    Math.abs(cross(a, b, p)) <= epsilon && axes.every((_, i) =>
      points[p]![i]! >= Math.min(points[a]![i]!, points[b]![i]!) - coordinateEpsilon &&
      points[p]![i]! <= Math.max(points[a]![i]!, points[b]![i]!) + coordinateEpsilon);
  for (let a = 0; a < face.length; a++) {
    const b = (a + 1) % face.length;
    if (Math.hypot(points[b]![0]! - points[a]![0]!, points[b]![1]! - points[a]![1]!) <= coordinateEpsilon)
      throw new Error("Проекция грани OBJ содержит вырожденное ребро.");
    for (let c = a + 1; c < face.length; c++) {
      const d = (c + 1) % face.length;
      if (b === c || d === a) continue;
      const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
      const opposite = (x: number, y: number) => (x > epsilon && y < -epsilon) || (x < -epsilon && y > epsilon);
      if ((opposite(abC, abD) && opposite(cdA, cdB)) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b))
        throw new Error("Проекция грани OBJ пересекает себя. Разбейте её на простые грани.");
    }
  }
  const remaining = face.map((_, i) => i), result: Corner[][] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let j = 0; j < remaining.length; j++) {
      const a = remaining[(j + remaining.length - 1) % remaining.length]!, b = remaining[j]!, c = remaining[(j + 1) % remaining.length]!;
      if (cross(a, b, c) * sign <= epsilon) continue;
      if (remaining.some(p => p !== a && p !== b && p !== c && cross(a, b, p) * sign >= -epsilon && cross(b, c, p) * sign >= -epsilon && cross(c, a, p) * sign >= -epsilon)) continue;
      result.push([face[a]!, face[b]!, face[c]!]); remaining.splice(j, 1); found = true; break;
    }
    if (!found) throw new Error("Грань OBJ пересекает себя или содержит вырожденные рёбра.");
  }
  if (cross(remaining[0]!, remaining[1]!, remaining[2]!) * sign <= epsilon) throw new Error("Вырожденный треугольник OBJ.");
  result.push(remaining.map(i => face[i]!));
  return result;
}

