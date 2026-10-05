export interface HdrImage { width: number; height: number; pixels: Float32Array }
export const HDR_MAX_BYTES = 128 * 1048576;

/** Decode scanlines directly into a solid-angle weighted smaller image. */
export function decodeHdr(buffer: ArrayBuffer, quality = 2048): HdrImage {
  if (buffer.byteLength > HDR_MAX_BYTES) throw new Error('HDR превышает 128 MiB.');
  if (![1024, 2048, 4096].includes(quality)) throw new Error('Недопустимое разрешение HDR.');
  const bytes = new Uint8Array(buffer); let cursor = 0;
  const line = () => {
    const start = cursor;
    while (cursor < bytes.length && bytes[cursor] !== 10) cursor++;
    if (cursor === bytes.length || cursor - start > 8192) throw new Error('Повреждён заголовок HDR.');
    return new TextDecoder().decode(bytes.subarray(start, cursor++)).replace(/\r$/, '');
  };
  if (!/^#\?(RADIANCE|RGBE)$/.test(line())) throw new Error('Ожидается Radiance .hdr.');
  let format = false;
  for (;;) { const text = line(); if (!text) break; if (text === 'FORMAT=32-bit_rle_rgbe') format = true; }
  if (!format) throw new Error('Поддерживается только RGBE HDR.');
  const match = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(line());
  if (!match || match[2] === match[5]) throw new Error('Некорректные оси HDR.');
  const outer = Number(match[3]), inner = Number(match[6]);
  const sourceWidth = match[2] === 'X' ? outer : inner, sourceHeight = match[2] === 'Y' ? outer : inner;
  if (!sourceWidth || sourceWidth > 8192 || sourceHeight > 4096 || sourceWidth !== 2 * sourceHeight) throw new Error('HDR должен быть панорамой 2:1, не больше 8192×4096.');
  const width = Math.min(quality, sourceWidth), height = width / 2;
  const sums = new Float64Array(width * height * 4), scan = new Uint8Array(inner * 4);
  const take = () => { if (cursor >= bytes.length) throw new Error('HDR неожиданно закончился.'); return bytes[cursor++]!; };
  for (let row = 0; row < outer; row++) {
    const a = take(), b = take(), c = take(), d = take();
    if (inner >= 8 && a === 2 && b === 2 && c < 128) {
      if ((c * 256 + d) !== inner) throw new Error('Некорректная длина RLE HDR.');
      for (let channel = 0; channel < 4; channel++) {
        let x = 0;
        while (x < inner) {
          const code = take(), count = code > 128 ? code - 128 : code;
          if (!count || x + count > inner) throw new Error('Повреждён RLE HDR.');
          if (code > 128) { const value = take(); for (let i = 0; i < count; i++) scan[(x++) * 4 + channel] = value; }
          else for (let i = 0; i < count; i++) scan[(x++) * 4 + channel] = take();
        }
      }
    } else {
      scan.set([a, b, c, d]);
      for (let i = 4; i < scan.length; i++) scan[i] = take();
    }
    for (let col = 0; col < inner; col++) {
      const first = match[1] === (match[2] === 'X' ? '+' : '-') ? row : outer - 1 - row;
      const second = match[4] === (match[5] === 'X' ? '+' : '-') ? col : inner - 1 - col;
      const sx = match[2] === 'X' ? first : second, sy = match[2] === 'Y' ? first : second;
      // Exact overlap handles non power-of-two input without losing highlights.
      const x0 = sx * width / sourceWidth, x1 = (sx + 1) * width / sourceWidth;
      const y0 = sy * height / sourceHeight, y1 = (sy + 1) * height / sourceHeight;
      const exponent = scan[col * 4 + 3]!, factor = exponent ? 2 ** (exponent - 136) : 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const weight = (Math.min(x1, x + 1) - Math.max(x0, x)) *
          (Math.cos(Math.max(y0, y) * Math.PI / height) - Math.cos(Math.min(y1, y + 1) * Math.PI / height));
        const offset = (y * width + x) * 4;
        for (let k = 0; k < 3; k++) sums[offset + k] = sums[offset + k]! + scan[col * 4 + k]! * factor * weight;
        sums[offset + 3] = sums[offset + 3]! + weight;
      }
    }
  }
  const pixels = new Float32Array(sums.length);
  for (let i = 0; i < pixels.length; i += 4) {
    for (let k = 0; k < 3; k++) pixels[i + k] = sums[i + k]! / sums[i + 3]!;
    pixels[i + 3] = 1;
  }
  return { width, height, pixels };
}

export function solidAngle(width: number, height: number, y: number): number {
  return 2 * Math.PI / width * (Math.cos(y * Math.PI / height) - Math.cos((y + 1) * Math.PI / height));
}

/** Per-row conditional CDF plus marginal CDF, packed into RGBA32F. */
export function hdrDistribution(image: HdrImage): { pixels: Float32Array; integral: number } {
  const { width, height } = image, pixels = new Float32Array(width * height * 4);
  const rows = new Float64Array(height), masses = new Float64Array(width * height); let integral = 0;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luminance = image.pixels[i]! * .2126 + image.pixels[i + 1]! * .7152 + image.pixels[i + 2]! * .0722;
      // The proposal below adds uniform texel support for interpolation and tint changes.
      const mass = Math.max(0, luminance) * solidAngle(width, height, y);
      masses[y * width + x] = mass; sum += mass;
    }
    rows[y] = sum; integral += sum;
  }
  let marginal = 0, previousRow = 0;
  for (let y = 0; y < height; y++) {
    // Uniform rows keep polar CDF increments representable in float32.
    const rowProbability = integral > 0 ? .99 * rows[y]! / integral + .01 / height : 1 / height;
    marginal += rowProbability;
    const rowCdf = y === height - 1 ? 1 : Math.fround(marginal), actualRowProbability = rowCdf - previousRow;
    previousRow = rowCdf; let conditional = 0, previousColumn = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const probability = rows[y]! > 0 ? .99 * masses[y * width + x]! / rows[y]! + .01 / width : 1 / width;
      conditional += probability;
      pixels[i] = x === width - 1 ? 1 : conditional;
      pixels[i + 1] = rowCdf;
      pixels[i + 2] = (pixels[i]! - previousColumn) * actualRowProbability / solidAngle(width, height, y);
      previousColumn = pixels[i]!;
    }
  }
  return { pixels, integral };
}

export function hdrMipmaps(image: HdrImage): HdrImage[] {
  const levels = [image];
  while (image.width > 1 || image.height > 1) {
    const width = Math.max(1, Math.floor(image.width / 2)), height = Math.max(1, Math.floor(image.height / 2));
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let weight = 0;
      const x0 = x * image.width / width, x1 = (x + 1) * image.width / width;
      const y0 = y * image.height / height, y1 = (y + 1) * image.height / height;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = (Math.min(x1, sx + 1) - Math.max(x0, sx)) *
            (Math.cos(Math.max(y0, sy) * Math.PI / image.height) - Math.cos(Math.min(y1, sy + 1) * Math.PI / image.height));
          weight += w;
          for (let k = 0; k < 3; k++) pixels[(y * width + x) * 4 + k] = pixels[(y * width + x) * 4 + k]! + image.pixels[(sy * image.width + sx) * 4 + k]! * w;
        }
      for (let k = 0; k < 3; k++) pixels[(y * width + x) * 4 + k] = pixels[(y * width + x) * 4 + k]! / weight;
      pixels[(y * width + x) * 4 + 3] = 1;
    }
    image = { width, height, pixels }; levels.push(image);
  }
  return levels;
}
