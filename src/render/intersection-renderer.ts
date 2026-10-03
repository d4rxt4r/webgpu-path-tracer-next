import { debugShader as computeCode } from '../transport/shaders';
import displayCode from './display.wgsl?raw';
import { checkedShader, createDevice } from '../gpu/device';
import { fitRenderSize } from './size';
import { ScenePreparer } from '../assets/prepare';
import { definitions } from '../accel/pack';
import type { PackedScene } from '../accel/pack';
import type { CameraDescription, SceneDescription } from '../scene/types';
import { cameraBasis } from '../scene/camera';
import { makeStructuredView } from 'webgpu-utils';
import { GpuScene } from '../gpu/scene';

export interface RenderStats {
  adapter: string; width: number; height: number; frames: number; bytes: number;
  completionMs: number; status: 'ready' | 'paused' | 'recovering' | 'error';
  triangles: number; nodes: number;
}

/** Scene intersection renderer; light transport is added in subsequent stages. */
export class IntersectionRenderer {
  private preparer = new ScenePreparer();
  private packed?: PackedScene;
  private scene?: GpuScene;
  private camera?: CameraDescription;
  private view = 0;
  private revision = 0;
  private sceneRevision = 0;
  private cameraRevision = 0;
  private loading = false;
  private diagnostic?: GPUBuffer;
  private readback?: GPUBuffer;
  private parameters = makeStructuredView(definitions.structs.CameraParams!);
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
  private stats: RenderStats = { adapter: '', width: 0, height: 0, frames: 0, bytes: 0, completionMs: 0, status: 'recovering', triangles: 0, nodes: 0 };

  constructor(private canvas: HTMLCanvasElement, private report: (stats: RenderStats) => void, private error: (error: Error) => void) {}

  async setScene(description: SceneDescription): Promise<void> {
    if (this.disposed) throw new Error('Renderer is disposed');
    const sceneRevision = ++this.sceneRevision;
    const cameraRevision = this.cameraRevision;
    this.preparer.cancel();
    this.revision++;
    this.loading = true;
    try {
      cameraBasis(description.camera);
      const camera = structuredClone(description.camera);
      const packed = await this.preparer.prepare(description);
      if (sceneRevision !== this.sceneRevision || this.disposed) return;
      // Allocate first so failed uploads leave the previous GPU scene usable.
      const scene = this.device ? new GpuScene(this.device, packed) : undefined;
      this.packed = packed;
      if (cameraRevision === this.cameraRevision) this.camera = camera;
      this.scene?.dispose(); this.scene = scene;
      this.stats.triangles = packed.triangleCount; this.stats.nodes = packed.nodeCount; this.stats.frames = 0;
      this.updateGroups();
    } finally { if (sceneRevision === this.sceneRevision) { this.loading = false; this.schedule(true); } }
  }
  setCamera(camera: CameraDescription): void {
    cameraBasis(camera); this.camera = structuredClone(camera); this.cameraRevision++; this.revision++; this.stats.frames = 0; this.schedule(true);
  }
  setDebugView(view: 'normal' | 'depth' | 'bvh'): void { this.view = { normal: 0, depth: 1, bvh: 2 }[view]; this.revision++; this.stats.frames = 0; this.schedule(true); }

  async initialize(): Promise<void> {
    if (!this.packed || !this.camera) throw new Error('Set a scene before initialization');
    const generation = ++this.generation;
    const { device, name } = await createDevice();
    if (this.disposed || generation !== this.generation) { device.destroy(); return; }
    this.device = device;
    device.addEventListener('uncapturederror', event => { if (!this.disposed && generation === this.generation) this.fail(new Error(event.error.message)); });
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
        checkedShader(device, computeCode, 'BVH intersections'), checkedShader(device, displayCode, 'Display'),
      ]);
      const [compute, display] = await Promise.all([
        device.createComputePipelineAsync({ layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } }),
        device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: displayModule, entryPoint: 'vertexMain' }, fragment: { module: displayModule, entryPoint: 'fragmentMain', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
      ]);
      if (this.disposed || generation !== this.generation) return;
      this.compute = compute;
      this.display = display;
      this.uniform = device.createBuffer({ label: 'Camera parameters', size: this.parameters.arrayBuffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.scene = new GpuScene(device, this.packed);
      this.diagnostic = device.createBuffer({ label: 'Traversal errors', size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.readback = device.createBuffer({ label: 'Traversal error readback', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
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
    this.stats.width = size.width;
    this.stats.height = size.height;
    this.updateGroups();
    this.stats.frames = 0; this.revision++;
    this.report({ ...this.stats });
    // Allow a resized canvas to redraw even when accumulation is paused.
    if (this.paused) this.schedule(true);
  }

  private updateGroups(): void {
    const { device, compute, display, texture, uniform, scene, diagnostic } = this;
    if (!device || !compute || !display || !texture || !uniform || !scene || !diagnostic) return;
    const view = texture.createView();
    this.computeGroup = device.createBindGroup({ layout: compute.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }, ...scene.entries(), { binding: 4, resource: { buffer: diagnostic } }] });
    this.displayGroup = device.createBindGroup({ layout: display.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] });
    this.stats.bytes = this.stats.width * this.stats.height * 8 + this.parameters.arrayBuffer.byteLength + scene.bytes + 8;
  }

  pause(): void { this.paused = true; cancelAnimationFrame(this.raf); this.raf = 0; this.stats.status = 'paused'; this.report({ ...this.stats }); }
  resume(): void { if (this.disposed || this.stats.status === 'error') return; this.paused = false; this.stats.status = 'ready'; this.report({ ...this.stats }); this.schedule(); }

  private schedule(force = false): void {
    if (force) this.redraw = true;
    if (this.raf || this.busy || this.loading || this.disposed || this.stats.status === 'error' || (!this.redraw && this.paused) || document.hidden || !this.texture) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; void this.frame(); });
  }

  private async frame(): Promise<void> {
    const { device, context, compute, display, computeGroup, displayGroup, uniform, diagnostic, readback, camera } = this;
    if (!device || !context || !compute || !display || !computeGroup || !displayGroup || !uniform || !diagnostic || !readback || !camera || this.disposed || this.loading) return;
    const generation = this.generation;
    const revision = this.revision;
    const started = performance.now();
    this.busy = true;
    this.redraw = false;
    try {
      const basis = cameraBasis(camera);
      this.parameters.set({ size: [this.stats.width, this.stats.height], frame: this.stats.frames, view: this.view, eye: [...basis.eye, 0], forward: [...basis.forward, 0], right: [...basis.right, 0], up: [...basis.up, 0] });
      device.queue.writeBuffer(uniform, 0, this.parameters.arrayBuffer);
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(diagnostic);
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(compute); computePass.setBindGroup(0, computeGroup);
      computePass.dispatchWorkgroups(Math.ceil(this.stats.width / 8), Math.ceil(this.stats.height / 8)); computePass.end();
      const renderPass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      renderPass.setPipeline(display); renderPass.setBindGroup(0, displayGroup); renderPass.draw(3); renderPass.end();
      encoder.copyBufferToBuffer(diagnostic, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const errors = new Uint32Array(readback.getMappedRange())[0]!;
      readback.unmap();
      if (generation !== this.generation || this.disposed) return;
      if (errors) throw new Error(`BVH traversal failed for ${errors} rays (range, stack or non-finite values).`);
      if (revision !== this.revision) return;
      this.stats.frames++;
      this.stats.completionMs = performance.now() - started;
      this.report({ ...this.stats });
    } catch (error) { if (generation === this.generation && !this.disposed) this.fail(error); }
    finally { this.busy = false; if (this.stats.status !== 'error') this.schedule(); }
  }

  private fail(error: unknown): void { this.pause(); this.stats.status = 'error'; this.report({ ...this.stats }); this.error(error instanceof Error ? error : new Error(String(error))); }
  private release(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.texture?.destroy(); this.uniform?.destroy(); this.scene?.dispose(); this.diagnostic?.destroy(); this.readback?.destroy(); this.context?.unconfigure(); this.device?.destroy();
    this.scene = undefined; this.diagnostic = undefined; this.readback = undefined;
    this.texture = undefined; this.uniform = undefined; this.device = undefined;
    this.compute = undefined; this.display = undefined; this.computeGroup = undefined; this.displayGroup = undefined;
  }
  dispose(): void { this.disposed = true; this.generation++; this.preparer.dispose(); this.release(); }
}
