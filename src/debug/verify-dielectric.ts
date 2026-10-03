import dielectric from '../transport/dielectric.wgsl?raw';
import { createDevice, checkedShader } from '../gpu/device';

/** GPU interface tests against analytic Fresnel / Snell / transport-mode results. */
export async function verifyDielectric(): Promise<number[]> {
  const { device } = await createDevice();
  const output = device.createBuffer({ size: 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 128, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = await checkedShader(device, dielectric + `
      @group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
      @compute @workgroup_size(1) fn main() {
        let n = vec3f(0, 1, 0);
        output[0] = vec4f(dielectricFresnel(1.0, 1.5), dielectricFresnel(0.0, 1.5), dielectricFresnel(0.5, 1.0 / 1.5), dielectricFresnel(0.0, 1.0));
        let d = normalize(vec3f(0.6, -0.8, 0));
        let entry = sampleDielectric(d, n, 1.5, 0.99, false);
        let exit = sampleDielectric(entry.direction, n, 1.0 / 1.5, 0.99, false);
        output[1] = vec4f(entry.direction, entry.weight);
        output[2] = vec4f(exit.direction, entry.weight * exit.weight);
        let importance = sampleDielectric(d, n, 1.5, 0.99, true);
        output[3] = vec4f(importance.direction, importance.weight);
        let tir = sampleDielectric(normalize(vec3f(0.8660254, -0.5, 0)), n, 1.0 / 1.5, 0.99, false);
        output[4] = vec4f(tir.direction, f32(tir.transmitted));
        output[5] = vec4f(exp(-vec3f(0.2, 0.5, 1.0) * 2.0), 1.0);
        let wo = vec3f(-0.6,0.8,0); let wi = vec3f(0.6,0.8,0); let ns = vec3f(0.6,0.8,0);
        output[6] = vec4f(shadingNormalWeight(wo,wi,n,ns,true), shadingNormalWeight(wo,wi,n,ns,false), shadingNormalWeight(wo,wi,n,n,true), shadingNormalWeight(vec3f(1,0,0),wi,n,ns,true));
        let invalid = sampleDielectricSurface(vec3f(0,-1,0),n,normalize(vec3f(0.995,0.1,0)),1.5,0.0,false);
        output[7] = vec4f(invalid.weight,0,0,0);
      }
    `, 'dielectric acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 128); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return Array.from(new Float32Array(readback.getMappedRange()));
  } finally { output.destroy(); readback.destroy(); device.destroy(); }
}
