@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<uniform> displayParams: DisplayParams;
struct VertexOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: VertexOutput;
  out.position = vec4f(p[index], 0, 1);
  out.uv = p[index] * 0.5 + 0.5;
  return out;
}
fn srgb(linear: vec3f) -> vec3f {
  return select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055, 12.92 * linear, linear <= vec3f(0.0031308));
}
@fragment fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
  let size = textureDimensions(image);
  let pixel = min(vec2u(vec2f(in.uv.x, 1.0-in.uv.y) * vec2f(size)), size - vec2u(1));
  let raw = textureLoad(image, vec2i(pixel), 0).rgb;
  let linear = max(select(raw, xyzToLinearRgb(raw), displayParams.colorSpace != 0u), vec3f(0));
  if (displayParams.debugView != 0u) { return vec4f(srgb(clamp(linear,vec3f(0),vec3f(1))),1); }
  let exposed = linear * displayParams.exposure;
  var mapped = exposed / (1.0 + exposed);
  if (displayParams.padding == 1u) { mapped = clamp((exposed*(2.51*exposed+0.03))/(exposed*(2.43*exposed+0.59)+0.14),vec3f(0),vec3f(1)); }
  if (displayParams.padding == 2u) { mapped = clamp(exposed,vec3f(0),vec3f(1)); }
  return vec4f(srgb(mapped), 1.0);
}
