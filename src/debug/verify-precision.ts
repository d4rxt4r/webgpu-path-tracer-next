import { makeStructuredView } from "webgpu-utils";
import { definitions, packBvh } from "../accel/pack";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { buddhaScene } from "../scene/buddha";
import { createDevice, checkedShader } from "../gpu/device";
import { intersectionCore } from "../transport/shaders";

/** Independent float64 reconstruction/plane checks plus sub-ULP hit ordering. */
export async function verifyPrecision() {
  const {device,name}=await createDevice(),buffers:GPUBuffer[]=[];
  const make=(size:number,usage:GPUBufferUsageFlags,data?:ArrayBuffer)=>{
    const buffer=device.createBuffer({size,usage,mappedAtCreation:!!data});buffers.push(buffer);
    if(data){new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));buffer.unmap();}return buffer;
  };
  let state=17;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  try {
    device.pushErrorScope("validation");
    const count=1024,triangles=new ArrayBuffer(count*96),inputs=new Float32Array(count*4);
    for(let i=0;i<count;i++) {
      const scale=[0.0001,1,10000][i%3]!,a=Array.from({length:3},()=>Math.fround((random()-0.5)*scale));
      const b=a.map(v=>Math.fround(v+(random()-0.5)*scale)),c=a.map(v=>Math.fround(v+(random()-0.5)*scale));
      makeStructuredView(definitions.structs.Triangle!,triangles,i*96).set({a,b,c,id:i});
      inputs.set([i%8===0?0:random()*0.8,i%8===0?0:random()*0.2,i%2?1:-1,0],i*4);
    }
    const input=make(inputs.byteLength,GPUBufferUsage.STORAGE,inputs.buffer),geometry=make(triangles.byteLength,GPUBufferUsage.STORAGE,triangles);
    const output=make(count*96,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),readback=make(output.size,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const module=await checkedShader(device,intersectionCore+`
@group(0) @binding(0) var<storage,read> cases:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> values:array<vec4f>;
@compute @workgroup_size(64) fn offsets(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=arrayLength(&cases)) {return;}
 let c=cases[id.x];let tri=triangles[id.x];let hit=Hit(1.0,tri.id,c.x,c.y,id.x,0u,0u,0u);
 values[6u*id.x]=vec4f(surfacePosition(tri,hit),1);
 values[6u*id.x+1u]=vec4f(offsetSurface(tri,hit,c.z*geometricNormal(tri)),1);
 let origin=preciseSurfaceOrigin(tri,hit,c.z*geometricNormal(tri));
 values[6u*id.x+2u]=vec4f(origin.position,1);
 values[6u*id.x+3u]=vec4f(origin.residual,1);
 let vertex=id.x%3u;let at=select(select(tri.a,tri.b,vertex==1u),tri.c,vertex==2u);
 let edgeHit=Hit(0.0,tri.id,f32(vertex==1u),f32(vertex==2u),id.x,0u,0u,0u);
 let crease=preciseRayOrigin(Ray(at,0.0,-geometricNormal(tri),1e20),vec3f(0),tri,edgeHit,c.z*geometricNormal(tri));
 values[6u*id.x+4u]=vec4f(crease.position,1);values[6u*id.x+5u]=vec4f(crease.residual,1);
}`,"Surface precision bounds");
    const pipeline=await device.createComputePipelineAsync({layout:"auto",compute:{module,entryPoint:"offsets"}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}},{binding:3,resource:{buffer:geometry}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count/64);pass.end();encoder.copyBufferToBuffer(output,0,readback,0,output.size);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const values=new Float32Array(readback.getMappedRange()),vertices=new Float32Array(triangles);
    let maxBoundRatio=0,wrongSide=0,preciseWrongSide=0,nonFinite=0,maxPreciseDisplacement=0,retreatedWrongSide=0,minRetreatMarginRatio=Infinity,maxRetreatBoundRatio=0;
    for(let i=0;i<count;i++) {
      const a=Array.from(vertices.slice(i*24,i*24+3)),b=Array.from(vertices.slice(i*24+4,i*24+7)),c=Array.from(vertices.slice(i*24+8,i*24+11));
      const u=inputs[i*4]!,v=inputs[i*4+1]!,e1=b.map((x,j)=>x-a[j]!),e2=c.map((x,j)=>x-a[j]!);
      const n=[e1[1]!*e2[2]!-e1[2]!*e2[1]!,e1[2]!*e2[0]!-e1[0]!*e2[2]!,e1[0]!*e2[1]!-e1[1]!*e2[0]!];
      let side=0,preciseSide=0;
      for(let axis=0;axis<3;axis++) {
        const exact=a[axis]!+u*e1[axis]!+v*e2[axis]!,actual=values[i*24+axis]!,offset=values[i*24+4+axis]!;
        const precise=values[i*24+8+axis]!+values[i*24+12+axis]!;
        const unit=2**-24,gamma3=3*unit/(1-3*unit);
        const bound=unit*(u*(Math.abs(a[axis]!)+Math.abs(b[axis]!))+v*(Math.abs(a[axis]!)+Math.abs(c[axis]!)))+gamma3*(Math.abs(u*e1[axis]!)+Math.abs(v*e2[axis]!))+unit*Math.abs(actual);
        maxBoundRatio=Math.max(maxBoundRatio,bound?Math.abs(actual-exact)/bound:0);
        if(!Number.isFinite(actual)||!Number.isFinite(offset)||!Number.isFinite(precise)) nonFinite++;
        side+=(offset-exact)*n[axis]!*inputs[i*4+2]!;
        preciseSide+=(precise-exact)*n[axis]!*inputs[i*4+2]!;
        const scale=Math.abs(a[axis]!)+u*(Math.abs(a[axis]!)+Math.abs(b[axis]!))+v*(Math.abs(a[axis]!)+Math.abs(c[axis]!))+Math.hypot(...e1)+Math.hypot(...e2);
        maxPreciseDisplacement=Math.max(maxPreciseDisplacement,Math.abs(precise-exact)/scale);
      }
      const at=[a,b,c][i%3]!,point=Array.from({length:3},(_,axis)=>values[i*24+16+axis]!+values[i*24+20+axis]!);
      const normalLength=Math.hypot(...n),normal=n.map(x=>x/normalLength);
      const edge=Math.max(Math.hypot(...e1),Math.hypot(...e2),Math.hypot(...e1.map((x,j)=>x-e2[j]!)));
      const altitude=normalLength/edge;
      const error=1.8189894e-12*(normal.reduce((sum,x,j)=>sum+Math.abs(x)*Math.abs(at[j]!),0)+Math.hypot(...e1)+Math.hypot(...e2));
      const fraction=Math.min(1,128*error/altitude),delta=point.map((x,j)=>x-a[j]!),movement=point.map((x,j)=>x-at[j]!);
      const dot=(x:number[],y:number[])=>x.reduce((sum,v,j)=>sum+v*y[j]!,0);
      if(dot(movement,normal)*inputs[i*4+2]!<0) retreatedWrongSide++;
      const d11=dot(e1,e1),d22=dot(e2,e2),d12=dot(e1,e2),det=d11*d22-d12*d12;
      const ru=(dot(delta,e1)*d22-dot(delta,e2)*d12)/det,rv=(dot(delta,e2)*d11-dot(delta,e1)*d12)/det;
      minRetreatMarginRatio=Math.min(minRetreatMarginRatio,Math.min(ru,rv,1-ru-rv)/(fraction/4));
      maxRetreatBoundRatio=Math.max(maxRetreatBoundRatio,Math.hypot(...movement)/(fraction*edge+2*error));
      if(point.some(x=>!Number.isFinite(x)))nonFinite++;
      if(side<0) wrongSide++;
      if(preciseSide<0) preciseWrongSide++;
    }
    readback.unmap();
    const scene=await buddhaScene("glass"),packed=packBvh(buildBvh(bakeTriangles(scene)));
    const rayInputs=new ArrayBuffer(64);
    const rays=[{origin:[-0.05510959401726723,0.7028122544288635,-0.23551368713378906],direction:[0.9848419427871704,-0.1604476124048233,-0.06590140610933304]},
      {origin:[0.16729861497879028,0.6716320514678955,-0.2117861956357956],direction:[-0.4459325671195984,-0.22015011310577393,0.8675702810287476]}];
    rays.forEach((ray,i)=>makeStructuredView(definitions.structs.Ray!,rayInputs,i*32).set({...ray,tMin:0,tMax:100}));
    const rayBuffer=make(64,GPUBufferUsage.STORAGE,rayInputs),hitBuffer=make(64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),hitReadback=make(64,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const nodes=make(packed.nodes.byteLength,GPUBufferUsage.STORAGE,packed.nodes),mesh=make(packed.triangles.byteLength,GPUBufferUsage.STORAGE,packed.triangles);
    const hitsModule=await checkedShader(device,intersectionCore+`
@group(0) @binding(0) var<storage,read> rays:array<Ray>;
@group(0) @binding(1) var<storage,read_write> hits:array<Hit>;
@compute @workgroup_size(1) fn compare(@builtin(global_invocation_id) id:vec3u) {hits[id.x]=closestHit(rays[id.x]);}`,"Sub-ULP Buddha boundaries");
    const hitsPipeline=await device.createComputePipelineAsync({layout:"auto",compute:{module:hitsModule,entryPoint:"compare"}});
    const hitsGroup=device.createBindGroup({layout:hitsPipeline.getBindGroupLayout(0),entries:[rayBuffer,hitBuffer,nodes,mesh].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const commands=device.createCommandEncoder(),hitPass=commands.beginComputePass();hitPass.setPipeline(hitsPipeline);hitPass.setBindGroup(0,hitsGroup);hitPass.dispatchWorkgroups(2);hitPass.end();commands.copyBufferToBuffer(hitBuffer,0,hitReadback,0,64);device.queue.submit([commands.finish()]);
    await hitReadback.mapAsync(GPUMapMode.READ);const words=new Uint32Array(hitReadback.getMappedRange()),nearest=[words[4],words[12]],errors=[words[6],words[14]];hitReadback.unmap();
    const validation=await device.popErrorScope();if(validation) throw new Error(validation.message);
    return {adapter:name,cases:count,maxBoundRatio,wrongSide,preciseWrongSide,maxPreciseDisplacement,retreatedWrongSide,minRetreatMarginRatio,maxRetreatBoundRatio,nonFinite,nearest,errors};
  } finally {buffers.forEach(b=>b.destroy());device.destroy();}
}
