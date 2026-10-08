import { IntersectionRenderer, type RenderStats } from "../render/intersection-renderer";
import { Denoiser, type DenoiseSettings } from "../render/denoiser";
import { cornellScene } from "../scene/cornell";
import { xyzToLinearRgb } from "../transport/spectrum";
import { GpuTimer } from "../gpu/timer";
import { COMPUTE_READBACK_BYTES } from "../render/transport-diagnostics";
import type { GpuScene } from "../gpu/scene";

/** Same accumulated input for every filter; reference uses the same integrator. */
export async function compareDenoise(options: {
  mode: "rgb" | "spectral"; integrator: "pt" | "sppm"; roughness: number; dispersion?: boolean;
  low?: number; reference?: number; progress?: (message: string) => void;
}) {
  const low = options.low ?? 4, referenceSamples = options.reference ?? 32;
  const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 120;
  document.body.append(canvas);
  let stats: RenderStats | undefined, stopAt = low, stopped = false;
  const errors: string[] = [];
  const renderer = new IntersectionRenderer(canvas, info => {
    stats = info;
    if (!stopped && info.samples >= stopAt) { stopped = true; renderer.pause(); }
  }, error => errors.push(error.message));
  let denoiser: Denoiser | undefined, timer: GpuTimer | undefined;
  const buffers: GPUBuffer[] = [];
  const wait = async (condition: () => boolean) => {
    const start = performance.now();
    while (!condition()) {
      if (errors.length) throw new Error(errors.join("; "));
      if (performance.now() - start > 120000) throw new Error("Denoise comparison stalled: " + JSON.stringify(stats));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    const scene = cornellScene(options.dispersion ? "nbk7" : "glass");
    const glass = scene.materials[4]!;
    if (glass.type !== "dielectric") throw new Error("Expected dielectric fixture");
    glass.roughness = options.roughness;
    renderer.setSettings({ maxPixels: 19200, mode: options.mode, integrator: options.integrator,
      maxDepth: 12, seed: 17, photonsPerIteration: 4096, photonBatchSize: 1024 });
    renderer.setDebugView("beauty");
    await renderer.setScene(scene); await renderer.initialize();
    options.progress?.("low accumulation"); await wait(() => stopped);
    const input = await renderer.capture();
    const internal = renderer as unknown as { device: GPUDevice; complete: GPUTexture; scene: GpuScene; uniform: GPUBuffer; diagnostic: GPUBuffer };
    const { device } = internal;
    device.pushErrorScope("validation");
    denoiser = await Denoiser.create(device);
    denoiser.configure(internal.complete, internal.scene, internal.uniform, internal.diagnostic);
    timer = device.features.has("timestamp-query") ? new GpuTimer(device) : undefined;
    const stride = Math.ceil(input.width * 8 / 256) * 256;
    const readback = device.createBuffer({ size: stride * input.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); buffers.push(readback);
    const timing = device.createBuffer({ size: COMPUTE_READBACK_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); buffers.push(timing);
    const half = (n: number) => {
      const exponent = (n >> 10) & 31, fraction = n & 1023;
      return (n & 0x8000 ? -1 : 1) * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? Infinity : (1 + fraction / 1024) * 2 ** (exponent - 15));
    };
    const captures: { name: string; rgb: Float32Array; gpuMs: number | null; completionMs: number }[] = [
      { name: "raw", rgb: input.linearRgb, gpuMs: null, completionMs: 0 },
    ];
    let refreshGuides = true;
    for (const algorithm of ["atrous", "bilateral", "nlm"] as const) for (const glassMode of ["off", "surface", "image"] as const) {
      const settings: DenoiseSettings = { enabled: true, passes: 3, strength: 2, filterGlass: glassMode !== "off",
        algorithm, glassMode, glassStrength: 1, radius: algorithm === "nlm" ? 3 : 2 };
      options.progress?.(`${algorithm}/${glassMode}`);
      // One warmup per setting; measured filtering excludes guide generation.
      let result: Float32Array = new Float32Array(), gpuMs: number | null = null, completionMs = 0;
      for (let round = 0; round < 2; round++) {
        const encoder = device.createCommandEncoder(); timer?.begin(encoder);
        const output = denoiser.encode(encoder, settings, options.mode === "spectral", refreshGuides);
        refreshGuides = false; timer?.end(encoder, timing);
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: stride }, [input.width, input.height]);
        const start = performance.now(); device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
        const halves = new Uint16Array(readback.getMappedRange());
        result = new Float32Array(input.width * input.height * 3);
        for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
          const i = y * stride / 2 + x * 4;
          const c: [number, number, number] = [half(halves[i]!), half(halves[i + 1]!), half(halves[i + 2]!)];
          result.set(options.mode === "spectral" ? xyzToLinearRgb(c) : c, (y * input.width + x) * 3);
        }
        readback.unmap();
        if (timer) { await timing.mapAsync(GPUMapMode.READ); gpuMs = timer.read(timing.getMappedRange()); timing.unmap(); }
        completionMs = performance.now() - start;
      }
      if (result.some(v => !Number.isFinite(v))) throw new Error("Nonfinite filter output");
      captures.push({ name: `${algorithm}-${glassMode}`, rgb: result, gpuMs, completionMs });
    }
    const after = await renderer.capture();
    const rawPreserved = input.samples === after.samples && input.linearRgb.every((v, i) => v === after.linearRgb[i]);
    if (!rawPreserved) throw new Error("Filtering changed raw accumulation");
    const validation = await device.popErrorScope(); if (validation) throw new Error(validation.message);
    options.progress?.("reference accumulation"); stopAt = referenceSamples; stopped = false; renderer.resume(); await wait(() => stopped);
    const reference = await renderer.capture();
    const png = (rgb: Float32Array) => {
      const target = document.createElement("canvas"); target.width = input.width; target.height = input.height;
      const ctx = target.getContext("2d")!, image = ctx.createImageData(target.width, target.height);
      for (let i = 0; i < rgb.length / 3; i++) {
        for (let c = 0; c < 3; c++) {
          const linear = Math.max(0, rgb[i * 3 + c]!), mapped = linear / (1 + linear);
          image.data[i * 4 + c] = Math.round(255 * (mapped <= .0031308 ? 12.92 * mapped : 1.055 * mapped ** (1 / 2.4) - .055));
        }
        image.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(image, 0, 0); return target;
    };
    const all = [...captures, { name: "reference", rgb: reference.linearRgb, gpuMs: null, completionMs: 0 }];
    const sheet = document.createElement("canvas"); sheet.width = 4 * input.width; sheet.height = 3 * (input.height + 22);
    const ctx = sheet.getContext("2d")!; ctx.fillStyle = "#171923"; ctx.fillRect(0, 0, sheet.width, sheet.height);
    const rows = all.map((capture, index) => {
      const image = png(capture.rgb), x = index % 4 * input.width, y = Math.floor(index / 4) * (input.height + 22);
      ctx.drawImage(image, x, y + 22); ctx.fillStyle = "white"; ctx.font = "12px sans-serif"; ctx.fillText(capture.name, x + 4, y + 15);
      let mse = 0, glassMse = 0, glassCount = 0;
      for (let i = 0; i < capture.rgb.length; i++) {
        const delta = capture.rgb[i]! - reference.linearRgb[i]!; mse += delta * delta;
        const pixel = Math.floor(i / 3), px = pixel % input.width, py = Math.floor(pixel / input.width);
        if (px > input.width * .42 && px < input.width * .58 && py > input.height * .52 && py < input.height * .78) { glassMse += delta * delta; glassCount++; }
      }
      return { name: capture.name, gpuMs: capture.gpuMs, completionMs: capture.completionMs,
        mse: mse / capture.rgb.length, centralGlassMse: glassMse / glassCount, png: image.toDataURL() };
    });
    return { options, adapter: stats!.adapter, width: input.width, height: input.height, rawPreserved,
      samples: input.samples, referenceSamples: reference.samples, denoiserBytes: denoiser.bytes, scene,
      rows, contactSheet: sheet.toDataURL(), errors };
  } finally { timer?.dispose(); buffers.forEach(b => b.destroy()); denoiser?.dispose(); renderer.dispose(); canvas.remove(); }
}
