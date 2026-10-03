import { debugShader, pathShader, displayShader } from '../transport/shaders';
import { checkedShader, createDevice } from '../gpu/device';
import { fitRenderSize } from './size';
import { ScenePreparer } from '../assets/prepare';
import { definitions } from '../accel/pack';
import type { PreparedScene } from '../assets/prepare';
import type { CameraDescription, SceneDescription } from '../scene/types';
import { cameraBasis } from '../scene/camera';
import { makeStructuredView } from 'webgpu-utils';
import { GpuScene } from '../gpu/scene';
import { loadSobol } from '../assets/sobol';
import { xyzToLinearRgb } from '../transport/spectrum';
import { SppmIntegrator, SPPM_POINT_BYTES } from './sppm-integrator';

export type DebugView = 'normal' | 'depth' | 'bvh' | 'beauty';
export interface PathSettings { maxDepth: number; seed: number; strategy: 'mis' | 'light' | 'bsdf'; maxPixels: number; mode: 'rgb' | 'spectral'; integrator: 'pt'|'sppm'; photonsPerIteration: number; photonBatchSize: number; initialRadius: number }
export interface RenderCapture { width: number; height: number; linearRgb: Float32Array; linearXyz?: Float32Array; accumulationSpace: 'linear-srgb' | 'cie-xyz'; sampleCounts: Float32Array; samples: number; emittedPhotons: number; settings: PathSettings; camera: CameraDescription; exposure: number }

export interface RenderStats {
  adapter: string; width: number; height: number; frames: number; bytes: number;
  completionMs: number; status: 'ready' | 'paused' | 'recovering' | 'error';
  triangles: number; nodes: number;
  samples: number; tile: number; tiles: number;
  integrator: 'pt'|'sppm'; phase: string; emittedPhotons: number; batch: number;
}

/** RGB / spectral PT and SPPM with shared intersection debug views. */
export class IntersectionRenderer {
  private preparer = new ScenePreparer();
  private packed?: PreparedScene;
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
  private accumulation?: GPUBuffer;
  private sobol?: GPUBuffer;
  private pathPipeline?: GPUComputePipeline;
  private pathGroup?: GPUBindGroup;
  private sppm?: SppmIntegrator;
  private settings: PathSettings = { maxDepth: 8, seed: 1, strategy: 'mis', maxPixels: 640 * 480, mode: 'rgb', integrator:'pt', photonsPerIteration:16384, photonBatchSize:1024, initialRadius:0.03 };
  private needsClear = true;
  private tileIndex = 0;
  private samples = 0;
  private redrawSweep = false;
  private displayParameters = makeStructuredView(definitions.structs.DisplayParams!);
  private displayUniform?: GPUBuffer;
  private exposure = 0;
  private displayOnly = false;
  private activeFrame?: Promise<void>;
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
  private stats: RenderStats = { adapter: '', width: 0, height: 0, frames: 0, bytes: 0, completionMs: 0, status: 'recovering', triangles: 0, nodes: 0, samples: 0, tile: 0, tiles: 0, integrator:'pt',phase:'camera',emittedPhotons:0,batch:0 };

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
      if (this.settings.mode === 'spectral' && !packed.spectralReady) throw new Error('Spectral mode requires spectra for non-neutral RGB materials');
      // Allocate first so failed uploads leave the previous GPU scene usable.
      const scene = this.device ? new GpuScene(this.device, packed) : undefined;
      this.packed = packed;
      if (cameraRevision === this.cameraRevision) this.camera = camera;
      this.scene?.dispose(); this.scene = scene;
      this.stats.triangles = packed.triangleCount; this.stats.nodes = packed.nodeCount; this.stats.frames = 0;
      this.invalidate();
      this.updateGroups();
    } finally { if (sceneRevision === this.sceneRevision) { this.loading = false; this.schedule(true); } }
  }
  setCamera(camera: CameraDescription): void {
    cameraBasis(camera); this.camera = structuredClone(camera); this.cameraRevision++; this.invalidate(); this.schedule(true);
  }
  setDebugView(view: DebugView): void { this.view = { normal: 0, depth: 1, bvh: 2, beauty: 3 }[view]; this.invalidate(); this.schedule(true); }
  setSettings(settings: Partial<PathSettings>): void {
    const next = { ...this.settings, ...settings };
    if(!['pt','sppm'].includes(next.integrator)||!Number.isInteger(next.photonsPerIteration)||next.photonsPerIteration<1||next.photonsPerIteration>1048576||!Number.isInteger(next.photonBatchSize)||next.photonBatchSize<1||next.photonBatchSize>4096||!Number.isFinite(next.initialRadius)||next.initialRadius<0.0001||next.initialRadius>0.5) throw new Error('Invalid SPPM settings');
    if (!['rgb', 'spectral'].includes(next.mode) || (next.mode === 'spectral' && this.packed && !this.packed.spectralReady)) throw new Error('Spectral mode requires valid material spectra');
    if (!Number.isInteger(next.maxDepth) || next.maxDepth < 1 || next.maxDepth > 64 || !Number.isInteger(next.seed) || next.seed < 0 || next.seed > 0xffffffff || !['mis', 'light', 'bsdf'].includes(next.strategy) || !Number.isInteger(next.maxPixels) || next.maxPixels < 1 || next.maxPixels > 640 * 480) throw new Error('Invalid path tracing settings');
    if (Object.keys(next).every(key => next[key as keyof PathSettings] === this.settings[key as keyof PathSettings])) return;
    this.settings = next; this.invalidate(); this.resize(); this.updateGroups(); this.schedule(true);
  }
  setExposure(exposure: number): void {
    if (!Number.isFinite(exposure) || exposure < -16 || exposure > 16) throw new Error('Invalid exposure');
    const completeSweep = this.redrawSweep || this.needsClear;
    this.exposure = exposure; this.displayOnly = !this.needsClear; this.schedule(true); this.redrawSweep = completeSweep;
  }
  async capture(): Promise<RenderCapture> {
    await this.activeFrame;
    const { device, accumulation, revision } = this;
    if (!device || !accumulation || this.disposed || this.view !== 3 || this.needsClear) throw new Error('Linear capture requires a rendered image');
    if(this.settings.integrator==='sppm'&&this.samples===0) throw new Error('Wait for a completed SPPM iteration before capture');
    const width = this.stats.width, height = this.stats.height, samples = this.samples;
    const settings = { ...this.settings }, camera = structuredClone(this.camera!), exposure = this.exposure;
    const readback = device.createBuffer({ size: accumulation.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(accumulation,0,readback,0,accumulation.size); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      if (this.disposed || revision !== this.revision) throw new DOMException('Capture superseded', 'AbortError');
      const raw = new Float32Array(readback.getMappedRange());
      const linearRgb = new Float32Array(width * height * 3), sampleCounts = new Float32Array(width * height);
      const linearXyz = settings.mode === 'spectral' ? new Float32Array(width * height * 3) : undefined;
      for (let i=0;i<width*height;i++) {
        const count = raw[i*4+3]!; sampleCounts[i] = count;
        for (let channel=0;channel<3;channel++) linearRgb[i*3+channel] = count ? raw[i*4+channel]!/count : 0;
        if (linearXyz) {
          const xyz: [number,number,number] = [linearRgb[i*3]!,linearRgb[i*3+1]!,linearRgb[i*3+2]!];
          linearXyz.set(xyz,i*3); linearRgb.set(xyzToLinearRgb(xyz),i*3);
        }
      }
      readback.unmap(); return { width, height, linearRgb, linearXyz, accumulationSpace: linearXyz ? 'cie-xyz' : 'linear-srgb', sampleCounts, samples, emittedPhotons:settings.integrator==='sppm'?samples*settings.photonsPerIteration:0, settings, camera, exposure };
    } finally { readback.destroy(); }
  }
  private invalidate(): void { this.revision++; this.displayOnly = false; this.needsClear = true; this.samples = 0; this.tileIndex = 0; this.sppm?.reset(); this.stats.samples = 0; this.stats.frames = 0; this.stats.tile = 0;this.stats.integrator=this.settings.integrator;this.stats.phase='camera';this.stats.emittedPhotons=0;this.stats.batch=0; this.report({ ...this.stats }); }

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
      const [computeModule, pathModule, displayModule, sobolData] = await Promise.all([
        checkedShader(device, debugShader, 'BVH intersections'), checkedShader(device, pathShader, 'RGB / spectral path tracer'), checkedShader(device, displayShader, 'Display'), loadSobol(),
      ]);
      const [compute, pathPipeline, display, sppm] = await Promise.all([
        device.createComputePipelineAsync({ layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } }),
        device.createComputePipelineAsync({ layout: 'auto', compute: { module: pathModule, entryPoint: 'main' } }),
        device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: displayModule, entryPoint: 'vertexMain' }, fragment: { module: displayModule, entryPoint: 'fragmentMain', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
        SppmIntegrator.create(device),
      ]);
      if (this.disposed || generation !== this.generation) {sppm.dispose();return;}
      this.compute = compute;
      this.pathPipeline = pathPipeline;
      this.display = display;
      this.sppm = sppm;
      this.uniform = device.createBuffer({ label: 'Camera parameters', size: this.parameters.arrayBuffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.displayUniform = device.createBuffer({ label: 'Display parameters', size: this.displayParameters.arrayBuffer.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.scene = new GpuScene(device, this.packed);
      this.sobol = device.createBuffer({ label: 'Sobol directions', size: sobolData.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      new Uint8Array(this.sobol.getMappedRange()).set(new Uint8Array(sobolData)); this.sobol.unmap();
      this.diagnostic = device.createBuffer({ label: 'Traversal errors', size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.readback = device.createBuffer({ label: 'Traversal error readback', size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    } finally {
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
    }
    if (this.disposed || generation !== this.generation) return;
    this.stats.adapter = name;
    this.stats.frames = 0;
    this.invalidate();
    this.resize();
    this.stats.status = this.paused ? 'paused' : 'ready';
    this.report({ ...this.stats });
    this.schedule();
  }

  resize(): void {
    const device = this.device;
    if (!device || !this.compute || !this.display || !this.uniform || this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const perPixel=this.settings.integrator==='sppm'?SPPM_POINT_BYTES:16;
    const maxPixels = Math.min(this.settings.maxPixels, Math.floor(device.limits.maxStorageBufferBindingSize / perPixel), Math.floor(device.limits.maxBufferSize / perPixel));
    const size = fitRenderSize(Math.max(1, rect.width), Math.max(1, rect.height), window.devicePixelRatio || 1, maxPixels, device.limits.maxTextureDimension2D);
    if (this.texture && size.width === this.stats.width && size.height === this.stats.height) return;
    this.texture?.destroy();
    this.accumulation?.destroy();
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.texture = device.createTexture({ label: 'Linear image', size: [size.width, size.height], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.accumulation = device.createBuffer({ label: 'Raw f32 linear accumulation', size: size.width * size.height * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.stats.width = size.width;
    this.stats.height = size.height;
    this.updateGroups();
    this.invalidate();
    this.report({ ...this.stats });
    // Allow a resized canvas to redraw even when accumulation is paused.
    if (this.paused) this.schedule(true);
  }

  private updateGroups(): void {
    const { device, compute, display, texture, uniform, scene, diagnostic, displayUniform } = this;
    if (!device || !compute || !display || !texture || !uniform || !scene || !diagnostic || !displayUniform) return;
    const view = texture.createView();
    this.computeGroup = device.createBindGroup({ layout: compute.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }, ...scene.entries(), { binding: 4, resource: { buffer: diagnostic } }] });
    if (this.pathPipeline && this.sobol && this.accumulation) {
      this.pathGroup = device.createBindGroup({ layout: this.pathPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: uniform } }, ...scene.entries(), { binding: 4, resource: { buffer: diagnostic } }, ...scene.transportEntries(), { binding: 7, resource: { buffer: this.sobol } }, { binding: 8, resource: { buffer: this.accumulation } }, scene.spectralEntry()] });
    }
    this.displayGroup = device.createBindGroup({ layout: display.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: displayUniform } }] });
    if(this.sppm&&this.sobol&&this.accumulation) {
      if(this.settings.integrator==='sppm') this.sppm.configure(this.stats.width,this.stats.height,this.settings,{scene,camera:uniform,sobol:this.sobol,errors:diagnostic,accumulation:this.accumulation,texture});
      else this.sppm.releaseBuffers();
    }
    this.stats.bytes = this.stats.width * this.stats.height * 24 + this.parameters.arrayBuffer.byteLength + scene.bytes + 8 + (this.sobol?.size ?? 0) + displayUniform.size+(this.sppm?.bytes??0);
  }

  pause(): void { this.paused = true; this.redrawSweep = false; cancelAnimationFrame(this.raf); this.raf = 0; this.stats.status = 'paused'; this.report({ ...this.stats }); }
  resume(): void { if (this.disposed || this.stats.status === 'error') return; this.paused = false; this.stats.status = 'ready'; this.report({ ...this.stats }); this.schedule(); }

  private schedule(force = false): void {
    if (force) { this.redraw = true; this.redrawSweep = this.view === 3; }
    const partial=this.settings.integrator==='sppm'&&this.view===3?this.sppm?.inProgress:this.tileIndex>0;
    if (this.raf || this.busy || this.loading || this.disposed || this.stats.status === 'error' || (!this.redraw && this.paused && !(this.redrawSweep && partial)) || document.hidden || !this.texture) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.activeFrame = this.frame(); });
  }

  private async frame(): Promise<void> {
    const { device, context, compute, display, computeGroup, displayGroup, uniform, diagnostic, readback, camera } = this;
    if (!device || !context || !compute || !display || !computeGroup || !displayGroup || !uniform || !diagnostic || !readback || !camera || this.disposed || this.loading) return;
    const generation = this.generation;
    const revision = this.revision;
    const pathMode = this.view === 3;
    const sppmMode=pathMode&&this.settings.integrator==='sppm';
    const displayOnly = this.displayOnly;
    this.displayOnly = false;
    const started = performance.now();
    this.busy = true;
    this.redraw = false;
    try {
      const basis = cameraBasis(camera);
      const columns = Math.ceil(this.stats.width / 64), rows = Math.ceil(this.stats.height / 64);
      const tile = sppmMode?this.sppm!.tileRect():pathMode ? [this.tileIndex % columns * 64, Math.floor(this.tileIndex / columns) * 64, 64, 64] : [0, 0, this.stats.width, this.stats.height];
      this.parameters.set({ size: [this.stats.width, this.stats.height], frame: this.samples, view: this.view, eye: [...basis.eye, 0], forward: [...basis.forward, 0], right: [...basis.right, 0], up: [...basis.up, 0], tile, maxDepth: this.settings.maxDepth, seed: this.settings.seed, strategy: { mis: 0, light: 1, bsdf: 2 }[this.settings.strategy], lightCount: this.packed!.lightCount, transportMode: Number(this.settings.mode === 'spectral') });
      device.queue.writeBuffer(uniform, 0, this.parameters.arrayBuffer);
      this.displayParameters.set({ exposure: 2 ** this.exposure, debugView: Number(!pathMode), colorSpace: Number(pathMode && this.settings.mode === 'spectral') });
      device.queue.writeBuffer(this.displayUniform!,0,this.displayParameters.arrayBuffer);
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(diagnostic);
      if (this.needsClear) {
        if (this.accumulation) encoder.clearBuffer(this.accumulation);
        const clear = encoder.beginRenderPass({ colorAttachments: [{ view: this.texture!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }); clear.end();
        this.needsClear = false;
      }
      let iterationComplete=false;
      if(sppmMode&&!displayOnly) {iterationComplete=this.sppm!.encodeStep(encoder);}
      else if (!displayOnly) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(pathMode ? this.pathPipeline! : compute); computePass.setBindGroup(0, pathMode ? this.pathGroup! : computeGroup);
        computePass.dispatchWorkgroups(Math.ceil(tile[2]! / 8), Math.ceil(tile[3]! / 8)); computePass.end();
      }
      const renderPass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      renderPass.setPipeline(display); renderPass.setBindGroup(0, displayGroup); renderPass.draw(3); renderPass.end();
      encoder.copyBufferToBuffer(diagnostic, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const errors = new Uint32Array(readback.getMappedRange())[0]!;
      readback.unmap();
      if (generation !== this.generation || this.disposed) return;
      if (errors) throw new Error(`GPU transport failed for ${errors} operations (intersection, medium, hash or non-finite values).`);
      if (revision !== this.revision) return;
      if(sppmMode&&!displayOnly) {
        if(iterationComplete) {this.samples++;this.stats.frames++;this.redrawSweep=false;}
        this.stats.samples=this.samples;this.stats.tile=this.sppm!.tile;this.stats.tiles=this.sppm!.tiles;this.stats.phase=this.sppm!.phase;this.stats.batch=this.sppm!.batch;this.stats.emittedPhotons=this.sppm!.emittedPhotons;
      } else if (pathMode && !displayOnly) {
        this.tileIndex++;
        if (this.tileIndex === columns * rows) { this.tileIndex = 0; this.samples++; this.stats.frames++; this.redrawSweep = false; }
        this.stats.samples = this.samples; this.stats.tile = this.tileIndex; this.stats.tiles = columns * rows;
      } else if (!displayOnly) this.stats.frames++;
      this.stats.completionMs = performance.now() - started;
      this.report({ ...this.stats });
    } catch (error) { if (generation === this.generation && !this.disposed) this.fail(error); }
    finally { this.busy = false; if (this.stats.status !== 'error') this.schedule(); }
  }

  private fail(error: unknown): void { this.pause(); this.stats.status = 'error'; this.report({ ...this.stats }); this.error(error instanceof Error ? error : new Error(String(error))); }
  private release(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.sppm?.dispose();this.sppm=undefined;
    this.texture?.destroy(); this.uniform?.destroy(); this.scene?.dispose(); this.diagnostic?.destroy(); this.readback?.destroy(); this.context?.unconfigure(); this.device?.destroy();
    this.scene = undefined; this.diagnostic = undefined; this.readback = undefined;
    this.accumulation?.destroy(); this.sobol?.destroy(); this.accumulation = undefined; this.sobol = undefined; this.pathPipeline = undefined; this.pathGroup = undefined;
    this.displayUniform?.destroy(); this.displayUniform = undefined;
    this.texture = undefined; this.uniform = undefined; this.device = undefined;
    this.compute = undefined; this.display = undefined; this.computeGroup = undefined; this.displayGroup = undefined;
  }
  dispose(): void { this.disposed = true; this.generation++; this.preparer.dispose(); this.release(); }
}
