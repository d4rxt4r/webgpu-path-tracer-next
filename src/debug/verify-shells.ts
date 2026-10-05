import { makeStructuredView } from "webgpu-utils";
import { createDevice, checkedShader } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { loadSobol } from "../assets/sobol";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { cameraShells } from "../accel/camera-media";
import { pathCore } from "../transport/shaders";
import { fastTransportShader } from "../transport/fast-source";
import { shellScene } from "./shell-fixture";

/** Compare identical paths against one slab; internal same-medium boundaries must be invisible. */
export async function verifyShells(precise = true) {
  const { device } = await createDevice();
  const buffers: GPUBuffer[] = [];
  const create = (size: number, usage: GPUBufferUsageFlags) => { const b=device.createBuffer({size,usage});buffers.push(b);return b; };
  try {
    const count=1024, output=create(count*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=create(count*16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const cameraView=makeStructuredView(definitions.structs.CameraParams!);
    const camera=create(cameraView.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const directions=await loadSobol(),sobol=create(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(sobol,0,directions);
    const code=pathCore+`
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      @group(0) @binding(1) var<uniform> params:CameraParams;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        let value=tracePathWithMedia(Ray(params.eye.xyz,0.0,vec3f(0,0,1),100.0),id.x,17u,1u,16u,2u,1u,0.0,cameraMedia(params));
        output[id.x]=vec4f(value.radiance,f32(value.error));
      }`;
    const module=await checkedShader(device,precise ? code : fastTransportShader(code),"independent overlapping shells");
    const pipeline=await device.createComputePipelineAsync({layout:"auto",compute:{module,entryPoint:"main"}});
    const results: {kind:string;inside:boolean;errors:number;retryable:number;mean:number[];difference?:number}[]=[];
    const reference=new Map<boolean,Float32Array>();
    for(const inside of [false,true]) for(const kind of ["reference","overlap","nested","touching","disjoint"] as const) {
      if(inside && kind==="disjoint") continue;
      const scene=shellScene(kind,inside),bvh=buildBvh(bakeTriangles(scene));
      const packed={...packBvh(bvh),...packTransport(scene,bvh)},gpu=new GpuScene(device,packed);
      try {
        const shells=cameraShells(packed,scene.camera.position),initialShells=new Uint32Array(32);initialShells.set(shells);
        cameraView.set({eye:[...scene.camera.position,0],padding1:shells.length,initialShells});
        device.queue.writeBuffer(camera,0,cameraView.arrayBuffer);
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}},{binding:1,resource:{buffer:camera}},...gpu.entries(),...gpu.transportEntries(),{binding:7,resource:{buffer:sobol}},gpu.spectralEntry()]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count/64);pass.end();
        encoder.copyBufferToBuffer(output,0,readback,0,count*16);device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);const data=new Float32Array(readback.getMappedRange()).slice();readback.unmap();
        let errors=0,retryable=0,difference=0;const mean=[0,0,0];
        for(let i=0;i<count;i++) retryable+=Number(data[i*4+3]===4 || data[i*4+3]===5);
        for(let i=0;i<count;i++) {errors+=Number(data[i*4+3]!==0);for(let c=0;c<3;c++) {mean[c]!+=data[i*4+c]!/count;if(kind!=="reference"&&kind!=="disjoint") difference=Math.max(difference,Math.abs(data[i*4+c]!-reference.get(inside)![i*4+c]!));}}
        if(kind==="reference") reference.set(inside,data);
        results.push({kind,inside,errors,retryable,mean,difference:kind==="overlap"||kind==="nested"||kind==="touching" ? difference : undefined});
      } finally {gpu.dispose();}
    }
    return results;
  } finally {buffers.forEach(b=>b.destroy());device.destroy();}
}
