import type { PackedScene } from '../accel/pack';
import type { PackedTransport } from '../accel/materials';

export class GpuScene {
  readonly nodes: GPUBuffer;
  readonly triangles: GPUBuffer;
  readonly materials: GPUBuffer;
  readonly lights: GPUBuffer;
  readonly spectra: GPUBuffer;
  readonly bytes: number;
  constructor(device: GPUDevice, scene: PackedScene & PackedTransport) {
    if ([scene.nodes.byteLength, scene.triangles.byteLength, scene.materials.byteLength, scene.lights.byteLength, scene.spectra.byteLength].some(size => size > device.limits.maxStorageBufferBindingSize || size > device.limits.maxBufferSize)) throw new Error('Сцена превышает лимиты GPU storage buffers.');
    if (scene.maxDepth >= 63) throw new Error('BVH exceeds traversal stack capacity');
    const upload = (data: ArrayBuffer, label: string): GPUBuffer => {
      const buffer = device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
      new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data)); buffer.unmap(); return buffer;
    };
    this.nodes = upload(scene.nodes, 'World-space SAH BVH');
    const allocated = [this.nodes];
    try {
      this.triangles = upload(scene.triangles, 'World-space triangles'); allocated.push(this.triangles);
      this.materials = upload(scene.materials, 'Transport materials'); allocated.push(this.materials);
      this.lights = upload(scene.lights, 'Area light triangles'); allocated.push(this.lights);
      this.spectra = upload(scene.spectra, 'CIE and material spectra');
    }
    catch (error) { allocated.forEach(buffer => buffer.destroy()); throw error; }
    this.bytes = scene.nodes.byteLength + scene.triangles.byteLength + scene.materials.byteLength + scene.lights.byteLength + scene.spectra.byteLength;
  }
  entries(): GPUBindGroupEntry[] { return [{ binding: 2, resource: { buffer: this.nodes } }, { binding: 3, resource: { buffer: this.triangles } }]; }
  transportEntries(): GPUBindGroupEntry[] { return [{ binding: 5, resource: { buffer: this.materials } }, { binding: 6, resource: { buffer: this.lights } }]; }
  spectralEntry(): GPUBindGroupEntry { return { binding: 9, resource: { buffer: this.spectra } }; }
  dispose(): void { this.nodes.destroy(); this.triangles.destroy(); this.materials.destroy(); this.lights.destroy(); this.spectra.destroy(); }
}
