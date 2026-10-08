import { hdrDistribution, hdrMipmaps, type HdrImage } from '../assets/hdr';
import { defaultEnvironment, type EnvironmentSettings } from '../scene/environment';
import { illuminantBasisData } from '../transport/environment-spectrum';
import type { PackedScene } from '../accel/pack';
import type { PackedTransport } from '../accel/materials';

export class GpuEnvironment {
  readonly uniform: GPUBuffer;
  readonly map: GPUTexture;
  readonly distribution: GPUTexture;
  readonly basis: GPUTexture;
  readonly bytes: number;
  private integral: number;
  private bounds = [0, 1, 0, 1];
  private areaPower = 0;
  static byteSize(image?: HdrImage): number {
    const width = image?.width ?? 1, height = image?.height ?? 1;
    let w = width, h = height, total = 0;
    for (;;) { total += w * h * 16; if (w === 1 && h === 1) break; w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2)); }
    return total + width * height * 16 + 32 * 7 * 4 + 80;
  }
  constructor(private device: GPUDevice, image?: HdrImage) {
    image ??= { width: 1, height: 1, pixels: new Float32Array([0, 0, 0, 1]) };
    if (image.width > device.limits.maxTextureDimension2D || image.height > device.limits.maxTextureDimension2D) throw new Error('HDR превышает размер текстуры GPU.');
    this.bytes = GpuEnvironment.byteSize(image);
    const levels = hdrMipmaps(image), distribution = hdrDistribution(image); this.integral = distribution.integral;
    this.uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const allocated: GPUTexture[] = [];
    try {
      this.map = device.createTexture({ label: 'Linear HDR environment', size: [image.width, image.height], format: 'rgba32float', mipLevelCount: levels.length, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); allocated.push(this.map);
      for (const [mipLevel, level] of levels.entries()) device.queue.writeTexture({ texture: this.map, mipLevel }, level.pixels as Float32Array<ArrayBuffer>, { bytesPerRow: level.width * 16 }, [level.width, level.height]);
      this.distribution = device.createTexture({ label: 'Environment solid angle CDF', size: [image.width, image.height], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); allocated.push(this.distribution);
      device.queue.writeTexture({ texture: this.distribution }, distribution.pixels as Float32Array<ArrayBuffer>, { bytesPerRow: image.width * 16 }, [image.width, image.height]);
      this.basis = device.createTexture({ label: 'PBRT illuminant RGB spectral bases', size: [32, 7], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); allocated.push(this.basis);
      device.queue.writeTexture({ texture: this.basis }, illuminantBasisData as Float32Array<ArrayBuffer>, { bytesPerRow: 128 }, [32, 7]);
      this.update(defaultEnvironment);
    } catch (error) { allocated.forEach(texture => texture.destroy()); this.uniform.destroy(); throw error; }
  }
  setScene(scene: PackedScene & PackedTransport): void {
    const nodes = new Float32Array(scene.nodes);
    this.bounds = [0, 1, 2].map(i => (nodes[i]! + nodes[4 + i]!) / 2);
    this.bounds.push(Math.max(.001, Math.hypot(...[0, 1, 2].map(i => (nodes[4 + i]! - nodes[i]!) / 2)) * 1.01));
    const lights = new Float32Array(scene.lights); this.areaPower = 0;
    for (let i = 0; i < scene.lightCount; i++) this.areaPower += lights[i * 20 + 3]! * Math.PI * (.2126 * lights[i * 20 + 12]! + .7152 * lights[i * 20 + 13]! + .0722 * lights[i * 20 + 14]!);
  }
  update(settings: EnvironmentSettings): void {
    if (!['off', 'color', 'hdr'].includes(settings.source) || !settings.color.every(v => Number.isFinite(v) && v >= 0 && v <= 1) || !Number.isFinite(settings.strength) || settings.strength < 0 || !Number.isFinite(settings.rotation) || settings.rotation < 0 || settings.rotation > 360 || !Number.isFinite(settings.exposure) || Math.abs(settings.exposure) > 8 || !Number.isFinite(settings.blur) || settings.blur < 0 || settings.blur > 1) throw new Error('Некорректные настройки окружения.');
    const luminance = settings.color[0] * .2126 + settings.color[1] * .7152 + settings.color[2] * .0722;
    const integral = settings.source === 'color' ? 4 * Math.PI : this.integral;
    const power = settings.source === 'off' ? 0 : integral * settings.strength * luminance * Math.PI * this.bounds[3]! ** 2;
    const p = power > 0 ? (this.areaPower > 0 ? Math.min(.99, Math.max(.01, power / (power + this.areaPower))) : 1) : 0;
    const packed = new Float32Array([
      ...settings.color, settings.strength,
      settings.source === 'off' ? 0 : settings.source === 'color' ? 1 : 2, settings.rotation * Math.PI / 180, Number(settings.background), 2 ** settings.exposure,
      settings.blur * (this.map.mipLevelCount - 1), p, this.map.width, this.map.height,
      ...this.bounds, 0, 0, 0, 0,
    ]);
    if (![power, power + this.areaPower, ...packed].every(Number.isFinite)) throw new Error("Параметры окружения превышают числовые пределы GPU. Уменьшите яркость.");
    this.device.queue.writeBuffer(this.uniform, 0, packed);
  }
  entries(): GPUBindGroupEntry[] { return [
    { binding: 12, resource: { buffer: this.uniform } },
    { binding: 13, resource: this.map.createView() },
    { binding: 14, resource: this.distribution.createView() },
    { binding: 15, resource: this.basis.createView() },
  ]; }
  dispose(): void { this.uniform.destroy(); this.map.destroy(); this.distribution.destroy(); this.basis.destroy(); }
}
