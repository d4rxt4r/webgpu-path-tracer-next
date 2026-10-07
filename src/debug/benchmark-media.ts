import { makeStructuredView } from "webgpu-utils";
import { createDevice, type DeviceInfo } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { GpuTimer } from "../gpu/timer";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { cameraShells } from "../accel/camera-media";
import { cameraBasis } from "../scene/camera";
import { loadSobol } from "../assets/sobol";
import { SppmIntegrator } from "../render/sppm-integrator";
import { PacketBudget, PacketUniforms } from "../render/compute-packets";
import { Denoiser, type DenoiseSettings } from "../render/denoiser";
import { TRANSPORT_QUEUE_BYTES, COMPUTE_READBACK_BYTES } from "../render/transport-diagnostics";
import type { CommonMediumCapacity } from "../transport/medium-source";
import type { SceneDescription } from "../scene/types";

export interface MediaVariant {
  name: string;
  capacity: CommonMediumCapacity;
  /** Unmodified full/common modules captured from the compared revision. */
  source?: { precise: string; common: string };
  /** Preserve failures of a historical kernel; never accepted for candidates. */
  allowErrors?: boolean;
}
export interface MediaBenchmarkOptions {
  width?: number; height?: number; iterations?: number; repeats?: number;
  maxDepth?: number; seed?: number; photons?: number; batch?: number;
  mode?: "rgb" | "spectral";
  specializeSampler?: boolean;
  packetSteps?: number;
  queueUniforms?: boolean;
  validWarmups?: number;
  warmupIterations?: number;
  checkpoints?: number[];
  /** Reuse one adapter/device for a validation matrix; the caller owns it. */
  gpu?: DeviceInfo;
  denoise?: DenoiseSettings;
  progress?: (message: string) => void;
}
const sha256 = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");

/** Same scene, buffers and immutable uniform packets for all variants. Warm-up
 * is excluded; measured rounds alternate kernel order to reduce thermal bias.
 * GPU timestamps exclude compilation, capture, filtering and browser scheduling.
 */
export async function benchmarkMedia(scene: SceneDescription, variants: MediaVariant[], options: MediaBenchmarkOptions = {}) {
  if (options.queueUniforms && options.packetSteps !== 1) throw new Error("Queue uniform writes require one submission per step");
  const samplers = new Set(variants.flatMap(v => v.source ? [v.source.common.includes("for (var level = 0u; level < 24u; level++)")] : []));
  if (samplers.size > 1) throw new Error("Benchmark variants must use the same sampler");
  const width = options.width ?? 960, height = options.height ?? 720;
  const iterations = options.iterations ?? 8, repeats = options.repeats ?? 5;
  const mode = options.mode ?? "spectral";
  const settings = { maxDepth: options.maxDepth ?? 8, seed: options.seed ?? 17,
    photonsPerIteration: options.photons ?? 16384, photonBatchSize: options.batch ?? 16384, initialRadius: 0.03 };
  const {device, name} = options.gpu ?? await createDevice();
  const buffers: GPUBuffer[] = [], integrators: SppmIntegrator[] = [];
  const create = (size: number, usage: GPUBufferUsageFlags) => { const b = device.createBuffer({size, usage}); buffers.push(b); return b; };
  let gpu: GpuScene | undefined, image: GPUTexture | undefined, timer: GpuTimer | undefined, snapshots: PacketUniforms | undefined;
  let denoiser: Denoiser | undefined;
  try {
    device.pushErrorScope("validation");
    const preparationStart = performance.now();
    const bvh = buildBvh(bakeTriangles(scene));
    const packed = {...packBvh(bvh), ...packTransport(scene, bvh)};
    const preparationMs = performance.now() - preparationStart;
    gpu = new GpuScene(device, packed);
    const directions = await loadSobol();
    const sobol = create(directions.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(sobol, 0, directions);
    const params = makeStructuredView(definitions.structs.CameraParams!);
    const camera = create(params.arrayBuffer.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const errors = create(TRANSPORT_QUEUE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const accumulation = create(width * height * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const readback = create(COMPUTE_READBACK_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const captureBuffer = create(accumulation.size + 128, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    image = device.createTexture({size: [width, height], format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
    timer = device.features.has("timestamp-query") ? new GpuTimer(device) : undefined;
    snapshots = new PacketUniforms(device);
    const basis = cameraBasis(scene.camera), shells = cameraShells(packed, scene.camera.position);
    const initialShells = new Uint32Array(32); initialShells.set(shells);
    const resources = {scene: gpu, camera, sobol, errors, accumulation, texture: image};
    const compilation: Record<string, number> = {};
    const sourceHashes: Record<string, Record<string, string>> = {};
    for (const variant of variants) {
      options.progress?.(`compile ${variant.name}`);
      const start = performance.now(), createShader = device.createShaderModule;
      const sources: Record<string, string> = {};
      // Instance-local interception supports old kernels without altering the
      // current transport API or another renderer's device.
      device.createShaderModule = function(descriptor) {
        const code = descriptor.label === "SPPM common transport" ? variant.source?.common
          : descriptor.label === "RGB / spectral SPPM" ? variant.source?.precise : undefined;
        if (descriptor.label === "SPPM common transport") sources.common = code ?? descriptor.code;
        if (descriptor.label === "RGB / spectral SPPM") sources.precise = code ?? descriptor.code;
        return createShader.call(this, code ? {...descriptor, code} : descriptor);
      };
      try { integrators.push(await SppmIntegrator.create(device, options.specializeSampler ?? true, false, undefined, variant.capacity)); }
      finally { device.createShaderModule = createShader; }
      compilation[variant.name] = performance.now() - start;
      sourceHashes[variant.name] = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([kind, code]) =>
        [kind, await sha256(new TextEncoder().encode(code).buffer)])));
    }
    const rows: {name: string; round: number; warmup: boolean; gpuMs: number | null; elapsedMs: number;
      phases: Record<string, {gpuMs: number; completionMs: number; steps: number; retries: number}>; bytes: number; errors?: number}[] = [];
    const captures: Record<string, {xyz: Float32Array; filtered?: Float32Array; counts: Float32Array; errors: number; emittedPhotons: number}> = {};
    const convergence: {name: string; round: number; iterations: number; meanY: number; floorMeanY: number; emittedPhotons: number}[] = [];
    const warmups = new Map<string, {attempts: number; consecutiveValid: number}>();
    for (let round = 0; round <= repeats; round++) {
      const order = variants.map((_, i) => i); if (round % 2) order.reverse();
      for (const index of order) {
        const variant = variants[index]!, integrator = integrators[index]!;
        const runIterations = round === 0 ? options.warmupIterations ?? iterations : iterations;
        options.progress?.(`${variant.name} ${round === 0 ? "warmup" : `${round}/${repeats}`}`);
        // Keep only one variant's large point/photon buffers resident. Retaining
        // every variant would exceed the user's 512 MiB benchmark budget.
        integrator.configure(width, height, settings, resources);
        integrator.reset();
        const clear = device.createCommandEncoder(); clear.clearBuffer(errors); clear.clearBuffer(accumulation);
        device.queue.submit([clear.finish()]); await device.queue.onSubmittedWorkDone();
        const phases: typeof rows[number]["phases"] = {};
        const budget = new PacketBudget();
        const started = performance.now();
        while (integrator.iterations < runIterations) {
          const phase = integrator.phase, stageStart = performance.now();
          const stage = phases[phase] ??= {gpuMs: 0, completionMs: 0, steps: 0, retries: 0};
          const encoder = device.createCommandEncoder(); snapshots.begin(); timer?.begin(encoder);
          const packetSteps = options.packetSteps ?? budget.steps(phase, false);
          let steps = 0;
          do {
            params.set({size: [width, height], frame: integrator.iterations, eye: [...basis.eye, 0],
              forward: [...basis.forward, 0], right: [...basis.right, 0], up: [...basis.up, 0],
              tile: integrator.tileRect(), maxDepth: settings.maxDepth, seed: settings.seed,
              lightCount: packed.lightCount, transportMode: Number(mode === "spectral"), padding1: shells.length, initialShells});
            if (options.queueUniforms) device.queue.writeBuffer(camera, 0, params.arrayBuffer);
            else snapshots.write(encoder, camera, params.arrayBuffer);
            integrator.encodeStep(encoder, options.queueUniforms ? undefined : snapshots); steps++;
          } while (integrator.phase === phase && steps < packetSteps);
          encoder.copyBufferToBuffer(errors, 0, readback, 0, 64); timer?.end(encoder, readback);
          device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
          const data = readback.getMappedRange(), words = new Uint32Array(data);
          const errorCount = words[0]!, retries = words[12]!;
          const diagnostic = Array.from(words.slice(1,12));
          const gpuMs = timer?.read(data);
          stage.gpuMs += gpuMs ?? 0;
          readback.unmap();
          if (errorCount && !variant.allowErrors) throw new Error(`${variant.name}: ${errorCount} transport errors in ${phase}: ${diagnostic.join(",")}`);
          stage.steps += steps; stage.completionMs += performance.now() - stageStart;
          budget.observe(phase, steps, gpuMs, performance.now() - stageStart);
          if (integrator.phase !== phase && (phase === "camera" || phase === "photon")) stage.retries += retries;
          if (round > 0 && phase === "update" && options.checkpoints?.includes(integrator.iterations)) {
            const checkpoint = device.createCommandEncoder();
            checkpoint.copyBufferToBuffer(accumulation, 0, captureBuffer, 0, accumulation.size);
            device.queue.submit([checkpoint.finish()]); await captureBuffer.mapAsync(GPUMapMode.READ);
            const values = new Float32Array(captureBuffer.getMappedRange());
            let total = 0, floor = 0, floorCount = 0;
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
              const p = (y * width + x) * 4;
              const luminance = (mode === "spectral" ? values[p + 1]! : 0.2126729 * values[p]! + 0.7151522 * values[p + 1]! + 0.072175 * values[p + 2]!) / values[p + 3]!;
              total += luminance;
              if (x >= width * 0.25 && x < width * 0.75 && y >= height * 0.7 && y < height * 0.95) {floor += luminance; floorCount++;}
            }
            captureBuffer.unmap();
            convergence.push({name: variant.name, round, iterations: integrator.iterations, meanY: total / (width * height), floorMeanY: floor / floorCount, emittedPhotons: integrator.emittedPhotons});
          }
        }
        const elapsedMs = performance.now() - started;
        rows.push({name: variant.name, round, warmup: round === 0, phases, elapsedMs,
          gpuMs: timer ? Object.values(phases).reduce((s, p) => s + p.gpuMs, 0) : null,
          bytes: gpu.bytes + integrator.bytes + accumulation.size + width * height * 8 + sobol.size + errors.size + snapshots.bytes});
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(accumulation, 0, captureBuffer, 0, accumulation.size);
        encoder.copyBufferToBuffer(errors, 0, captureBuffer, accumulation.size, 128);
        device.queue.submit([encoder.finish()]); await captureBuffer.mapAsync(GPUMapMode.READ);
        const mapped = captureBuffer.getMappedRange(), values = new Float32Array(mapped, 0, width * height * 4);
        const xyz = new Float32Array(width * height * 3), counts = new Float32Array(width * height);
        for (let pixel = 0; pixel < counts.length; pixel++) {
          counts[pixel] = values[pixel * 4 + 3]!;
          for (let c = 0; c < 3; c++) xyz[pixel * 3 + c] = values[pixel * 4 + c]! / counts[pixel]!;
        }
        const errorCount = new Uint32Array(mapped, accumulation.size, 1)[0]!;
        rows.at(-1)!.errors = errorCount;
        captureBuffer.unmap();
        if ((errorCount && !variant.allowErrors) || counts.some(n => n !== runIterations) || xyz.some(n => !Number.isFinite(n))) throw new Error(`${variant.name}: invalid capture`);
        captures[variant.name] = {xyz, counts, errors: errorCount, emittedPhotons: integrator.emittedPhotons};
        if (round === repeats && options.denoise?.enabled) {
          denoiser ??= await Denoiser.create(device);
          denoiser.configure(image, gpu, camera, errors);
          const encoder = device.createCommandEncoder();
          const output = denoiser.encode(encoder, options.denoise, mode === "spectral", true);
          const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
          const buffer = create(bytesPerRow * height, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
          encoder.copyTextureToBuffer({texture: output}, {buffer, bytesPerRow}, [width, height]);
          device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
          const halves = new Uint16Array(buffer.getMappedRange()), filtered = new Float32Array(xyz.length);
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
            const n = halves[y * bytesPerRow / 2 + x * 4 + c]!, e = (n >> 10) & 31, f = n & 1023;
            filtered[(y * width + x) * 3 + c] = (n & 0x8000 ? -1 : 1) * (e === 0 ? f * 2 ** -24 : e === 31 ? f ? NaN : Infinity : (1 + f / 1024) * 2 ** (e - 15));
          }
          buffer.unmap();
          if (filtered.some(n => !Number.isFinite(n))) throw new Error(`${variant.name}: non-finite filtered capture`);
          captures[variant.name]!.filtered = filtered;
        }
        integrator.releaseBuffers();
        if (round === 0 && (options.validWarmups ?? 1) > 0) {
          const state = warmups.get(variant.name) ?? {attempts: 0, consecutiveValid: 0};
          state.attempts++; state.consecutiveValid = errorCount ? 0 : state.consecutiveValid + 1;
          warmups.set(variant.name, state);
          if (state.consecutiveValid < (options.validWarmups ?? 1)) {
            if (state.attempts >= 12) throw new Error(`${variant.name}: valid warmup did not converge`);
            order.push(index);
          }
        }
      }
    }
    const validation = await device.popErrorScope(); if (validation) throw new Error(validation.message);
    return {adapter: name, width, height, iterations, repeats, mode, settings,
      sampler: options.specializeSampler === false ? "looped" : "specialized", packetSteps: options.packetSteps ?? "production budget",
      uniforms: options.queueUniforms ? "queue writes" : "immutable snapshots",
      camera: scene.camera,
      triangles: packed.triangleCount, shells: new Set(bvh.triangles.filter(t => scene.materials[scene.objects[t.surface]!.material]?.type === "dielectric").map(t => t.boundary)).size,
      cameraShells: shells.length, sceneHashes: {triangles: await sha256(packed.triangles), materials: await sha256(packed.materials)},
      preparationMs, compilation, sourceHashes, rows, captures, convergence};
  } finally {
    integrators.forEach(i => i.dispose()); denoiser?.dispose(); snapshots?.dispose(); timer?.dispose(); image?.destroy();
    gpu?.dispose(); buffers.forEach(b => b.destroy()); if (!options.gpu) device.destroy();
  }
}
