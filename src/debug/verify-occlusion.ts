import { makeStructuredView } from "webgpu-utils";
import { definitions, packBvh } from "../accel/pack";
import { buildBvh } from "../accel/bvh";
import { bakeTriangles } from "../accel/geometry";
import { bruteForce } from "../accel/intersect";
import { suzanneScene } from "../scene/suzanne";
import { checkedShader, createDevice } from "../gpu/device";
import { intersectionCore } from "../transport/shaders";
import type { Ray, Vec3, SceneDescription } from "../scene/types";

/** Check real Suzanne occlusion, not just the simplified sphere fixture. */
export async function verifyOcclusion(description?: SceneDescription) {
  const scene = description ?? (await suzanneScene()),
    triangles = bakeTriangles(scene);
  const packed = packBvh(buildBvh(triangles));
  const sides: { name: string; eye: Vec3; surface: number }[] = [
    { name: "front", eye: [0, 1, 3.7], surface: 6 },
    { name: "back", eye: [0, 1, -3.7], surface: 2 },
    { name: "left", eye: [-3.7, 1, 0], surface: 3 },
    { name: "right", eye: [3.7, 1, 0], surface: 4 },
    { name: "top", eye: [0, 4.7, 0], surface: 1 },
    { name: "bottom", eye: [0, -2.7, 0], surface: 0 },
  ];
  const rays: Ray[] = sides.flatMap((side) => {
    const axis =
      side.name === "left" || side.name === "right"
        ? 0
        : side.name === "top" || side.name === "bottom"
          ? 1
          : 2;
    const axes = [0, 1, 2].filter((i) => i !== axis);
    return Array.from({ length: 49 }, (_, i) => {
      const target = [0, 1, 0];
      target[axes[0]!]! += ((i % 7) - 3) * 0.1;
      target[axes[1]!]! += (Math.floor(i / 7) - 3) * 0.1;
      const direction = target.map((v, j) => v - side.eye[j]!);
      const length = Math.hypot(...direction);
      return {
        origin: side.eye,
        direction: direction.map((v) => v / length) as Vec3,
        tMin: 0.00001,
        tMax: 1e20,
      };
    });
  });
  const { device, name } = await createDevice();
  const buffers: GPUBuffer[] = [];
  const create = (
    size: number,
    usage: GPUBufferUsageFlags,
    data?: ArrayBuffer,
  ) => {
    const buffer = device.createBuffer({
      size,
      usage,
      mappedAtCreation: Boolean(data),
    });
    buffers.push(buffer);
    if (data) {
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
      buffer.unmap();
    }
    return buffer;
  };
  try {
    const module = await checkedShader(
      device,
      intersectionCore +
        `
@group(0) @binding(0) var<storage, read> rays: array<Ray>;
@group(0) @binding(1) var<storage, read_write> hits: array<Hit>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&rays)) { return; }
  let ray = rays[id.x]; let hit = closestHit(ray);
  hits[id.x * 2u] = hit;
  hits[id.x * 2u + 1u] = closestHit(Ray(ray.origin, ray.tMin, ray.direction, hit.t));
}`,
      "Suzanne six-side occlusion",
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const data = new ArrayBuffer(rays.length * definitions.structs.Ray!.size);
    rays.forEach((ray, i) =>
      makeStructuredView(
        definitions.structs.Ray!,
        data,
        i * definitions.structs.Ray!.size,
      ).set(ray),
    );
    const byteLength = rays.length * 2 * definitions.structs.Hit!.size;
    const input = create(data.byteLength, GPUBufferUsage.STORAGE, data),
      output = create(
        byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
    const nodes = create(
        packed.nodes.byteLength,
        GPUBufferUsage.STORAGE,
        packed.nodes,
      ),
      geometry = create(
        packed.triangles.byteLength,
        GPUBufferUsage.STORAGE,
        packed.triangles,
      );
    const readback = create(
      byteLength,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [input, output, nodes, geometry].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(rays.length / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const raw = readback.getMappedRange().slice(0);
    readback.unmap();
    const floats = new Float32Array(raw),
      uints = new Uint32Array(raw);
    const mismatches: string[] = [];
    rays.forEach((ray, i) => {
      const cpu = bruteForce(ray, triangles),
        offset = i * 16;
      // Shared wall diagonals can select either triangle at the same distance.
      if (
        !cpu ||
        triangles[uints[offset + 1]!]!.surface !== triangles[cpu.id]!.surface ||
        Math.abs(floats[offset]! - cpu.t) > 1e-4 ||
        uints[offset + 6] ||
        uints[offset + 14]
      )
        mismatches.push(`Ray ${i}: nearest surface mismatch/error`);
      if (
        i >= 49 &&
        triangles[uints[offset + 1]!]!.surface !==
          sides[Math.floor(i / 49)]!.surface
      )
        mismatches.push(`Ray ${i}: wall failed to occlude Suzanne`);
    });
    return {
      adapter: name,
      rays: rays.length,
      mismatches,
      sides: sides.map((side, i) => {
        const offset = (i * 49 + 24) * 16;
        return {
          ...side,
          actualSurface: triangles[uints[offset + 1]!]!.surface,
          distance: floats[offset],
          fullVisits: uints[offset + 5],
          visibleVisits: uints[offset + 13],
        };
      }),
    };
  } finally {
    buffers.forEach((b) => b.destroy());
    device.destroy();
  }
}
