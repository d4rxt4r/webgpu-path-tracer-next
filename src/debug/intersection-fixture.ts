import type { Ray, Vec3 } from '../scene/types';

export function fixedRays(count = 2048): Ray[] {
  let seed = 0x12345678;
  const random = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const rays: Ray[] = [];
  for (let i = 0; i < count; i++) {
    const origin: Vec3 = [Math.fround(random() * 6 - 3), Math.fround(random() * 4 - 1), Math.fround(random() * 6 - 3)];
    const direction: Vec3 = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    const length = Math.hypot(...direction);
    rays.push({ origin, direction: direction.map(v => Math.fround(v / length)) as Vec3, tMin: 0.00001, tMax: i % 3 === 0 ? 0.5 : 100 });
  }
  // Faces, common edges, vertices, zero direction components, inside and misses.
  for (const origin of [[-1, 1, 3], [1, 1, 3], [0, 1, 3], [-1, 0, 3], [1, 2, 3], [0, 0, 0], [0, 2, 0], [0, 1, -1], [0, 0.65, 0], [3, 3, 3]] as Vec3[]) {
    for (const direction of [[0, 0, -1], [1, 0, 0], [0, 1, 0], [0, -1, 0]] as Vec3[]) rays.push({ origin, direction, tMin: 0.00001, tMax: 100 });
  }
  return rays;
}
