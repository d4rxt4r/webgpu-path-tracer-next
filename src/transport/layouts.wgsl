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
}
struct Ray { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32 }
struct Hit { t: f32, id: u32, u: f32, v: f32, triangle: u32, visits: u32, error: u32, padding: u32 }
