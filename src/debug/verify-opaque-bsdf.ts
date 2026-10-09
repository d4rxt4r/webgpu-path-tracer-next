import { createDevice, checkedShader } from "../gpu/device";
import { pathCore } from "../transport/shaders";

/** Independent sphere quadrature checks the sampled PDF mass, reciprocity and energy. */
export async function verifyOpaqueBsdf() {
  const { device } = await createDevice();
  const count = 32768, cases = 24;
  const output = device.createBuffer({ size: count * cases * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const spectra = device.createBuffer({ size: 471 * 4, usage: GPUBufferUsage.STORAGE });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = await checkedShader(device, pathCore + `
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let i=id.x;let test=id.y;
        let roughness=select(select(0.2,0.6,test%3u==1u),1.0,test%3u==2u);
        let wo=select(vec3f(0,1,0),normalize(vec3f(0.8660254,0.5,0)),test%6u>=3u);
        let n=vec3f(0,1,0);var material:Material;
        material.kind=select(6u+test/6u,10u,test>=18u);material.textureParams.x=roughness;
        if(material.kind==10u) {
          let s2=pow(roughness*PI/2.0,2.0);let a=1.0-s2/(2.0*(s2+0.33));let b=0.45*s2/(s2+0.09);let scale=max(1.0,a+b/2.0);
          material.textureParams.y=a/scale;material.textureParams.z=b/scale;
        }
        material.color=select(vec3f(0.5),vec3f(0.2,0.9,1.3),material.kind==6u);
        material.absorption=vec3f(3.5,2.5,1.8);material.ior=1.5;
        let u=vec2f(f32(i%256u)/256.0+0.5/256.0,f32(i/256u)/128.0+0.5/128.0);
        let random=f32(hash32(i+test*32768u))/4294967296.0;
        let event=sampleOpaque(material,-wo,n,0.0,u,random);
        var reciprocity=0.0;var mismatch=0.0;
        if(event.pdf>0.0) {
          let forward=opaqueEval(material,wo,event.direction,n,0.0);
          let reverse=opaqueEval(material,event.direction,wo,n,0.0);
          reciprocity=abs(forward.f.x-reverse.f.x)/max(1e-8,max(forward.f.x,reverse.f.x));
          mismatch=abs(forward.pdf-event.pdf)/max(1e-8,event.pdf);
        }
        // Uniform sphere integral, independent of VNDF sampling and event probabilities.
        let y=1.0-2.0*(f32(i)+0.5)/32768.0;let phi=2.0*PI*fract(f32(i)*0.61803398875);
        let wi=vec3f(sqrt(max(0.0,1.0-y*y))*cos(phi),y,sqrt(max(0.0,1.0-y*y))*sin(phi));
        let evaluated=opaqueEval(material,wo,wi,n,0.0);
        let index=(test*32768u+i)*2u;
        output[index]=vec4f(event.weight.x,f32(event.pdf>0.0),reciprocity,mismatch);
        output[index+1u]=vec4f(evaluated.pdf*4.0*PI,evaluated.f.x*abs(wi.y)*4.0*PI,0,0);
      }`, "opaque energy / reciprocity");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }, { binding: 9, resource: { buffer: spectra } }] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count / 64, cases); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ); const data = new Float32Array(readback.getMappedRange());
    const results = Array.from({ length: cases }, (_, test) => {
      let energy = 0, accepted = 0, pdfIntegral = 0, quadratureEnergy = 0, reciprocity = 0, mismatch = 0, invalid = 0;
      for (let i = 0; i < count; i++) {
        const offset = (test * count + i) * 8;
        for (let c = 0; c < 6; c++) if (!Number.isFinite(data[offset + c]!) || data[offset + c]! < 0) invalid++;
        energy += data[offset]! / count; accepted += data[offset + 1]! / count;
        reciprocity = Math.max(reciprocity, data[offset + 2]!); mismatch = Math.max(mismatch, data[offset + 3]!);
        pdfIntegral += data[offset + 4]! / count; quadratureEnergy += data[offset + 5]! / count;
      }
      return { kind:test>=18?10:6+Math.floor(test/6), roughness:[.2,.6,1][test%3], grazing:test%6>=3, energy, accepted, pdfIntegral, quadratureEnergy, reciprocity, mismatch, invalid };
    });
    return results;
  } finally { output.destroy(); spectra.destroy(); readback.destroy(); device.destroy(); }
}
