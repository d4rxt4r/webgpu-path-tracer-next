import { checkedShader } from "../gpu/device";
import { intersectionCore } from "../transport/shaders";
import guideSource from "./guide.wgsl?raw";
import filterSource from "./atrous.wgsl?raw";
import type { GpuScene } from "../gpu/scene";

export interface DenoiseSettings {
  enabled: boolean;
  passes: number;
  strength: number;
  filterGlass: boolean;
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
  static async create(device: GPUDevice): Promise<Denoiser> {
    const [guide, filter] = await Promise.all([
      checkedShader(
        device,
        intersectionCore + "\n" + guideSource,
        "Denoise guides",
      ),
      checkedShader(device, filterSource, "Spatial à-trous"),
    ]);
    const [gp, fp] = await Promise.all([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: guide, entryPoint: "guideMain" },
      }),
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: filter, entryPoint: "filterMain" },
      }),
    ]);
    return new Denoiser(device, gp, fp);
  }
  get bytes(): number {
    return this.width * this.height * 32 + this.uniforms.length * 16;
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
          label: "Display-only à-trous",
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
          size: 16,
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
    for (let i = 0; i < settings.passes; i++) {
      const data = new ArrayBuffer(16),
        view = new DataView(data);
      view.setUint32(0, 2 ** i, true);
      view.setFloat32(4, settings.strength, true);
      view.setUint32(8, Number(settings.filterGlass), true);
      view.setUint32(12, Number(spectral), true);
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
    return this.images[(settings.passes - 1) % 2]!;
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
