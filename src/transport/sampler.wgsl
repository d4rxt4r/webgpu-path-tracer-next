@group(0) @binding(7) var<storage, read> sobolDirections: array<u32>;
fn hash32(input: u32) -> u32 {
  var v = input;
  v ^= v >> 16u; v *= 0x7feb352du; v ^= v >> 15u; v *= 0x846ca68bu; v ^= v >> 16u;
  return v;
}
// Nested binary Owen scrambling at all 24 bits used by the f32 sample.
fn sample1D(index: u32, dimension: u32, pixel: u32, seed: u32) -> f32 {
  var value = 0u; var remaining = index; var bit = 0u;
  loop {
    if (remaining == 0u) { break; }
    if ((remaining & 1u) != 0u) { value ^= sobolDirections[dimension * 32u + bit]; }
    remaining >>= 1u; bit++;
  }
  let scramble = hash32(pixel ^ hash32(seed) ^ hash32(dimension + 0x9e3779b9u));
  var output = 0u; var prefix = 0u;
  for (var level = 0u; level < 24u; level++) {
    let original = (value >> (31u - level)) & 1u;
    let flip = hash32(scramble ^ prefix ^ hash32(level)) & 1u;
    output = (output << 1u) | (original ^ flip);
    prefix = (prefix << 1u) | original;
  }
  return min((f32(output) + 0.5) * (1.0 / 16777216.0), 0.99999994);
}
