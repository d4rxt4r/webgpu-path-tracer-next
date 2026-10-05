import { makeStructuredView } from 'webgpu-utils';
import { createDevice, checkedShader } from '../gpu/device';
import { definitions } from '../accel/pack';
import { sppmDefinitions, sppmShader } from '../transport/sppm-shader';
import type { Vec3 } from '../scene/types';

/** Deliberately one hash bucket: all spatial cells collide. Compare to brute force. */
export async function verifySppm(rough = false) {
  const {device,name}=await createDevice();const buffers:GPUBuffer[]=[];
  const create=(size:number,usage:GPUBufferUsageFlags,data?:ArrayBuffer)=>{const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});buffers.push(b);if(data) device.queue.writeBuffer(b,0,data);return b;};
  try {
    const pointDef=sppmDefinitions.structs.SppmPoint!, photonDef=sppmDefinitions.structs.Photon!;
    const pointData=new ArrayBuffer(pointDef.size*4), photonData=new ArrayBuffer(photonDef.size*128);
    const positions:Vec3[]=[[0,0,0],[-0.22,0,0],[0,0,0],[0,0,0]];
    const weight:Vec3=[0.5/Math.PI,0.4/Math.PI,0.3/Math.PI];
    positions.forEach((position,i)=>makeStructuredView(pointDef,pointData,i*pointDef.size).set({position,surface:i===2?2:1,normal:[0,1,0],valid:Number(i!==3),weight,radius:0.2,N:10,tau:[1,2,3],iterations:2,direct:[0.1,0.2,0.3],directSum:[2,4,6]}));
    const fixtures:{position:Vec3;surface:number;normal:Vec3;flux:Vec3;valid:number}[]=[
      {position:[0.05,0,0],surface:1,normal:[0,1,0],flux:[1,2,3],valid:1},
      {position:[-0.05,0,0],surface:1,normal:[0,1,0],flux:[0.5,1,2],valid:1},
      {position:[0,0.1,0],surface:1,normal:[0,1,0],flux:[100,100,100],valid:1},
      {position:[0,0,0.1],surface:2,normal:[0,1,0],flux:[5,6,7],valid:1},
      {position:[0,0,0],surface:1,normal:[0,-1,0],flux:[50,50,50],valid:1},
      {position:[1,0,0],surface:1,normal:[0,1,0],flux:[100,100,100],valid:1},
      {position:[-0.25,0,0],surface:1,normal:[0,1,0],flux:[2,3,4],valid:1},
      {position:[0,0,0.15],surface:1,normal:[0,1,0],flux:[10,10,10],valid:0},
      {position:[0.19,0,0],surface:1,normal:[0,1,0],flux:[1,1,1],valid:1},
      {position:[-0.4,0,0],surface:1,normal:[0,1,0],flux:[1,2,1],valid:1},
    ];
    if (rough) positions.forEach((_, i) => makeStructuredView(pointDef, pointData, i * pointDef.size).set({ bsdf: 1, wo: [0,1,0], shading: [0,1,0], material: 0, eta: 1.5, boundary: 42 }));
    fixtures.forEach((photon,i)=>makeStructuredView(photonDef,photonData,i*photonDef.size).set({ ...photon, incoming: photon.normal, boundary: i === 8 ? 43 : 42 }));
    const cameraView=makeStructuredView(definitions.structs.CameraParams!);cameraView.set({size:[4,1],tile:[0,0,4,1],maxDepth:1});
    const settingsView=makeStructuredView(sppmDefinitions.structs.SppmParams!);settingsView.set({initialRadius:0.2,photonsPerIteration:100,batchCount:64,batchSize:64,hashMask:0,iteration:2});
    const states=create(pointData.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC,pointData);
    const photons=create(photonData.byteLength,GPUBufferUsage.STORAGE,photonData);
    const heads=create(4,GPUBufferUsage.STORAGE),diagnostic=create(4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const camera=create(cameraView.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM,cameraView.arrayBuffer),settings=create(settingsView.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM,settingsView.arrayBuffer);
    const output=create(64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const materialView=makeStructuredView(definitions.structs.Material!);
    materialView.set({ kind: 2, color: [1,1,1], ior: 1.5, textureParams: [0.6,0,0,0] });
    const materials=create(materialView.arrayBuffer.byteLength,GPUBufferUsage.STORAGE,materialView.arrayBuffer);
    const spectra=create(471*4,GPUBufferUsage.STORAGE),sobol=create(4,GPUBufferUsage.STORAGE);
    const readback=create(pointData.byteLength+64+4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const image=device.createTexture({size:[4,1],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING});
    try {
      const module=await checkedShader(device,sppmShader,'SPPM hash / statistics acceptance');
      const entries=['hash','gather','update'] as const;
      const pipelines=await Promise.all(entries.map(entry=>device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:entry+'Main'}})));
      const binding=(binding:number,buffer:GPUBuffer):GPUBindGroupEntry=>({binding,resource:{buffer}});
      const groups=[
        [binding(1,camera),binding(11,settings),binding(21,photons),binding(22,heads)],
        [binding(1,camera),binding(4,diagnostic),binding(5,materials),binding(7,sobol),binding(9,spectra),binding(10,states),binding(11,settings),binding(21,photons),binding(22,heads)],
        [{binding:0,resource:image.createView()},binding(1,camera),binding(4,diagnostic),binding(8,output),binding(10,states),binding(11,settings)],
      ].map((entries,i)=>device.createBindGroup({layout:pipelines[i]!.getBindGroupLayout(0),entries}));
      const encoder=device.createCommandEncoder();encoder.clearBuffer(heads);encoder.clearBuffer(diagnostic);
      for(let i=0;i<3;i++) {const pass=encoder.beginComputePass();pass.setPipeline(pipelines[i]!);pass.setBindGroup(0,groups[i]!);pass.dispatchWorkgroups(i===0?2:1);pass.end();}
      encoder.copyBufferToBuffer(states,0,readback,0,pointData.byteLength);encoder.copyBufferToBuffer(output,0,readback,pointData.byteLength,64);encoder.copyBufferToBuffer(diagnostic,0,readback,pointData.byteLength+64,4);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const raw=readback.getMappedRange().slice(0);readback.unmap();
      const floats=new Float32Array(raw),ints=new Uint32Array(raw);let maxError=0;const counts:number[]=[];
      const scalar=(i:number,field:string)=>floats[(i*pointDef.size+pointDef.fields[field]!.offset)/4]!;
      for(let i=0;i<4;i++) {
        let M=0;const phi=[0,0,0];
        for(const [fixtureIndex, photon] of fixtures.entries()) {
          const delta=photon.position.map((v,c)=>v-positions[i]![c]!);
          if(i===3||!photon.valid||photon.surface!==(i===2?2:1)||(!rough && photon.normal[1]<0.95)||(rough && fixtureIndex===8)||delta.reduce((sum,v)=>sum+v*v,0)>0.2**2||Math.abs(delta[1]!)>0.02) continue;
          const d = 1 / (Math.PI * 0.6 ** 4);
          const f = !rough ? 1 : photon.normal[1] > 0 ? 0.04 * d / 4 : 0.96 * d / 0.5 ** 2;
          M++;for(let c=0;c<3;c++) phi[c]!+=weight[c]!*photon.flux[c]! * f;
        }
        counts.push(ints[(i*pointDef.size+pointDef.fields.M!.offset)/4]!);
        const N=10+(2/3)*M,ratio=M?N/(10+M):1,radius=0.2*Math.sqrt(ratio);
        maxError=Math.max(maxError,Math.abs(scalar(i,'radius')-radius),Math.abs(scalar(i,'N')-N),Math.abs(counts[i]!-M));
        for(let c=0;c<3;c++) {
          const tau=(c+1+phi[c]!)*ratio, radiance=((c+1)*2+(c+1)*0.1)/3+tau/(Math.PI*radius*radius*300);
          maxError=Math.max(maxError,Math.abs(floats[(i*pointDef.size+pointDef.fields.tau!.offset)/4+c]!-tau),Math.abs(floats[pointData.byteLength/4+i*4+c]!/3-radiance));
        }
      }
      const errors=ints[(pointData.byteLength+64)/4]!;
      device.queue.writeBuffer(heads,0,new Uint32Array([130]));
      const bad=device.createCommandEncoder();bad.clearBuffer(diagnostic);const pass=bad.beginComputePass();pass.setPipeline(pipelines[1]!);pass.setBindGroup(0,groups[1]!);pass.dispatchWorkgroups(1);pass.end();bad.copyBufferToBuffer(diagnostic,0,readback,0,4);device.queue.submit([bad.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const invalidLinks=new Uint32Array(readback.getMappedRange())[0]!;readback.unmap();
      return {counts,maxError,errors,invalidLinks,adapter:name};
    } finally {image.destroy();}
  } finally {buffers.forEach(b=>b.destroy());device.destroy();}
}
