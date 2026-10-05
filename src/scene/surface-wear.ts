import type { SurfaceWear } from "./types";

export const wearControlIds = ["wear-scratches", "wear-scuffs", "wear-fingerprints", "wear-seed"] as const;
export const cleanSurface: SurfaceWear = { scratches: 0, scuffs: 0, fingerprints: 0, seed: 1 };
export const rastagotchiWear: SurfaceWear = { scratches: 0.5, scuffs: 0.5, fingerprints: 0.5, seed: 1 };

export function validateSurfaceWear(wear: SurfaceWear): void {
  if (![wear.scratches, wear.scuffs, wear.fingerprints].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      || !Number.isInteger(wear.seed) || wear.seed < 1 || wear.seed > 65535)
    throw new Error("Invalid dielectric surface wear");
}

export function hasSurfaceWear(wear: SurfaceWear | undefined): boolean {
  return !!wear && (wear.scratches > 0 || wear.scuffs > 0 || wear.fingerprints > 0);
}
