import { mat4 } from 'gl-matrix';
import { createDevice, checkedShader } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { loadSobol } from '../assets/sobol';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { pathCore } from '../transport/shaders';
import { sobolSample } from '../transport/sampler';
import type { SceneDescription } from '../scene/types';

const code = pathCore + `
struct TestParams { count: u32, strategy: u32, depth: u32, seed: u32 }
@group(0) @binding(0) var<storage, read_write> values: array<vec4f>;
@group(0) @binding(1) var<uniform> testParams: TestParams;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= testParams.count) { return; }
  let value = tracePath(Ray(vec3f(0, 0.5, 0), 0.00001, vec3f(0, -1, 0), 100.0), id.x, 17u, testParams.seed, testParams.depth, testParams.strategy, 2u);
  values[id.x] = vec4f(value.radiance, f32(value.error));
}
@compute @workgroup_size(64)
fn samplerMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= testParams.count) { return; }
  values[id.x] = vec4f(sample1D(id.x, 0u, 17u, 1u), sample1D(id.x, 1u, 17u, 1u), sample1D(id.x, 450u, 17u, 1u), 0.0);
}
@compute @workgroup_size(64)
fn pdfMain(@builtin(global_invocation_id) id: vec3u) {
 if (id.x >= testParams.count) { return; }
 let wi = cosineDirection(vec3f(0,1,0), vec2f(sample1D(id.x,6u,17u,1u), sample1D(id.x,7u,17u,1u)));
 let ray = Ray(vec3f(0,0.000004,0),0.0,wi,100.0);
 let hit = closestHit(ray);
 var pdf = 0.0;
 if(hit.id != NO_HIT) { pdf = lightPdf(vec3f(0),ray.origin+hit.t*wi,hit.id,2u); }
 values[id.x] = vec4f(f32(hit.id),pdf,wi.y/PI,hit.t);
}
@compute @workgroup_size(64)
fn rouletteMain(@builtin(global_invocation_id) id: vec3u) {
 if (id.x >= testParams.count) { return; }
 var beta = vec3f(1);
 for (var depth = 0u; depth < 12u; depth++) {
   beta *= 0.8;
   if (depth >= 4u) { beta = rouletteWeight(beta,1.0,sample1D(id.x,3u+7u*depth+6u,17u,1u)); }
   if (all(beta == vec3f(0))) { break; }
 }
 values[id.x] = vec4f(beta,0);
}`;

export async function verifyTransport() {
  const { device, name } = await createDevice();
  const resources: GPUBuffer[] = [];
  let gpuScene: GpuScene | undefined;
  const create = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => { const buffer = device.createBuffer({ size, usage }); resources.push(buffer); return buffer; };
  try {
    const identity = Array.from(mat4.create());
    const scene: SceneDescription = {
      version: 1, camera: { position: [0, 0.5, 0], target: [0, 0, 0], up: [0, 0, 1], verticalFov: 40 },
      meshes: [
        { positions: new Float32Array([-2, 0, 2, 2, 0, 2, 2, 0, -2, -2, 0, -2]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
        { positions: new Float32Array([-1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
      ], objects: [{ mesh: 0, material: 0, transform: identity }, { mesh: 1, material: 1, transform: identity }],
      materials: [{ type: 'diffuse', reflectance: [0.5, 0.4, 0.3] }, { type: 'emissive', emission: [1, 1, 1] }], lights: [{ object: 1 }],
    };
    const bvh = buildBvh(bakeTriangles(scene));
    gpuScene = new GpuScene(device, { ...packBvh(bvh), ...packTransport(scene, bvh) });
    const directions = await loadSobol();
    const sobol = create(directions.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST); device.queue.writeBuffer(sobol, 0, directions);
    const count = 65536;
    const output = create(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = create(count * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const params = create(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const module = await checkedShader(device, code, 'RGB energy acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const samplerPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'samplerMain' } });
    const pdfPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'pdfMain' } });
    const roulettePipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'rouletteMain' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, { binding: 1, resource: { buffer: params } }, ...gpuScene.entries(), ...gpuScene.transportEntries(), { binding: 7, resource: { buffer: sobol } }, gpuScene.spectralEntry()] });
    const samplerGroup = device.createBindGroup({ layout: samplerPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, { binding: 1, resource: { buffer: params } }, { binding: 7, resource: { buffer: sobol } }] });
    const pdfGroup = device.createBindGroup({ layout: pdfPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, { binding: 1, resource: { buffer: params } }, ...gpuScene.entries(), { binding: 6, resource: { buffer: gpuScene.lights } }, { binding: 7, resource: { buffer: sobol } }] });
    const rouletteGroup = device.createBindGroup({ layout: roulettePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, { binding: 1, resource: { buffer: params } }, { binding: 7, resource: { buffer: sobol } }] });
    const run = async (strategy: number, depth: number, seed: number, sampler = false, pdf = false, roulette = false): Promise<Float32Array> => {
      device.queue.writeBuffer(params, 0, new Uint32Array([count, strategy, depth, seed]));
      const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass();
      pass.setPipeline(roulette ? roulettePipeline : pdf ? pdfPipeline : sampler ? samplerPipeline : pipeline); pass.setBindGroup(0, roulette ? rouletteGroup : pdf ? pdfGroup : sampler ? samplerGroup : group); pass.dispatchWorkgroups(count / 64); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, count * 16); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ); const data = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap(); return data;
    };
    let errors = 0;
    const estimates: number[][] = [];
    for (let strategy = 0; strategy < 3; strategy++) {
      const data = await run(strategy, 1, 1), mean = [0, 0, 0];
      for (let i = 0; i < count; i++) { for (let channel = 0; channel < 3; channel++) mean[channel]! += data[i * 4 + channel]! / count; errors += data[i * 4 + 3]!; }
      estimates.push(mean);
    }
    const samples = await run(0, 1, 1, true), cpuDirections = new Uint32Array(directions);
    const pdfData = await run(0,1,1,false,true);
    let maxPdfError = 0;
    for (let i = 0; i < count; i++) if (pdfData[i*4]! < 10) {
      const cosine = pdfData[i*4+2]! * Math.PI, distance = pdfData[i*4+3]!;
      const expected = (1 + (1 - cosine * cosine) * distance * distance) ** 1.5 / 4;
      const pdf = pdfData[i*4+1]!;
      if (!Number.isFinite(pdf) || pdf <= 0) errors++;
      else maxPdfError = Math.max(maxPdfError, Math.abs(pdf - expected) / expected);
    }
    const rouletteData = await run(0,1,1,false,false,true);
    let rouletteMean = 0;
    for (let i = 0; i < count; i++) rouletteMean += rouletteData[4*i]! / count;
    let maxSamplerError = 0;
    for (let i = 0; i < 256; i++) for (const [channel, dim] of [0, 1, 450].entries()) maxSamplerError = Math.max(maxSamplerError, Math.abs(samples[i * 4 + channel]! - sobolSample(i, dim, 17, 1, cpuDirections)));
    // Independent deterministic area quadrature of cos(theta)^2 / r^2.
    let irradiance = 0;
    const grid = 512;
    for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
      const px = -1 + (x + 0.5) * 2 / grid, pz = -1 + (y + 0.5) * 2 / grid;
      irradiance += 4 / (grid * grid) / ((1 + px * px + pz * pz) ** 2);
    }
    return { estimates, reference: [0.5, 0.4, 0.3].map(albedo => albedo * irradiance / Math.PI), maxSamplerError, maxPdfError, rouletteMean, rouletteReference: 0.8 ** 12, errors, adapter: name };
  } finally { resources.forEach(buffer => buffer.destroy()); gpuScene?.dispose(); device.destroy(); }
}
