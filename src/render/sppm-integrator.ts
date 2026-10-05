import { checkPhotonLimits } from "./settings-limits";
import { makeStructuredView } from "webgpu-utils";
import {
  sppmDefinitions,
  sppmShader,
  specializedSppmShader,
} from "../transport/sppm-shader";
import { fastTransportShader } from "../transport/fast-source";
import { checkedShader } from "../gpu/device";
import type { GpuScene } from "../gpu/scene";
import type { PacketUniforms } from "./compute-packets";

import { clearTransportQueue, encodeTransportRepair } from "./transport-diagnostics";

export interface SppmSettings {
  maxDepth: number;
  seed: number;
  photonsPerIteration: number;
  photonBatchSize: number;
  initialRadius: number;
}
export interface SppmResources {
  scene: GpuScene;
  camera: GPUBuffer;
  sobol: GPUBuffer;
  errors: GPUBuffer;
  accumulation: GPUBuffer;
  texture: GPUTexture;
}
// Suzanne's glass camera pass exceeded 40 ms at 128² on Intel UHD.
const TILE = 64;
export const SPPM_POINT_BYTES = sppmDefinitions.structs.SppmPoint!.size;
export class SppmIntegrator {
  private uniform: GPUBuffer;
  private indirect: GPUBuffer;
  private errors?: GPUBuffer;
  private parameters = makeStructuredView(sppmDefinitions.structs.SppmParams!);
  private points?: GPUBuffer;
  private photons?: GPUBuffer;
  private heads?: GPUBuffer;
  private groups: Partial<
    Record<"camera" | "photon" | "cameraRepair" | "photonRepair" | "hash" | "gather" | "update", GPUBindGroup>
  > = {};
  private camera?: GPUBuffer;
  private width = 0;
  private height = 0;
  private settings?: SppmSettings;
  private allocationKey = "";
  private clearPending = true;
  private tileIndex = 0;
  private batchStart = 0;
  phase: "camera" | "photon" | "gather" | "update" = "camera";
  iterations = 0;
  private constructor(
    private device: GPUDevice,
    private pipelines: Record<
      "camera" | "photon" | "cameraRepair" | "photonRepair" | "hash" | "gather" | "update",
      GPUComputePipeline
    >,
  ) {
    this.indirect = device.createBuffer({label: "SPPM precision dispatch", size:12, usage:GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST});
    this.uniform = device.createBuffer({
      label: "SPPM parameters",
      size: this.parameters.arrayBuffer.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  static async create(
    device: GPUDevice,
    specializeSampler = false,
    preciseTransport = false,
    timing?: (entry: string, milliseconds: number) => void,
  ): Promise<SppmIntegrator> {
    const module = await checkedShader(
      device,
      specializeSampler ? specializedSppmShader : sppmShader,
      "RGB / spectral SPPM",
    );
    const fastModule = preciseTransport ? module : await checkedShader(device,fastTransportShader(specializeSampler ? specializedSppmShader : sppmShader),"SPPM common transport");
    const entries = [
      "camera",
      "photon",
      "cameraRepair",
      "photonRepair",
      "hash",
      "gather",
      "update",
    ] as const;
    const pipelines = await Promise.all(
      entries.map(async (entry) => {
        const started = performance.now();
        const pipeline = await device.createComputePipelineAsync({
          layout: "auto",
          compute: { module: (entry === "camera" || entry === "photon") ? fastModule : module, entryPoint: entry + "Main" },
        });
        timing?.(entry + "Main", performance.now() - started);
        return pipeline;
      }),
    );
    return new SppmIntegrator(
      device,
      Object.fromEntries(
        entries.map((entry, i) => [entry, pipelines[i]!]),
      ) as Record<(typeof entries)[number], GPUComputePipeline>,
    );
  }
  get bytes(): number {
    return (
      this.uniform.size + this.indirect.size +
      (this.points?.size ?? 0) +
      (this.photons?.size ?? 0) +
      (this.heads?.size ?? 0)
    );
  }
  get inProgress(): boolean {
    return this.phase !== "camera" || this.tileIndex > 0;
  }
  get tiles(): number {
    return Math.ceil(this.width / TILE) * Math.ceil(this.height / TILE);
  }
  get tile(): number {
    return this.tileIndex;
  }
  get emittedPhotons(): number {
    return this.iterations * (this.settings?.photonsPerIteration ?? 0);
  }
  get batch(): number {
    return Math.floor(this.batchStart / (this.settings?.photonBatchSize ?? 1));
  }
  tileRect(): number[] {
    if (this.phase === "photon" || this.phase === "update")
      return [0, 0, this.width, this.height];
    const columns = Math.ceil(this.width / TILE);
    return [
      (this.tileIndex % columns) * TILE,
      Math.floor(this.tileIndex / columns) * TILE,
      TILE,
      TILE,
    ];
  }
  configure(
    width: number,
    height: number,
    settings: SppmSettings,
    resources: SppmResources,
  ): void {
    checkPhotonLimits(settings.photonBatchSize, settings.maxDepth, this.device.limits);
    const key = [
      width,
      height,
      settings.maxDepth,
      settings.photonBatchSize,
    ].join(":");
    this.camera = resources.camera;
    this.errors = resources.errors;
    this.width = width;
    this.height = height;
    this.settings = { ...settings };
    if (key !== this.allocationKey) {
      this.releaseBuffers();
      const pointSize =
        width * height * sppmDefinitions.structs.SppmPoint!.size;
      const photonSize =
        settings.photonBatchSize *
        (settings.maxDepth + 1) *
        sppmDefinitions.structs.Photon!.size;
      const hashSize =
        2 **
          Math.ceil(
            Math.log2(settings.photonBatchSize * (settings.maxDepth + 1) * 2),
          ) *
        4;
      if (
        [pointSize, photonSize, hashSize].some(
          (size) =>
            size > this.device.limits.maxBufferSize ||
            size > this.device.limits.maxStorageBufferBindingSize,
        )
      )
        throw new Error("SPPM buffers exceed device limits");
      const create = (size: number, label: string) =>
        this.device.createBuffer({
          size,
          label,
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_SRC |
            GPUBufferUsage.COPY_DST,
        });
      try {
        this.points = create(pointSize, "SPPM visible points and history");
        this.photons = create(photonSize, "Bounded photon batch");
        this.heads = create(hashSize, "Photon hash heads");
      } catch (error) {
        this.releaseBuffers();
        throw error;
      }
      this.allocationKey = key;
      this.reset();
    }
    const binding = (
      binding: number,
      buffer: GPUBuffer,
    ): GPUBindGroupEntry => ({ binding, resource: { buffer } });
    const camera = binding(1, resources.camera),
      error = binding(4, resources.errors),
      uniform = binding(11, this.uniform);
    const points = binding(10, this.points!),
      photons = binding(21, this.photons!),
      heads = binding(22, this.heads!);
    const transport = [
      camera,
      ...resources.scene.entries(),
      error,
      ...resources.scene.transportEntries(true),
      binding(7, resources.sobol),
      resources.scene.spectralEntry(),
    ];
    const entries: Record<
      Exclude<keyof typeof this.pipelines, "density">,
      GPUBindGroupEntry[]
    > = {
      camera: [...transport, points],
      cameraRepair: [...transport, points],
      photon: [...transport, uniform, photons],
      photonRepair: [...transport, uniform, photons],
      hash: [camera, uniform, photons, heads],
      gather: [camera, error, uniform, points, photons, heads, ...resources.scene.transportEntries().filter(entry => entry.binding === 5), binding(7, resources.sobol), resources.scene.spectralEntry()],
      update: [
        { binding: 0, resource: resources.texture.createView() },
        camera,
        error,
        binding(8, resources.accumulation),
        uniform,
        points,
      ],
    };
    for (const stage of Object.keys(entries) as (keyof typeof entries)[])
      this.groups[stage] = this.device.createBindGroup({
        layout: this.pipelines[stage].getBindGroupLayout(0),
        entries: entries[stage],
      });
  }
  reset(): void {
    this.iterations = 0;
    this.phase = "camera";
    this.tileIndex = 0;
    this.batchStart = 0;
    this.clearPending = true;
  }
  /** Encode one bounded portion. Persistent output changes only in updateMain. */
  encodeStep(encoder: GPUCommandEncoder, snapshots?: PacketUniforms): boolean {
    const settings = this.settings;
    if (!settings || !this.points || !this.photons || !this.heads)
      throw new Error("SPPM is not configured");
    if (this.iterations === 0xffffffff)
      throw new Error("SPPM iteration counter exhausted");
    if (this.clearPending) {
      encoder.clearBuffer(this.points);
      this.clearPending = false;
    }
    const batchCount = Math.min(
      settings.photonBatchSize,
      settings.photonsPerIteration - this.batchStart,
    );
    this.parameters.set({
      initialRadius: settings.initialRadius,
      photonsPerIteration: settings.photonsPerIteration,
      batchStart: this.batchStart,
      batchCount,
      batchSize: settings.photonBatchSize,
      hashMask: this.heads.size / 4 - 1,
      iteration: this.iterations,
      seed: settings.seed,
    });
    if (snapshots)
      snapshots.write(encoder, this.uniform, this.parameters.arrayBuffer);
    else
      this.device.queue.writeBuffer(
        this.uniform,
        0,
        this.parameters.arrayBuffer,
      );
    const dispatch = (
      stage: Exclude<keyof typeof this.pipelines, "density">,
      x: number,
      y = 1,
    ) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines[stage]);
      pass.setBindGroup(0, this.groups[stage]!);
      pass.dispatchWorkgroups(x, y);
      pass.end();
    };
    if (this.phase === "camera") {
      if(this.tileIndex===0) clearTransportQueue(encoder, this.errors!);
      dispatch("camera", TILE / 8, TILE / 8);
      if (++this.tileIndex === this.tiles) {
        encodeTransportRepair(encoder, this.errors!, this.indirect, this.pipelines.cameraRepair, this.groups.cameraRepair!);
        this.tileIndex = 0;
        this.phase = "photon";
      }
    } else if (this.phase === "photon") {
      encoder.clearBuffer(this.heads);
      clearTransportQueue(encoder, this.errors!);
      dispatch("photon", Math.ceil(batchCount / 64));
      encodeTransportRepair(encoder, this.errors!, this.indirect, this.pipelines.photonRepair, this.groups.photonRepair!);
      dispatch("hash", Math.ceil((batchCount * (settings.maxDepth + 1)) / 64));
      this.phase = "gather";
    } else if (this.phase === "gather") {
      dispatch("gather", TILE / 8, TILE / 8);
      if (++this.tileIndex === this.tiles) {
        this.tileIndex = 0;
        this.batchStart += batchCount;
        this.phase =
          this.batchStart < settings.photonsPerIteration ? "photon" : "update";
      }
    } else {
      dispatch("update", Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      this.iterations++;
      this.phase = "camera";
      this.tileIndex = 0;
      this.batchStart = 0;
      return true;
    }
    return false;
  }
  private densityPipeline?: GPUComputePipeline;
  private densityJob?: Promise<void>;
  private disposed = false;
  prepareDensity(): Promise<void> {
    return this.densityJob ??= (async () => {
      const module = await checkedShader(this.device, sppmShader, "Photon density");
      const pipeline = await this.device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint: "densityMain"}});
      if (!this.disposed) this.densityPipeline = pipeline;
    })();
  }
  encodeDensity(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    if (!this.points || !this.camera)
      throw new Error("Wait for SPPM before displaying photon density");
    const group = this.device.createBindGroup({
      layout: this.densityPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: this.camera } },
        { binding: 10, resource: { buffer: this.points } },
        { binding: 11, resource: { buffer: this.uniform } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.densityPipeline!);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(
      Math.ceil(this.width / 8),
      Math.ceil(this.height / 8),
    );
    pass.end();
  }
  releaseBuffers(): void {
    this.points?.destroy();
    this.photons?.destroy();
    this.heads?.destroy();
    this.points = undefined;
    this.photons = undefined;
    this.heads = undefined;
    this.groups = {};
    this.allocationKey = "";
    this.reset();
  }
  dispose(): void {
    this.disposed = true;
    this.releaseBuffers();
    this.uniform.destroy();
    this.indirect.destroy();
  }
}
