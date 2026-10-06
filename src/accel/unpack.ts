import type { Bvh } from './bvh';
import type { PackedScene } from './pack';
import { definitions } from './pack';
import type { Vec3 } from '../scene/types';

/** bakeTriangles produces Float32 world positions/normals. Their packed bits
 * restore the exact CPU inputs to material packing without rebuilding SAH. */
export function unpackBvh(packed: PackedScene): Bvh {
  const node = definitions.structs.BvhNode!, triangle = definitions.structs.Triangle!;
  const nf = new Float32Array(packed.nodes), ni = new Uint32Array(packed.nodes);
  const tf = new Float32Array(packed.triangles), ti = new Uint32Array(packed.triangles);
  const vector = (data: Float32Array, offset: number): Vec3 => Array.from(data.subarray(offset, offset + 3)) as Vec3;
  return {
    maxDepth: packed.maxDepth,
    nodes: Array.from({length: packed.nodeCount}, (_, i) => {
      const base = i * node.size / 4;
      return {min: vector(nf, base + node.fields.min!.offset / 4), max: vector(nf, base + node.fields.max!.offset / 4),
        first: ni[base + node.fields.first!.offset / 4]!, count: ni[base + node.fields.count!.offset / 4]!};
    }),
    triangles: Array.from({length: packed.triangleCount}, (_, i) => {
      const base = i * triangle.size / 4;
      return {
        a: vector(tf, base + triangle.fields.a!.offset / 4), b: vector(tf, base + triangle.fields.b!.offset / 4), c: vector(tf, base + triangle.fields.c!.offset / 4),
        na: vector(tf, base + triangle.fields.na!.offset / 4), nb: vector(tf, base + triangle.fields.nb!.offset / 4), nc: vector(tf, base + triangle.fields.nc!.offset / 4),
        id: ti[base + triangle.fields.id!.offset / 4]!, material: ti[base + triangle.fields.material!.offset / 4]!, surface: ti[base + triangle.fields.surface!.offset / 4]!,
        boundary: ti[base + triangle.fields.padding0!.offset / 4]!,
      };
    }),
  };
}
