import { makeStructuredView } from 'webgpu-utils';
import { createDevice,checkedShader } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { definitions,packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { loadSobol } from '../assets/sobol';
import { hash32,sobolSample } from '../transport/sampler';
import { nbk7Ior } from '../transport/spectrum';
import { sppmDefinitions,sppmShader } from '../transport/sppm-shader';
import { prismScene } from '../scene/prism';
import type { Vec3,Triangle } from '../scene/types';

const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul=(a:Vec3,b:number):Vec3=>[a[0]*b,a[1]*b,a[2]*b];
const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=(a:Vec3)=>mul(a,1/Math.sqrt(dot(a,a)));
/** Independent double-precision Moller-Trumbore, Fresnel and Snell projection. */
function closest(origin:Vec3,direction:Vec3,triangles:Triangle[]) {
  let distance=Infinity,face:Triangle|undefined;
  for(const triangle of triangles) {
    const e1=sub(triangle.b,triangle.a),e2=sub(triangle.c,triangle.a),p=cross(direction,e2),det=dot(e1,p);
    if(Math.abs(det)<1e-12)continue;const t=sub(origin,triangle.a),u=dot(t,p)/det;if(u<0||u>1)continue;
    const q=cross(t,e1),v=dot(direction,q)/det;if(v<0||u+v>1)continue;const d=dot(e2,q)/det;
    if(d>1e-7&&d<distance){distance=d;face=triangle;}
  }
  return face?{face,position:add(origin,mul(direction,distance))}:undefined;
}
function transmit(direction:Vec3,n:Vec3,eta:number,random:number):Vec3|undefined {
  const c=-dot(direction,n),sin2=(1-c*c)/(eta*eta);if(sin2>=1)return;
  const ct=Math.sqrt(1-sin2),rs=(c-eta*ct)/(c+eta*ct),rp=(eta*c-ct)/(eta*c+ct);
  if(random<(rs*rs+rp*rp)/2)return;
  return normal(add(mul(direction,1/eta),mul(n,c/eta-ct)));
}
export async function verifySppmPrism() {
  const {device,name}=await createDevice();const buffers:GPUBuffer[]=[];let gpu:GpuScene|undefined;
  const create=(size:number,usage:GPUBufferUsageFlags)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
  try {
    const count=4096,seed=17,directions=new Uint32Array(await loadSobol());
    const sobol=create(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);device.queue.writeBuffer(sobol,0,directions);
    const paramsView=makeStructuredView(definitions.structs.CameraParams!),sppmView=makeStructuredView(sppmDefinitions.structs.SppmParams!);
    const params=create(paramsView.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),settings=create(sppmView.arrayBuffer.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const error=create(4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
    const photonDef=sppmDefinitions.structs.Photon!,photons=create(count*3*photonDef.size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const readback=create(photons.size+4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const module=await checkedShader(device,sppmShader,'SPPM photon prism acceptance');
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'photonMain'}});
    const frames=[410,790].map(target=>{let frame=0,error=Infinity;for(let i=0;i<4096;i++){const difference=Math.abs(360+470*sobolSample(i,2,0x7370706d,seed,directions)-target);if(difference<error){error=difference;frame=i;}}return frame;});
    const wavelengths=frames.map(frame=>Math.fround(360+470*sobolSample(frame,2,0x7370706d,seed,directions)));
    const scene=prismScene();scene.materials[0]={type:'dielectric',ior:nbk7Ior(587.6),iorModel:'nbk7',absorption:[0.2,0.2,0.2],absorptionSpectrum:[[360,0.1],[830,0.3]]};
    const direction:Vec3=[Math.cos(Math.PI/18),Math.sin(Math.PI/18),0],tangent=normal(cross([0,0,1],direction)),bitangent=cross(direction,tangent),center:Vec3=[-1,0.2,0],extent=0.002;
    const corners=[add(add(center,mul(tangent,-extent)),mul(bitangent,-extent)),add(add(center,mul(tangent,extent)),mul(bitangent,-extent)),add(add(center,mul(tangent,extent)),mul(bitangent,extent)),add(add(center,mul(tangent,-extent)),mul(bitangent,extent))];
    scene.meshes.push({positions:new Float32Array(corners.flat()),indices:new Uint32Array([0,1,2,0,2,3])},{positions:new Float32Array([2,-2,-2,2,-2,2,2,2,2,2,2,-2]),indices:new Uint32Array([0,1,2,0,2,3])});
    scene.objects.push({mesh:1,material:1,transform:scene.objects[0]!.transform},{mesh:2,material:2,transform:scene.objects[0]!.transform});
    scene.materials.push({type:'emissive',emission:[1,1,1],spectrum:[[360,1],[830,2]]},{type:'diffuse',reflectance:[0.5,0.5,0.5]});scene.lights=[{object:1}];
    const triangles=bakeTriangles(scene),lightTriangles=triangles.filter(face=>face.surface===1),prismTriangles=triangles.filter(face=>face.surface===0);
    const photonSeed=seed^hash32(0x51eed),sample=(index:number,dimension:number)=>sobolSample(index,dimension,0x70686f74,photonSeed,directions);
    const binding=(binding:number,buffer:GPUBuffer):GPUBindGroupEntry=>({binding,resource:{buffer}});
    const results=[];let maxPositionError=0,maxFluxRelativeError=0,errors=0;
    for(const dispersive of [true,false]) {
      scene.materials[0]!.type==='dielectric'&&(scene.materials[0]!.iorModel=dispersive?'nbk7':'constant');
      const bvh=buildBvh(bakeTriangles(scene)),packed={...packBvh(bvh),...packTransport(scene,bvh)};gpu?.dispose();gpu=new GpuScene(device,packed);
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[binding(1,params),...gpu.entries(),binding(4,error),...gpu.transportEntries(),binding(7,sobol),gpu.spectralEntry(),binding(11,settings),binding(21,photons)]});
      const projections:Map<number,Vec3>[]=[];
      for(let w=0;w<2;w++) {
        const wavelength=wavelengths[w]!,ior=nbk7Ior(dispersive?wavelength:587.6);
        paramsView.set({frame:frames[w],seed,transportMode:1,maxDepth:2,lightCount:packed.lightCount});sppmView.set({iteration:0,batchStart:0,batchCount:count});
        device.queue.writeBuffer(params,0,paramsView.arrayBuffer);device.queue.writeBuffer(settings,0,sppmView.arrayBuffer);
        const encoder=device.createCommandEncoder();encoder.clearBuffer(error);const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count/64);pass.end();encoder.copyBufferToBuffer(photons,0,readback,0,photons.size);encoder.copyBufferToBuffer(error,0,readback,photons.size,4);device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);const raw=readback.getMappedRange().slice(0);readback.unmap();const floats=new Float32Array(raw),ints=new Uint32Array(raw);errors+=ints[photons.size/4]!;
        const projected=new Map<number,Vec3>();
        for(let index=0;index<count;index++) {
          const light=lightTriangles[sample(index,0)<0.5?0:1]!,root=Math.sqrt(sample(index,1)),b=root*(1-sample(index,2)),c=root*sample(index,2);
          const origin=add(add(mul(light.a,1-root),mul(light.b,b)),mul(light.c,c));
          const n=normal(cross(sub(light.b,light.a),sub(light.c,light.a))),t=normal(cross([0,0,1],n)),bt=cross(n,t),r=Math.sqrt(sample(index,3)),phi=2*Math.PI*sample(index,4);
          const incoming=normal(add(add(mul(t,r*Math.cos(phi)),mul(bt,r*Math.sin(phi))),mul(n,Math.sqrt(1-r*r))));
          const first=closest(origin,incoming,prismTriangles);if(!first)continue;
          const ng=normal(cross(sub(first.face.b,first.face.a),sub(first.face.c,first.face.a)));
          const inside=transmit(incoming,ng,ior,sample(index,10));if(!inside)continue;
          const second=closest(add(first.position,mul(inside,1e-6)),inside,prismTriangles);if(!second)continue;
          const exitNormal=normal(cross(sub(second.face.b,second.face.a),sub(second.face.c,second.face.a)));
          const outgoing=transmit(inside,mul(exitNormal,-1),1/ior,sample(index,17));if(!outgoing||outgoing[0]<=0)continue;
          const position=add(second.position,mul(outgoing,(2-second.position[0])/outgoing[0]));if(Math.abs(position[1])>=2||Math.abs(position[2])>=2)continue;
          const offset=(index*3+2)*photonDef.size/4;
          if(ints[offset+photonDef.fields.valid!.offset/4]!==1||ints[offset+photonDef.fields.surface!.offset/4]!==2){errors++;continue;}
          const actual:Vec3=[floats[offset]!,floats[offset+1]!,floats[offset+2]!];projected.set(index,actual);
          maxPositionError=Math.max(maxPositionError,...actual.map((value,i)=>Math.abs(value-position[i]!)));
          const expectedFlux=4*extent*extent*Math.PI*(1+(wavelength-360)/470)*Math.exp(-(0.1+0.2*(wavelength-360)/470)*Math.sqrt(dot(sub(second.position,first.position),sub(second.position,first.position))));
          maxFluxRelativeError=Math.max(maxFluxRelativeError,Math.abs(floats[offset+photonDef.fields.flux!.offset/4]!/expectedFlux-1));
        }
        projections.push(projected);
      }
      let spread=0,matchedPaths=0;for(const [index,position] of projections[0]!) {const other=projections[1]!.get(index);if(other){spread+=Math.sqrt(dot(sub(other,position),sub(other,position)));matchedPaths++;}}
      results.push({dispersive,matchedPaths,meanFootprintSpread:spread/matchedPaths});
    }
    return {wavelengths,results,maxPositionError,maxFluxRelativeError,errors,adapter:name};
  } finally {gpu?.dispose();buffers.forEach(buffer=>buffer.destroy());device.destroy();}
}
