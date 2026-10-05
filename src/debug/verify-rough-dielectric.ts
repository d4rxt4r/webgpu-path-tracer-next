import { createDevice, checkedShader } from "../gpu/device";
import { pathCore } from "../transport/shaders";

/** Independent sphere quadrature checks the sampled PDF mass, reciprocity and energy. */
export async function verifyRoughDielectric() {
  const { device } = await createDevice();
  const count = 32768, cases = 16;
  const output = device.createBuffer({ size: count * cases * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const spectra = device.createBuffer({ size: 471 * 4, usage: GPUBufferUsage.STORAGE });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = await checkedShader(device, pathCore + `
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let i=id.x;let test=id.y;let thin=(test>=6u && test<12u)||test>=14u;let local=select(test%6u,test%2u,test>=12u);
        let roughness=select(select(0.6,1.0,local>=3u),0.01,test>=12u);let eta=select(1.5,1.0/1.5,local%3u==2u);
        let wo=select(vec3f(0,1,0),normalize(vec3f(0.8660254,0.5,0)),local%3u!=0u);
        let n=vec3f(0,1,0);var material:Material;
        material.kind=select(2u,5u,thin);material.color=vec3f(1);material.textureParams.x=roughness;
        let u=vec2f(f32(i%256u)/256.0+0.5/256.0,f32(i/256u)/128.0+0.5/128.0);
        let random=f32(hash32(i+test*32768u))/4294967296.0;
        let event=sampleRoughDielectric(material,-wo,n,n,eta,0.0,u,random,true);
        var reciprocity=0.0;var mismatch=0.0;
        if(event.pdf>0.0) {
          let forward=roughDielectricEval(material,wo,event.direction,n,n,eta,0.0,false);
          let transmitted=event.transmitted!=0u;
          let reverseNormal=select(n,-n,transmitted);
          let reverseEta=select(eta,1.0/eta,transmitted && !thin);
          let reverse=roughDielectricEval(material,event.direction,wo,reverseNormal,reverseNormal,reverseEta,0.0,false);
          let scale=select(1.0,eta*eta,transmitted && !thin);
          reciprocity=abs(forward.f.x*scale-reverse.f.x)/max(1e-8,max(forward.f.x*scale,reverse.f.x));
          mismatch=abs(forward.pdf-event.pdf)/max(1e-8,event.pdf);
        }
        // Uniform sphere integral, independent of VNDF sampling and event probabilities.
        let y=1.0-2.0*(f32(i)+0.5)/32768.0;let phi=2.0*PI*fract(f32(i)*0.61803398875);
        let wi=vec3f(sqrt(max(0.0,1.0-y*y))*cos(phi),y,sqrt(max(0.0,1.0-y*y))*sin(phi));
        let evaluated=roughDielectricEval(material,wo,wi,n,n,eta,0.0,true);
        let index=(test*32768u+i)*2u;
        output[index]=vec4f(event.weight.x,f32(event.pdf>0.0),reciprocity,mismatch);
        output[index+1u]=vec4f(evaluated.pdf*4.0*PI,evaluated.f.x*abs(wi.y)*4.0*PI,0,0);
      }`, "rough dielectric energy / reciprocity");
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
      return { thin: (test >= 6 && test < 12) || test >= 14, roughness: test >= 12 ? 0.01 : test % 6 >= 3 ? 1 : 0.6, incidence: test >= 12 ? test % 2 : test % 3, energy, accepted, pdfIntegral, quadratureEnergy, reciprocity, mismatch, invalid };
    });
    return results;
  } finally { output.destroy(); spectra.destroy(); readback.destroy(); device.destroy(); }
}
