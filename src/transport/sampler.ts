export function hash32(input: number): number {
  let value = input >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  return (value ^ value >>> 16) >>> 0;
}
export function sobolSample(index: number, dimension: number, pixel: number, seed: number, directions: Uint32Array): number {
  let value = 0, remaining = index >>> 0, bit = 0;
  while (remaining) { if (remaining & 1) value ^= directions[dimension * 32 + bit]!; remaining >>>= 1; bit++; }
  const scramble = hash32(pixel ^ hash32(seed) ^ hash32(dimension + 0x9e3779b9));
  let output = 0, prefix = 0;
  for (let level = 0; level < 24; level++) {
    const original = value >>> (31 - level) & 1;
    output = output << 1 | (original ^ (hash32(scramble ^ prefix ^ hash32(level)) & 1));
    prefix = prefix << 1 | original;
  }
  return Math.min(Math.fround(Math.fround(output + 0.5) / 16777216), Math.fround(0.99999994));
}
