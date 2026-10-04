import { makeStructuredView } from "webgpu-utils";
import { createDevice, checkedShader } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { loadSobol } from "../assets/sobol";
import { buddhaScene } from "../scene/buddha";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { cameraBasis } from "../scene/camera";
import { pathCore } from "../transport/shaders";
import { sppmShader } from "../transport/sppm-shader";
import type { SphereMaterial } from "../scene/cornell";

/** Exercise every spectral camera path; preserve the failing pixel and sample. */
export async function verifyBuddhaGlass(
  width = 960,
  height = 720,
  samples = 16,
  replay?: { sample: number; pixel: number },
  options: { mode?: "rgb" | "spectral"; integrator?: "pt" | "sppm"; material?: SphereMaterial; seed?: number } = {},
) {
  if (options.integrator === "sppm" && !replay) throw new Error("SPPM camera replay requires a pixel and sample");
  const scene = await buddhaScene(options.material ?? "blue-glass");
  const bvh = buildBvh(bakeTriangles(scene));
  const packed = { ...packBvh(bvh), ...packTransport(scene, bvh) };
  const { device, name } = await createDevice();
  const buffers: GPUBuffer[] = [];
  let gpu: GpuScene | undefined;
  const create = (size: number, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    gpu = new GpuScene(device, packed);
    const directions = await loadSobol();
    const sobol = create(
      directions.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(sobol, 0, directions);
    const values = create(
      width * height * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const readback = create(
      values.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    const params = makeStructuredView(definitions.structs.CameraParams!);
    const uniform = create(
      params.arrayBuffer.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const basis = cameraBasis(scene.camera);
    const diagnostic = create(64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    const sppmReplay = options.integrator === "sppm";
    const trace = options.mode === "rgb" ? "tracePath" : "traceSpectralPath";
    const module = await checkedShader(
      device,
      (sppmReplay ? sppmShader : pathCore) +
        `
@group(0) @binding(12) var<storage,read_write> results: array<vec4u>;
${sppmReplay ? "" : "@group(0) @binding(1) var<uniform> params: CameraParams;"}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let pixel=params.tile.x+id.x;if(pixel>=params.size.x*params.size.y||id.x>=params.tile.z) {return;}
  let xy=vec2u(pixel%params.size.x,pixel/params.size.x);
  let jitter=vec2f(sample1D(params.frame,0u,pixel,params.seed),sample1D(params.frame,1u,pixel,params.seed));
  let uv=(vec2f(xy)+jitter)/vec2f(params.size);let p=vec2f(2.0*uv.x-1.0,1.0-2.0*uv.y);
  let direction=normalize(params.forward.xyz+p.x*f32(params.size.x)/f32(params.size.y)*params.right.xyz+p.y*params.up.xyz);
  ${sppmReplay ? `let point=cameraPoint(Ray(params.eye.xyz,0.00001,direction,1e20),pixel,0.0);
  results[pixel]=vec4u(atomicLoad(&transportErrors[0]),point.valid,xy);` : `let value=${trace}(Ray(params.eye.xyz,0.00001,direction,1e20),params.frame,pixel,params.seed,params.maxDepth,0u,params.lightCount);
  results[pixel]=vec4u(value.error,value.interactions,xy);`}
}`,
      "Buddha blue glass regression",
    );
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 12, resource: { buffer: values } },
        { binding: 1, resource: { buffer: uniform } },
        ...(sppmReplay ? [{binding:4,resource:{buffer:diagnostic}}] : []),
        ...gpu.entries(),
        ...gpu.transportEntries(),
        gpu.spectralEntry(),
        { binding: 7, resource: { buffer: sobol } },
      ],
    });
    let paths = 0;
    const failures: {
      sample: number;
      pixel: number;
      code: number;
      depth: number;
    }[] = [];
    for (
      let sample = replay?.sample ?? 0;
      sample < (replay ? replay.sample + 1 : samples);
      sample++
    ) {
      for (
        let start = replay?.pixel ?? 0;
        start < (replay ? replay.pixel + 1 : width * height);
        start += 4096
      ) {
        params.set({
          size: [width, height],
          frame: sample,
          eye: [...basis.eye, 0],
          forward: [...basis.forward, 0],
          right: [...basis.right, 0],
          up: [...basis.up, 0],
          maxDepth: 64,
          seed: options.seed ?? 1,
          lightCount: packed.lightCount,
          tile: [start, 0, replay ? 1 : 4096, 1],
        });
        device.queue.writeBuffer(uniform, 0, params.arrayBuffer);
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(64);
        pass.end();
        device.queue.submit([encoder.finish()]);
        if ((start / 4096) % 32 === 31)
          await device.queue.onSubmittedWorkDone();
      }
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(values, 0, readback, 0, values.size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(readback.getMappedRange());
      for (
        let pixel = replay?.pixel ?? 0;
        pixel < (replay ? replay.pixel + 1 : width * height);
        pixel++
      )
        if (data[4 * pixel])
          failures.push({
            sample,
            pixel,
            code: data[4 * pixel]!,
            depth: data[4 * pixel + 1]!,
          });
      readback.unmap();
      paths += replay ? 1 : width * height;
      if (failures.length) break;
    }
    return { adapter: name, width, height, paths, failures };
  } finally {
    buffers.forEach((buffer) => buffer.destroy());
    gpu?.dispose();
    device.destroy();
  }
}
