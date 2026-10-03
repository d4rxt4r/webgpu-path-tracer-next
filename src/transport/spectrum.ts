import data from '../assets/spectral-data.json';
import metadata from '../assets/spectral-meta.json';
import type { SpectrumTable, Vec3 } from '../scene/types';

export const LAMBDA_MIN = 360, LAMBDA_MAX = 830, SPECTRUM_SAMPLES = 471;
export const CIE_Y_INTEGRAL = 106.856895;
export const cie = [data.x, data.y, data.z];
export function constantSpectrum(value: number): SpectrumTable { return [[360, value], [830, value]]; }
export function spectrumValue(table: SpectrumTable, wavelength: number): number {
  if (wavelength < table[0]![0] || wavelength > table.at(-1)![0]) return 0;
  let low = 0, high = table.length - 1;
  while (high - low > 1) { const mid = (low + high) >>> 1; if (table[mid]![0] <= wavelength) low = mid; else high = mid; }
  const a = table[low]!, b = table[high]!;
  return a[1] + (b[1] - a[1]) * (wavelength - a[0]) / (b[0] - a[0]);
}
export function bakeSpectrum(table: SpectrumTable, reflectance = false): Float32Array {
  if (table.length < 2 || table[0]![0] > 360 || table.at(-1)![0] < 830 || table.some((entry, i) => entry.length !== 2 || !entry.every(v => Number.isFinite(Math.fround(v))) || entry[1] < 0 || (reflectance && entry[1] > 1) || (i > 0 && entry[0] <= table[i-1]![0]))) throw new Error('Invalid spectrum table: require ordered, finite, nonnegative samples covering 360-830 nm');
  return Float32Array.from({ length: 471 }, (_, i) => spectrumValue(table, 360 + i));
}
export function cieValue(wavelength: number): Vec3 {
  if (!Number.isFinite(wavelength) || wavelength < 360 || wavelength > 830) return [0,0,0];
  const index = Math.max(0, Math.min(469, Math.floor(wavelength - 360))), fraction = wavelength - 360 - index;
  return cie.map(channel => channel[index]! + fraction * (channel[index+1]! - channel[index]!)) as Vec3;
}
/** Exact per-interval Simpson integral of the product of two linear tables. */
export function integrateXyz(table: SpectrumTable): Vec3 {
  const dense = bakeSpectrum(table), sum: Vec3 = [0,0,0];
  for (let i = 0; i < 470; i++) for (let c = 0; c < 3; c++) {
    const a = cie[c]![i]!, b = cie[c]![i+1]!, v = dense[i]!, w = dense[i+1]!;
    sum[c]! += (a*v + (a+b)*(v+w) + b*w) / 6 / CIE_Y_INTEGRAL;
  }
  return sum;
}
export function xyzToLinearRgb(xyz: Vec3): Vec3 {
  const [x,y,z] = xyz;
  return [3.2404542*x - 1.5371385*y - 0.4985314*z, -0.969266*x + 1.8760108*y + 0.041556*z, 0.0556434*x - 0.2040259*y + 1.0572252*z];
}
export function nbk7Ior(wavelengthNm: number): number {
  if (!Number.isFinite(wavelengthNm) || wavelengthNm < 360 || wavelengthNm > 830) throw new Error('N-BK7 wavelength outside visible range');
  const squaredMicrometers = (wavelengthNm * 0.001) ** 2;
  return Math.sqrt(1 + metadata.glass.B.reduce((sum, b, i) => sum + b * squaredMicrometers / (squaredMicrometers - metadata.glass.C[i]!), 0));
}
export const nbk7Absorption: SpectrumTable = metadata.glass.internalTransmittance.map(([nm, tau]) => [nm!, -Math.log(tau!) / metadata.glass.internalTransmittanceThicknessMeters]);
const d65: SpectrumTable = Array.from({ length: data.d65.length / 2 }, (_, i) => [data.d65[2*i]!, data.d65[2*i+1]!]);
const d65Y = integrateXyz(d65)[1];
export const d65Spectrum: SpectrumTable = d65.map(([nm,value]) => [nm, value / d65Y]);
