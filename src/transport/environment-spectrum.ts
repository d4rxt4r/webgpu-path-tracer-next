import bases from './illuminant-bases.json';
import { cie, CIE_Y_INTEGRAL } from './spectrum';
import type { Vec3 } from '../scene/types';

const names = ['White', 'Cyan', 'Magenta', 'Yellow', 'Red', 'Green', 'Blue'];
const raw = names.map(name => bases[('RGBIllum2Spect' + name) as keyof typeof bases].map(v => Math.max(0, v) * .86445));
const sample = (table: number[], wavelength: number): number => {
  const p = Math.max(0, Math.min(31, (wavelength - 380) * 31 / 340)), i = Math.min(30, Math.floor(p));
  return table[i]! + (table[i + 1]! - table[i]!) * (p - i);
};
// Calibrate the illuminant white to unit CIE luminance under our 360..830 nm sampler.
let whiteY = 0;
for (let i = 0; i < 470; i++) {
  const a = cie[1]![i]!, b = cie[1]![i + 1]!, v = sample(raw[0]!, 360 + i), w = sample(raw[0]!, 361 + i);
  whiteY += (a * v + (a + b) * (v + w) + b * w) / (6 * CIE_Y_INTEGRAL);
}
export const illuminantBasisData = new Float32Array(raw.flatMap(table => table.map(v => v / whiteY)));
export function rgbIlluminantSpectrum(rgb: Vec3, wavelength: number): number {
  const [r, g, b] = rgb, weights = [Math.min(r, g, b), 0, 0, 0, 0, 0, 0];
  if (r <= g && r <= b) { weights[1] = Math.min(g, b) - r; weights[5] = Math.max(0, g - b); weights[6] = Math.max(0, b - g); }
  else if (g <= r && g <= b) { weights[2] = Math.min(r, b) - g; weights[4] = Math.max(0, r - b); weights[6] = Math.max(0, b - r); }
  else { weights[3] = Math.min(r, g) - b; weights[4] = Math.max(0, r - g); weights[5] = Math.max(0, g - r); }
  return weights.reduce((sum, weight, i) => sum + weight * sample([...illuminantBasisData.subarray(i * 32, (i + 1) * 32)], wavelength), 0);
}
