import { createDevice, checkedShader } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { buildBvh } from "../accel/bvh";
import { bakeTriangles } from "../accel/geometry";
import { packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { shellBox } from "./shell-fixture";
import { pathCore } from "../transport/shaders";
import { mediumCapacityShader, type CommonMediumCapacity } from "../transport/medium-source";
import type { SceneDescription } from "../scene/types";

/** Exercise production state transitions directly: order, signed winding,
 * reflection rollback and capacity overflow must not depend on path sampling.
 */
export async function verifyMediumState(capacity: CommonMediumCapacity = 4) {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const meshes = Array.from({length: 33}, (_,i) => shellBox([i * 3,0,0],[i * 3 + 1,1,1]));
  const scene: SceneDescription = {version: 1, meshes, objects: meshes.map((_,mesh) => ({mesh,material:0,transform:identity})),
    materials: [{type:"dielectric",ior:1.5,absorption:[0,0,0]}], lights: [],
    camera: {position:[-1,0.2,0.3],target:[1,0.2,0.3],up:[0,1,0],verticalFov:40}};
  const bvh = buildBvh(bakeTriangles(scene)), packed = {...packBvh(bvh), ...packTransport(scene,bvh)};
  const indices = meshes.map((_,surface) => bvh.triangles.findIndex(t => t.surface === surface));
  const {device} = await createDevice(), gpu = new GpuScene(device,packed);
  const output = device.createBuffer({size:32,usage:GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const readback = device.createBuffer({size:32,usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  try {
    const code = mediumCapacityShader(pathCore,capacity) + `
      @group(0) @binding(0) var<storage,read_write> output:array<u32>;
      const INDICES=array<u32,33>(${indices.map(n=>n+"u").join(",")});
      fn step(state:ptr<function,MediumSet>, index:u32, entering:bool) {
        let change=previewMediumChange(state,INDICES[index],entering);applyMediumChange(state,change);
      }
      @compute @workgroup_size(1) fn main() {
        var state:MediumSet;
        let first=previewMediumChange(&state,INDICES[0],true);
        output[0]=u32(state.count!=0u || first.medium!=INDICES[0] || first.error!=0u);
        applyMediumChange(&state,first);step(&state,0u,true);
        output[1]=u32(state.count!=1u || state.windings[0]!=2);
        step(&state,0u,false);step(&state,0u,false);
        output[1]+=u32(state.count!=0u);
        step(&state,0u,false);
        output[2]=u32(state.count!=1u || state.windings[0]!=-1);
        step(&state,0u,true);output[2]+=u32(state.count!=0u);
        step(&state,0u,true);step(&state,1u,true);
        let removal=previewMediumChange(&state,INDICES[0],false);
        output[3]=u32(removal.medium!=INDICES[1] || state.count!=2u);
        applyMediumChange(&state,removal);undoMediumChange(&state,MediumUndo(removal.triangle,removal.slot,removal.before,removal.after));
        output[3]+=u32(state.count!=2u || state.entries[0]!=INDICES[0] || state.entries[1]!=INDICES[1]);
        var journal:MediumJournal;
        journalMediumChange(&state,&journal,INDICES[0],false);
        journalMediumChange(&state,&journal,INDICES[2],true);
        finishMediumAtSurface(&state,removal,&journal,false);
        output[4]=u32(journal.error!=0u || state.count!=2u || state.entries[0]!=INDICES[0] || state.entries[1]!=INDICES[1] || state.windings[0]!=1);
        for(var i=2u;i<MEDIUM_CAPACITY;i++) {step(&state,i,true);}
        let overflow=previewMediumChange(&state,INDICES[MEDIUM_CAPACITY],true);
        output[5]=u32(overflow.error!=select(4u,5u,MEDIUM_CAPACITY<32u) || state.count!=MEDIUM_CAPACITY || activeMedium(&state)!=INDICES[MEDIUM_CAPACITY-1u]);
        var camera:CameraParams;camera.padding1=MEDIUM_CAPACITY+1u;
        let initial=cameraMedia(camera);
        output[6]=u32(initial.error!=select(4u,5u,MEDIUM_CAPACITY<32u));
        camera.padding1=MEDIUM_CAPACITY;
        for(var i=0u;i<MEDIUM_CAPACITY;i++) {camera.initialShells[i/4u][i%4u]=INDICES[i];}
        var exact=cameraMedia(camera);
        output[7]=u32(exact.error!=0u || exact.count!=MEDIUM_CAPACITY || activeMedium(&exact)!=INDICES[MEDIUM_CAPACITY-1u]);
      }`;
    const module = await checkedShader(device,code,"medium transaction invariants");
    const pipeline = await device.createComputePipelineAsync({layout:"auto",compute:{module,entryPoint:"main"}});
    const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}},{binding:3,resource:{buffer:gpu.triangles}}]});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    encoder.copyBufferToBuffer(output,0,readback,0,32);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const results=Array.from(new Uint32Array(readback.getMappedRange()));readback.unmap();
    const names=["preview is immutable","positive winding","negative winding","non-LIFO removal","reflection rollback","overflow is immutable","initial overflow","initial exact capacity"];
    return {capacity,results:results.map((errors,i)=>({name:names[i]!,errors}))};
  } finally {output.destroy();readback.destroy();gpu.dispose();device.destroy();}
}
