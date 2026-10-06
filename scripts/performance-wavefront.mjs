import { pathCore } from "../src/transport/shaders.ts";
import layouts from "../src/transport/layouts.wgsl?raw";
import color from "../src/transport/color.wgsl?raw";
import spectrum from "../src/transport/spectrum.wgsl?raw";
import { checkedShader } from "../src/gpu/device.ts";
import { makeShaderDataDefinitions } from "webgpu-utils";
import diagnostics from "../src/transport/diagnostics.wgsl?raw";

/** One-bounce kernels with GPU-compacted queues and indirect dispatch. Benchmark only. */
export async function installWavefrontCandidate(renderer, { hybrid = false } = {}) {
  const device = renderer.device,
    reference = pathCore.replaceAll("\r\n", "\n");
  const start = reference.indexOf("  for (var depth = 0u; depth <= maxDepth;) {");
  const open = reference.indexOf("{", start);
  let end = open + 1, level = 1;
  for (; level && end < reference.length; end++) {
    if (reference[end] === "{") level++;
    else if (reference[end] === "}") level--;
  }
  if (start < 0 || level) throw Error("Wavefront trace marker mismatch");
  const store = (active, error = "0u", value = "radiance") =>
    `waveStore(pathId,ray,originLow,beta,${value},previousPosition,lightPosition,previousPdf,previousDelta,etaScale,media,medium,depth,crossings,spawnedTriangle,interactions,${error},${active});return;`;
  const body = reference.slice(open + 1, end - 1)
    .replace(/return PathResult\(vec3f\(0\),\s*([^,]+),\s*interactions\);/g,
      (_, error) => store("false", error, "vec3f(0)"))
    .replaceAll("continue;", `if(depth>startDepth && !MEGA_BOUNCE){${store("true")}}continue;`);
  const types = `
struct WavePath {
  ray:Ray,beta:vec3f,previousPdf:f32,radiance:vec3f,etaScale:f32,
  previousPosition:vec3f,medium:u32,previousDelta:u32,depth:u32,error:u32,interactions:u32,
  wavelength:f32,pdf:f32,pixel:u32,padding:u32,
  originLow:vec3f,crossings:u32,lightPosition:vec3f,spawnedTriangle:u32,media:MediumSet,
}
struct WaveQueues {counts:array<atomic<u32>,2>,args:array<vec3u,2>,indices:array<u32>}
struct WaveParams {parity:u32,padding0:u32,padding1:u32,padding2:u32}
struct WaveIndirect {args:array<vec3u,2>}
override MEGA_BOUNCE:bool=false;
`;
  const code =
    reference +
    types +
    `
@group(0) @binding(0) var<storage,read_write> waveQueues:WaveQueues;
@group(0) @binding(1) var<uniform> params:CameraParams;
@group(0) @binding(8) var<storage,read_write> wavePaths:array<WavePath>;
@group(0) @binding(10) var<uniform> wave:WaveParams;
@group(0) @binding(12) var<storage,read_write> waveIndirect:WaveIndirect;
fn waveStore(pathId:u32,ray:Ray,originLow:vec3f,beta:vec3f,radiance:vec3f,previousPosition:vec3f,lightPosition:vec3f,previousPdf:f32,previousDelta:bool,etaScale:f32,media:MediumSet,medium:u32,depth:u32,crossings:u32,spawnedTriangle:u32,interactions:u32,error:u32,keepPath:bool){
  var state=wavePaths[pathId];state.ray=ray;state.beta=beta;state.radiance=radiance;
  state.previousPosition=previousPosition;state.previousPdf=previousPdf;state.previousDelta=u32(previousDelta);
  state.etaScale=etaScale;state.medium=medium;state.depth=depth;state.interactions=interactions;state.error=error;
  state.originLow=originLow;state.crossings=crossings;state.lightPosition=lightPosition;state.spawnedTriangle=spawnedTriangle;state.media=media;
  if(!all(radiance>=vec3f(0))||!all(radiance<vec3f(FAR))){state.error=3u;}
  wavePaths[pathId]=state;
  if(keepPath&&state.error==0u){let next=1u-wave.parity;let slot=atomicAdd(&waveQueues.counts[next],1u);waveQueues.indices[next*arrayLength(&wavePaths)+slot]=pathId;}
}
@compute @workgroup_size(64) fn waveInit(@builtin(global_invocation_id) invocation:vec3u){
  let pathId=invocation.x;if(pathId>=params.tile.z*params.tile.w){return;}
  let id=vec2u(pathId%params.tile.z,pathId/params.tile.z)+params.tile.xy;if(any(id>=params.size)){return;}
  let pixel=id.y*params.size.x+id.x;
  let jitter=vec2f(sample1D(params.frame,0u,pixel,params.seed),sample1D(params.frame,1u,pixel,params.seed));
  let uv=(vec2f(id)+jitter)/vec2f(params.size);let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
  let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
  var wavelength=WavelengthSample(0.0,1.0);if(params.transportMode!=0u){wavelength=sampleWavelength(sample1D(params.frame,2u,pixel,params.seed));}
  wavePaths[pathId]=WavePath(Ray(params.eye.xyz,0.00001,direction,1e20),vec3f(1),0.0,vec3f(0),1.0,params.eye.xyz,activeMedium(cameraMedia(params)),1u,0u,0u,0u,wavelength.wavelength,wavelength.pdf,pixel,0u,vec3f(0),0u,params.eye.xyz,NO_HIT,cameraMedia(params));
  let slot=atomicAdd(&waveQueues.counts[0],1u);waveQueues.indices[slot]=pathId;
}
@compute @workgroup_size(1) fn wavePrepare(){
  let count=atomicLoad(&waveQueues.counts[wave.parity]);waveIndirect.args[wave.parity]=vec3u((count+63u)/64u,1u,1u);
  atomicStore(&waveQueues.counts[1u-wave.parity],0u);
}
@compute @workgroup_size(64) fn waveBounce(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=atomicLoad(&waveQueues.counts[wave.parity])){return;}
  let pathId=waveQueues.indices[wave.parity*arrayLength(&wavePaths)+id.x];let state=wavePaths[pathId];
  var ray=state.ray;var beta=state.beta;var radiance=state.radiance;var previousPosition=state.previousPosition;
  var previousPdf=state.previousPdf;var previousDelta=state.previousDelta!=0u;var etaScale=state.etaScale;
  var medium=state.medium;var interactions=state.interactions;
  var media=state.media;var originLow=state.originLow;var crossings=state.crossings;var spawnedTriangle=state.spawnedTriangle;var lightPosition=state.lightPosition;
  var depth=state.depth;let startDepth=depth;let sampleIndex=params.frame;let pixel=state.pixel;let seed=params.seed;
  let maxDepth=params.maxDepth;let strategy=params.strategy;let lightCount=params.lightCount;let wavelength=state.wavelength;
  if(media.error!=0u){${store("false","4u","vec3f(0)")}}
  loop {
    if(depth>maxDepth){break;}
    ${body}
    if(depth>startDepth && !MEGA_BOUNCE){${store("true")}}
  }
  ${store("false")}
}
`;
  const finishCode =
    layouts +
    color +
    spectrum +
    "const NO_HIT:u32=0xffffffffu;\nstruct MediumSet {entries:array<u32,32>,windings:array<i32,32>,count:u32,error:u32}\n" +
    diagnostics +
    types +
    `
@group(0) @binding(0) var outputImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(1) var<uniform> params:CameraParams;
@group(0) @binding(8) var<storage,read> wavePaths:array<WavePath>;
@group(0) @binding(11) var<storage,read_write> accumulation:array<vec4f>;
@compute @workgroup_size(64) fn waveFinish(@builtin(global_invocation_id) invocation:vec3u){
  let pathId=invocation.x;if(pathId>=params.tile.z*params.tile.w){return;}
  let id=vec2u(pathId%params.tile.z,pathId/params.tile.z)+params.tile.xy;if(any(id>=params.size)){return;}
  let state=wavePaths[pathId];if(state.error!=0u){reportTransportError(state.error,5u,state.pixel,state.depth,NO_HIT,NO_HIT);return;}
  var radiance=state.radiance;if(params.transportMode!=0u){radiance=cieXyz(state.wavelength)*radiance.x/(state.pdf*CIE_Y_INTEGRAL);}
  let sum=accumulation[state.pixel]+vec4f(radiance,1);accumulation[state.pixel]=sum;
  textureStore(outputImage,vec2i(id),vec4f(sum.xyz/sum.w,1));
}
`;
  const [module, finishModule] = await Promise.all([
    checkedShader(device, code, "Wavefront experiment"),
    checkedShader(device, finishCode, "Wavefront output"),
  ]);
  const names = ["waveInit", "wavePrepare", "waveBounce", "waveFinish"];
  const pipelines = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await device.createComputePipelineAsync({
          layout: "auto",
          compute: {
            module: name === "waveFinish" ? finishModule : module,
            entryPoint: name,
            constants: name === "waveBounce" ? { MEGA_BOUNCE: hybrid } : {},
          },
        }),
      ]),
    ),
  );
  const definitions = makeShaderDataDefinitions(code),
    capacity = 128 ** 2;
  const create = (size, usage) => device.createBuffer({ size, usage });
  const states = create(
    capacity * definitions.structs.WavePath.size,
    GPUBufferUsage.STORAGE,
  );
  const indirect = create(32, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT);
  const queues = create(
    definitions.structs.WaveQueues.fields.indices.offset + capacity * 8,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  );
  const uniforms = [0, 1].map((parity) => {
    const buffer = create(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(buffer, 0, new Uint32Array([parity, 0, 0, 0]));
    return buffer;
  });
  const buffers = [states, queues, indirect, ...uniforms];
  const resources = {
    0: queues,
    1: renderer.uniform,
    2: renderer.scene.nodes,
    3: renderer.scene.triangles,
    5: renderer.scene.materials,
    6: renderer.scene.lights,
    7: renderer.sobol,
    8: states,
    9: renderer.scene.spectra,
  };
  const binding = (binding, buffer) => ({ binding, resource: { buffer } });
  const group = (name, entries) =>
    device.createBindGroup({
      layout: pipelines[name].getBindGroupLayout(0),
      entries,
    });
  const init = group(
    "waveInit",
    [0, 1, 7, 8].map((b) => binding(b, resources[b])),
  );
  const prepare = uniforms.map((u) =>
    group("wavePrepare", [
      binding(0, queues),
      binding(10, u),
      binding(12, indirect),
    ]),
  );
  const bounce = uniforms.map((u) =>
    group("waveBounce", [
      ...[0, 1, 2, 3, 5, 6, 7, 8, 9].map((b) => binding(b, resources[b])),
      binding(10, u),
      ...renderer.scene.environment.entries(),
    ]),
  );
  const finish = group("waveFinish", [
    { binding: 0, resource: renderer.texture.createView() },
    binding(1, renderer.uniform),
    binding(4, renderer.diagnostic),
    binding(8, states),
    binding(9, renderer.scene.spectra),
    binding(11, renderer.accumulation),
  ]);
  const encode = (encoder) => {
    const tile = renderer.parameters.views.tile;
    if (tile[2] * tile[3] > capacity)
      throw Error("Wavefront prototype tile capacity exceeded");
    encoder.clearBuffer(queues, 0, 8);
    const dispatch = (name, bind, count, offset) => {
      const p = encoder.beginComputePass();
      p.setPipeline(pipelines[name]);
      p.setBindGroup(0, bind);
      if (offset !== undefined) p.dispatchWorkgroupsIndirect(indirect, offset);
      else p.dispatchWorkgroups(count);
      p.end();
    };
    dispatch("waveInit", init, Math.ceil((tile[2] * tile[3]) / 64));
    for (let depth = 0; depth < (hybrid ? 1 : renderer.settings.maxDepth + 1); depth++) {
      const parity = depth % 2;
      dispatch("wavePrepare", prepare[parity], 1);
      dispatch("waveBounce", bounce[parity], 0, parity * 16);
    }
    dispatch("waveFinish", finish, Math.ceil((tile[2] * tile[3]) / 64));
  };
  const original = device.createCommandEncoder.bind(device);
  const wrapped = (...args) => {
    const encoder = original(...args),
      begin = encoder.beginComputePass.bind(encoder);
    encoder.beginComputePass = (...args) => {
      const pass = begin(...args),
        set = pass.setPipeline.bind(pass),
        bind = pass.setBindGroup.bind(pass),
        dispatch = pass.dispatchWorkgroups.bind(pass),
        end = pass.end.bind(pass);
      let wave = false;
      pass.setPipeline = (p) => {
        wave = p === renderer.pathPipeline;
        if (!wave) set(p);
      };
      pass.setBindGroup = (...args) => {
        if (!wave) bind(...args);
      };
      pass.dispatchWorkgroups = (...args) => {
        if (!wave) dispatch(...args);
      };
      pass.end = () => {
        end();
        if (wave) encode(encoder);
      };
      return pass;
    };
    return encoder;
  };
  device.createCommandEncoder = wrapped;
  const extraBytes = buffers.reduce((sum, b) => sum + b.size, 0);
  renderer.scene.bytes += extraBytes;
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    device.createCommandEncoder = original;
    buffers.forEach((b) => b.destroy());
    dispose();
  };
  return { bytes:extraBytes, stateBytes:definitions.structs.WavePath.size, restore(){device.createCommandEncoder=original;}, apply(){device.createCommandEncoder=wrapped;} };
}
