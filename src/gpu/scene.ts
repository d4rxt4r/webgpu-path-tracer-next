import type { PackedScene } from '../accel/pack';

export class GpuScene {
  readonly nodes: GPUBuffer;
  readonly triangles: GPUBuffer;
  readonly bytes: number;
  constructor(device: GPUDevice, scene: PackedScene) {
    if ([scene.nodes.byteLength, scene.triangles.byteLength].some(size => size > device.limits.maxStorageBufferBindingSize || size > device.limits.maxBufferSize)) throw new Error('Геометрия превышает лимиты GPU storage buffers.');
    if (scene.maxDepth >= 63) throw new Error('BVH exceeds traversal stack capacity');
    const upload = (data: ArrayBuffer, label: string): GPUBuffer => {
      const buffer = device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data)); buffer.unmap(); return buffer;
    };
    this.nodes = upload(scene.nodes, 'World-space SAH BVH');
    try { this.triangles = upload(scene.triangles, 'World-space triangles'); }
    catch (error) { this.nodes.destroy(); throw error; }
    this.bytes = scene.nodes.byteLength + scene.triangles.byteLength;
  }
  entries(): GPUBindGroupEntry[] { return [{ binding: 2, resource: { buffer: this.nodes } }, { binding: 3, resource: { buffer: this.triangles } }]; }
  dispose(): void { this.nodes.destroy(); this.triangles.destroy(); }
}
