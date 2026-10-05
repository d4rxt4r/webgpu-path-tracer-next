import type { PathSettings } from "../render/intersection-renderer";
export type Profile =
  | "preview" | "reference" | "quality"
  | "reference-fhd" | "reference-qhd" | "reference-4k"
  | "quality-fhd" | "quality-qhd" | "quality-4k"
  | "custom";
export const profileLabels: Record<Exclude<Profile, "custom">, string> = {
  preview: "Preview", reference: "Reference", quality: "Quality",
  "reference-fhd": "Reference Full HD", "reference-qhd": "Reference QHD", "reference-4k": "Reference 4K",
  "quality-fhd": "Quality Full HD", "quality-qhd": "Quality QHD", "quality-4k": "Quality 4K",
};
export const qualityProfile = (profile: Profile): boolean => profile === "quality" || profile.startsWith("quality-");
export const profiles: Record<
  Exclude<Profile, "custom">,
  Partial<PathSettings>
> = {
  preview: {
    mode: "rgb",
    integrator: "pt",
    maxDepth: 8,
    maxPixels: 19200,
    strategy: "mis",
  },
  reference: {
    mode: "spectral",
    integrator: "pt",
    maxDepth: 64,
    maxPixels: 307200,
    strategy: "mis",
  },
  quality: {
    mode: "spectral",
    integrator: "sppm",
    maxDepth: 32,
    maxPixels: 307200,
    strategy: "mis",
    photonsPerIteration: 16384,
    photonBatchSize: 1024,
    initialRadius: 0.03,
  },
  "reference-fhd": {
    mode: "spectral",
    integrator: "pt",
    maxDepth: 64,
    strategy: "mis",
    maxPixels: 1920 * 1080,
    memoryBudgetMiB: 512,
  },
  "reference-qhd": {
    mode: "spectral",
    integrator: "pt",
    maxDepth: 64,
    strategy: "mis",
    maxPixels: 2560 * 1440,
    memoryBudgetMiB: 1024,
  },
  "reference-4k": {
    mode: "spectral",
    integrator: "pt",
    maxDepth: 64,
    strategy: "mis",
    maxPixels: 3840 * 2160,
    memoryBudgetMiB: 2048,
  },
  "quality-fhd": {
    mode: "spectral",
    integrator: "sppm",
    maxDepth: 32,
    strategy: "mis",
    maxPixels: 1920 * 1080,
    memoryBudgetMiB: 1024,
    photonsPerIteration: 65536,
    photonBatchSize: 2048,
    initialRadius: 0.03,
  },
  "quality-qhd": {
    mode: "spectral",
    integrator: "sppm",
    maxDepth: 32,
    strategy: "mis",
    maxPixels: 2560 * 1440,
    memoryBudgetMiB: 2048,
    photonsPerIteration: 131072,
    photonBatchSize: 4096,
    initialRadius: 0.03,
  },
  "quality-4k": {
    mode: "spectral",
    integrator: "sppm",
    maxDepth: 32,
    strategy: "mis",
    maxPixels: 3840 * 2160,
    memoryBudgetMiB: 4096,
    photonsPerIteration: 262144,
    photonBatchSize: 4096,
    initialRadius: 0.03,
  },
};
