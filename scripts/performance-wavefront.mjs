import { pathCore } from "../src/transport/shaders.ts";
import layouts from "../src/transport/layouts.wgsl?raw";
import color from "../src/transport/color.wgsl?raw";
import spectrum from "../src/transport/spectrum.wgsl?raw";
import { checkedShader } from "../src/gpu/device.ts";
import { makeShaderDataDefinitions } from "webgpu-utils";

/** One-bounce kernels with GPU-compacted queues and indirect dispatch. Benchmark only. */
export async function installWavefrontCandidate(renderer) {
  const device = renderer.device,
    reference = pathCore.replaceAll("\r\n", "\n");
  const start = reference.indexOf(
    "  for (var depth = 0u; depth <= maxDepth; depth++) {",
  );
  const open = reference.indexOf("{", start);
  let end = open + 1,
    level = 1;
  for (; level && end < reference.length; end++) {
    if (reference[end] === "{") level++;
    else if (reference[end] === "}") level--;
  }
  if (start < 0 || level) throw Error("Wavefront trace marker mismatch");
  const store = (active, error = "0u", radiance = "radiance") =>
    `waveStore(pathId,ray,beta,${radiance},previousPosition,previousPdf,previousDelta,etaScale,medium,depth+1u,interactions,${error},${active});return;`;
  const body = reference
    .slice(open + 1, end - 1)
    .replace(
      /return PathResult\(vec3f\(0\), ([^,]+), interactions\);/g,
      (_, error) => store("false", error, "vec3f(0)"),
    )
    .replaceAll("continue;", store("true"))
    .replaceAll("break;", store("false"));
  const types = `
struct WavePath {
  ray:Ray,beta:vec3f,previousPdf:f32,radiance:vec3f,etaScale:f32,
  previousPosition:vec3f,medium:u32,previousDelta:u32,depth:u32,error:u32,interactions:u32,
  wavelength:f32,pdf:f32,pixel:u32,padding:u32,
}
struct WaveQueues {counts:array<atomic<u32>,2>,args:array<vec3u,2>,indices:array<u32>}
struct WaveParams {parity:u32,padding0:u32,padding1:u32,padding2:u32}
struct WaveIndirect {args:array<vec3u,2>}
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
fn waveStore(pathId:u32,ray:Ray,beta:vec3f,radiance:vec3f,previousPosition:vec3f,previousPdf:f32,previousDelta:bool,etaScale:f32,medium:u32,depth:u32,interactions:u32,error:u32,keepPath:bool){
  var state=wavePaths[pathId];state.ray=ray;state.beta=beta;state.radiance=radiance;
  state.previousPosition=previousPosition;state.previousPdf=previousPdf;state.previousDelta=u32(previousDelta);
  state.etaScale=etaScale;state.medium=medium;state.depth=depth;state.interactions=interactions;state.error=error;
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
  wavePaths[pathId]=WavePath(Ray(params.eye.xyz,0.00001,direction,1e20),vec3f(1),0.0,vec3f(0),1.0,params.eye.xyz,NO_HIT,1u,0u,0u,0u,wavelength.wavelength,wavelength.pdf,pixel,0u);
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
  let depth=state.depth;let sampleIndex=params.frame;let pixel=state.pixel;let seed=params.seed;
  let maxDepth=params.maxDepth;let strategy=params.strategy;let lightCount=params.lightCount;let wavelength=state.wavelength;
  ${body}
  ${store("true")}
}
`;
  const finishCode =
    layouts +
    color +
    spectrum +
    types +
    `
@group(0) @binding(0) var outputImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(1) var<uniform> params:CameraParams;
@group(0) @binding(4) var<storage,read_write> errors:atomic<u32>;
@group(0) @binding(8) var<storage,read> wavePaths:array<WavePath>;
@group(0) @binding(11) var<storage,read_write> accumulation:array<vec4f>;
@compute @workgroup_size(64) fn waveFinish(@builtin(global_invocation_id) invocation:vec3u){
  let pathId=invocation.x;if(pathId>=params.tile.z*params.tile.w){return;}
  let id=vec2u(pathId%params.tile.z,pathId/params.tile.z)+params.tile.xy;if(any(id>=params.size)){return;}
  let state=wavePaths[pathId];if(state.error!=0u){atomicAdd(&errors,1u);return;}
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
          },
        }),
      ]),
    ),
  );
  const definitions = makeShaderDataDefinitions(code),
    capacity = renderer.pathTileSize ** 2;
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
    for (let depth = 0; depth <= renderer.settings.maxDepth; depth++) {
      const parity = depth % 2;
      dispatch("wavePrepare", prepare[parity], 1);
      dispatch("waveBounce", bounce[parity], 0, parity * 16);
    }
    dispatch("waveFinish", finish, Math.ceil((tile[2] * tile[3]) / 64));
  };
  const original = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (...args) => {
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
  renderer.scene.bytes += buffers.reduce((sum, b) => sum + b.size, 0);
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    device.createCommandEncoder = original;
    buffers.forEach((b) => b.destroy());
    dispose();
  };
}
