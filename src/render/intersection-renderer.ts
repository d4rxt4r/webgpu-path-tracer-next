import { debugShader, pathShader, displayShader } from "../transport/shaders";
import { checkedShader, createDevice } from "../gpu/device";
import { GpuTimer } from "../gpu/timer";
import { fitRenderSize } from "./size";
import { ScenePreparer } from "../assets/prepare";
import { definitions } from "../accel/pack";
import type { PreparedScene } from "../assets/prepare";
import type { CameraDescription, SceneDescription } from "../scene/types";
import { cameraBasis } from "../scene/camera";
import { makeStructuredView } from "webgpu-utils";
import { GpuScene } from "../gpu/scene";
import { loadSobol } from "../assets/sobol";
import { xyzToLinearRgb } from "../transport/spectrum";
import { Denoiser } from "./denoiser";
import type { DenoiseSettings } from "./denoiser";
import { SppmIntegrator, SPPM_POINT_BYTES } from "./sppm-integrator";

export type DebugView =
  | "normal"
  | "depth"
  | "bvh"
  | "beauty"
  | "material"
  | "wavelength"
  | "path-length"
  | "photon-density";
export interface PathSettings {
  maxDepth: number;
  seed: number;
  strategy: "mis" | "light" | "bsdf";
  maxPixels: number;
  mode: "rgb" | "spectral";
  integrator: "pt" | "sppm";
  photonsPerIteration: number;
  photonBatchSize: number;
  initialRadius: number;
  memoryBudgetMiB: number;
}
export interface RenderCapture {
  width: number;
  height: number;
  linearRgb: Float32Array;
  linearXyz?: Float32Array;
  accumulationSpace: "linear-srgb" | "cie-xyz";
  sampleCounts: Float32Array;
  samples: number;
  emittedPhotons: number;
  settings: PathSettings;
  camera: CameraDescription;
  exposure: number;
}

export interface RenderStats {
  adapter: string;
  width: number;
  height: number;
  frames: number;
  bytes: number;
  completionMs: number;
  gpuMs?: number;
  revision: number;
  presentedRevision: number;
  status: "ready" | "paused" | "recovering" | "error";
  triangles: number;
  nodes: number;
  samples: number;
  tile: number;
  tiles: number;
  integrator: "pt" | "sppm";
  phase: string;
  emittedPhotons: number;
  batch: number;
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
  private settings: PathSettings = {
    maxDepth: 8,
    seed: 1,
    strategy: "mis",
    maxPixels: 640 * 480,
    mode: "rgb",
    integrator: "pt",
    photonsPerIteration: 16384,
    photonBatchSize: 1024,
    initialRadius: 0.03,
    memoryBudgetMiB: 192,
  };
  private needsClear = true;
  private tileIndex = 0;
  private samples = 0;
  private redrawSweep = false;
  private displayParameters = makeStructuredView(
    definitions.structs.DisplayParams!,
  );
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
  private front?: GPUTexture;
  private complete?: GPUTexture;
  private denoiser?: Denoiser;
  private denoise: DenoiseSettings = {
    enabled: false,
    passes: 3,
    strength: 2,
    filterGlass: false,
  };
  private guidesDirty = true;
  private presentedRevision = -1;
  private presentedColorSpace = 0;
  private presentedDebug = 0;
  private toneMapper = 0;
  private interacting = false;
  private pngPipeline?: GPURenderPipeline;
  private timer?: GpuTimer;
  private photonDensity = false;
  private densityTexture?: GPUTexture;
  private computeGroup?: GPUBindGroup;
  private displayGroup?: GPUBindGroup;
  private generation = 0;
  private raf = 0;
  private busy = false;
  private redraw = false;
  private paused = false;
  private disposed = false;
  private stats: RenderStats = {
    adapter: "",
    width: 0,
    height: 0,
    frames: 0,
    bytes: 0,
    completionMs: 0,
    revision: 0,
    presentedRevision: -1,
    status: "recovering",
    triangles: 0,
    nodes: 0,
    samples: 0,
    tile: 0,
    tiles: 0,
    integrator: "pt",
    phase: "camera",
    emittedPhotons: 0,
    batch: 0,
  };

  constructor(
    private canvas: HTMLCanvasElement,
    private report: (stats: RenderStats) => void,
    private error: (error: Error) => void,
  ) {}

  async setScene(description: SceneDescription): Promise<void> {
    if (this.disposed) throw new Error("Renderer is disposed");
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
      if (this.settings.mode === "spectral" && !packed.spectralReady)
        throw new Error(
          "Spectral mode requires spectra for non-neutral RGB materials",
        );
      // Allocate first so failed uploads leave the previous GPU scene usable.
      const scene = this.device ? new GpuScene(this.device, packed) : undefined;
      this.packed = packed;
      if (cameraRevision === this.cameraRevision) this.camera = camera;
      this.scene?.dispose();
      this.scene = scene;
      this.stats.triangles = packed.triangleCount;
      this.stats.nodes = packed.nodeCount;
      this.stats.frames = 0;
      this.invalidate();
      this.updateGroups();
    } finally {
      if (sceneRevision === this.sceneRevision) {
        this.loading = false;
        this.schedule(true);
      }
    }
  }
  setCamera(camera: CameraDescription): void {
    cameraBasis(camera);
    this.camera = structuredClone(camera);
    this.cameraRevision++;
    this.invalidate();
    this.schedule(true);
  }
  setDebugView(view: DebugView): void {
    if (view === "photon-density") {
      if (this.settings.integrator !== "sppm")
        throw new Error("Photon density requires SPPM");
      if (this.view !== 3) {
        this.view = 3;
        this.invalidate();
      }
      this.photonDensity = true;
      this.displayOnly = !this.needsClear;
      this.schedule(true);
      return;
    }
    if (this.photonDensity && view === "beauty") {
      this.photonDensity = false;
      this.displayOnly = !this.needsClear;
      this.schedule(true);
      return;
    }
    this.photonDensity = false;
    this.view = {
      normal: 0,
      depth: 1,
      bvh: 2,
      beauty: 3,
      material: 4,
      wavelength: 5,
      "path-length": 6,
    }[view];
    this.invalidate();
    this.schedule(true);
  }
  setSettings(settings: Partial<PathSettings>): void {
    const next = { ...this.settings, ...settings };
    if (
      !["pt", "sppm"].includes(next.integrator) ||
      !Number.isInteger(next.photonsPerIteration) ||
      next.photonsPerIteration < 1 ||
      next.photonsPerIteration > 1048576 ||
      !Number.isInteger(next.photonBatchSize) ||
      next.photonBatchSize < 1 ||
      next.photonBatchSize > 4096 ||
      !Number.isFinite(next.initialRadius) ||
      next.initialRadius < 0.0001 ||
      next.initialRadius > 0.5
    )
      throw new Error("Invalid SPPM settings");
    if (
      !["rgb", "spectral"].includes(next.mode) ||
      (next.mode === "spectral" && this.packed && !this.packed.spectralReady)
    )
      throw new Error("Spectral mode requires valid material spectra");
    if (
      !Number.isInteger(next.maxDepth) ||
      next.maxDepth < 1 ||
      next.maxDepth > 64 ||
      !Number.isInteger(next.seed) ||
      next.seed < 0 ||
      next.seed > 0xffffffff ||
      !["mis", "light", "bsdf"].includes(next.strategy) ||
      !Number.isInteger(next.maxPixels) ||
      next.maxPixels < 1 ||
      next.maxPixels > 1920 * 1080 ||
      !Number.isFinite(next.memoryBudgetMiB) ||
      next.memoryBudgetMiB < 64 ||
      next.memoryBudgetMiB > 384
    )
      throw new Error("Invalid path tracing settings");
    if (
      Object.keys(next).every(
        (key) =>
          next[key as keyof PathSettings] ===
          this.settings[key as keyof PathSettings],
      )
    )
      return;
    this.settings = next;
    if (next.integrator !== "sppm") this.photonDensity = false;
    this.invalidate();
    this.resize();
    this.updateGroups();
    this.schedule(true);
  }
  setExposure(exposure: number): void {
    if (!Number.isFinite(exposure) || exposure < -16 || exposure > 16)
      throw new Error("Invalid exposure");
    const completeSweep = this.redrawSweep || this.needsClear;
    this.exposure = exposure;
    this.displayOnly = !this.needsClear;
    this.schedule(true);
    this.redrawSweep = completeSweep;
  }
  setInteracting(value: boolean): void {
    this.interacting = value;
  }
  setDisplay(
    settings: Partial<DenoiseSettings> & {
      toneMapper?: "reinhard" | "aces" | "linear";
    },
  ): void {
    const { toneMapper, ...filter } = settings;
    const next = { ...this.denoise, ...filter };
    if (
      !Number.isInteger(next.passes) ||
      next.passes < 1 ||
      next.passes > 5 ||
      !Number.isFinite(next.strength) ||
      next.strength < 0.1 ||
      next.strength > 10
    )
      throw new Error("Invalid denoiser settings");
    if (toneMapper !== undefined) {
      if (!["reinhard", "aces", "linear"].includes(toneMapper))
        throw new Error("Invalid tone mapper");
      this.toneMapper = { reinhard: 0, aces: 1, linear: 2 }[toneMapper];
    }
    this.denoise = next;
    this.displayOnly = !this.needsClear;
    this.schedule(true);
  }
  async capture(): Promise<RenderCapture> {
    await this.activeFrame;
    const { device, accumulation, revision } = this;
    if (
      !device ||
      !accumulation ||
      this.disposed ||
      this.loading ||
      this.view !== 3 ||
      this.needsClear
    )
      throw new Error("Linear capture requires a rendered image");
    if (this.settings.integrator === "sppm" && this.samples === 0)
      throw new Error("Wait for a completed SPPM iteration before capture");
    const width = this.stats.width,
      height = this.stats.height,
      samples = this.samples;
    const settings = { ...this.settings },
      camera = structuredClone(this.camera!),
      exposure = this.exposure;
    const readback = device.createBuffer({
      size: accumulation.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(
        accumulation,
        0,
        readback,
        0,
        accumulation.size,
      );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      if (this.disposed || revision !== this.revision)
        throw new DOMException("Capture superseded", "AbortError");
      const raw = new Float32Array(readback.getMappedRange());
      const linearRgb = new Float32Array(width * height * 3),
        sampleCounts = new Float32Array(width * height);
      const linearXyz =
        settings.mode === "spectral"
          ? new Float32Array(width * height * 3)
          : undefined;
      for (let i = 0; i < width * height; i++) {
        const count = raw[i * 4 + 3]!;
        sampleCounts[i] = count;
        for (let channel = 0; channel < 3; channel++)
          linearRgb[i * 3 + channel] = count
            ? raw[i * 4 + channel]! / count
            : 0;
        if (linearXyz) {
          const xyz: [number, number, number] = [
            linearRgb[i * 3]!,
            linearRgb[i * 3 + 1]!,
            linearRgb[i * 3 + 2]!,
          ];
          linearXyz.set(xyz, i * 3);
          linearRgb.set(xyzToLinearRgb(xyz), i * 3);
        }
      }
      readback.unmap();
      return {
        width,
        height,
        linearRgb,
        linearXyz,
        accumulationSpace: linearXyz ? "cie-xyz" : "linear-srgb",
        sampleCounts,
        samples,
        emittedPhotons:
          settings.integrator === "sppm"
            ? samples * settings.photonsPerIteration
            : 0,
        settings,
        camera,
        exposure,
      };
    } finally {
      readback.destroy();
    }
  }
  private invalidate(): void {
    this.revision++;
    this.stats.revision = this.revision;
    this.guidesDirty = true;
    this.displayOnly = false;
    this.needsClear = true;
    this.samples = 0;
    this.tileIndex = 0;
    this.sppm?.reset();
    this.stats.samples = 0;
    this.stats.frames = 0;
    this.stats.tile = 0;
    this.stats.integrator = this.settings.integrator;
    this.stats.phase = "camera";
    this.stats.emittedPhotons = 0;
    this.stats.batch = 0;
    this.report({ ...this.stats });
  }

  async initialize(): Promise<void> {
    if (!this.packed || !this.camera)
      throw new Error("Set a scene before initialization");
    const generation = ++this.generation;
    const { device, name } = await createDevice();
    if (this.disposed || generation !== this.generation) {
      device.destroy();
      return;
    }
    this.device = device;
    this.timer = device.features.has("timestamp-query")
      ? new GpuTimer(device)
      : undefined;
    device.addEventListener("uncapturederror", (event) => {
      if (!this.disposed && generation === this.generation)
        this.fail(new Error(event.error.message));
    });
    void device.lost.then(async (info) => {
      if (
        this.disposed ||
        generation !== this.generation ||
        info.reason === "destroyed"
      )
        return;
      this.stats.status = "recovering";
      this.report({ ...this.stats });
      this.release();
      try {
        await this.initialize();
      } catch (error) {
        this.fail(error);
      }
    });
    const context = this.canvas.getContext("webgpu");
    if (!context) throw new Error("Не удалось создать WebGPU canvas context.");
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    device.pushErrorScope("validation");
    try {
      const [computeModule, pathModule, displayModule, sobolData] =
        await Promise.all([
          checkedShader(device, debugShader, "BVH intersections"),
          checkedShader(device, pathShader, "RGB / spectral path tracer"),
          checkedShader(device, displayShader, "Display"),
          loadSobol(),
        ]);
      const [compute, pathPipeline, display, sppm, denoiser, pngPipeline] =
        await Promise.all([
          device.createComputePipelineAsync({
            layout: "auto",
            compute: { module: computeModule, entryPoint: "main" },
          }),
          device.createComputePipelineAsync({
            layout: "auto",
            compute: { module: pathModule, entryPoint: "main" },
          }),
          device.createRenderPipelineAsync({
            layout: "auto",
            vertex: { module: displayModule, entryPoint: "vertexMain" },
            fragment: {
              module: displayModule,
              entryPoint: "fragmentMain",
              targets: [{ format }],
            },
            primitive: { topology: "triangle-list" },
          }),
          SppmIntegrator.create(device),
          Denoiser.create(device),
          device.createRenderPipelineAsync({
            layout: "auto",
            vertex: { module: displayModule, entryPoint: "vertexMain" },
            fragment: {
              module: displayModule,
              entryPoint: "fragmentMain",
              targets: [{ format: "rgba8unorm" }],
            },
            primitive: { topology: "triangle-list" },
          }),
        ]);
      if (this.disposed || generation !== this.generation) {
        sppm.dispose();
        denoiser.dispose();
        return;
      }
      this.compute = compute;
      this.pathPipeline = pathPipeline;
      this.display = display;
      this.sppm = sppm;
      this.denoiser = denoiser;
      this.pngPipeline = pngPipeline;
      this.uniform = device.createBuffer({
        label: "Camera parameters",
        size: this.parameters.arrayBuffer.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.displayUniform = device.createBuffer({
        label: "Display parameters",
        size: this.displayParameters.arrayBuffer.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.scene = new GpuScene(device, this.packed);
      this.sobol = device.createBuffer({
        label: "Sobol directions",
        size: sobolData.byteLength,
        usage: GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      new Uint8Array(this.sobol.getMappedRange()).set(
        new Uint8Array(sobolData),
      );
      this.sobol.unmap();
      this.diagnostic = device.createBuffer({
        label: "Traversal errors",
        size: 4,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      this.readback = device.createBuffer({
        label: "Traversal error readback",
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    } finally {
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
    }
    if (this.disposed || generation !== this.generation) return;
    this.stats.adapter = name;
    this.stats.frames = 0;
    this.invalidate();
    this.resize();
    this.stats.status = this.paused ? "paused" : "ready";
    this.report({ ...this.stats });
    this.schedule();
  }

  resize(): void {
    const device = this.device;
    if (
      !device ||
      !this.compute ||
      !this.display ||
      !this.uniform ||
      this.disposed
    )
      return;
    const rect = this.canvas.getBoundingClientRect();
    const perPixel =
      80 + (this.settings.integrator === "sppm" ? SPPM_POINT_BYTES : 0);
    const slots = this.settings.photonBatchSize * (this.settings.maxDepth + 1);
    const fixed =
      (this.scene?.bytes ?? 0) +
      (this.sobol?.size ?? 0) +
      (this.front ? this.front.width * this.front.height * 8 : 0) +
      1024 +
      (this.settings.integrator === "sppm"
        ? slots * 64 + 2 ** Math.ceil(Math.log2(slots * 2)) * 4
        : 0);
    const available = this.settings.memoryBudgetMiB * 1048576 - fixed;
    if (available < perPixel)
      throw new Error("Scene and photon batch exceed the memory budget");
    const largestPlane =
      this.settings.integrator === "sppm" ? SPPM_POINT_BYTES : 16;
    const maxPixels = Math.min(
      this.settings.maxPixels,
      Math.floor(available / perPixel),
      Math.floor(device.limits.maxStorageBufferBindingSize / largestPlane),
      Math.floor(device.limits.maxBufferSize / largestPlane),
    );
    const size = fitRenderSize(
      Math.max(1, rect.width),
      Math.max(1, rect.height),
      window.devicePixelRatio || 1,
      maxPixels,
      device.limits.maxTextureDimension2D,
    );
    if (
      this.texture &&
      size.width === this.stats.width &&
      size.height === this.stats.height
    )
      return;
    this.sppm?.releaseBuffers();
    this.denoiser?.dispose();
    this.densityTexture?.destroy();
    this.densityTexture = undefined;
    this.texture?.destroy();
    this.complete?.destroy();
    this.accumulation?.destroy();
    // Display backing size is independent of the accumulation budget: camera
    // Preview/Quality transitions retain the last complete image.
    const displaySize = fitRenderSize(
      Math.max(1, rect.width),
      Math.max(1, rect.height),
      window.devicePixelRatio || 1,
      1920 * 1080,
      device.limits.maxTextureDimension2D,
    );
    if (this.canvas.width !== displaySize.width)
      this.canvas.width = displaySize.width;
    if (this.canvas.height !== displaySize.height)
      this.canvas.height = displaySize.height;
    this.texture = device.createTexture({
      label: "Linear image",
      size: [size.width, size.height],
      format: "rgba16float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    this.complete = device.createTexture({
      label: "Last complete unfiltered image",
      size: [size.width, size.height],
      format: "rgba16float",
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    });
    this.accumulation = device.createBuffer({
      label: "Raw f32 linear accumulation",
      size: size.width * size.height * 16,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    this.stats.width = size.width;
    this.stats.height = size.height;
    this.updateGroups();
    this.invalidate();
    this.report({ ...this.stats });
    // Allow a resized canvas to redraw even when accumulation is paused.
    if (this.paused) this.schedule(true);
  }

  private updateGroups(): void {
    const {
      device,
      compute,
      display,
      texture,
      uniform,
      scene,
      diagnostic,
      displayUniform,
    } = this;
    if (
      !device ||
      !compute ||
      !display ||
      !texture ||
      !uniform ||
      !scene ||
      !diagnostic ||
      !displayUniform
    )
      return;
    const view = texture.createView();
    this.computeGroup = device.createBindGroup({
      layout: compute.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: { buffer: uniform } },
        ...scene.entries(),
        { binding: 4, resource: { buffer: diagnostic } },
      ],
    });
    if (this.pathPipeline && this.sobol && this.accumulation) {
      this.pathGroup = device.createBindGroup({
        layout: this.pathPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: { buffer: uniform } },
          ...scene.entries(),
          { binding: 4, resource: { buffer: diagnostic } },
          ...scene.transportEntries(),
          { binding: 7, resource: { buffer: this.sobol } },
          { binding: 8, resource: { buffer: this.accumulation } },
          scene.spectralEntry(),
        ],
      });
    }
    if (this.front)
      this.displayGroup = device.createBindGroup({
        layout: display.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.front.createView() },
          { binding: 1, resource: { buffer: displayUniform } },
        ],
      });
    this.denoiser?.configure(this.complete!, scene, uniform, diagnostic);
    if (this.sppm && this.sobol && this.accumulation) {
      if (this.settings.integrator === "sppm")
        this.sppm.configure(
          this.stats.width,
          this.stats.height,
          this.settings,
          {
            scene,
            camera: uniform,
            sobol: this.sobol,
            errors: diagnostic,
            accumulation: this.accumulation,
            texture,
          },
        );
      else this.sppm.releaseBuffers();
    }
    this.stats.bytes =
      this.stats.width * this.stats.height * 32 +
      this.parameters.arrayBuffer.byteLength +
      scene.bytes +
      8 +
      (this.sobol?.size ?? 0) +
      displayUniform.size +
      (this.sppm?.bytes ?? 0) +
      (this.denoiser?.bytes ?? 0) +
      (this.densityTexture
        ? this.densityTexture.width * this.densityTexture.height * 8
        : 0) +
      (this.timer?.bytes ?? 0) +
      (this.front ? this.front.width * this.front.height * 8 : 0);
  }

  pause(): void {
    this.paused = true;
    this.redrawSweep = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stats.status = "paused";
    this.report({ ...this.stats });
  }
  resume(): void {
    if (this.disposed || this.stats.status === "error") return;
    this.paused = false;
    this.stats.status = "ready";
    this.report({ ...this.stats });
    this.schedule();
  }

  private schedule(force = false): void {
    if (force) {
      this.redraw = true;
      this.redrawSweep = this.view === 3 || this.view === 5 || this.view === 6;
    }
    const partial =
      this.settings.integrator === "sppm" && this.view === 3
        ? this.sppm?.inProgress
        : this.tileIndex > 0;
    if (
      this.raf ||
      this.busy ||
      this.loading ||
      this.disposed ||
      this.stats.status === "error" ||
      (!this.redraw && this.paused && !(this.redrawSweep && partial)) ||
      document.hidden ||
      !this.texture
    )
      return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.activeFrame = this.frame();
    });
  }

  private async frame(): Promise<void> {
    const {
      device,
      context,
      compute,
      display,
      computeGroup,
      uniform,
      diagnostic,
      readback,
      camera,
    } = this;
    if (
      !device ||
      !context ||
      !compute ||
      !display ||
      !computeGroup ||
      !uniform ||
      !diagnostic ||
      !readback ||
      !camera ||
      this.disposed ||
      this.loading
    )
      return;
    const generation = this.generation;
    const timer = this.timer;
    const revision = this.revision;
    const pathMode = this.view === 3 || this.view === 5 || this.view === 6;
    const sppmMode = this.view === 3 && this.settings.integrator === "sppm";
    const displayOnly = this.displayOnly;
    this.displayOnly = false;
    const started = performance.now();
    this.busy = true;
    this.redraw = false;
    try {
      const basis = cameraBasis(camera);
      const tileSize = this.interacting
        ? Math.max(this.stats.width, this.stats.height)
        : 64;
      const columns = Math.ceil(this.stats.width / tileSize),
        rows = Math.ceil(this.stats.height / tileSize);
      const tile = sppmMode
        ? this.sppm!.tileRect()
        : pathMode
          ? [
              (this.tileIndex % columns) * tileSize,
              Math.floor(this.tileIndex / columns) * tileSize,
              tileSize,
              tileSize,
            ]
          : [0, 0, this.stats.width, this.stats.height];
      this.parameters.set({
        size: [this.stats.width, this.stats.height],
        frame: this.samples,
        view: this.view,
        eye: [...basis.eye, 0],
        forward: [...basis.forward, 0],
        right: [...basis.right, 0],
        up: [...basis.up, 0],
        tile,
        maxDepth: this.settings.maxDepth,
        seed: this.settings.seed,
        strategy: { mis: 0, light: 1, bsdf: 2 }[this.settings.strategy],
        lightCount: this.packed!.lightCount,
        transportMode: Number(this.settings.mode === "spectral"),
        padding0: Number(this.settings.integrator === "sppm"),
      });
      device.queue.writeBuffer(uniform, 0, this.parameters.arrayBuffer);
      const encoder = device.createCommandEncoder();
      timer?.begin(encoder);
      encoder.clearBuffer(diagnostic);
      if (this.needsClear) {
        if (this.accumulation) encoder.clearBuffer(this.accumulation);
        const clear = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.texture!.createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        clear.end();
        this.needsClear = false;
      }
      let iterationComplete = false;
      if (sppmMode && !displayOnly) {
        iterationComplete = this.sppm!.encodeStep(encoder);
      } else if (!displayOnly) {
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(pathMode ? this.pathPipeline! : compute);
        computePass.setBindGroup(0, pathMode ? this.pathGroup! : computeGroup);
        computePass.dispatchWorkgroups(
          Math.ceil(tile[2]! / 8),
          Math.ceil(tile[3]! / 8),
        );
        computePass.end();
      }
      timer?.end(encoder);
      encoder.copyBufferToBuffer(diagnostic, 0, readback, 0, 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const errors = new Uint32Array(readback.getMappedRange())[0]!;
      readback.unmap();
      const gpuMs = await timer?.read();
      if (generation !== this.generation || this.disposed) return;
      if (errors)
        throw new Error(
          `GPU transport failed for ${errors} operations (intersection, medium, hash or non-finite values).`,
        );
      if (revision !== this.revision) return;
      if (sppmMode && !displayOnly) {
        if (iterationComplete) {
          this.samples++;
          this.stats.frames++;
          this.redrawSweep = false;
        }
        this.stats.samples = this.samples;
        this.stats.tile = this.sppm!.tile;
        this.stats.tiles = this.sppm!.tiles;
        this.stats.phase = this.sppm!.phase;
        this.stats.batch = this.sppm!.batch;
        this.stats.emittedPhotons = this.sppm!.emittedPhotons;
      } else if (pathMode && !displayOnly) {
        this.tileIndex++;
        if (this.tileIndex === columns * rows) {
          this.tileIndex = 0;
          this.samples++;
          this.stats.frames++;
          this.redrawSweep = false;
        }
        this.stats.samples = this.samples;
        this.stats.tile = this.tileIndex;
        this.stats.tiles = columns * rows;
      } else if (!displayOnly) this.stats.frames++;
      const complete =
        displayOnly ||
        !pathMode ||
        (sppmMode ? iterationComplete : this.tileIndex === 0);
      if (complete) await this.present(!displayOnly);
      this.stats.completionMs = performance.now() - started;
      this.stats.gpuMs = gpuMs;
      this.report({ ...this.stats });
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.fail(error);
    } finally {
      this.busy = false;
      if (this.stats.status !== "error") this.schedule();
    }
  }

  private async present(commit: boolean): Promise<void> {
    const device = this.device!;
    const encoder = device.createCommandEncoder();
    if (
      commit ||
      (this.presentedRevision === this.revision && this.samples > 0)
    ) {
      if (commit)
        encoder.copyTextureToTexture(
          { texture: this.texture! },
          { texture: this.complete! },
          [this.stats.width, this.stats.height],
        );
      let source =
        this.view === 3 && this.denoise.enabled
          ? this.denoiser!.encode(
              encoder,
              this.denoise,
              this.settings.mode === "spectral",
              this.guidesDirty,
            )
          : this.complete!;
      if (this.view === 3 && this.denoise.enabled) this.guidesDirty = false;
      if (this.photonDensity && this.settings.integrator === "sppm") {
        if (!this.densityTexture)
          this.densityTexture = device.createTexture({
            label: "Photon count density display",
            size: [source.width, source.height],
            format: "rgba16float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
          });
        this.sppm!.encodeDensity(encoder, this.densityTexture);
        source = this.densityTexture;
      }
      if (
        !this.front ||
        this.front.width !== source.width ||
        this.front.height !== source.height
      ) {
        this.front?.destroy();
        this.front = device.createTexture({
          label: "Last complete presentation",
          size: [source.width, source.height],
          format: "rgba16float",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.displayGroup = device.createBindGroup({
          layout: this.display!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.front.createView() },
            { binding: 1, resource: { buffer: this.displayUniform! } },
          ],
        });
      }
      encoder.copyTextureToTexture(
        { texture: source },
        { texture: this.front },
        [source.width, source.height],
      );
      this.presentedRevision = this.revision;
      this.presentedColorSpace = Number(
        this.view === 3 &&
          !this.photonDensity &&
          this.settings.mode === "spectral",
      );
      this.presentedDebug = Number(this.view !== 3 || this.photonDensity);
      this.stats.presentedRevision = this.presentedRevision;
      this.stats.bytes =
        this.stats.width * this.stats.height * 32 +
        this.parameters.arrayBuffer.byteLength +
        this.scene!.bytes +
        8 +
        (this.sobol?.size ?? 0) +
        this.displayUniform!.size +
        (this.sppm?.bytes ?? 0) +
        (this.denoiser?.bytes ?? 0) +
        (this.densityTexture
          ? this.densityTexture.width * this.densityTexture.height * 8
          : 0) +
        (this.timer?.bytes ?? 0) +
        source.width * source.height * 8;
    }
    if (!this.displayGroup) return;
    this.displayParameters.set({
      exposure: 2 ** this.exposure,
      debugView: this.presentedDebug,
      colorSpace: this.presentedColorSpace,
      padding: this.toneMapper,
    });
    device.queue.writeBuffer(
      this.displayUniform!,
      0,
      this.displayParameters.arrayBuffer,
    );
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context!.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.display!);
    pass.setBindGroup(0, this.displayGroup);
    pass.draw(3);
    pass.end();
    encoder.copyBufferToBuffer(this.diagnostic!, 0, this.readback!, 0, 4);
    device.queue.submit([encoder.finish()]);
    await this.readback!.mapAsync(GPUMapMode.READ);
    const errors = new Uint32Array(this.readback!.getMappedRange())[0]!;
    this.readback!.unmap();
    if (errors) throw new Error("GPU display guides failed");
  }
  async capturePng(): Promise<Blob> {
    await this.activeFrame;
    if (!this.device || !this.front || this.presentedRevision !== this.revision)
      throw new Error("Wait for a complete displayed frame before PNG export");
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.busy = true;
    const device = this.device,
      revision = this.revision,
      width = this.front.width,
      height = this.front.height;
    const stride = Math.ceil((width * 4) / 256) * 256;
    const texture = device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const buffer = device.createBuffer({
      size: stride * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      await this.present(false);
      const group = device.createBindGroup({
        layout: this.pngPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.front.createView() },
          { binding: 1, resource: { buffer: this.displayUniform! } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: texture.createView(), loadOp: "clear", storeOp: "store" },
        ],
      });
      pass.setPipeline(this.pngPipeline!);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow: stride },
        [width, height],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      if (revision !== this.revision || this.disposed)
        throw new DOMException("PNG capture superseded", "AbortError");
      const source = new Uint8Array(buffer.getMappedRange()),
        pixels = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        pixels.set(
          source.subarray(y * stride, y * stride + width * 4),
          y * width * 4,
        );
      buffer.unmap();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas
        .getContext("2d")!
        .putImageData(new ImageData(pixels, width, height), 0, 0);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new Error("PNG encoding failed")),
          "image/png",
        ),
      );
    } finally {
      buffer.destroy();
      texture.destroy();
      this.busy = false;
      this.schedule();
    }
  }
  private fail(error: unknown): void {
    this.pause();
    this.stats.status = "error";
    this.report({ ...this.stats });
    this.error(error instanceof Error ? error : new Error(String(error)));
  }
  private release(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.sppm?.dispose();
    this.sppm = undefined;
    this.denoiser?.dispose();
    this.denoiser = undefined;
    this.front?.destroy();
    this.front = undefined;
    this.pngPipeline = undefined;
    this.presentedRevision = -1;
    this.timer?.dispose();
    this.timer = undefined;
    this.densityTexture?.destroy();
    this.densityTexture = undefined;
    this.complete?.destroy();
    this.complete = undefined;
    this.texture?.destroy();
    this.uniform?.destroy();
    this.scene?.dispose();
    this.diagnostic?.destroy();
    this.readback?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
    this.scene = undefined;
    this.diagnostic = undefined;
    this.readback = undefined;
    this.accumulation?.destroy();
    this.sobol?.destroy();
    this.accumulation = undefined;
    this.sobol = undefined;
    this.pathPipeline = undefined;
    this.pathGroup = undefined;
    this.displayUniform?.destroy();
    this.displayUniform = undefined;
    this.texture = undefined;
    this.uniform = undefined;
    this.device = undefined;
    this.compute = undefined;
    this.display = undefined;
    this.computeGroup = undefined;
    this.displayGroup = undefined;
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.preparer.dispose();
    this.release();
  }
}
