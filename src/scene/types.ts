export type Vec3 = [number, number, number];
export interface CameraDescription {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  verticalFov: number;
}
export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
}
export interface SceneObject {
  mesh: number;
  material: number;
  transform: number[];
}
export type SpectrumTable = [number, number][];
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
      absorption: Vec3;
      iorModel?: "constant" | "nbk7";
      absorptionSpectrum?: SpectrumTable;
    }
  | TexturedMaterial;
export interface AreaLightDescription {
  object: number;
}
export interface SceneDescription {
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
}
export interface Ray {
  origin: Vec3;
  direction: Vec3;
  tMin: number;
  tMax: number;
}
