import type { EnvironmentSettings } from './environment';
export type Vec3 = [number, number, number];
export interface CameraDescription {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  verticalFov: number;
  depthOfField?: {
    enabled?: boolean;
    /** Diameter in metres, independent of exposure. */
    apertureDiameter?: number;
    focusMode?: "target" | "manual" | "point";
    focusDistance?: number;
    focusPoint?: Vec3;
    apertureShape?: "circle" | "polygon";
    blades?: number;
    /** Degrees. */
    rotation?: number;
  };
}
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  /** Connected-shell index for each triangle. */
  shells?: Uint32Array;
}
export interface SceneObject {
  visible?: boolean;
  mesh: number;
  material: number;
  transform: number[];
}
export type SpectrumTable = [number, number][];
export interface LegacySurfaceWear {
  scratches: number;
  scuffs: number;
  fingerprints: number;
  seed: number;
}
export interface WearEffect {
  enabled: boolean; intensity: number; scale: number; space: "model" | "scene"; seed: number;
  roughness: number; coverage: number; length: number; width: number; variation: number;
  direction: number; spread: number; relief: number; grainScale: number; grainContrast: number;
  softness: number; abrasionScale: number; count: number; aspect: number;
  ridgeSpacing: number; ridgeWidth: number; rubbed: number; contrast: number;
}
export interface SurfaceWearV2 {
  version: 2; scratches: WearEffect; scuffs: WearEffect; fingerprints: WearEffect;
}
export type SurfaceWear = LegacySurfaceWear | SurfaceWearV2;
interface TextureParameters {
  reflectance: Vec3;
  spectrum: SpectrumTable;
  secondary: Vec3;
  secondarySpectrum: SpectrumTable;
  scale: number;
  turbulence: number;
  width: number;
  coating: number;
  emissionPower: number;
}
export type TexturedMaterial = TextureParameters &
  ({ type: "marble" } | { type: "lava" });
export type MaterialDescription =
  | { type: "diffuse"; reflectance: Vec3; spectrum?: SpectrumTable }
  | { type: "emissive"; emission: Vec3; spectrum?: SpectrumTable }
  | {
      type: "dielectric";
      ior: number;
      thin?: boolean;
      absorption: Vec3;
      iorModel?: "constant" | "nbk7" | "cauchy";
      cauchy?: [number, number];
      roughness?: number;
      surfaceWear?: SurfaceWear;
      transmission?: Vec3;
      transmissionSpectrum?: SpectrumTable;
      absorptionSpectrum?: SpectrumTable;
    }
  | TexturedMaterial;
export interface AreaLightDescription {
  object: number;
}
export interface SceneDescription {
  environment?: EnvironmentSettings;
  version: 1;
  meshes: MeshData[];
  objects: SceneObject[];
  materials: MaterialDescription[];
  lights: AreaLightDescription[];
  camera: CameraDescription;
}
export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  na: Vec3;
  nb: Vec3;
  nc: Vec3;
  id: number;
  material: number;
  surface: number;
  boundary?: number;
}
export interface Ray {
  origin: Vec3;
  direction: Vec3;
  tMin: number;
  tMax: number;
}
