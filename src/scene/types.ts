export type Vec3 = [number, number, number];
export interface CameraDescription { position: Vec3; target: Vec3; up: Vec3; verticalFov: number }
export interface MeshData { positions: Float32Array; indices: Uint32Array; normals?: Float32Array }
export interface SceneObject { mesh: number; material: number; transform: number[] }
export type MaterialDescription =
  | { type: 'diffuse'; reflectance: Vec3 }
  | { type: 'emissive'; emission: Vec3 }
  | { type: 'dielectric'; ior: number; absorption: Vec3 };
export interface AreaLightDescription { object: number }
export interface SceneDescription {
  version: 1; meshes: MeshData[]; objects: SceneObject[];
  materials: MaterialDescription[]; lights: AreaLightDescription[]; camera: CameraDescription;
}
export interface Triangle { a: Vec3; b: Vec3; c: Vec3; na: Vec3; nb: Vec3; nc: Vec3; id: number; material: number; surface: number }
export interface Ray { origin: Vec3; direction: Vec3; tMin: number; tMax: number }
