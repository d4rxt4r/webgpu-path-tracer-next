@group(0) @binding(0) var outputImage: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> params: CameraParams;
@group(0) @binding(4) var<storage, read_write> traversalErrors: atomic<u32>;
@group(0) @binding(8) var<storage, read_write> accumulation: array<vec4f>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (any(invocation.xy >= params.tile.zw)) { return; }
  let id = invocation.xy + params.tile.xy;
  if (any(id >= params.size)) { return; }
  let pixel = id.y * params.size.x + id.x;
  let jitter = vec2f(sample1D(params.frame, 0u, pixel, params.seed), sample1D(params.frame, 1u, pixel, params.seed));
  let uv = (vec2f(id) + jitter) / vec2f(params.size);
  let p = vec2f(2.0 * uv.x - 1.0, 1.0 - 2.0 * uv.y);
  let direction = normalize(params.forward.xyz + p.x * f32(params.size.x) / f32(params.size.y) * params.right.xyz + p.y * params.up.xyz);
  let result = tracePath(Ray(params.eye.xyz, 0.00001, direction, 1e20), params.frame, pixel, params.seed, params.maxDepth, params.strategy, params.lightCount);
  if (result.error != 0u) { atomicAdd(&traversalErrors, 1u); textureStore(outputImage, vec2i(id), vec4f(1, 0, 1, 1)); return; }
  let sum = accumulation[pixel] + vec4f(result.radiance, 1.0);
  accumulation[pixel] = sum;
  textureStore(outputImage, vec2i(id), vec4f(sum.xyz / sum.w, 1));
}
