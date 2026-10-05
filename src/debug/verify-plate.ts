import { cameraShells } from "../accel/camera-media";
import { createDevice, checkedShader } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { loadSobol } from '../assets/sobol';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { pathCore } from '../transport/shaders';
import type { SceneDescription } from '../scene/types';

export async function verifyPlate(inside = false) {
  const { device } = await createDevice();
  const buffers: GPUBuffer[] = []; let gpu: GpuScene | undefined;
  const create = (size: number, usage: GPUBufferUsageFlags) => { const b = device.createBuffer({ size, usage }); buffers.push(b); return b; };
  try {
    const transform = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const absorption = [0.2, 0.5, 1] as [number, number, number];
    const scene: SceneDescription = {
      version: 1, camera: { position: [0,2,0], target: [0,0,0], up: [0,0,1], verticalFov: 40 },
      meshes: [
        { positions: new Float32Array([-5,0,-5, 5,0,-5, 5,0,5, -5,0,5, -5,1,-5, 5,1,-5, 5,1,5, -5,1,5]), indices: new Uint32Array([0,1,2,0,2,3,4,7,6,4,6,5,0,4,5,0,5,1,3,2,6,3,6,7,0,3,7,0,7,4,1,5,6,1,6,2]) },
        { positions: new Float32Array([-5,-1,-5,-5,-1,5,5,-1,5,5,-1,-5]), indices: new Uint32Array([0,1,2,0,2,3]) },
      ], objects: [{ mesh: 0, material: 0, transform }, { mesh: 1, material: 1, transform }],
      materials: [{ type: 'dielectric', ior: 1.5, absorption }, { type: 'emissive', emission: [1,1,1] }], lights: [{ object: 1 }],
    };
    const bvh = buildBvh(bakeTriangles(scene));
    const packed = { ...packBvh(bvh), ...packTransport(scene, bvh) };
    const shells = cameraShells(packed,[0,inside ? 0.5 : 2,0]);
    gpu = new GpuScene(device, packed);
    const directions = await loadSobol();
    const sobol = create(directions.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(sobol, 0, directions);
    const count = 65536, output = create(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = create(count * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const module = await checkedShader(device, pathCore + `
      @group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
        var initialMedia:MediumSet;initialMedia.count=${shells.length}u;
        ${Array.from(shells,(index,i)=>`initialMedia.entries[${i}u]=${index}u;initialMedia.windings[${i}u]=1;`).join("\n")}
        let value = tracePathWithMedia(Ray(vec3f(0,${inside ? '0.5' : '2.0'},0), 0.0, vec3f(0,-1,0), 100.0), id.x, 17u, 1u, 32u, 1u, 2u, 0.0, initialMedia);
        output[id.x] = vec4f(value.radiance, f32(value.error));
      }`, 'absorbing parallel plate');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, ...gpu.entries(), ...gpu.transportEntries(true), { binding: 7, resource: { buffer: sobol } }, gpu.spectralEntry()] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, count * 16); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readback.getMappedRange()), mean = [0,0,0]; let errors = 0;
    for (let i = 0; i < count; i++) { for (let c = 0; c < 3; c++) mean[c]! += data[4*i+c]! / count; errors += data[4*i+3]!; }
    // Sum all internal round trips: (1-R)^2 A / (1-R^2 A^2).
    return { mean, reference: absorption.map(sigma => { const a = Math.exp(-sigma); return (inside ? 0.96 * 2.25 * Math.sqrt(a) : 0.96 ** 2 * a) / (1 - 0.04 ** 2 * a * a); }), errors };
  } finally { buffers.forEach(b => b.destroy()); gpu?.dispose(); device.destroy(); }
}
