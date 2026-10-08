import { GpuTimer } from "../gpu/timer";
import { validateAperture } from "../accel/camera-optics";
import { cameraShells } from "../accel/camera-media";
import { makeStructuredView } from "webgpu-utils";
import { createDevice, type DeviceInfo } from "../gpu/device";
import { GpuScene } from "../gpu/scene";
import { bakeTriangles } from "../accel/geometry";
import { buildBvh } from "../accel/bvh";
import { definitions, packBvh } from "../accel/pack";
import { packTransport } from "../accel/materials";
import { loadSobol } from "../assets/sobol";
import { cameraBasis, cameraOptics } from "../scene/camera";
import type { SceneDescription } from "../scene/types";
import { TRANSPORT_QUEUE_BYTES } from "../render/transport-diagnostics";
import { SppmIntegrator } from "../render/sppm-integrator";
import { sppmDefinitions } from "../transport/sppm-shader";
import type { CommonMediumCapacity } from "../transport/medium-source";
import { Denoiser, type DenoiseSettings } from "../render/denoiser";

/** Numerical acceptance runner; production rendering retains its RAF job budget. */
export async function renderSppm(
  scene: SceneDescription,
  options: {
    iterations: number;
    measure?: boolean;
    width?: number;
    height?: number;
    mode?: "rgb" | "spectral";
    photonsPerIteration?: number;
    photonBatchSize?: number;
    initialRadius?: number;
    maxDepth?: number;
    seed?: number;
    denoise?: DenoiseSettings;
    checkpoints?: number[];
    specializeSampler?: boolean;
    preciseTransport?: boolean;
    mediumCapacity?: CommonMediumCapacity;
    debugPixel?: number;
    gpu?: DeviceInfo;
  },
) {
  const { device, name } = options.gpu ?? await createDevice();
  device.pushErrorScope("validation");
  const buffers: GPUBuffer[] = [];
  let gpu: GpuScene | undefined,
    integrator: SppmIntegrator | undefined,
    image: GPUTexture | undefined;
  let denoiser: Denoiser | undefined;
  let timer: GpuTimer | undefined;
  const create = (size: number, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size, usage });
    buffers.push(buffer);
    return buffer;
  };
  try {
    const width = options.width ?? 1,
      height = options.height ?? 1,
      mode = options.mode ?? "spectral";
    const settings = {
      maxDepth: options.maxDepth ?? 8,
      seed: options.seed ?? 17,
      photonsPerIteration: options.photonsPerIteration ?? 4096,
      photonBatchSize: options.photonBatchSize ?? 1024,
      initialRadius: options.initialRadius ?? 0.15,
    };
    const bvh = buildBvh(bakeTriangles(scene)),
      packed = { ...packBvh(bvh), ...packTransport(scene, bvh) };
    if (mode === "spectral" && !packed.spectralReady)
      throw new Error("Acceptance scene needs spectra");
    validateAperture(packed, scene.camera);
    gpu = new GpuScene(device, packed);
    const directions = await loadSobol();
    const sobol = create(
      directions.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(sobol, 0, directions);
    const parameters = makeStructuredView(definitions.structs.CameraParams!);
    const camera = create(
      parameters.arrayBuffer.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const errors = create(
      TRANSPORT_QUEUE_BYTES,
      GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    );
    const accumulation = create(
      width * height * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    );
    const readback = create(
      accumulation.size + 128,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    );
    image = device.createTexture({
      size: [width, height],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    integrator = await SppmIntegrator.create(device,options.specializeSampler ?? false,options.preciseTransport ?? false,undefined,options.mediumCapacity);
    integrator.configure(width, height, settings, {
      scene: gpu,
      camera,
      sobol,
      errors,
      accumulation,
      texture: image,
    });
    const basis = cameraBasis(scene.camera), optics = cameraOptics(scene.camera);
    const shells = cameraShells(packed, scene.camera.position);
    const initialShells = new Uint32Array(32); initialShells.set(shells);
    let jobs = 0;
    const convergence: {
      iterations: number;
      emittedPhotons: number;
      floorMeanY: number;
      elapsedMs: number;
    }[] = [];
    const timing = options.measure && device.features.has("timestamp-query") ? create(80, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST) : undefined;
    if (timing) timer = new GpuTimer(device);
    let gpuMs = 0;
    const started = performance.now();
    while (integrator.iterations < options.iterations) {
      parameters.set({
        size: [width, height],
        frame: integrator.iterations,
        optics: [optics.radius, optics.distance, optics.shape === "polygon" ? optics.blades : 0, optics.rotation * Math.PI / 180],
        eye: [...basis.eye, 0],
        forward: [...basis.forward, 0],
        right: [...basis.right, 0],
        up: [...basis.up, 0],
        tile: integrator.tileRect(),
        maxDepth: settings.maxDepth,
        seed: settings.seed,
        lightCount: packed.lightCount,
        transportMode: Number(mode === "spectral"),
        padding1: shells.length, initialShells,
      });
      device.queue.writeBuffer(camera, 0, parameters.arrayBuffer);
      const encoder = device.createCommandEncoder();
      timer?.begin(encoder);
      integrator.encodeStep(encoder);
      if (timing) timer?.end(encoder, timing);
      device.queue.submit([encoder.finish()]);
      if (timing) { await timing.mapAsync(GPUMapMode.READ); gpuMs += timer!.read(timing.getMappedRange()); timing.unmap(); }
      if (++jobs % 32 === 0) await device.queue.onSubmittedWorkDone();
      if (
        integrator.phase === "camera" &&
        integrator.tile === 0 &&
        options.checkpoints?.includes(integrator.iterations)
      ) {
        const checkpoint = device.createCommandEncoder();
        checkpoint.copyBufferToBuffer(
          accumulation,
          0,
          readback,
          0,
          accumulation.size,
        );
        device.queue.submit([checkpoint.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(readback.getMappedRange());
        let sum = 0,
          count = 0;
        for (
          let y = Math.floor(height * 0.8);
          y < Math.floor(height * 0.95);
          y++
        )
          for (
            let x = Math.floor(width * 0.35);
            x < Math.floor(width * 0.65);
            x++
          ) {
            const i = (y * width + x) * 4;
            sum +=
              (mode === "spectral"
                ? values[i + 1]!
                : 0.2126729 * values[i]! +
                  0.7151522 * values[i + 1]! +
                  0.072175 * values[i + 2]!) / values[i + 3]!;
            count++;
          }
        readback.unmap();
        convergence.push({
          iterations: integrator.iterations,
          emittedPhotons: integrator.emittedPhotons,
          floorMeanY: sum / count,
          elapsedMs: performance.now() - started,
        });
      }
    }
    await device.queue.onSubmittedWorkDone();
    const completionMs = performance.now() - started;
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(accumulation, 0, readback, 0, accumulation.size);
    encoder.copyBufferToBuffer(errors, 0, readback, accumulation.size, 128);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const raw = readback.getMappedRange().slice(0);
    readback.unmap();
    const values = new Float32Array(raw, 0, width * height * 4),
      pixels: number[] = [],
      counts: number[] = [];
    for (let i = 0; i < width * height; i++) {
      counts.push(values[4 * i + 3]!);
      for (let c = 0; c < 3; c++)
        pixels.push(values[4 * i + c]! / values[4 * i + 3]!);
    }
    let filtered: number[] | undefined;
    if (options.denoise?.enabled) {
      denoiser = await Denoiser.create(device);
      denoiser.configure(image, gpu, camera, errors);
      const encoder = device.createCommandEncoder();
      const output = denoiser.encode(
        encoder,
        {...options.denoise, imageOnly: optics.active},
        mode === "spectral",
        true,
      );
      const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
      const filteredReadback = create(
        bytesPerRow * height + 4,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      );
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: filteredReadback, bytesPerRow },
        [width, height],
      );
      encoder.copyBufferToBuffer(
        errors,
        0,
        filteredReadback,
        bytesPerRow * height,
        4,
      );
      device.queue.submit([encoder.finish()]);
      await filteredReadback.mapAsync(GPUMapMode.READ);
      const data = filteredReadback.getMappedRange();
      const halves = new Uint16Array(data);
      const half = (n: number) => {
        const sign = n & 0x8000 ? -1 : 1,
          exponent = (n >> 10) & 31,
          fraction = n & 1023;
        return (
          sign *
          (exponent === 0
            ? fraction * 2 ** -24
            : exponent === 31
              ? fraction
                ? NaN
                : Infinity
              : (1 + fraction / 1024) * 2 ** (exponent - 15))
        );
      };
      filtered = [];
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          for (let c = 0; c < 3; c++)
            filtered.push(half(halves[(y * bytesPerRow) / 2 + x * 4 + c]!));
      const filterErrors = new Uint32Array(data, bytesPerRow * height, 1)[0]!;
      filteredReadback.unmap();
      if (filterErrors || filtered.some((v) => !Number.isFinite(v)))
        throw new Error("Denoiser acceptance failed");
    }
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    let debugPoint: unknown;
    if (options.debugPixel !== undefined) {
      const point = makeStructuredView(sppmDefinitions.structs.SppmPoint!);
      const pointReadback = create(point.arrayBuffer.byteLength, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const encoder = device.createCommandEncoder();
      const points = (integrator as unknown as { points: GPUBuffer }).points;
      encoder.copyBufferToBuffer(points, options.debugPixel * point.arrayBuffer.byteLength, pointReadback, 0, point.arrayBuffer.byteLength);
      device.queue.submit([encoder.finish()]); await pointReadback.mapAsync(GPUMapMode.READ);
      new Uint8Array(point.arrayBuffer).set(new Uint8Array(pointReadback.getMappedRange())); pointReadback.unmap();
      debugPoint = point.views;
    }
    return {
      gpuMs: timer ? gpuMs : null,
      completionMs,
      debugPoint,
      width,
      height,
      pixels,
      filtered,
      convergence,
      counts,
      errors: new Uint32Array(raw, accumulation.size, 1)[0]!,
      diagnostic: Array.from(new Uint32Array(raw, accumulation.size, 32)),
      emittedPhotons: integrator.emittedPhotons,
      adapter: name,
    };
  } finally {
    timer?.dispose();
    denoiser?.dispose();
    integrator?.dispose();
    image?.destroy();
    gpu?.dispose();
    buffers.forEach((buffer) => buffer.destroy());
    if (!options.gpu) device.destroy();
  }
}
