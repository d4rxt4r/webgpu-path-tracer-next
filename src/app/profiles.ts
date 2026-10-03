import type { PathSettings } from "../render/intersection-renderer";
export type Profile = "preview" | "reference" | "quality" | "custom";
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
};
