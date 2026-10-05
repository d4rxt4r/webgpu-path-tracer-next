import { makeShaderDataDefinitions } from "webgpu-utils";
import sppmLayouts from "../transport/sppm-layouts.wgsl?raw";
export const PHOTON_BYTES = makeShaderDataDefinitions(sppmLayouts).structs.Photon!.size;

/** Shared UI and renderer limits; device capabilities may impose smaller sizes. */
export const settingsLimits = {
  maxPixels: 3840 * 2160,
  minMemoryMiB: 64,
  maxMemoryMiB: 4096,
  maxPhotons: 4194304,
  maxPhotonBatch: 16384,
  maxDepth: 64,
} as const;

export function photonAllocation(batch: number, depth: number): { photons: number; heads: number; workgroups: number } {
  const slots = batch * (depth + 1);
  return { photons: slots * PHOTON_BYTES, heads: 2 ** Math.ceil(Math.log2(slots * 2)) * 4, workgroups: Math.ceil(slots / 64) };
}

export function checkPhotonLimits(batch: number, depth: number, limits: Pick<GPUSupportedLimits, "maxBufferSize" | "maxStorageBufferBindingSize" | "maxComputeWorkgroupsPerDimension">): void {
  const sizes = photonAllocation(batch, depth);
  if (Math.max(sizes.photons, sizes.heads) > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) || sizes.workgroups > limits.maxComputeWorkgroupsPerDimension)
    throw new Error("Фотонный пакет превышает лимиты GPU. Уменьшите пакет или глубину пути.");
}
