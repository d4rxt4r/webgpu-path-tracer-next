import { makeStructuredView } from 'webgpu-utils';
import { createDevice } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { definitions, packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { loadSobol } from '../assets/sobol';
import { cameraBasis } from '../scene/camera';
import type { SceneDescription } from '../scene/types';
import { SppmIntegrator } from '../render/sppm-integrator';

/** Numerical acceptance runner; production rendering retains its RAF job budget. */
export async function renderSppm(scene: SceneDescription, options: {
  iterations: number; width?: number; height?: number; mode?: 'rgb'|'spectral';
  photonsPerIteration?: number; photonBatchSize?: number; initialRadius?: number; maxDepth?: number; seed?: number;
}) {
  const {device,name}=await createDevice();const buffers:GPUBuffer[]=[];
  let gpu:GpuScene|undefined,integrator:SppmIntegrator|undefined,image:GPUTexture|undefined;
  const create=(size:number,usage:GPUBufferUsageFlags)=>{const buffer=device.createBuffer({size,usage});buffers.push(buffer);return buffer;};
  try {
    const width=options.width??1,height=options.height??1,mode=options.mode??'spectral';
    const settings={maxDepth:options.maxDepth??8,seed:options.seed??17,photonsPerIteration:options.photonsPerIteration??4096,photonBatchSize:options.photonBatchSize??1024,initialRadius:options.initialRadius??0.15};
    const bvh=buildBvh(bakeTriangles(scene)),packed={...packBvh(bvh),...packTransport(scene,bvh)};
    if(mode==='spectral'&&!packed.spectralReady) throw new Error('Acceptance scene needs spectra');
    gpu=new GpuScene(device,packed);const directions=await loadSobol();
    const sobol=create(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(sobol,0,directions);
    const parameters=makeStructuredView(definitions.structs.CameraParams!);
    const camera=create(parameters.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const errors=create(4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
    const accumulation=create(width*height*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=create(accumulation.size+4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    image=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING});
    integrator=await SppmIntegrator.create(device);integrator.configure(width,height,settings,{scene:gpu,camera,sobol,errors,accumulation,texture:image});
    const basis=cameraBasis(scene.camera);let jobs=0;
    while(integrator.iterations<options.iterations) {
      parameters.set({size:[width,height],frame:integrator.iterations,eye:[...basis.eye,0],forward:[...basis.forward,0],right:[...basis.right,0],up:[...basis.up,0],tile:integrator.tileRect(),maxDepth:settings.maxDepth,seed:settings.seed,lightCount:packed.lightCount,transportMode:Number(mode==='spectral')});
      device.queue.writeBuffer(camera,0,parameters.arrayBuffer);
      const encoder=device.createCommandEncoder();integrator.encodeStep(encoder);device.queue.submit([encoder.finish()]);
      if(++jobs%32===0) await device.queue.onSubmittedWorkDone();
    }
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(accumulation,0,readback,0,accumulation.size);encoder.copyBufferToBuffer(errors,0,readback,accumulation.size,4);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const raw=readback.getMappedRange().slice(0);readback.unmap();
    const values=new Float32Array(raw,0,width*height*4),pixels:number[]=[],counts:number[]=[];
    for(let i=0;i<width*height;i++) {counts.push(values[4*i+3]!);for(let c=0;c<3;c++)pixels.push(values[4*i+c]!/values[4*i+3]!);}
    return {width,height,pixels,counts,errors:new Uint32Array(raw,accumulation.size,1)[0]!,emittedPhotons:integrator.emittedPhotons,adapter:name};
  } finally {integrator?.dispose();image?.destroy();gpu?.dispose();buffers.forEach(buffer=>buffer.destroy());device.destroy();}
}
