import { specializeSurfaceWear } from "../transport/wear-source";
import { pipelineVariant } from "./pipeline-variants";
import { checkedShader } from "../gpu/device";
import { intersectionCore, surfaceWearCore } from "../transport/shaders";
import guideSource from "./guide.wgsl?raw";
import filterSource from "./atrous.wgsl?raw";
import type { GpuScene } from "../gpu/scene";

export interface DenoiseSettings {
  enabled: boolean;
  imageOnly?: boolean;
  passes: number;
  strength: number;
  filterGlass: boolean;
  algorithm?: "atrous" | "bilateral" | "nlm";
  glassMode?: "off" | "surface" | "image";
  glassStrength?: number;
  blend?: number;
  normalPower?: number;
  depthScale?: number;
  radius?: number;
  compare?: boolean;
  split?: number;
}
export const denoiseDefaults = { algorithm: "atrous", glassStrength: 1, blend: 1,
  normalPower: 32, depthScale: 0.015, radius: 2, compare: false, split: 0.5 } as const;
export function resolveDenoise(settings: DenoiseSettings) {
  const next = { ...denoiseDefaults, radius: settings.algorithm === "nlm" ? 3 : 2,
    ...settings, glassMode: settings.glassMode ?? (settings.filterGlass ? "surface" : "off") };
  if ([next.enabled, next.filterGlass, next.compare].some(value => typeof value !== "boolean")) throw new Error("Invalid denoiser settings");
  if (!["atrous", "bilateral", "nlm"].includes(next.algorithm) || !["off", "surface", "image"].includes(next.glassMode)) throw new Error("Invalid denoiser mode");
  for (const [value, min, max, integer] of [
    [next.passes, 1, 5, true], [next.strength, .1, 10, false], [next.glassStrength, .1, 5, false],
    [next.blend, 0, 1, false], [next.normalPower, 0, 128, false], [next.depthScale, .001, .1, false],
    [next.radius, 1, 5, true], [next.split, 0, 1, false],
  ] as const) if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error("Invalid denoiser settings");
  return next;
}
export class Denoiser {
  private guides?: GPUTexture;
  private images: GPUTexture[] = [];
  private uniforms: GPUBuffer[] = [];
  private guideGroup?: GPUBindGroup;
  private groups: GPUBindGroup[] = [];
  private width = 0;
  private height = 0;
  private constructor(
    private device: GPUDevice,
    private guidePipeline: GPUComputePipeline,
    private filterPipeline: GPUComputePipeline,
  ) {}
  static async create(device: GPUDevice, timing?: (entry: string, milliseconds: number) => void, wearMask = 7): Promise<Denoiser> {
    const [gp, fp] = await this.compilePipelines(device, timing, wearMask);
    const denoiser = new Denoiser(device, gp, fp); denoiser.wearMask = wearMask; return denoiser;
  }
  private wearMask = -1;
  private wearRevision = 0;
  private static async compilePipelines(device: GPUDevice, timing: ((entry: string, milliseconds: number) => void) | undefined, wearMask: number) {
    const compile = async (source: string, label: string, entryPoint: string) => {
      const module = await checkedShader(device, source, label), started = performance.now();
      const pipeline = await device.createComputePipelineAsync({layout: "auto", compute: {module, entryPoint}});
      timing?.(entryPoint, performance.now() - started);
      return pipeline;
    };
    return Promise.all([
      pipelineVariant(device, "denoise-guides", wearMask, () => compile(
        specializeSurfaceWear(intersectionCore + "\n" + surfaceWearCore + "\n" + guideSource, wearMask), "Denoise guides", "guideMain")),
      pipelineVariant(device, "denoise-filter", 0, () => compile(filterSource, "Spatial denoising", "filterMain")),
    ]);
  }
  async setWearMask(mask: number): Promise<boolean> {
    const revision = ++this.wearRevision;
    if (mask === this.wearMask) return false;
    const [guide] = await Denoiser.compilePipelines(this.device, undefined, mask);
    if (revision !== this.wearRevision) return false;
    this.guidePipeline = guide; this.wearMask = mask; return true;
  }
  get bytes(): number {
    return this.width * this.height * 32 + this.uniforms.length * 64;
  }
  configure(
    raw: GPUTexture,
    scene: GpuScene,
    camera: GPUBuffer,
    errors: GPUBuffer,
  ): void {
    if (raw.width !== this.width || raw.height !== this.height) {
      this.dispose();
      this.width = raw.width;
      this.height = raw.height;
      this.guides = this.device.createTexture({
        label: "First-hit normals and signed depth",
        size: [this.width, this.height],
        format: "rgba32float",
        usage:
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.images = Array.from({ length: 2 }, () =>
        this.device.createTexture({
          label: "Display-only denoising",
          size: [this.width, this.height],
          format: "rgba16float",
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        }),
      );
      this.uniforms = Array.from({ length: 5 }, () =>
        this.device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }
    this.guideGroup = this.device.createBindGroup({
      layout: this.guidePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.guides!.createView() },
        { binding: 1, resource: { buffer: camera } },
        ...scene.entries(),
        { binding: 4, resource: { buffer: errors } },
        scene.transportEntries()[0]!,
      ],
    });
    this.groups = this.uniforms.map((uniform, i) =>
      this.device.createBindGroup({
        layout: this.filterPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: (i === 0 ? raw : this.images[(i - 1) % 2]!).createView(),
          },
          { binding: 1, resource: raw.createView() },
          { binding: 2, resource: this.guides!.createView() },
          { binding: 3, resource: this.images[i % 2]!.createView() },
          { binding: 4, resource: { buffer: uniform } },
        ],
      }),
    );
  }
  encode(
    encoder: GPUCommandEncoder,
    settings: DenoiseSettings,
    spectral: boolean,
    refreshGuides: boolean,
  ): GPUTexture {
    const config = resolveDenoise(settings);
    if (refreshGuides) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.guidePipeline);
      pass.setBindGroup(0, this.guideGroup!);
      pass.dispatchWorkgroups(
        Math.ceil(this.width / 8),
        Math.ceil(this.height / 8),
      );
      pass.end();
    }
    const passes = config.algorithm === "atrous" ? config.passes : 1;
    for (let i = 0; i < passes; i++) {
      const data = new ArrayBuffer(64),
        view = new DataView(data);
      view.setUint32(0, 2 ** i, true);
      view.setFloat32(4, settings.strength, true);
      view.setUint32(8, ["off", "surface", "image"].indexOf(config.glassMode), true);
      view.setUint32(12, Number(spectral), true);
      view.setUint32(16, ["atrous", "bilateral", "nlm"].indexOf(config.algorithm), true);
      view.setUint32(20, config.radius, true);
      view.setFloat32(24, config.normalPower, true);
      view.setFloat32(28, config.depthScale, true);
      view.setFloat32(32, config.glassStrength, true);
      view.setFloat32(36, config.blend, true);
      view.setUint32(40, Number(i === passes - 1), true);
      view.setUint32(44, Number(config.compare), true);
      view.setFloat32(48, config.split, true);
      view.setFloat32(52, Number(settings.imageOnly ?? false), true);
      this.device.queue.writeBuffer(this.uniforms[i]!, 0, data);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.filterPipeline);
      pass.setBindGroup(0, this.groups[i]!);
      pass.dispatchWorkgroups(
        Math.ceil(this.width / 8),
        Math.ceil(this.height / 8),
      );
      pass.end();
    }
    return this.images[(passes - 1) % 2]!;
  }
  dispose(): void {
    this.guides?.destroy();
    for (const image of this.images) image.destroy();
    for (const uniform of this.uniforms) uniform.destroy();
    this.guides = undefined;
    this.images = [];
    this.uniforms = [];
    this.groups = [];
    this.guideGroup = undefined;
    this.width = 0;
    this.height = 0;
  }
}
