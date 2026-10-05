import { makeStructuredView } from "webgpu-utils";
import { createDevice, checkedShader } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { loadSobol } from "../assets/sobol";
import { loadBuiltinObj } from "../assets/builtin-obj";
import { presentationScene } from "../scene/presentation";
import { dielectricMaterial, defaultDielectric, hexToLinear } from "../scene/dielectric-settings";
import { cameraBasis } from "../scene/camera";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { pathCore } from "../transport/shaders";

/** Reproduce the reported 138x138 PT paths without compiling the display/SPPM pipelines. */
export async function verifyRastagotchiPt(guard = true, count = 64, start = 9273, target = 9305) {
  const scene = await presentationScene("glass", await loadBuiltinObj("rastagotchi"));
  scene.materials[4] = dielectricMaterial({ ...defaultDielectric, ior: 1.5,
    transmission: hexToLinear("#f4fff6"), roughness: 0.03 }, true);
  const bvh = buildBvh(bakeTriangles(scene));
  const packed = { ...packBvh(bvh), ...packTransport(scene, bvh) };
  const { device } = await createDevice();
  const buffers: GPUBuffer[] = [];
  const make = (size: number, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size, usage }); buffers.push(buffer); return buffer;
  };
  const gpu = new GpuScene(device, packed);
  try {
    const output = make(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = make(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const trace = make(128 * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const traceReadback = make(trace.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const directions = await loadSobol();
    const sobol = make(directions.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(sobol, 0, directions);
    const view = makeStructuredView(definitions.structs.CameraParams!);
    const basis = cameraBasis(scene.camera);
    view.set({ size: [138, 138], eye: [...basis.eye, 0], forward: [...basis.forward, 0],
      right: [...basis.right, 0], up: [...basis.up, 0] });
    const camera = make(view.arrayBuffer.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(camera, 0, view.arrayBuffer);
    const core = guard ? pathCore : pathCore.replace("if(hit.triangle==spawnedTriangle)", "if(false)");
    const diagnosticCore = core.replace("if(nextMedia.error!=0u) {return PathResult(vec3f(0),4u,interactions);}",
      "if(nextMedia.error!=0u) {return PathResult(vec3f(f32(hit.triangle), f32(triangle.padding0), f32(depth)),select(42u,41u,entering),interactions);}")
      .replace("if (medium != NO_HIT) { return PathResult(vec3f(0), 4u, interactions); }", "if (medium != NO_HIT) { return PathResult(vec3f(f32(media.count),f32(triangles[medium].padding0),f32(depth)),43u,interactions); }")
      .replace("let entering = dot(ng, ray.direction) < 0.0;", `let entering = dot(ng, ray.direction) < 0.0;
        if(pixel==${target}u && traceIndex<128u) {
          trace[traceIndex*2u]=vec4f(f32(hit.triangle),f32(triangle.padding0),f32(media.count),f32(entering));
          trace[traceIndex*2u+1u]=vec4f(position,f32(depth));traceIndex++;
        }`);
    const source = diagnosticCore + `
      @group(0) @binding(0) var<storage,read_write> output:array<vec4f>;
      @group(0) @binding(1) var<uniform> params:CameraParams;
      @group(0) @binding(4) var<storage,read_write> trace:array<vec4f>;
      var<private> traceIndex:u32=0u;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
        if(id.x>=${count}u) {return;}
        let pixel=${start}u+id.x; let xy=vec2u(pixel%138u,pixel/138u);
        let jitter=vec2f(sample1D(0u,0u,pixel,1u),sample1D(0u,1u,pixel,1u));
        let uv=(vec2f(xy)+jitter)/138.0;let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
        let direction=normalize(params.forward.xyz+p.x*params.right.xyz+p.y*params.up.xyz);
        let result=tracePath(Ray(params.eye.xyz,0.00001,direction,1e20),0u,pixel,1u,32u,0u,${packed.lightCount}u);
        output[id.x]=vec4f(result.radiance,f32(result.error));
      }`;
    const module = await checkedShader(device, source, "Rastagotchi PT regression");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: output } }, { binding: 1, resource: { buffer: camera } },
      ...gpu.entries(), ...gpu.transportEntries(), { binding: 7, resource: { buffer: sobol } }, gpu.spectralEntry(),
      { binding: 4, resource: { buffer: trace } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    encoder.copyBufferToBuffer(trace, 0, traceReadback, 0, trace.size); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readback.getMappedRange()).slice(); readback.unmap();
    await traceReadback.mapAsync(GPUMapMode.READ);
    const traceData = Array.from(new Float32Array(traceReadback.getMappedRange())); traceReadback.unmap();
    const errors = [];
    for (let i = 0; i < count; i++) if (data[i * 4 + 3] !== 0) errors.push({ pixel: start + i, code: data[i * 4 + 3] });
    return { guard, count, errors, trace: traceData.filter((_, i) => i < 128), reportedPixel: Array.from(data.slice((target - start) * 4, (target + 1 - start) * 4)) };
  } finally { gpu.dispose(); buffers.forEach(buffer => buffer.destroy()); device.destroy(); }
}
