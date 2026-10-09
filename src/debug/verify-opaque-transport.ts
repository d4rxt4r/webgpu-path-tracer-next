import { diffuseMaterial } from "../scene/diffuse-material";
import { pipelineVariant } from '../render/pipeline-variants';
import { createDevice, checkedShader, type DeviceInfo } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { loadSobol } from '../assets/sobol';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { packBvh, definitions } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { makeStructuredView } from 'webgpu-utils';
import { pathCore } from '../transport/shaders';
import { fastTransportShader } from '../transport/fast-source';
import { cameraBasis } from '../scene/camera';
import { xyzToLinearRgb } from '../transport/spectrum';
import { GpuTimer } from '../gpu/timer';
import { renderSppm } from './render-sppm';
import { plasticMaterial, emissiveMaterial, metalPresets } from '../scene/opaque-materials';
import { transmissionSpectrum } from '../scene/dielectric-settings';
import type { SceneDescription, MaterialDescription, Vec3 } from '../scene/types';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function opaqueFixture(material:MaterialDescription):SceneDescription {
  return {version:1,camera:{position:[0,.5,0],target:[0,0,0],up:[0,0,1],verticalFov:40},
    meshes:[{positions:new Float32Array([-2,0,2,2,0,2,2,0,-2,-2,0,-2]),indices:new Uint32Array([0,1,2,0,2,3])},
      {positions:new Float32Array([-1,1,-1,1,1,-1,1,1,1,-1,1,1]),indices:new Uint32Array([0,1,2,0,2,3])}],
    objects:[{mesh:0,material:0,transform:identity},{mesh:1,material:1,transform:identity}],
    materials:[material,{type:'emissive',emission:[1,1,1]}],lights:material.type==='emissive'?[{object:0},{object:1}]:[{object:1}]};
}
const implementation=pathCore+`
@group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
@group(0) @binding(1) var<uniform> params:CameraParams;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 if(any(id.xy>=params.size)) {return;}let pixel=id.y*params.size.x+id.x;var sum=vec3f(0);var errors=0u;
 for(var sample=0u;sample<params.frame;sample++) {
  let jitter=vec2f(sample1D(sample,0u,pixel,params.seed),sample1D(sample,1u,pixel,params.seed));
  let uv=(vec2f(id.xy)+jitter)/vec2f(params.size);let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
  let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
  let ray=Ray(params.eye.xyz,0.0,direction,1e20);var result:PathResult;
  var wavelength=WavelengthSample(0.0,1.0);
  if(params.transportMode!=0u) {wavelength=sampleWavelength(sample1D(sample,2u,pixel,params.seed));}
  result=tracePathAtWavelength(ray,sample,pixel,params.seed,params.maxDepth,0u,params.lightCount,wavelength.wavelength);
  if(params.transportMode!=0u) {result.radiance=cieXyz(wavelength.wavelength)*result.radiance.x/(wavelength.pdf*CIE_Y_INTEGRAL);}
  sum+=result.radiance;errors+=result.error;
 }
 output[pixel]=vec4f(sum/f32(params.frame),f32(errors));
}`;
export async function renderOpaquePt(scene:SceneDescription, gpu:DeviceInfo, mode:'rgb'|'spectral', samples:number, precise=true) {
  const {device}=gpu;const buffers:GPUBuffer[]=[];let transport:GpuScene|undefined;let timer:GpuTimer|undefined;
  const create=(size:number,usage:GPUBufferUsageFlags,data?:ArrayBuffer)=>{const b=device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST});buffers.push(b);if(data)device.queue.writeBuffer(b,0,data);return b;};
  device.pushErrorScope('validation');
  try {
    const width=16,height=16,bvh=buildBvh(bakeTriangles(scene)),packed={...packBvh(bvh),...packTransport(scene,bvh)};
    transport=new GpuScene(device,packed);
    const sobolData=await loadSobol();const sobol=create(sobolData.byteLength,GPUBufferUsage.STORAGE,sobolData);
    const view=makeStructuredView(definitions.structs.CameraParams!),basis=cameraBasis(scene.camera);
    view.set({size:[width,height],frame:samples,maxDepth:2,seed:17,lightCount:packed.lightCount,transportMode:Number(mode==='spectral'),eye:[...basis.eye,0],forward:[...basis.forward,0],right:[...basis.right,0],up:[...basis.up,0]});
    const uniform=create(view.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM,view.arrayBuffer);
    const output=create(width*height*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),readback=create(output.size,GPUBufferUsage.MAP_READ);
    const pipeline=await pipelineVariant(device,'opaque-reference',Number(precise),async()=>{
      const module=await checkedShader(device,precise?implementation:fastTransportShader(implementation),'opaque PT acceptance');
      return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    });
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}},{binding:1,resource:{buffer:uniform}},...transport.entries(),...transport.transportEntries(true),{binding:7,resource:{buffer:sobol}},transport.spectralEntry()]});
    const timing=device.features.has('timestamp-query')?create(80,GPUBufferUsage.MAP_READ):undefined;if(timing)timer=new GpuTimer(device);
    const started=performance.now(),encoder=device.createCommandEncoder();timer?.begin(encoder);
    const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(width/8,height/8);pass.end();if(timing)timer?.end(encoder,timing);
    encoder.copyBufferToBuffer(output,0,readback,0,output.size);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
    const completionMs=performance.now()-started,raw=new Float32Array(readback.getMappedRange());let errors=0;const pixels:number[]=[];
    for(let p=0;p<width*height;p++){errors+=raw[p*4+3]!;const value=Array.from(raw.slice(p*4,p*4+3)) as Vec3;pixels.push(...(mode==='spectral'?xyzToLinearRgb(value):value));}
    let gpuMs:number|null=null;if(timing){await timing.mapAsync(GPUMapMode.READ);gpuMs=timer!.read(timing.getMappedRange());timing.unmap();}
    readback.unmap();const validation=await device.popErrorScope();if(validation)throw new Error(validation.message);
    return {width,height,pixels,errors,completionMs,gpuMs,adapter:gpu.name};
  } finally {timer?.dispose();transport?.dispose();buffers.forEach(b=>b.destroy());}
}
export const opaqueCases:Record<string,MaterialDescription>={
  ...Object.fromEntries(metalPresets.flatMap(preset=>[0,.6].map(roughness=>[preset+'-'+roughness,{type:'metal',preset,roughness}]))),
  'custom-0':{type:'metal',preset:'custom',roughness:0,reflectance:[.1,.4,.8],spectrum:transmissionSpectrum([.1,.4,.8])},
  'custom-.6':{type:'metal',preset:'custom',roughness:.6,reflectance:[.1,.4,.8],spectrum:transmissionSpectrum([.1,.4,.8])},
  'plastic-0':plasticMaterial(undefined,0), 'plastic-.6':plasticMaterial(undefined,.6), 'plastic-ior1':plasticMaterial(undefined,.6,1), 'plastic-ior2.5':plasticMaterial(undefined,.6,2.5),
  ...Object.fromEntries([0,.5,1].flatMap(roughness=>['#ffffff','#2865d4'].map(color=>['diffuse-'+(color==='#ffffff'?'white':'blue')+'-'+roughness,diffuseMaterial(color,.65,roughness)]))),
  'diffuse-black':diffuseMaterial('#2865d4',0,1), 'diffuse-full':diffuseMaterial('#ffffff',1,1),
  'diffuse-tiny':diffuseMaterial('#ffffff',.65,1e-50),
  'emissive-0':emissiveMaterial(undefined,undefined,0), 'emissive-10':emissiveMaterial(),
};
export async function verifyOpaqueTransport(names:string[], samples=256, compare=false, progress?:(name:string,mode:string,phase:string)=>void, measure=true, modes:('rgb'|'spectral')[]=['rgb','spectral']) {
  const gpu=await createDevice();const results=[];
  try {for(const name of names)for(const mode of modes){
    progress?.(name,mode,'pt');
    const scene=opaqueFixture(opaqueCases[name]!);
    const pt=await renderOpaquePt(scene,gpu,mode,samples);
    progress?.(name,mode,'pt-fast');
    const repeat=await renderOpaquePt(scene,gpu,mode,samples,false);
    const deterministic=await renderOpaquePt(scene,gpu,mode,samples);
    progress?.(name,mode,'sppm');
    const sppm=await renderSppm(scene,{gpu,mode,width:16,height:16,iterations:samples,photonsPerIteration:128,photonBatchSize:128,maxDepth:2,seed:17,measure,preciseTransport:false});
    progress?.(name,mode,'sppm-precise');
    const precise=compare?await renderSppm(scene,{gpu,mode,width:16,height:16,iterations:samples,photonsPerIteration:128,photonBatchSize:128,maxDepth:2,seed:17,measure,preciseTransport:true}):undefined;
    // renderSppm exposes accumulation XYZ; PT above already returns linear RGB.
    if(mode==='spectral') for(const image of [sppm,precise]) if(image) {
      const rgb:number[]=[];
      for(let i=0;i<image.pixels.length;i+=3) rgb.push(...xyzToLinearRgb(image.pixels.slice(i,i+3) as Vec3));
      image.pixels=rgb;
    }
    const mean=(pixels:number[])=>[0,1,2].map(c=>pixels.reduce((sum,v,i)=>sum+(i%3===c?v:0),0)/(pixels.length/3));
    const ptReplayRelativeL1=pt.pixels.reduce((sum,v,i)=>sum+Math.abs(v-repeat.pixels[i]!),0)/Math.max(1e-9,pt.pixels.reduce((sum,v)=>sum+Math.abs(v),0));
    results.push({name,mode,samples,seed:17,pt:{...pt,mean:mean(pt.pixels)},sppm:{...sppm,mean:mean(sppm.pixels)},ptDeterministicDifference:Math.max(...pt.pixels.map((v,i)=>Math.abs(v-deterministic.pixels[i]!))),ptReplayRelativeL1,ptReplayDifference:Math.max(...pt.pixels.map((v,i)=>Math.abs(v-repeat.pixels[i]!))),sppmReplayDifference:precise?Math.max(...sppm.pixels.map((v,i)=>Math.abs(v-precise.pixels[i]!))):null});
  }return results;}finally{gpu.device.destroy();}
}
