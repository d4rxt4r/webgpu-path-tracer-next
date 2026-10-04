import { createDevice, checkedShader } from '../gpu/device';
import { TRANSPORT_QUEUE_BYTES, clearTransportQueue, encodeTransportRepair } from '../render/transport-diagnostics';
import diagnostics from '../transport/diagnostics.wgsl?raw';

/** Exercise compact replay and bounded-queue overflow on the actual GPU. */
export async function verifyTransportQueue() {
  const {device}=await createDevice();
  const buffers:GPUBuffer[]=[];
  const create=(size:number,usage:number)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
  try {
    device.pushErrorScope('validation');
    const queue=create(TRANSPORT_QUEUE_BYTES,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
    const indirect=create(12,GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST);
    const result=create(70001*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
    const readback=create(result.size+68,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const module=await checkedShader(device,`const NO_HIT:u32=0xffffffffu;
struct TestParams {frame:u32,seed:u32,size:vec2u}
@group(0) @binding(1) var<uniform> params:TestParams;
${diagnostics}
override TOTAL:u32=512u;
override STRIDE:u32=2u;
@group(0) @binding(8) var<storage,read_write> seen:array<atomic<u32>>;
@compute @workgroup_size(64) fn emit(@builtin(global_invocation_id) id:vec3u) {
  if(id.x<TOTAL && id.x%STRIDE==0u) {enqueueTransportRetry(id.x,TOTAL);}
}
@compute @workgroup_size(64) fn repair(@builtin(global_invocation_id) id:vec3u) {
  let index=transportRetryIndex(id.x,TOTAL);if(index==NO_HIT || index%STRIDE!=0u) {return;}
  atomicAdd(&seen[index],1u);
}`, 'Transport retry queue');
    const reports=[];
    for(const [total,stride] of [[512,2],[70001,1]]) {
      const pipelines=await Promise.all(['emit','repair'].map(entryPoint=>device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint,constants:{TOTAL:total!,STRIDE:stride!}}})));
      const groups=pipelines.map((p,i)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:queue}},...(i?[{binding:8,resource:{buffer:result}}]:[])]}));
      const encoder=device.createCommandEncoder();clearTransportQueue(encoder,queue);encoder.clearBuffer(result);
      const pass=encoder.beginComputePass();pass.setPipeline(pipelines[0]!);pass.setBindGroup(0,groups[0]!);pass.dispatchWorkgroups(Math.ceil(total!/64));pass.end();
      encodeTransportRepair(encoder,queue,indirect,pipelines[1]!,groups[1]!);
      encoder.copyBufferToBuffer(queue,0,readback,0,68);encoder.copyBufferToBuffer(result,0,readback,68,result.size);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const words=new Uint32Array(readback.getMappedRange());
      let missed=0,duplicated=0,unexpected=0;
      for(let i=0;i<total!;i++) {const count=words[17+i]!;if((i%stride!)===0) {if(count===0) missed++;if(count>1) duplicated++;}else if(count) unexpected++;}
      reports.push({total,stride,count:words[12],dense:words[16],dispatch:words[13],missed,duplicated,unexpected});readback.unmap();
    }
    const error=await device.popErrorScope();if(error) throw Error(error.message);return reports;
  }finally{buffers.forEach(b=>b.destroy());device.destroy();}
}
