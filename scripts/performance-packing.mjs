import { rgbPathShader } from '../src/transport/pt-source.ts';
import { fastTransportShader } from '../src/transport/fast-source.ts';
import { checkedShader } from '../src/gpu/device.ts';
import { GpuScene } from '../src/gpu/scene.ts';

function accesses(source) {
  let result='',cursor=0;
  for(;;){
    const start=source.indexOf('triangles[',cursor);
    if(start<0) return result+source.slice(cursor);
    let end=start+10,depth=1;
    for(;depth&&end<source.length;end++){if(source[end]==='[')depth++;else if(source[end]===']')depth--;}
    if(depth) throw Error('Unbalanced triangle index');
    result+=source.slice(cursor,start)+'triangleAt('+source.slice(start+10,end-1)+')';cursor=end;
  }
}
function shader(source) {
  source=source.replace('var<storage, read> triangles: array<Triangle>;',`var<storage,read> triangles:array<vec4u>;
fn triangleCount()->u32{return arrayLength(&triangles)/6u;}
fn geometryAt(index:u32)->Triangle {
  let a=triangles[index*3u];let b=triangles[index*3u+1u];let c=triangles[index*3u+2u];
  return Triangle(bitcast<vec3f>(a.xyz),a.w,bitcast<vec3f>(b.xyz),b.w,bitcast<vec3f>(c.xyz),c.w,vec3f(0),0u,vec3f(0),0u,vec3f(0),0u);
}
fn triangleAt(index:u32)->Triangle {
  var tri=geometryAt(index);let offset=triangleCount()*3u+index*3u;
  let a=triangles[offset];let b=triangles[offset+1u];let c=triangles[offset+2u];
  tri.na=bitcast<vec3f>(a.xyz);tri.padding0=a.w;tri.nb=bitcast<vec3f>(b.xyz);tri.padding1=b.w;tri.nc=bitcast<vec3f>(c.xyz);tri.padding2=c.w;return tri;
}`);
  const split=source.indexOf('fn miss(');
  if(split<0||!source.includes('fn triangleAt(')) throw Error('Packing marker mismatch');
  const implementation=accesses(source.slice(split).replaceAll('arrayLength(&triangles)','triangleCount()'))
    .replace('triangleHitPrepared(bounded, triangleAt(i), shear','triangleHitPrepared(bounded, geometryAt(i), shear');
  return source.slice(0,split)+implementation;
}
export async function packingCandidate(session) {
  const renderer=session.renderer,device=renderer.device,baseline={scene:renderer.scene,kernel:session.kernelState()};
  const source=new Uint32Array(renderer.packed.triangles),count=source.length/24,target=new Uint32Array(source.length);
  for(let i=0;i<count;i++){target.set(source.subarray(i*24,i*24+12),i*12);target.set(source.subarray(i*24+12,i*24+24),count*12+i*12);}
  const at=performance.now(),reference=rgbPathShader();
  const [precise,fast]=await Promise.all([checkedShader(device,shader(reference),'SOA precise'),checkedShader(device,shader(fastTransportShader(reference,true)),'SOA common')]);
  const [pipeline,repair]=await Promise.all([
    device.createComputePipelineAsync({layout:'auto',compute:{module:fast,entryPoint:'main'}}),
    device.createComputePipelineAsync({layout:'auto',compute:{module:precise,entryPoint:'repairMain'}})]);
  const compileMs=performance.now()-at,scene=new GpuScene(device,{...renderer.packed,triangles:target.buffer},renderer.environment);
  const variants=new Map(renderer.pathVariants);variants.set('rgb',{pipeline,repair});
  return {compileMs,bytes:scene.bytes,
    apply(){renderer.scene=scene;session.useKernel({...baseline.kernel,pipeline,repair,variants});},
    restore(){renderer.scene=baseline.scene;session.useKernel(baseline.kernel);},dispose(){scene.dispose();}};
}
