struct SppmPoint {
  position: vec3f, surface: u32,
  normal: vec3f, valid: u32,
  weight: vec3f, padding0: u32,
  direct: vec3f, M: u32,
  phi: vec3f, radius: f32,
  tau: vec3f, N: f32,
  directSum: vec3f, iterations: u32,
}
struct Photon {
  position: vec3f, surface: u32,
  normal: vec3f, valid: u32,
  flux: vec3f, next: u32,
  cell: vec3i, padding: u32,
}
struct SppmParams {
  initialRadius: f32, photonsPerIteration: u32, batchStart: u32, batchCount: u32,
  batchSize: u32, hashMask: u32, iteration: u32, seed: u32,
}
