import dielectric from "../transport/dielectric.wgsl?raw";
import { createDevice, checkedShader } from "../gpu/device";

/** Exercise the production WGSL functions against analytic sheet optics. */
export async function verifyThinGlass(): Promise<number[]> {
  const { device } = await createDevice();
  const output = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = await checkedShader(device, dielectric + `
      @group(0) @binding(0) var<storage,read_write> output: array<vec4f>;
      @compute @workgroup_size(1) fn main() {
        let n=vec3f(0,1,0); let d=normalize(vec3f(0.6,-0.8,0));
        output[0]=vec4f(thinReflectance(1.0,1.5),thinReflectance(0.0,1.5),thinReflectance(0.0,1.0),thinReflectance(1.0,1.0));
        let transmitted=sampleThinDielectric(d,n,1.5,0.99);
        let reflected=sampleThinDielectric(d,n,1.5,0.0);
        output[1]=vec4f(transmitted.direction,transmitted.weight);
        output[2]=vec4f(reflected.direction,reflected.weight);
        var reflections=0.0;var meanWeight=0.0;
        for(var i=0u;i<10000u;i++) {
          let event=sampleThinDielectric(vec3f(0,-1,0),n,1.5,(f32(i)+0.5)/10000.0);
          reflections+=f32(event.transmitted==0u);meanWeight+=event.weight;
        }
        output[3]=vec4f(reflections/10000.0,meanWeight/10000.0,thinReflectance(0.001,2.5),thinReflectance(0.8,1.5));
      }`, "thin glass acceptance");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 64); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return Array.from(new Float32Array(readback.getMappedRange()));
  } finally { output.destroy(); readback.destroy(); device.destroy(); }
}
