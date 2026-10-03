import computeCode from '../transport/foundation.wgsl?raw';
import displayCode from './display.wgsl?raw';
import { checkedShader, createDevice } from '../gpu/device';
import { fitRenderSize } from './size';

export interface FoundationStats {
  adapter: string; width: number; height: number; frames: number; bytes: number;
  completionMs: number; status: 'ready' | 'paused' | 'recovering' | 'error';
}

/** Stage 1 compute-to-canvas harness. Not yet the scene Renderer contract. */
export class FoundationRenderer {
  private device?: GPUDevice;
  private context?: GPUCanvasContext;
  private compute?: GPUComputePipeline;
  private display?: GPURenderPipeline;
  private uniform?: GPUBuffer;
  private texture?: GPUTexture;
  private computeGroup?: GPUBindGroup;
  private displayGroup?: GPUBindGroup;
  private generation = 0;
  private raf = 0;
  private busy = false;
  private redraw = false;
  private paused = false;
  private disposed = false;
  private stats: FoundationStats = { adapter: '', width: 0, height: 0, frames: 0, bytes: 0, completionMs: 0, status: 'recovering' };

  constructor(private canvas: HTMLCanvasElement, private report: (stats: FoundationStats) => void, private error: (error: Error) => void) {}

  async initialize(): Promise<void> {
    const generation = ++this.generation;
    const { device, name } = await createDevice();
    if (this.disposed || generation !== this.generation) { device.destroy(); return; }
    this.device = device;
    device.addEventListener('uncapturederror', event => this.fail(new Error(event.error.message)));
    void device.lost.then(async info => {
      if (this.disposed || generation !== this.generation || info.reason === 'destroyed') return;
      this.stats.status = 'recovering';
      this.report({ ...this.stats });
      this.release();
      try { await this.initialize(); } catch (error) { this.fail(error); }
    });
    const context = this.canvas.getContext('webgpu');
    if (!context) throw new Error('Не удалось создать WebGPU canvas context.');
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    device.pushErrorScope('validation');
    try {
      const [computeModule, displayModule] = await Promise.all([
        checkedShader(device, computeCode, 'Foundation compute'), checkedShader(device, displayCode, 'Display'),
      ]);
      const [compute, display] = await Promise.all([
        device.createComputePipelineAsync({ layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } }),
        device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: displayModule, entryPoint: 'vertexMain' }, fragment: { module: displayModule, entryPoint: 'fragmentMain', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
      ]);
      if (this.disposed || generation !== this.generation) return;
      this.compute = compute;
      this.display = display;
      this.uniform = device.createBuffer({ label: 'Frame parameters', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    } finally {
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
    }
    if (this.disposed || generation !== this.generation) return;
    this.stats.adapter = name;
    this.stats.frames = 0;
    this.resize();
    this.stats.status = this.paused ? 'paused' : 'ready';
    this.report({ ...this.stats });
    this.schedule();
  }

  resize(): void {
    const device = this.device;
    if (!device || !this.compute || !this.display || !this.uniform || this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const size = fitRenderSize(Math.max(1, rect.width), Math.max(1, rect.height), window.devicePixelRatio || 1, 640 * 480, device.limits.maxTextureDimension2D);
    if (this.texture && size.width === this.stats.width && size.height === this.stats.height) return;
    this.texture?.destroy();
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.texture = device.createTexture({ label: 'Linear diagnostic image', size: [size.width, size.height], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const view = this.texture.createView();
    this.computeGroup = device.createBindGroup({ layout: this.compute.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: this.uniform } }] });
    this.displayGroup = device.createBindGroup({ layout: this.display.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] });
    this.stats.width = size.width;
    this.stats.height = size.height;
    this.stats.bytes = size.width * size.height * 8 + 16;
    this.report({ ...this.stats });
    // Allow a resized canvas to redraw even when accumulation is paused.
    if (this.paused) this.schedule(true);
  }

  pause(): void { this.paused = true; cancelAnimationFrame(this.raf); this.raf = 0; this.stats.status = 'paused'; this.report({ ...this.stats }); }
  resume(): void { if (this.disposed || this.stats.status === 'error') return; this.paused = false; this.stats.status = 'ready'; this.report({ ...this.stats }); this.schedule(); }

  private schedule(force = false): void {
    if (force) this.redraw = true;
    if (this.raf || this.busy || this.disposed || (!this.redraw && this.paused) || document.hidden || !this.texture) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; void this.frame(); });
  }

  private async frame(): Promise<void> {
    const { device, context, compute, display, computeGroup, displayGroup, uniform } = this;
    if (!device || !context || !compute || !display || !computeGroup || !displayGroup || !uniform || this.disposed) return;
    const generation = this.generation;
    const started = performance.now();
    this.busy = true;
    this.redraw = false;
    try {
      device.queue.writeBuffer(uniform, 0, new Uint32Array([this.stats.width, this.stats.height, this.stats.frames, 0]));
      const encoder = device.createCommandEncoder();
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(compute); computePass.setBindGroup(0, computeGroup);
      computePass.dispatchWorkgroups(Math.ceil(this.stats.width / 8), Math.ceil(this.stats.height / 8)); computePass.end();
      const renderPass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      renderPass.setPipeline(display); renderPass.setBindGroup(0, displayGroup); renderPass.draw(3); renderPass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (generation !== this.generation || this.disposed) return;
      this.stats.frames++;
      this.stats.completionMs = performance.now() - started;
      this.report({ ...this.stats });
    } catch (error) { if (generation === this.generation && !this.disposed) this.fail(error); }
    finally { this.busy = false; if (this.stats.status !== 'error') this.schedule(); }
  }

  private fail(error: unknown): void { this.pause(); this.stats.status = 'error'; this.report({ ...this.stats }); this.error(error instanceof Error ? error : new Error(String(error))); }
  private release(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.texture?.destroy(); this.uniform?.destroy(); this.context?.unconfigure(); this.device?.destroy();
    this.texture = undefined; this.uniform = undefined; this.device = undefined;
    this.compute = undefined; this.display = undefined; this.computeGroup = undefined; this.displayGroup = undefined;
  }
  dispose(): void { this.disposed = true; this.generation++; this.release(); }
}
