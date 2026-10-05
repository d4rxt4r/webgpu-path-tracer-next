import { createDevice, checkedShader } from '../gpu/device';
import { GpuScene } from '../gpu/scene';
import { loadSobol } from '../assets/sobol';
import { bakeTriangles } from '../accel/geometry';
import { buildBvh } from '../accel/bvh';
import { packBvh } from '../accel/pack';
import { packTransport } from '../accel/materials';
import { pathCore } from '../transport/shaders';
import { d65Spectrum, integrateXyz, nbk7Ior } from '../transport/spectrum';
import { prismScene } from '../scene/prism';
import type { SceneDescription, SpectrumTable } from '../scene/types';

const shader = pathCore + `
struct TestParams { count: u32, seed: u32, mode: u32, padding: u32 }
@group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(1) var<uniform> params: TestParams;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.count) { return; }
  let result = traceSpectralPath(Ray(vec3f(0,0.5,0),0.00001,vec3f(0,-1,0),100.0),id.x,17u,params.seed,1u,params.mode,2u);
  output[id.x] = vec4f(result.radiance,f32(result.error));
}
@compute @workgroup_size(64) fn prismMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.count) { return; }
  let wavelength = 400.0 + 400.0 * f32(id.x) / f32(params.count-1u);
  let ior = select(nbk7Ior(wavelength), materials[0].ior, params.mode != 0u);
  var ray = Ray(vec3f(-1,0.2,0),0.0,vec3f(cos(PI/18.0),sin(PI/18.0),0),100.0);
  var error = 0u;
  for (var boundary = 0u; boundary < 2u; boundary++) {
    let hit = closestHit(ray);
    if (hit.id == NO_HIT || hit.error != 0u) { error = 1u; break; }
    let triangle = triangles[hit.triangle]; let ng = geometricNormal(triangle);
    let entering = dot(ng,ray.direction) < 0.0;
    if (entering != (boundary == 0u)) { error = 2u; break; }
    let n = select(-ng,ng,entering);
    let event = sampleDielectricSurface(ray.direction,n,n,select(1.0/ior,ior,entering),0.99999,false);
    if (event.transmitted == 0u || event.weight == 0.0) { error = 3u; break; }
    let position = ray.origin + hit.t * ray.direction;
    ray = Ray(offsetOrigin(position,ng,event.direction),0.0,event.direction,100.0);
  }
  output[id.x] = vec4f(ray.direction,f32(error));
}`;

export async function verifySpectral() {
  const { device, name } = await createDevice();
  const buffers: GPUBuffer[] = []; let gpu: GpuScene | undefined;
  const create = (size: number, usage: GPUBufferUsageFlags) => { const b = device.createBuffer({ size, usage }); buffers.push(b); return b; };
  try {
    const count = 65536, directions = await loadSobol();
    const sobol = create(directions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST); device.queue.writeBuffer(sobol,0,directions);
    const output = create(count*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC), readback = create(count*16,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const params = create(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    const module = await checkedShader(device,shader,'Spectral and prism acceptance');
    const pipeline = await device.createComputePipelineAsync({ layout:'auto', compute:{ module,entryPoint:'main' } });
    const prismPipeline = await device.createComputePipelineAsync({ layout:'auto', compute:{ module,entryPoint:'prismMain' } });
    const run = async (scene: SceneDescription, mode = 0, prism = false) => {
      gpu?.dispose(); const bvh = buildBvh(bakeTriangles(scene)); gpu = new GpuScene(device,{ ...packBvh(bvh), ...packTransport(scene,bvh) });
      const active = prism ? prismPipeline : pipeline, size = prism ? 256 : count;
      device.queue.writeBuffer(params,0,new Uint32Array([size,1,mode,0]));
      const group = device.createBindGroup({ layout:active.getBindGroupLayout(0), entries:[{binding:0,resource:{buffer:output}},{binding:1,resource:{buffer:params}},...gpu.entries(), ...(prism ? [{binding:5,resource:{buffer:gpu.materials}}] : [...gpu.transportEntries(true),{binding:7,resource:{buffer:sobol}},gpu.spectralEntry()])] });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(active); pass.setBindGroup(0,group); pass.dispatchWorkgroups(Math.ceil(size/64)); pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,size*16); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ); const data = new Float32Array(readback.getMappedRange().slice(0,size*16)); readback.unmap(); return data;
    };
    const transform = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const emitter = (spectrum: SpectrumTable): SceneDescription => ({ version:1,camera:{position:[0,0.5,0],target:[0,0,0],up:[0,0,1],verticalFov:40}, meshes:[{positions:new Float32Array([-2,0,2,2,0,2,2,0,-2,-2,0,-2]),indices:new Uint32Array([0,1,2,0,2,3])}], objects:[{mesh:0,material:0,transform}],materials:[{type:'emissive',emission:[1,1,1],spectrum}],lights:[{object:0}] });
    let errors = 0;
    const estimates = [];
    for (const spectrum of [d65Spectrum,[[360,0],[445,0],[450,1],[455,0],[830,0]] as SpectrumTable,[[360,0],[645,0],[650,1],[655,0],[830,0]] as SpectrumTable]) {
      const data = await run(emitter(spectrum)), mean = [0,0,0];
      for (let i=0;i<count;i++) { errors += data[4*i+3]!; for(let c=0;c<3;c++) mean[c]! += data[4*i+c]!/count; }
      estimates.push({ mean, reference:integrateXyz(spectrum) });
    }
    const diffuse = emitter(d65Spectrum);
    diffuse.meshes.push({ positions:new Float32Array([-1,1,-1,1,1,-1,1,1,1,-1,1,1]),indices:new Uint32Array([0,1,2,0,2,3]) });
    diffuse.objects.push({mesh:1,material:1,transform});
    diffuse.materials = [{type:'diffuse',reflectance:[0.5,0.5,0.5]},{type:'emissive',emission:[1,1,1],spectrum:d65Spectrum}]; diffuse.lights = [{object:1}];
    let irradiance = 0;
    for(let y=0;y<512;y++) for(let x=0;x<512;x++) { const px = -1+(x+0.5)/256, pz = -1+(y+0.5)/256; irradiance += 4/(512*512)/(1+px*px+pz*pz)**2; }
    const diffuseReference = integrateXyz(d65Spectrum).map(value=>value*0.5*irradiance/Math.PI);
    const diffuseEstimates: number[][] = [];
    for(let strategy=0;strategy<3;strategy++) {
      const data = await run(diffuse,strategy), mean = [0,0,0];
      for(let i=0;i<count;i++) { errors += data[4*i+3]!; for(let c=0;c<3;c++) mean[c]! += data[4*i+c]!/count; }
      diffuseEstimates.push(mean);
    }
    const scene = prismScene(), prism = await run(scene,0,true), constant = await run(scene,1,true);
    let maxPrismError = 0, constantSpread = 0;
    const prismAngles: number[] = [];
    for (let i=0;i<256;i++) {
      errors += prism[4*i+3]! + constant[4*i+3]!;
      const n = nbk7Ior(400+400*i/255), internal = Math.asin(Math.sin(40*Math.PI/180)/n);
      const reference = Math.PI/6 - Math.asin(n*Math.sin(Math.PI/3-internal));
      const angle = Math.atan2(prism[4*i+1]!,prism[4*i]!); prismAngles.push(angle*180/Math.PI);
      maxPrismError = Math.max(maxPrismError,Math.abs(angle-reference));
      constantSpread = Math.max(constantSpread,Math.abs(Math.atan2(constant[4*i+1]!,constant[4*i]!)-Math.atan2(constant[1]!,constant[0]!)));
    }
    const fixedIor = nbk7Ior(587.6), constantAngle = Math.atan2(constant[1]!,constant[0]!);
    const constantReference = Math.PI/6 - Math.asin(fixedIor*Math.sin(Math.PI/3-Math.asin(Math.sin(40*Math.PI/180)/fixedIor)));
    return { estimates, diffuseEstimates, diffuseReference, errors, maxPrismError, constantSpread, constantAngleError:Math.abs(constantAngle-constantReference), prismAngles, adapter:name };
  } finally { buffers.forEach(b=>b.destroy()); gpu?.dispose(); device.destroy(); }
}
