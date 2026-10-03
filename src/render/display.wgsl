@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var<uniform> displayParams: DisplayParams;
struct VertexOutput { @builtin(position) position: vec4f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: VertexOutput;
  out.position = vec4f(p[index], 0, 1);
  return out;
}
fn srgb(linear: vec3f) -> vec3f {
  return select(1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055, 12.92 * linear, linear <= vec3f(0.0031308));
}
@fragment fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
  let size = textureDimensions(image);
  let pixel = min(vec2u(in.position.xy), size - vec2u(1));
  let linear = max(textureLoad(image, vec2i(pixel), 0).rgb, vec3f(0));
  if (displayParams.debugView != 0u) { return vec4f(srgb(clamp(linear,vec3f(0),vec3f(1))),1); }
  let exposed = linear * displayParams.exposure;
  return vec4f(srgb(exposed / (1.0 + exposed)), 1.0);
}
