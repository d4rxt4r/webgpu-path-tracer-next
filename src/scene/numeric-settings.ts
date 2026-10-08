/** Slider limits describe convenient scales; these limits describe accepted values. */
export const numericLimits: Record<string, readonly [number, number]> = {
  'memory-budget': [64, Math.floor(Number.MAX_SAFE_INTEGER / 1048576)],
  'light-power': [0, 3.4028234663852886e38],
  'environment-strength': [0, 3.4028234663852886e38],
  'lava-power': [0, 3.4028234663852886e38],
  exposure: [-8, 16], 'denoise-strength': [.1, 10], radius: [.001, .5],
  'texture-width': [.01, 1], 'wall-neutral': [.05, 1], fov: [15, 179],
};
export function validNumeric(id: string, raw: string): boolean {
  const limits = numericLimits[id], n = Number(raw);
  return !!limits && !!raw.trim() && Number.isFinite(n) && n >= limits[0] && (id === 'fov' ? n < limits[1] : n <= limits[1]);
}
