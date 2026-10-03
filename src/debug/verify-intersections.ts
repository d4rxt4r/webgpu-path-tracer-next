import { makeStructuredView } from 'webgpu-utils';
import { definitions, packBvh } from '../accel/pack';
import type { PackedScene } from '../accel/pack';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import type { Bvh } from '../accel/bvh';
import { bruteForce } from '../accel/intersect';
import { cornellScene } from '../scene/cornell';
import type { Ray } from '../scene/types';
import { checkedShader, createDevice } from '../gpu/device';
import { intersectionCore } from '../transport/shaders';
import { fixedRays } from './intersection-fixture';
import { ScenePreparer } from '../assets/prepare';

const testShader = intersectionCore + `
@group(0) @binding(0) var<storage, read> testRays: array<Ray>;
@group(0) @binding(1) var<storage, read_write> results: array<Hit>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&testRays)) { return; }
  results[2u * id.x] = closestHit(testRays[id.x]);
  results[2u * id.x + 1u] = anyHit(testRays[id.x]);
}`;

interface GpuHit { t: number; id: number; error: number; u: number; v: number }
async function gpuTrace(device: GPUDevice, pipeline: GPUComputePipeline, scene: PackedScene, rays: Ray[]): Promise<GpuHit[]> {
  const buffers: GPUBuffer[] = [];
  const create = (size: number, usage: GPUBufferUsageFlags, data?: ArrayBuffer): GPUBuffer => {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: Boolean(data) }); buffers.push(buffer);
    if (data) { new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data)); buffer.unmap(); }
    return buffer;
  };
  try {
    const rayDefinition = definitions.structs.Ray!;
    const rayData = new ArrayBuffer(rayDefinition.size * rays.length);
    rays.forEach((ray, i) => makeStructuredView(rayDefinition, rayData, i * rayDefinition.size).set(ray));
    const rayBuffer = create(rayData.byteLength, GPUBufferUsage.STORAGE, rayData);
    const byteLength = rays.length * 2 * definitions.structs.Hit!.size;
    const resultBuffer = create(byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const nodes = create(scene.nodes.byteLength, GPUBufferUsage.STORAGE, scene.nodes);
    const triangles = create(scene.triangles.byteLength, GPUBufferUsage.STORAGE, scene.triangles);
    const readback = create(byteLength, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [rayBuffer, resultBuffer, nodes, triangles].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(rays.length / 64)); pass.end();
    encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, byteLength); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = readback.getMappedRange();
    const floats = new Float32Array(data), uints = new Uint32Array(data);
    const hits = Array.from({ length: rays.length * 2 }, (_, i) => ({ t: floats[i * 8]!, id: uints[i * 8 + 1]!, u: floats[i * 8 + 2]!, v: floats[i * 8 + 3]!, error: uints[i * 8 + 6]! }));
    readback.unmap(); return hits;
  } finally { buffers.forEach(buffer => buffer.destroy()); }
}

/** Browser-only numeric acceptance harness, loaded by tests, not the app. */
export async function verifyIntersections(): Promise<{ rays: number; maxDistanceError: number; mismatches: string[]; rangeError: number; stackError: number; numericError: number; workerCancelled: boolean; adapter: string }> {
  const { device, name } = await createDevice();
  const preparer = new ScenePreparer();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  try {
    const scene = cornellScene(), cpuTriangles = bakeTriangles(scene), bvh = buildBvh(cpuTriangles);
    const cancelled = preparer.prepare(scene).then(() => false, error => error.name === 'AbortError');
    const prepared = await preparer.prepare(scene);
    const workerCancelled = await cancelled;
    if (prepared.nodeCount !== bvh.nodes.length || prepared.triangleCount !== cpuTriangles.length) errors.push('Worker geometry mismatch');
    const shader = await checkedShader(device, testShader, 'Intersection acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
    const rays = fixedRays();
    const actual = await gpuTrace(device, pipeline, prepared, rays);
    let maxDistanceError = 0;
    rays.forEach((ray, i) => {
      const expected = bruteForce(ray, cpuTriangles), closest = actual[2 * i]!, any = actual[2 * i + 1]!;
      if (closest.error || any.error) errors.push(`Ray ${i}: traversal error ${closest.error}/${any.error}`);
      if ((closest.id !== 0xffffffff) !== Boolean(expected) || (any.id !== 0xffffffff) !== Boolean(expected)) errors.push(`Ray ${i}: hit/miss mismatch`);
      if (expected && closest.id !== 0xffffffff) {
        const difference = Math.abs(closest.t - expected.t); maxDistanceError = Math.max(maxDistanceError, difference);
        if (difference > 2e-5 * Math.max(1, expected.t)) errors.push(`Ray ${i}: distance error ${difference}`);
        // Shared-edge tie ownership may differ by roundoff; equal-distance surfaces are valid.
        if (closest.id !== expected.id && i < 2048) errors.push(`Ray ${i}: primitive mismatch ${closest.id}/${expected.id}`);
        if (closest.u < -1e-5 || closest.v < -1e-5 || closest.u + closest.v > 1.00001) errors.push(`Ray ${i}: invalid barycentrics`);
      }
    });
    const ray: Ray = { origin: [0, 1, 3], direction: [0, 0, -1], tMin: 0.00001, tMax: 100 };
    const malformed = packBvh({ ...bvh, nodes: [{ min: [-10, -10, -10], max: [10, 10, 10], first: 0xfffffff0, count: 1 }] });
    const rangeError = (await gpuTrace(device, pipeline, malformed, [ray]))[0]!.error;
    const numericError = (await gpuTrace(device, pipeline, prepared, [{ ...ray, direction: [0, 0, 0] }]))[0]!.error;
    // Deliberately invalid tree deeper than the production builder permits.
    const deep: Bvh = { nodes: [], triangles: [cpuTriangles[0]!], maxDepth: 66 };
    const leaf = () => ({ min: [-10, -10, -10] as [number, number, number], max: [10, 10, 10] as [number, number, number], first: 0, count: 1 });
    deep.nodes.push(leaf());
    let index = 0;
    for (let i = 0; i < 66; i++) {
      deep.nodes[index]!.count = 0; deep.nodes[index]!.first = deep.nodes.length;
      index = deep.nodes.length; deep.nodes.push(leaf(), leaf());
    }
    const stackError = (await gpuTrace(device, pipeline, packBvh(deep), [ray]))[0]!.error;
    return { rays: rays.length, maxDistanceError, mismatches: errors, rangeError, numericError, stackError, workerCancelled, adapter: name };
  } finally { preparer.dispose(); device.destroy(); }
}
