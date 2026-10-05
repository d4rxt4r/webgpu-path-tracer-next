import { GpuEnvironment } from '../gpu/environment';
import { defaultEnvironment, type EnvironmentSettings } from '../scene/environment';
import type { HdrImage } from '../assets/hdr';
import { cameraShells } from "../accel/camera-media";
import { settingsLimits, photonAllocation, checkPhotonLimits } from "./settings-limits";
import { fastTransportShader } from "../transport/fast-source";
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
import { PacketBudget, PacketUniforms, TileBudget } from "./compute-packets";
import type { ComputePhase } from "./compute-packets";
import { TRANSPORT_DIAGNOSTIC_BYTES, TRANSPORT_QUEUE_BYTES, clearTransportQueue, encodeTransportRepair, COMPUTE_READBACK_BYTES, transportDiagnostic, transportFailure } from "./transport-diagnostics";

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
  computation: {
    sampler: "owen-sobol-24";
    kernel: "megakernel";
    scheduler: "bounded-packets-v1";
    workgroup: [number, number];
    tileSize: number;
    specializedSppmSampler: boolean;
  };
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
  status: "initializing" | "ready" | "paused" | "recovering" | "error";
  triangles: number;
  nodes: number;
  samples: number;
  tile: number;
  tiles: number;
  integrator: "pt" | "sppm";
  phase: string;
  emittedPhotons: number;
  batch: number;
  executedPhase?: ComputePhase | "display";
  packetSteps?: number;
  packetCount?: number;
}

/** RGB / spectral PT and SPPM with shared intersection debug views. */
export class IntersectionRenderer {
  private environment?: GpuEnvironment;
  private environmentSettings = structuredClone(defaultEnvironment);
  private environmentImage?: HdrImage;
  private preparer = new ScenePreparer();
  private packed?: PreparedScene;
  private scene?: GpuScene;
  private camera?: CameraDescription;
  private view = 0;
  private revision = 0;
  private sceneRevision = 0;
  private cameraRevision = 0;
  private mediaCache?: { packed: PreparedScene; eye: string; shells: Uint32Array };
  private loading = false;
  private diagnostic?: GPUBuffer;
  private readback?: GPUBuffer;
  private nextReadback?: GPUBuffer;
  private packetUniforms?: PacketUniforms;
  private packetBudget = new PacketBudget();
  private parameters = makeStructuredView(definitions.structs.CameraParams!);
  private accumulation?: GPUBuffer;
  private sobol?: GPUBuffer;
  private pathPipeline?: GPUComputePipeline;
  private pathRepairPipeline?: GPUComputePipeline;
  private pathRepairGroup?: GPUBindGroup;
  private precisionIndirect?: GPUBuffer;
  private pathWorkgroup: [number, number] = [8, 8];
  private pathTileSize = 0;
  private tileBudget = new TileBudget();
  private sweepTileSize = 0;
  private sweepGpuMs = 0;
  private sweepTiles = 0;
  private specializedSppmSampler = false;
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
  private gpuPreparation?: Promise<void>;
  private preparationJobs = new Map<string, Promise<void>>();
  readonly startupTimings: Record<string, number> = {};
  private startedAt = performance.now();
  private booting = true;
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
  private filterDirty = true;
  private filtered?: GPUTexture;
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
  private jobTimer = 0;
  private workChannel = new MessageChannel();
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
    status: "initializing",
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

  cancelScenePreparation(): void {
    this.sceneRevision++;
    this.preparer.cancel();
    this.loading = false;
    this.schedule(true);
  }
  async setEnvironment(settings: EnvironmentSettings, image = this.environmentImage): Promise<void> {
    const bytes = GpuEnvironment.byteSize(image);
    const minimum = this.fixedMemoryBytes(this.settings) - (this.environment?.bytes ?? GpuEnvironment.byteSize(this.environmentImage)) + bytes + 88 + (this.settings.integrator === "sppm" ? SPPM_POINT_BYTES : 0);
    if (minimum > this.settings.memoryBudgetMiB * 1048576) throw new Error("HDR не помещается в бюджет GPU. Выберите 1K/2K или увеличьте бюджет памяти.");
    const device = this.device;
    if (!device) { this.environmentSettings = structuredClone(settings); this.environmentImage = image; return; }
    await this.activeFrame;
    let next = this.environment;
    const replace = image !== this.environmentImage || !next;
    if (replace) {
      next = undefined;
      device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation');
      let allocationError: unknown;
      try { next = new GpuEnvironment(device, image); } catch (error) { allocationError = error; }
      const validation = await device.popErrorScope(), memory = await device.popErrorScope();
      if (allocationError || validation || memory) { next?.dispose(); throw allocationError ?? new Error((validation ?? memory)!.message); }
    }
    try { if (this.packed) next!.setScene(this.packed); next!.update(settings); }
    catch (error) { if (replace) next?.dispose(); throw error; }
    const old = this.environment;
    this.environment = next; this.environmentImage = image; this.environmentSettings = structuredClone(settings);
    if (this.scene && next) this.scene.environment = next;
    this.invalidate(); this.resize(); this.updateGroups(); this.schedule(true);
    if (replace) old?.dispose();
  }

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
      const packed = await this.timed("scene", () => this.preparer.prepare(description));
      if (sceneRevision !== this.sceneRevision || this.disposed) return;
      if (this.settings.mode === "spectral" && !packed.spectralReady)
        throw new Error(
          "Spectral mode requires spectra for non-neutral RGB materials",
        );
      const bytes = packed.nodes.byteLength + packed.triangles.byteLength + packed.materials.byteLength + packed.lights.byteLength + packed.spectra.byteLength;
      const minimum = this.fixedMemoryBytes(this.settings, bytes) + 88 + (this.settings.integrator === "sppm" ? SPPM_POINT_BYTES : 0);
      if (minimum > this.settings.memoryBudgetMiB * 1048576)
        throw new Error("Модель превышает бюджет памяти. Увеличьте бюджет или загрузите меньший OBJ.");
      // Allocate and validate before committing the replacement.
      let scene: GpuScene | undefined;
      if (this.device) {
        const device = this.device;
        device.pushErrorScope("out-of-memory"); device.pushErrorScope("validation");
        let allocationError: unknown;
        try { scene = new GpuScene(device, packed, this.environment); } catch (error) { allocationError = error; }
        const [validation, memory] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
        if (allocationError || validation || memory) {
          scene?.dispose();
          throw allocationError || new Error(validation?.message || memory?.message || "Не удалось загрузить модель в GPU.");
        }
      }
      if (sceneRevision !== this.sceneRevision || this.disposed) { scene?.dispose(); return; }
      const previous = { scene: this.scene, packed: this.packed, camera: this.camera, triangles: this.stats.triangles, nodes: this.stats.nodes };
      try {
        this.packed = packed;
        this.environment?.setScene(packed);
        this.environment?.update(this.environmentSettings);
        if (cameraRevision === this.cameraRevision) this.camera = camera;
        this.scene = scene;
        this.stats.triangles = packed.triangleCount;
        this.stats.nodes = packed.nodeCount;
        this.invalidate();
        this.resize();
        this.updateGroups();
      } catch (error) {
        this.scene = previous.scene; this.packed = previous.packed; this.camera = previous.camera;
        if (previous.packed) this.environment?.setScene(previous.packed);
        this.environment?.update(this.environmentSettings);
        this.stats.triangles = previous.triangles; this.stats.nodes = previous.nodes;
        scene?.dispose(); this.invalidate(); this.resize(); this.updateGroups();
        throw error;
      }
      previous.scene?.dispose();
      this.report({ ...this.stats });
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
  validateSettings(settings: Partial<PathSettings>): PathSettings {
    const next = { ...this.settings, ...settings };
    if (
      !["pt", "sppm"].includes(next.integrator) ||
      !Number.isInteger(next.photonsPerIteration) ||
      next.photonsPerIteration < 1 ||
      next.photonsPerIteration > settingsLimits.maxPhotons ||
      !Number.isInteger(next.photonBatchSize) ||
      next.photonBatchSize < 1 ||
      next.photonBatchSize > settingsLimits.maxPhotonBatch ||
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
      next.maxDepth > settingsLimits.maxDepth ||
      !Number.isInteger(next.seed) ||
      next.seed < 0 ||
      next.seed > 0xffffffff ||
      !["mis", "light", "bsdf"].includes(next.strategy) ||
      !Number.isInteger(next.maxPixels) ||
      next.maxPixels < 1 ||
      next.maxPixels > settingsLimits.maxPixels ||
      !Number.isFinite(next.memoryBudgetMiB) ||
      next.memoryBudgetMiB < settingsLimits.minMemoryMiB ||
      next.memoryBudgetMiB > settingsLimits.maxMemoryMiB
    )
      throw new Error("Invalid path tracing settings");
    if (this.device) {
      if (next.integrator === "sppm")
        checkPhotonLimits(next.photonBatchSize, next.maxDepth, this.device.limits);
      if (this.fixedMemoryBytes(next) + 88 + (next.integrator === "sppm" ? SPPM_POINT_BYTES : 0) > next.memoryBudgetMiB * 1048576)
        throw new Error("Сцена и фотонный пакет превышают бюджет памяти. Увеличьте бюджет или уменьшите пакет.");
    }
    return next;
  }
  setSettings(settings: Partial<PathSettings>): void {
    const next = this.validateSettings(settings);
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
    if (
      next.enabled !== this.denoise.enabled ||
      next.passes !== this.denoise.passes ||
      next.strength !== this.denoise.strength ||
      next.filterGlass !== this.denoise.filterGlass
    )
      this.filterDirty = true;
    this.denoise = next;
    this.prepareDenoiser();
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
        const storedCount = raw[i * 4 + 3]!;
        const count = storedCount < 0 ? -storedCount - 1 : storedCount;
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
        computation: {
          sampler: "owen-sobol-24",
          kernel: "megakernel",
          scheduler: "bounded-packets-v1",
          workgroup: [...this.pathWorkgroup],
          tileSize: this.pathTileSize || this.tileBudget.size,
          specializedSppmSampler: this.specializedSppmSampler,
        },
      };
    } finally {
      readback.destroy();
    }
  }
  private invalidate(): void {
    this.revision++;
    this.packetBudget = new PacketBudget();
    this.sweepTileSize = this.sweepGpuMs = this.sweepTiles = 0;
    this.stats.completionMs = 0;
    this.stats.gpuMs = undefined;
    this.stats.packetSteps = 0;
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

  /** May run alongside model/HDR loading and BVH preparation. */
  prepareGpu(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Renderer is disposed"));
    return this.gpuPreparation ??= this.initializeGpu();
  }

  private async timed<T>(name: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const generation = this.generation;
    try { return await work(); }
    finally {
      if (generation === this.generation) this.startupTimings[name] = performance.now() - start;
    }
  }

  private async prepareOnce(name: string, work: (device: GPUDevice) => Promise<void>): Promise<void> {
    const preparation = this.prepareGpu();
    const generation = this.generation;
    await preparation;
    if (this.disposed || generation !== this.generation) return;
    let job = this.preparationJobs.get(name);
    if (!job) {
      const device = this.device!;
      job = this.timed(name, () => work(device));
      this.preparationJobs.set(name, job);
    }
    await job;
  }

  prepareIntegrator(integrator: PathSettings["integrator"]): Promise<void> {
    if (integrator === "pt") return this.prepareGpu();
    return this.prepareOnce("sppm", async device => {
      const generation = this.generation;
      const sppm = await SppmIntegrator.create(device, this.specializedSppmSampler, false, (entry, ms) => {
        if (generation === this.generation) this.startupTimings[entry] = ms;
      });
      if (generation !== this.generation || this.disposed) { sppm.dispose(); return; }
      this.sppm = sppm;
      this.updateGroups();
    });
  }

  private async prepareDebug(): Promise<void> {
    return this.prepareOnce("debug", async device => {
      const generation = this.generation;
      const module = await checkedShader(device, debugShader, "BVH intersections");
      const pipeline = await device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint: "main"}});
      if (generation !== this.generation || this.disposed) return;
      this.compute = pipeline;
      this.updateGroups();
    });
  }

  private prepareDenoiser(): void {
    if (!this.denoise.enabled || this.booting || !this.device || this.preparationJobs.has("denoiser")) return;
    const generation = this.generation;
    void this.prepareOnce("denoiser", async device => {
      const denoiser = await Denoiser.create(device, (entry, ms) => {
        if (generation === this.generation) this.startupTimings[entry] = ms;
      });
      if (generation !== this.generation || this.disposed) { denoiser.dispose(); return; }
      this.denoiser = denoiser;
      this.updateGroups();
      this.displayOnly = !this.needsClear;
      this.schedule(true);
    }).catch(error => {
      if (!this.disposed && generation === this.generation)
        this.error(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async prepareActiveMode(): Promise<void> {
    // A user can change the view while a pipeline is compiling. Recheck the
    // requested mode before scheduling work rather than dispatching stale work.
    let previous: string;
    do {
      previous = `${this.view}:${this.settings.integrator}:${this.photonDensity}`;
      if (this.view === 3 || this.view === 5 || this.view === 6) {
        await this.prepareIntegrator(this.view === 3 ? this.settings.integrator : "pt");
        if (this.photonDensity && this.sppm) await this.sppm.prepareDensity();
      } else await this.prepareDebug();
      if (this.disposed) return;
    } while (previous !== `${this.view}:${this.settings.integrator}:${this.photonDensity}`);
  }

  async initialize(): Promise<void> {
    if (!this.packed || !this.camera) throw new Error("Set a scene before initialization");
    const preparation = this.prepareGpu();
    const generation = this.generation;
    await preparation;
    if (this.disposed || generation !== this.generation) return;
    const device = this.device!;
    this.environment ??= new GpuEnvironment(device, this.environmentImage);
    this.environment.setScene(this.packed);
    this.environment.update(this.environmentSettings);
    this.scene?.dispose();
    this.scene = new GpuScene(device, this.packed, this.environment);
    await this.prepareActiveMode();
    if (this.disposed || generation !== this.generation) return;
    this.invalidate();
    this.resize();
    this.stats.status = this.paused ? "paused" : "ready";
    this.report({ ...this.stats });
    this.schedule();
  }

  private async initializeGpu(): Promise<void> {
    const generation = ++this.generation;
    const { device, name, adapter } = await createDevice();
    // These two choices have measured wins on gen-12lp. Other adapters use the
    // generic sampler and a conservative initial grid with feedback adaptation.
    const calibratedIntel =
      adapter.info.vendor === "intel" &&
      adapter.info.architecture === "gen-12lp";
    this.specializedSppmSampler = calibratedIntel;
    // On gen-12lp the robust PT kernel loses throughput below 128 pixels:
    // shrinking to 16 made the same four samples take 16.4s instead of 5.9s.
    // PacketBudget still bounds submissions and reacts to expensive tiles.
    this.tileBudget = new TileBudget(calibratedIntel ? 128 : 64, calibratedIntel ? 128 : 16);
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
    void device.lost.then(async () => {
      if (this.disposed || generation !== this.generation) return;
      this.stats.status = "recovering";
      this.report({ ...this.stats });
      // Retire in-flight work before destroying resources and requesting a new device.
      this.generation++;
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
      const [pathModule, displayModule, sobolData, fastPathModule] = await Promise.all([
        checkedShader(device, pathShader, "RGB / spectral path tracer"),
        checkedShader(device, displayShader, "Display"),
        loadSobol(),
        checkedShader(device, fastTransportShader(pathShader, calibratedIntel), "PT common transport"),
      ]);
      const [pathPipeline, display, pathRepairPipeline] = await Promise.all([
        this.timed("pt", () => device.createComputePipelineAsync({layout: "auto", compute: {module: fastPathModule, entryPoint: "main"}})),
        this.timed("display", () => device.createRenderPipelineAsync({
          layout: "auto", vertex: {module: displayModule, entryPoint: "vertexMain"},
          fragment: {module: displayModule, entryPoint: "fragmentMain", targets: [{format}]},
          primitive: {topology: "triangle-list"},
        })),
        this.timed("pt-repair", () => device.createComputePipelineAsync({layout: "auto", compute: {module: pathModule, entryPoint: "repairMain"}})),
      ]);
      if (this.disposed || generation !== this.generation) return;
      this.pathPipeline = pathPipeline;
      this.pathRepairPipeline = pathRepairPipeline;
      this.precisionIndirect = device.createBuffer({label: "PT precision dispatch", size:12, usage:GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST});
      this.display = display;
      this.uniform = device.createBuffer({
        label: "Camera parameters",
        size: this.parameters.arrayBuffer.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.packetUniforms = new PacketUniforms(device);
      this.displayUniform = device.createBuffer({
        label: "Display parameters",
        size: this.displayParameters.arrayBuffer.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
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
        size: TRANSPORT_QUEUE_BYTES,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      this.readback = device.createBuffer({
        label: "Traversal error readback",
        size: COMPUTE_READBACK_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this.nextReadback = device.createBuffer({
        label: "Second compute packet readback",
        size: COMPUTE_READBACK_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    } finally {
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
    }
    if (this.disposed || generation !== this.generation) return;
    this.stats.adapter = name;
    this.stats.frames = 0;
    this.startupTimings["gpu-ready"] = performance.now() - this.startedAt;
  }

  private fixedMemoryBytes(settings: PathSettings, sceneBytes = this.scene?.bytes ?? 0): number {
    const allocation = photonAllocation(settings.photonBatchSize, settings.maxDepth);
    return sceneBytes + (this.environment?.bytes ?? GpuEnvironment.byteSize(this.environmentImage)) +
      (this.sobol?.size ?? 0) +
      (this.front ? this.front.width * this.front.height * 8 : 0) +
      1024 + TRANSPORT_QUEUE_BYTES + 12 + 2 * COMPUTE_READBACK_BYTES +
      (this.packetUniforms?.bytes ?? 0) +
      (settings.integrator === "sppm" ? allocation.photons + allocation.heads : 0);
  }

  resize(): void {
    const device = this.device;
    if (
      !device ||
      !this.packed ||
      !this.display ||
      !this.uniform ||
      this.disposed
    )
      return;
    const rect = this.canvas.getBoundingClientRect();
    // Reserve the next presentation texture as well as a retained previous frame.
    const perPixel =
      88 + (this.settings.integrator === "sppm" ? SPPM_POINT_BYTES : 0);
    const fixed = this.fixedMemoryBytes(this.settings);
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
      settingsLimits.maxPixels,
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
      !display ||
      !texture ||
      !uniform ||
      !scene ||
      !diagnostic ||
      !displayUniform
    )
      return;
    const view = texture.createView();
    if (compute) this.computeGroup = device.createBindGroup({
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
          ...scene.transportEntries(true),
          { binding: 7, resource: { buffer: this.sobol } },
          { binding: 8, resource: { buffer: this.accumulation } },
          scene.spectralEntry(),
        ],
      });
      this.pathRepairGroup = device.createBindGroup({
        layout: this.pathRepairPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: { buffer: uniform } },
          ...scene.entries(),
          { binding: 4, resource: { buffer: diagnostic } },
          ...scene.transportEntries(true),
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
    this.filtered = undefined;
    this.filterDirty = true;
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
      scene.bytes + (this.environment?.bytes ?? 0) +
      (this.sobol?.size ?? 0) +
      displayUniform.size +
      (this.sppm?.bytes ?? 0) +
      (this.denoiser?.bytes ?? 0) +
      (this.densityTexture
        ? this.densityTexture.width * this.densityTexture.height * 8
        : 0) +
      (this.timer?.bytes ?? 0) +
      (this.packetUniforms?.bytes ?? 0) +
      TRANSPORT_QUEUE_BYTES + 12 + 2 * COMPUTE_READBACK_BYTES +
      (this.front ? this.front.width * this.front.height * 8 : 0);
  }

  pause(): void {
    this.paused = true;
    this.redrawSweep = false;
    this.cancelScheduled();
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
      this.jobTimer ||
      this.busy ||
      this.loading ||
      this.disposed ||
      this.stats.status === "error" ||
      (!this.redraw && this.paused && !(this.redrawSweep && partial)) ||
      document.hidden ||
      !this.texture
    )
      return;
    const run = () => {
      this.raf = 0;
      this.jobTimer = 0;
      const generation = this.generation;
      this.busy = true;
      this.activeFrame = (async () => {
        try {
          await this.prepareActiveMode();
          if (this.disposed || generation !== this.generation) return;
          this.busy = false;
          if (!this.paused || this.redraw) await this.frame();
        } catch (error) {
          if (!this.disposed && generation === this.generation) this.fail(error);
        } finally {
          if (generation === this.generation) this.busy = false;
        }
      })();
    };
    // Accumulation portions need not wait for a screen refresh. Each portion
    // awaits GPU completion before another is scheduled; the queue stays bounded.
    if (
      !this.interacting &&
      (this.view === 3 || this.view === 5 || this.view === 6)
    ) {
      // Posted tasks avoid the 4 ms clamping of nested setTimeout calls.
      this.jobTimer = 1;
      this.workChannel.port1.onmessage = () => {
        if (this.jobTimer) run();
      };
      this.workChannel.port2.postMessage(null);
    } else this.raf = requestAnimationFrame(run);
  }

  private cancelScheduled(): void {
    cancelAnimationFrame(this.raf);
    this.workChannel.port1.onmessage = null;
    this.raf = this.jobTimer = 0;
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
      !display ||
      ((this.view !== 3 && this.view !== 5 && this.view !== 6) && (!compute || !computeGroup)) ||
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
      const eyeKey = camera.position.join(",");
      if (this.mediaCache?.packed !== this.packed || this.mediaCache?.eye !== eyeKey)
        this.mediaCache = { packed: this.packed!, eye: eyeKey, shells: cameraShells(this.packed!, camera.position) };
      const initialShells = new Uint32Array(32); initialShells.set(this.mediaCache!.shells);
      if (!this.sweepTileSize)
        this.sweepTileSize = Math.min(
          this.interacting
            ? Math.max(this.stats.width, this.stats.height)
            : this.pathTileSize || this.tileBudget.size,
          Math.max(this.stats.width, this.stats.height),
        );
      const tileSize = this.sweepTileSize;
      const columns = Math.ceil(this.stats.width / tileSize),
        rows = Math.ceil(this.stats.height / tileSize);
      const phase: ComputePhase = sppmMode
        ? this.sppm!.phase
        : pathMode
          ? "pt"
          : "debug";
      const maximumSteps = displayOnly
        ? 0
        : this.packetBudget.steps(phase, this.interacting);
      const snapshots = this.packetUniforms!;
      const availableReadbacks = [readback, this.nextReadback!];
      const submitted: GPUBuffer[] = [];
      let iterationComplete = false;
      let packetSteps = 0;
      let nextTile = this.tileIndex;
      // Two bounded packets may be in flight, both within the same sample and
      // phase. Drain both before publishing progress or admitting another sample.
      for (let packet = 0; packet < (this.interacting ? 1 : 2); packet++) {
        const encoder = device.createCommandEncoder();
        const packetReadback = availableReadbacks[packet]!;
        snapshots.begin();
        timer?.begin(encoder);
        encoder.clearBuffer(diagnostic,0,48);
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

        if (!displayOnly) {
          for (let step = 0; step < maximumSteps; step++) {
            const tile = sppmMode
              ? this.sppm!.tileRect()
              : pathMode
                ? [
                    (nextTile % columns) * tileSize,
                    Math.floor(nextTile / columns) * tileSize,
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
              padding1: this.mediaCache!.shells.length,
              initialShells,
            });
            snapshots.write(encoder, uniform, this.parameters.arrayBuffer);
            if (sppmMode)
              iterationComplete = this.sppm!.encodeStep(encoder, snapshots);
            else {
              if(pathMode && nextTile===0) clearTransportQueue(encoder, diagnostic);
              const pass = encoder.beginComputePass();
              pass.setPipeline(pathMode ? this.pathPipeline! : compute!);
              pass.setBindGroup(0, pathMode ? this.pathGroup! : computeGroup!);
              const group = pathMode ? this.pathWorkgroup : [8, 8];
              pass.dispatchWorkgroups(
                Math.ceil(tile[2]! / group[0]!),
                Math.ceil(tile[3]! / group[1]!),
              );
              pass.end();
              if (pathMode) {
                nextTile++;
                if(nextTile===columns*rows) encodeTransportRepair(encoder, diagnostic, this.precisionIndirect!, this.pathRepairPipeline!, this.pathRepairGroup!);
              }
            }
            packetSteps++;
            // Never queue beyond a completed sample/iteration. Pause/capture callbacks
            // observe exactly that boundary, and no future writes can alter it.
            if (
              !pathMode ||
              iterationComplete ||
              (sppmMode
                ? this.sppm!.phase !== phase
                : nextTile === columns * rows)
            )
              break;
          }
        }
        timer?.end(encoder, packetReadback);
        const complete =
          displayOnly ||
          !pathMode ||
          (sppmMode ? iterationComplete : nextTile === columns * rows);
        if (complete) this.encodePresent(encoder, !displayOnly);
        encoder.copyBufferToBuffer(diagnostic, 0, packetReadback, 0, TRANSPORT_DIAGNOSTIC_BYTES);
        device.queue.submit([encoder.finish()]);
        submitted.push(packetReadback);
        if (complete || (sppmMode && this.sppm!.phase !== phase)) break;
      }
      const results = await Promise.all(
        submitted.map(async (buffer) => {
          await buffer.mapAsync(GPUMapMode.READ);
          const mapped = buffer.getMappedRange();
          const result = {
            errors: new Uint32Array(mapped, 0, 1)[0]!,
            diagnostic: transportDiagnostic(mapped),
            gpuMs: timer?.read(mapped),
          };
          buffer.unmap();
          return result;
        }),
      );
      const errors = results.reduce((sum, result) => sum + result.errors, 0);
      const gpuMs = timer
        ? results.reduce((sum, result) => sum + result.gpuMs!, 0)
        : undefined;
      if (generation !== this.generation || this.disposed) return;
      if (errors)
        throw new Error(
          transportFailure(results.find(result => result.errors)!.diagnostic, errors),
        );
      if (revision !== this.revision) return;
      if (packetSteps)
        this.packetBudget.observe(
          phase,
          packetSteps,
          gpuMs,
          performance.now() - started,
        );
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
        this.sweepGpuMs += gpuMs ?? performance.now() - started;
        this.sweepTiles += packetSteps;
        this.tileIndex = nextTile;
        if (this.tileIndex === columns * rows) {
          this.tileIndex = 0;
          this.samples++;
          this.stats.frames++;
          this.redrawSweep = false;
          if (!this.interacting && !this.pathTileSize)
            this.tileBudget.observe(this.sweepGpuMs, this.sweepTiles);
          this.sweepTileSize = this.sweepGpuMs = this.sweepTiles = 0;
        }
        this.stats.samples = this.samples;
        this.stats.tile = this.tileIndex;
        this.stats.tiles = columns * rows;
      } else if (!displayOnly) this.stats.frames++;
      this.stats.executedPhase = displayOnly ? "display" : phase;
      this.stats.packetSteps = packetSteps;
      this.stats.packetCount = submitted.length;
      this.stats.completionMs = performance.now() - started;
      this.stats.gpuMs = gpuMs;
      if (this.booting && this.view === 3 && this.samples > 0 && this.presentedRevision === this.revision) {
        this.booting = false;
        this.startupTimings["first-image"] = performance.now() - this.startedAt;
      }
      this.report({ ...this.stats });
      this.prepareDenoiser();
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.fail(error);
    } finally {
      this.busy = false;
      if (this.stats.status !== "error") this.schedule();
    }
  }

  private encodePresent(encoder: GPUCommandEncoder, commit: boolean): void {
    const device = this.device!;
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
      let source = this.complete!;
      if (this.view === 3 && this.denoise.enabled && this.denoiser) {
        if (commit || this.filterDirty || this.guidesDirty || !this.filtered) {
          this.filtered = this.denoiser!.encode(
            encoder,
            this.denoise,
            this.settings.mode === "spectral",
            this.guidesDirty,
          );
          this.guidesDirty = false;
          this.filterDirty = false;
        }
        source = this.filtered;
      }
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
        this.scene!.bytes + (this.environment?.bytes ?? 0) +
        (this.sobol?.size ?? 0) +
        this.displayUniform!.size +
        (this.sppm?.bytes ?? 0) +
        (this.denoiser?.bytes ?? 0) +
        (this.densityTexture
          ? this.densityTexture.width * this.densityTexture.height * 8
          : 0) +
        (this.timer?.bytes ?? 0) +
        (this.packetUniforms?.bytes ?? 0) +
        TRANSPORT_QUEUE_BYTES + 12 + 2 * COMPUTE_READBACK_BYTES +
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
  }
  private async present(commit: boolean): Promise<void> {
    const device = this.device!;
    const encoder = device.createCommandEncoder();
    this.encodePresent(encoder, commit);
    encoder.copyBufferToBuffer(this.diagnostic!, 0, this.readback!, 0, 4);
    device.queue.submit([encoder.finish()]);
    await this.readback!.mapAsync(GPUMapMode.READ);
    const errors = new Uint32Array(this.readback!.getMappedRange())[0]!;
    this.readback!.unmap();
    if (errors) throw new Error("GPU display guides failed");
  }
  async capturePng(): Promise<Blob> {
    await this.prepareOnce("png", async device => {
      const generation = this.generation;
      const module = await checkedShader(device, displayShader, "PNG display");
      const pipeline = await device.createRenderPipelineAsync({
        layout: "auto", vertex: {module, entryPoint: "vertexMain"},
        fragment: {module, entryPoint: "fragmentMain", targets: [{format: "rgba8unorm"}]},
        primitive: {topology: "triangle-list"},
      });
      if (generation === this.generation && !this.disposed) this.pngPipeline = pipeline;
    });
    await this.activeFrame;
    if (!this.device || !this.front || this.presentedRevision !== this.revision)
      throw new Error("Wait for a complete displayed frame before PNG export");
    this.cancelScheduled();
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
    this.gpuPreparation = undefined;
    this.preparationJobs.clear();
    this.booting = true;
    this.cancelScheduled();
    this.sppm?.dispose();
    this.sppm = undefined;
    this.denoiser?.dispose();
    this.denoiser = undefined;
    this.filtered = undefined;
    this.filterDirty = true;
    this.front?.destroy();
    this.front = undefined;
    this.pngPipeline = undefined;
    this.presentedRevision = -1;
    this.timer?.dispose();
    this.timer = undefined;
    this.packetUniforms?.dispose();
    this.packetUniforms = undefined;
    this.packetBudget = new PacketBudget();
    this.densityTexture?.destroy();
    this.densityTexture = undefined;
    this.complete?.destroy();
    this.complete = undefined;
    this.texture?.destroy();
    this.uniform?.destroy();
    this.scene?.dispose();
    this.environment?.dispose(); this.environment = undefined;
    this.diagnostic?.destroy();
    this.precisionIndirect?.destroy();
    this.precisionIndirect = undefined;
    this.pathRepairPipeline = undefined;
    this.pathRepairGroup = undefined;
    this.readback?.destroy();
    this.nextReadback?.destroy();
    this.nextReadback = undefined;
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
    this.workChannel.port1.close();
    this.workChannel.port2.close();
  }
}
