import { makeStructuredView } from "webgpu-utils";
import { buddhaScene } from "../scene/buddha";
import type { SphereMaterial } from "../scene/cornell";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { GpuScene } from "../gpu/scene";
import { createDevice, checkedShader } from "../gpu/device";
import { loadSobol } from "../assets/sobol";
import { cameraBasis } from "../scene/camera";
import { sppmShader, specializedSppmShader, sppmDefinitions } from "../transport/sppm-shader";
import { intersectTriangle } from "../accel/intersect";

/** Debug-only path replay. Reuse photon slots to stay within eight storage bindings. */
export async function replayBuddhaTransport(options: {
  phase:"camera"|"photon";sample:number;index:number;seed?:number;material?:SphereMaterial;
  width?: number; height?: number; specializeSampler?: boolean;
  shaderTransform?: (source:string)=>string;
}) {
  const scene=await buddhaScene(options.material ?? "glass");
  const bvh=buildBvh(bakeTriangles(scene)),packed={...packBvh(bvh),...packTransport(scene,bvh)};
  const {device}=await createDevice(),gpu=new GpuScene(device,packed),buffers:GPUBuffer[]=[];
  const make=(size:number,usage:GPUBufferUsageFlags)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
  try {
    const directions=await loadSobol(),sobol=make(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(sobol,0,directions);
    const params=makeStructuredView(definitions.structs.CameraParams!),basis=cameraBasis(scene.camera);
    params.set({size:[options.width ?? 1316,options.height ?? 740],frame:options.sample,eye:[...basis.eye,0],forward:[...basis.forward,0],right:[...basis.right,0],up:[...basis.up,0],maxDepth:32,seed:options.seed ?? 1,lightCount:packed.lightCount});
    const uniform=make(params.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(uniform,0,params.arrayBuffer);
    const batch=makeStructuredView(sppmDefinitions.structs.SppmParams!);
    batch.set({iteration:options.sample,batchStart:options.index,batchCount:1,photonsPerIteration:16384,initialRadius:0.03});
    const batchUniform=make(batch.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(batchUniform,0,batch.arrayBuffer);
    const diagnostic=make(64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const trace=make(33*64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=make(trace.size+64,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const shader=options.specializeSampler ? specializedSppmShader : sppmShader;
    let source=options.shaderTransform?.(shader) ?? shader;
    const begin=source.indexOf(options.phase==="camera"?"fn cameraPoint(":"fn tracePhoton("),end=source.indexOf(options.phase==="camera"?"fn cameraMain(":"fn hashMain(",begin);
    let part=source.slice(begin,end);
    part=part.replace("let hit=closestHitWithOrigin(ray,originLow);", "let hit=closestHitWithOrigin(ray,originLow);photons[depth]=Photon(ray.origin,medium,ray.direction,hit.triangle,vec3f(hit.t,hit.u,hit.v),hit.id,bitcast<vec3i>(originLow),0u,vec3f(0),0u);");
    part=part.replace(/photons\[first\+depth\]=Photon\([^;]+;/,"// Trace slot already contains the ray.\n");
    part=part.replace("if(event.weight==0.0)","photons[depth].next=event.transmitted+2u*u32(entering);if(event.weight==0.0)");
    source=source.slice(0,begin)+part+source.slice(end);
    if(options.phase==="camera") source+=`
@compute @workgroup_size(1) fn cameraReplay() {
 let pixel=${options.index}u;let xy=vec2u(pixel%params.size.x,pixel/params.size.x);
 let jitter=vec2f(sample1D(params.frame,0u,pixel,params.seed),sample1D(params.frame,1u,pixel,params.seed));
 let uv=(vec2f(xy)+jitter)/vec2f(params.size);let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
 let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
 let point=cameraPoint(Ray(params.eye.xyz,0.00001,direction,1e20),pixel,0.0);
}`;
    device.pushErrorScope("validation");
    const module=await checkedShader(device,source,"Buddha path replay"),pipeline=await device.createComputePipelineAsync({layout:"auto",compute:{module,entryPoint:options.phase==="camera"?"cameraReplay":"photonMain"}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:1,resource:{buffer:uniform}},{binding:4,resource:{buffer:diagnostic}},
      {binding:7,resource:{buffer:sobol}},{binding:21,resource:{buffer:trace}},
      ...(options.phase==="photon"?[{binding:11,resource:{buffer:batchUniform}}]:[]),
      ...gpu.entries(),...gpu.transportEntries(),gpu.spectralEntry()]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    encoder.copyBufferToBuffer(trace,0,readback,0,trace.size);encoder.copyBufferToBuffer(diagnostic,0,readback,trace.size,64);
    device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
    const mapped=readback.getMappedRange(),floats=new Float32Array(mapped),words=new Uint32Array(mapped);
    const geometry=new Float32Array(packed.triangles),steps=[];
    for(let depth=0;depth<33;depth++) {
      const offset=depth*16;if(floats[offset+4]===0&&floats[offset+5]===0&&floats[offset+6]===0) break;
      const index=words[offset+7]!;
      steps.push({depth,origin:Array.from(floats.slice(offset,offset+3)),residual:Array.from(floats.slice(offset+12,offset+15)),medium:words[offset+3],direction:Array.from(floats.slice(offset+4,offset+7)),triangle:index,t:floats[offset+8],u:floats[offset+9],v:floats[offset+10],id:words[offset+15],event:words[offset+11],vertices:index<packed.triangleCount?Array.from(geometry.slice(index*24,index*24+12)):[]});
      if(index===0xffffffff) break;
    }
    const errors=Array.from(words.slice(trace.size/4,trace.size/4+16));readback.unmap();
    const cpuTriangles=bvh.triangles.map((tri,i)=>({...tri,
      a:Array.from(geometry.slice(i*24,i*24+3)) as [number,number,number],
      b:Array.from(geometry.slice(i*24+4,i*24+7)) as [number,number,number],
      c:Array.from(geometry.slice(i*24+8,i*24+11)) as [number,number,number]}));
    const cpu=steps.map(step=>{
      let nearest:{index:number;t:number;u:number;v:number;side:number}|undefined;
      cpuTriangles.forEach((tri,index)=>{
        const hit=intersectTriangle({origin:step.origin.map((v,i)=>v+step.residual[i]!) as [number,number,number],direction:step.direction as [number,number,number],tMin:0,tMax:nearest?.t ?? 1e20},tri);
        if(!hit)return;
        const a=tri.b.map((v,i)=>v-tri.a[i]!),b=tri.c.map((v,i)=>v-tri.a[i]!);
        const normal=[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
        nearest={index,t:hit.t,u:hit.u,v:hit.v,side:normal.reduce((sum,v,i)=>sum+v*step.direction[i]!,0)};
      });
      return nearest;
    });
    const validation=await device.popErrorScope();if(validation) throw new Error(validation.message);
    return {options:{...options,shaderTransform:undefined},errors,steps,cpu};
  } finally {buffers.forEach(b=>b.destroy());gpu.dispose();device.destroy();}
}
