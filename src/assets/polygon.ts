export type Corner = { v: number; n?: number };
export type Point = [number, number, number];

/** Clip the projected contour, retaining original 3D corners and normal indices. */
export function triangulate(face: Corner[], positions: Point[]): Corner[][] {
  if (face.length < 3 || face.length > 4096) throw new Error("Грань OBJ должна содержать от 3 до 4096 вершин.");
  const normal = [0, 0, 0];
  for (let i = 0; i < face.length; i++) {
    const a = positions[face[i]!.v]!, b = positions[face[(i + 1) % face.length]!.v]!;
    normal[0]! += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1]! += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2]! += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(...normal);
  if (!(length > 0)) throw new Error("Вырожденная грань OBJ.");
  const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  const origin = positions[face[0]!.v]!;
  const scale = Math.max(...face.map(c => Math.hypot(...positions[c.v]!.map((v, i) => v - origin[i]!))));
  const axes = [0, 1, 2].filter(i => i !== axis);
  const points = face.map(c => axes.map(i => positions[c.v]![i]!));
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

