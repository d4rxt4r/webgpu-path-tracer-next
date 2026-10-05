struct Triangle {
  a: vec3f, material: u32,
  b: vec3f, id: u32,
  c: vec3f, surface: u32,
  na: vec3f, padding0: u32,
  nb: vec3f, padding1: u32,
  nc: vec3f, padding2: u32,
}
struct BvhNode { min: vec3f, first: u32, max: vec3f, count: u32 }
struct CameraParams {
  size: vec2u, frame: u32, view: u32,
  eye: vec4f, forward: vec4f, right: vec4f, up: vec4f,
  tile: vec4u,
  maxDepth: u32, seed: u32, strategy: u32, lightCount: u32,
  transportMode: u32, padding0: u32, padding1: u32, padding2: u32,
  initialShells: array<vec4u,8>,
}
struct Material {
  color: vec3f, kind: u32, absorption: vec3f, ior: f32,
  spectrumOffset: u32, absorptionOffset: u32, iorModel: u32, padding: u32,
  textureParams: vec4f, worldToTexture: mat4x4f,
  wearParams: vec4f, wearBounds: vec4f,
}
struct LightTriangle { a: vec3f, area: f32, b: vec3f, probability: f32, c: vec3f, triangleId: u32, emission: vec3f, cdf: f32, spectrumOffset: u32, material: u32, padding1: u32, padding2: u32 }
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32 }
struct Hit { t: f32, id: u32, u: f32, v: f32, triangle: u32, visits: u32, error: u32, padding: u32 }
struct DisplayParams { exposure: f32, debugView: u32, colorSpace: u32, padding: u32 }
