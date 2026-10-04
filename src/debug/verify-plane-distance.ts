import { createDevice, checkedShader } from '../gpu/device';
import { intersectionCore } from '../transport/shaders';

/** Plane distances with compensated origins, checked against independent float64 arithmetic. */
export async function verifyPlaneDistance() {
  const { device, name } = await createDevice();
  const buffers: GPUBuffer[] = [];
  let state = 17;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const count = 1024, vertices = new Float32Array(count * 24), inputs = new Float32Array(count * 12);
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
  for (let i = 0; i < count; i++) {
    const scale = [1e-4, 1, 1e4][i % 3]!;
    const a = Array.from({ length: 3 }, () => Math.fround((random() - 0.5) * scale));
    const b = a.map(v => Math.fround(v + (random() - 0.5) * scale));
    const c = a.map(v => Math.fround(v + (random() - 0.5) * scale));
    vertices.set(a, i * 24); vertices.set(b, i * 24 + 4); vertices.set(c, i * 24 + 8);
    const e = b.map((v, j) => v - a[j]!), normal = cross(e, c.map((v, j) => v - a[j]!));
    const length = Math.hypot(...normal), tangentLength = Math.hypot(...e);
    const grazing = i % 2 ? 1e-3 : 1;
    inputs.set(a.map(v => Math.fround(v + (random() - 0.5) * scale)), i * 12);
    inputs.set(normal.map((v, j) => Math.fround(grazing * v / length + e[j]! / tangentLength)), i * 12 + 4);
    inputs.set(a.map(() => Math.fround((random() - 0.5) * scale * 1e-8)), i * 12 + 8);
  }
  const make = (size: number, usage: number, data?: ArrayBuffer) => {
    const b = device.createBuffer({ size, usage, mappedAtCreation: !!data }); buffers.push(b);
    if (data) { new Uint8Array(b.getMappedRange()).set(new Uint8Array(data)); b.unmap(); } return b;
  };
  try {
    device.pushErrorScope('validation');
    const input = make(inputs.byteLength, GPUBufferUsage.STORAGE, inputs.buffer);
    const mesh = make(vertices.byteLength, GPUBufferUsage.STORAGE, vertices.buffer);
    const out = make(count * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const read = make(out.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const module = await checkedShader(device, intersectionCore + `
@group(0) @binding(0) var<storage,read> inputs:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> output:array<vec2f>;
@compute @workgroup_size(64) fn plane(@builtin(global_invocation_id) id:vec3u) {
 let i=id.x; if(i>=arrayLength(&output)) {return;}
 let ray=Ray(inputs[3u*i].xyz,0.0,inputs[3u*i+1u].xyz,1e20);
 output[i]=precisePlaneDistance(ray,triangles[i],inputs[3u*i+2u].xyz);
}`, 'Compensated plane distance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'plane' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: out } }, { binding: 3, resource: { buffer: mesh } }] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64); pass.end();
    encoder.copyBufferToBuffer(out, 0, read, 0, out.size); device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ); const distances = new Float32Array(read.getMappedRange());
    let maxNormalizedError = 0, nonFinite = 0;
    for (let i = 0; i < count; i++) {
      const a = Array.from(vertices.slice(i * 24, i * 24 + 3)), b = Array.from(vertices.slice(i * 24 + 4, i * 24 + 7)), c = Array.from(vertices.slice(i * 24 + 8, i * 24 + 11));
      const normal = cross(b.map((v, j) => v - a[j]!), c.map((v, j) => v - a[j]!));
      const delta = a.map((v, j) => v - inputs[i * 12 + j]! - inputs[i * 12 + 8 + j]!);
      const exact = dot(normal, delta) / dot(normal, Array.from(inputs.slice(i * 12 + 4, i * 12 + 7)));
      const actual = distances[i * 2]! + distances[i * 2 + 1]!;
      if (!Number.isFinite(actual)) nonFinite++;
      const error = Math.abs(actual - exact) / Math.max(Math.abs(exact), [1e-4, 1, 1e4][i % 3]!);
      maxNormalizedError = Math.max(maxNormalizedError, error);
    }
    read.unmap(); const validation = await device.popErrorScope(); if (validation) throw Error(validation.message);
    return { adapter: name, cases: count, maxNormalizedError, nonFinite };
  } finally { buffers.forEach(b => b.destroy()); device.destroy(); }
}
