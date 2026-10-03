struct Params { size: vec2u, frame: u32, padding: u32 }
@group(0) @binding(0) var outputImage: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> params: Params;

// Foundation diagnostic, deliberately not a light transport integrator.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(params.size);
  let aspect = f32(params.size.x) / f32(params.size.y);
  let p = (uv - 0.5) * vec2f(aspect, 1.0);
  let grid = select(0.0, 0.035, (u32(uv.x * 32.0) + u32(uv.y * 24.0)) % 2u == 0u);
  let ring = exp(-2200.0 * pow(length(p) - 0.24, 2.0));
  let color = vec3f(0.018 + grid, 0.025 + grid, 0.045 + grid) + ring * vec3f(0.12, 0.65, 0.9);
  textureStore(outputImage, vec2i(id.xy), vec4f(color, 1.0));
}
