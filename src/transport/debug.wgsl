@group(0) @binding(0) var outputImage: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> params: CameraParams;
@group(0) @binding(4) var<storage, read_write> traversalErrors: atomic<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(params.size);
  let p = vec2f(2.0 * uv.x - 1.0, 1.0 - 2.0 * uv.y);
  let direction = normalize(params.forward.xyz + p.x * f32(params.size.x) / f32(params.size.y) * params.right.xyz + p.y * params.up.xyz);
  let hit = closestHit(Ray(params.eye.xyz, 0.00001, direction, 1e20));
  var color = vec3f(0.0);
  if (hit.error != 0u) { atomicAdd(&traversalErrors, 1u); color = vec3f(1, 0, 1); }
  else if (hit.id != NO_HIT) {
    if (params.view == 0u) { color = shadingNormal(triangles[hit.triangle], hit) * 0.5 + 0.5; }
    else if (params.view == 1u) { color = vec3f(exp(-0.3 * hit.t)); }
    else if (params.view == 2u) { let t = f32(hit.visits) / 64.0; color = vec3f(t, t * t, 0.08); }
    else { let id = f32(triangles[hit.triangle].material+1u); color = fract(sin(vec3f(id,id+2.0,id+7.0))*43758.5453); }
  }
  textureStore(outputImage, vec2i(id.xy), vec4f(color, 1));
}
