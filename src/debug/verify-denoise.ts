import filterSource from "../render/atrous.wgsl?raw";
import { checkedShader, createDevice } from "../gpu/device";
import { GpuTimer } from "../gpu/timer";
import { COMPUTE_READBACK_BYTES } from "../render/transport-diagnostics";

/** Small deterministic GPU fixtures, independent of transport noise. */
export async function verifyDenoise() {
  const { device, name } = await createDevice();
  const textures: GPUTexture[] = [], buffers: GPUBuffer[] = [];
  let timer: GpuTimer | undefined;
  try {
    device.pushErrorScope("validation");
    const width = 16, height = 8;
    const texture = (format: GPUTextureFormat, usage: GPUTextureUsageFlags) => {
      const value = device.createTexture({ size: [width, height], format, usage }); textures.push(value); return value;
    };
    const buffer = (size: number, usage: GPUBufferUsageFlags) => {
      const value = device.createBuffer({ size, usage }); buffers.push(value); return value;
    };
    const raw = texture("rgba32float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const guides = texture("rgba32float", GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const output = texture("rgba16float", GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    const uniform = buffer(64, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const readback = buffer(256 * height, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const timing = buffer(COMPUTE_READBACK_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    timer = device.features.has("timestamp-query") ? new GpuTimer(device) : undefined;
    const module = await checkedShader(device, filterSource, "Denoise fixture");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "filterMain" } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: raw.createView() }, { binding: 1, resource: raw.createView() },
      { binding: 2, resource: guides.createView() }, { binding: 3, resource: output.createView() },
      { binding: 4, resource: { buffer: uniform } },
    ] });
    const data = new Float32Array(width * height * 4), guideData = data.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      guideData.set([0, 0, 1, x < 8 ? -1 : 1], i);
    }
    device.queue.writeTexture({ texture: guides }, guideData, { bytesPerRow: width * 16 }, [width, height]);
    const rows: { algorithm: number; spectral: boolean; glassMode: number; gpuMs: number | null; completionMs: number }[] = [];
    let checks = 0;
    const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message); checks++; };
    for (const spectral of [false, true]) for (const algorithm of [0, 1, 2]) for (const glassMode of [0, 1, 2]) {
      // Dyadic values survive the output's half precision exactly.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const v = x < 8 ? .25 : 2;
        data.set([v, v / 2, v / 4, 1], (y * width + x) * 4);
      }
      device.queue.writeTexture({ texture: raw }, data, { bytesPerRow: width * 16 }, [width, height]);
      const params = new ArrayBuffer(64), view = new DataView(params);
      view.setUint32(0, 1, true); view.setFloat32(4, 2, true); view.setUint32(8, glassMode, true);
      view.setUint32(12, Number(spectral), true); view.setUint32(16, algorithm, true); view.setUint32(20, 3, true);
      view.setFloat32(24, 32, true); view.setFloat32(28, .015, true); view.setFloat32(32, 1, true);
      view.setFloat32(36, 1, true); view.setUint32(40, 1, true); view.setFloat32(48, .5, true);
      const run = async () => {
        device.queue.writeBuffer(uniform, 0, params);
        const encoder = device.createCommandEncoder(); timer?.begin(encoder);
        const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(2, 1); pass.end();
        timer?.end(encoder, timing);
        encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [width, height]);
        const started = performance.now(); device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const halves = new Uint16Array(readback.getMappedRange()).slice(); readback.unmap();
        let gpuMs: number | null = null;
        if (timer) { await timing.mapAsync(GPUMapMode.READ); gpuMs = timer.read(timing.getMappedRange()); timing.unmap(); }
        return { halves, gpuMs, completionMs: performance.now() - started };
      };
      const constant = await run();
      rows.push({ algorithm, spectral, glassMode, gpuMs: constant.gpuMs, completionMs: constant.completionMs });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const value = constant.halves[y * 128 + x * 4]!;
        assert(Math.abs(value - (x < 8 ? 0x3400 : 0x4000)) <= 1, `Constant color or glass silhouette changed: ${algorithm}/${spectral}/${glassMode} at ${x},${y}: ${value}`);
      }
      // Noise inside each side; glass bypass, blend=0, and split must preserve raw.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[(y * width + x) * 4] = (x < 8 ? .25 : 2) + ((x + y) % 2 ? .125 : 0);
      device.queue.writeTexture({ texture: raw }, data, { bytesPerRow: width * 16 }, [width, height]);
      const noisy = await run();
      const original = (x: number, y: number) => x < 8 ? ((x + y) % 2 ? 0x3600 : 0x3400) : ((x + y) % 2 ? 0x4040 : 0x4000);
      let changed = false;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const value = noisy.halves[y * 128 + x * 4]!;
        assert((value & 0x7c00) !== 0x7c00, "Nonfinite denoised output");
        if (glassMode === 0 && x < 8) assert(value === original(x, y), "Glass bypass changed raw");
        if (x >= 8 && value !== original(x, y)) changed = true;
      }
      assert(changed, "Filter did not reduce fixture noise");
      view.setUint32(44, 1, true);
      const split = await run();
      for (let y = 0; y < height; y++) for (let x = 0; x < 8; x++) assert(split.halves[y * 128 + x * 4] === original(x, y), "Split changed original half");
      view.setFloat32(36, 0, true); view.setUint32(44, 0, true);
      const bypass = await run();
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) assert(bypass.halves[y * 128 + x * 4] === original(x, y), "Zero blend changed original");
    }
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    return { adapter: name, width, height, checks, rows };
  } finally {
    timer?.dispose(); textures.forEach(t => t.destroy()); buffers.forEach(b => b.destroy()); device.destroy();
  }
}
