import { makeStructuredView } from 'webgpu-utils';
import { createDevice, checkedShader } from '../gpu/device';
import { definitions } from '../accel/pack';
import { loadSobol } from '../assets/sobol';
import layouts from '../transport/layouts.wgsl?raw';
import sampler from '../transport/sampler.wgsl?raw';
import cameraSource from '../transport/camera.wgsl?raw';

/** Isolate optical geometry from Monte Carlo lighting noise. */
export async function verifyCameraRays() {
  const {device,name}=await createDevice(), count=4096, buffers:GPUBuffer[]=[];
  const make=(size:number,usage:GPUBufferUsageFlags)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
  try {
    const source=layouts+'\n'+sampler+'\n'+cameraSource+`
      @group(0) @binding(1) var<uniform> params:CameraParams;
      @group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let direction=normalize(vec3f(.2,.1,-1));
        let ray=thinLensRay(params,direction,id.x);
        let axial=dot(ray.direction,params.forward.xyz);
        let expected=direction*(params.optics.y/dot(direction,params.forward.xyz));
        let onPlane=ray.origin+ray.direction*(params.optics.y/axial);
        let near=ray.origin+ray.direction*(params.optics.y*.5/axial)-expected*.5;
        let far=ray.origin+ray.direction*(params.optics.y*1.5/axial)-expected*1.5;
        result[id.x*2u]=vec4f(ray.origin.xy,length(onPlane-expected),dot(ray.origin,params.forward.xyz));
        result[id.x*2u+1u]=vec4f(length(near),length(far),length(near)/max(length(ray.origin),1e-20),0);
      }`;
    const module=await checkedShader(device,source,'Thin lens geometry acceptance');
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const output=make(count*32,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC), readback=make(count*32,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const params=makeStructuredView(definitions.structs.CameraParams!), uniform=make(params.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const directions=await loadSobol(), sobol=make(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(sobol,0,directions);
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}},{binding:1,resource:{buffer:uniform}},{binding:7,resource:{buffer:sobol}}]});
    const rows=[];
    for(const blades of [0,3,6,12]) for(const radius of [.01,.05]) {
      params.set({eye:[0,0,0,0],forward:[0,0,-1,0],right:[1,0,0,0],up:[0,1,0,0],seed:17,optics:[radius,2,blades,.4]});device.queue.writeBuffer(uniform,0,params.arrayBuffer);
      const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count/64);pass.end();encoder.copyBufferToBuffer(output,0,readback,0,output.size);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const data=new Float32Array(readback.getMappedRange());
      let focusError=0,planeError=0,near2=0,far2=0,meanR2=0,ratioError=0;
      for(let i=0;i<count;i++) {const p=i*8;focusError=Math.max(focusError,data[p+2]!);planeError=Math.max(planeError,Math.abs(data[p+3]!));near2+=data[p+4]!**2;far2+=data[p+5]!**2;meanR2+=(data[p]!**2+data[p+1]!**2)/radius**2;ratioError=Math.max(ratioError,Math.abs(data[p+6]!-.5));}
      readback.unmap();rows.push({blades,radius,focusError,planeError,nearRms:Math.sqrt(near2/count),farRms:Math.sqrt(far2/count),meanR2:meanR2/count,ratioError});
    }
    return {adapter:name,count,focusDistance:2,rows};
  } finally {buffers.forEach(b=>b.destroy());device.destroy();}
}
