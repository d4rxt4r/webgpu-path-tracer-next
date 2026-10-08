import { makeStructuredView } from 'webgpu-utils';
import { createDevice, checkedShader, type DeviceInfo } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { GpuTimer } from '../gpu/timer';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { definitions, packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { cameraShells } from '../accel/camera-media';
import { cameraBasis, cameraOptics } from '../scene/camera';
import { cornellScene } from '../scene/cornell';
import { loadSobol } from '../assets/sobol';
import { pathShader } from '../transport/shaders';
import { specializeSurfaceWear } from '../transport/wear-source';
import { fastTransportShader } from '../transport/fast-source';
import { renderSppm } from './render-sppm';
import { TRANSPORT_QUEUE_BYTES } from '../render/transport-diagnostics';
import type { CameraDescription } from '../scene/types';

/** Small deterministic production-kernel matrix for the connected browser. */
export async function verifyCamera(mode: 'rgb' | 'spectral' = 'rgb', integrator: 'pt' | 'sppm' = 'pt') {
  const gpu = await createDevice();
  const scene = cornellScene('diffuse'), width = 48, height = 48, samples = 16, seed = 17;
  const cases: [string, CameraDescription['depthOfField']][] = [
    ['legacy', undefined], ['disabled', {enabled:false,apertureDiameter:.1}],
    ['zero', {enabled:true,apertureDiameter:0}],
    ['circle20', {enabled:true,apertureDiameter:.02}],
    ['circle100', {enabled:true,apertureDiameter:.1}],
    ['polygon', {enabled:true,apertureDiameter:.1,apertureShape:'polygon',blades:6,rotation:30}],
    ['repeat', {enabled:true,apertureDiameter:.1}],
  ];
  const captures: Record<string, number[]> = {}, timings = [];
  try {
    const pt = integrator === 'pt' ? await cameraPt(gpu, scene, width, height, samples, seed, mode) : undefined;
    try {
      if (pt) { const reference = await pt.render(scene.camera, true); captures.original = Array.from(reference.pixels); timings.push({name:'original',...reference,pixels:undefined}); }
      for (const [name, optics] of cases) {
        scene.camera.depthOfField=optics;
        if (pt) {
          const result=await pt.render(scene.camera); captures[name]=Array.from(result.pixels);
          timings.push({name, ...result, pixels:undefined});
        } else {
          const started=performance.now();
          const result=await renderSppm(scene,{gpu,width,height,iterations:samples,seed,mode,maxDepth:8,photonsPerIteration:1024,photonBatchSize:512,specializeSampler:true,measure:true});
          captures[name]=Array.from(result.pixels);
          timings.push({name,errors:result.errors,gpuMs:result.gpuMs,completionMs:result.completionMs,totalMs:performance.now()-started});
        }
      }
    } finally {pt?.dispose();}
    const difference=(a:string,b:string)=>Math.max(...captures[a]!.map((v,i)=>Math.abs(v-captures[b]![i]!)));
    const halfRound=(value:number)=>{if(!value)return value;const step=2**Math.max(-24,Math.floor(Math.log2(Math.abs(value)))-10), scaled=value/step, low=Math.floor(scaled);return step*(scaled-low===.5 ? low%2===0?low:low+1 : Math.round(scaled));};
    const displayDifference=(a:string,b:string)=>captures[a]!.filter((v,i)=>halfRound(v)!==halfRound(captures[b]![i]!)).length;
    return {adapter:gpu.name,mode,integrator,width,height,samples,seed,timings,
      originalDifference:integrator === 'pt' ? difference('original','legacy') : null, disabledDifference:difference('legacy','disabled'),zeroDifference:difference('legacy','zero'),repeatDifference:difference('circle100','repeat'),
      disabledDisplayDifferences:displayDifference('legacy','disabled'),zeroDisplayDifferences:displayDifference('legacy','zero'),repeatDisplayDifferences:displayDifference('circle100','repeat'), blurDifference:difference('legacy','circle100'), nonFinite:Object.values(captures).flat().filter(v=>!Number.isFinite(v)).length,captures};
  } finally {gpu.device.destroy();}
}

async function cameraPt(gpu: DeviceInfo, scene: ReturnType<typeof cornellScene>, width:number,height:number,samples:number,seed:number,mode:'rgb'|'spectral') {
  const {device}=gpu, buffers:GPUBuffer[]=[];
  const make=(size:number,usage:GPUBufferUsageFlags)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
  const bvh=buildBvh(bakeTriangles(scene)), packed={...packBvh(bvh),...packTransport(scene,bvh)}, geometry=new GpuScene(device,packed);
  const parameters=makeStructuredView(definitions.structs.CameraParams!);
  const uniform=make(parameters.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const directions=await loadSobol(), sobol=make(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST); device.queue.writeBuffer(sobol,0,directions);
  const errors=make(TRANSPORT_QUEUE_BYTES,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
  const accumulation=make(width*height*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
  const readback=make(accumulation.size+64,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
  const timing=make(80,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST), timer=device.features.has('timestamp-query')?new GpuTimer(device):undefined;
  const image=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING});
  const source=specializeSurfaceWear(pathShader,0);
  const module=await checkedShader(device,fastTransportShader(source),'Camera PT acceptance');
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  // Compile the previous pinhole expression independently, rather than treating
  // another branch of the new lens implementation as the legacy reference.
  const legacySource=fastTransportShader(source.replace('thinLensRay(params, direction, pixel)', 'Ray(params.eye.xyz, 0.00001, direction, 1e20)'));
  const legacyModule=await checkedShader(device,legacySource,'Legacy pinhole acceptance');
  const legacyPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:legacyModule,entryPoint:'main'}});
  const entries: GPUBindGroupEntry[] = [
    {binding:0,resource:image.createView()},{binding:1,resource:{buffer:uniform}},...geometry.entries(),
    {binding:4,resource:{buffer:errors}},...geometry.transportEntries(true),{binding:7,resource:{buffer:sobol}},
    {binding:8,resource:{buffer:accumulation}},geometry.spectralEntry()];
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
  const legacyGroup=device.createBindGroup({layout:legacyPipeline.getBindGroupLayout(0),entries});
  return {
    async render(camera:CameraDescription, legacy = false) {
      device.pushErrorScope('validation');
      const basis=cameraBasis(camera), optics=cameraOptics(camera), shells=cameraShells(packed,camera.position), initialShells=new Uint32Array(32);initialShells.set(shells);
      const clear=device.createCommandEncoder();clear.clearBuffer(accumulation);clear.clearBuffer(errors);device.queue.submit([clear.finish()]);await device.queue.onSubmittedWorkDone();
      let gpuMs=0;const started=performance.now();
      for(let frame=0;frame<samples;frame++) {
        parameters.set({size:[width,height],tile:[0,0,width,height],view:3,frame,seed,maxDepth:8,lightCount:packed.lightCount,transportMode:Number(mode==='spectral'),
          eye:[...basis.eye,0],forward:[...basis.forward,0],right:[...basis.right,0],up:[...basis.up,0],initialShells,padding1:shells.length,
          optics:[optics.radius,optics.distance,optics.shape==='polygon'?optics.blades:0,optics.rotation*Math.PI/180]});
        device.queue.writeBuffer(uniform,0,parameters.arrayBuffer);
        const encoder=device.createCommandEncoder();timer?.begin(encoder);
        const pass=encoder.beginComputePass();pass.setPipeline(legacy ? legacyPipeline : pipeline);pass.setBindGroup(0,legacy ? legacyGroup : group);pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();
        timer?.end(encoder,timing);device.queue.submit([encoder.finish()]);
        if(timer) {await timing.mapAsync(GPUMapMode.READ);gpuMs+=timer.read(timing.getMappedRange());timing.unmap();}
      }
      await device.queue.onSubmittedWorkDone();const completionMs=performance.now()-started;
      const copy=device.createCommandEncoder();copy.copyBufferToBuffer(accumulation,0,readback,0,accumulation.size);copy.copyBufferToBuffer(errors,0,readback,accumulation.size,64);device.queue.submit([copy.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const raw=readback.getMappedRange(), pixels=new Float32Array(raw,0,width*height*4).slice(), errorCount=new Uint32Array(raw,accumulation.size,1)[0]!;readback.unmap();
      const validation=await device.popErrorScope();if(validation) throw new Error(validation.message);
      for(let i=0;i<pixels.length;i++) if(i%4!==3) pixels[i]=pixels[i]!/samples;
      return {pixels,errors:errorCount,gpuMs:timer?gpuMs:null,completionMs};
    },
    dispose(){timer?.dispose();geometry.dispose();image.destroy();buffers.forEach(b=>b.destroy());},
  };
}
