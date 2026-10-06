import { pathShader } from './shaders';
import dielectric from './path-dielectric.wgsl?raw';

/** Keep the portable/spectral reference. Intel's first RGB image uses a smaller
 * equivalent kernel: one dielectric BSDF call site and constant wavelength zero.
 */
export function rgbPathShader(): string {
  const start = pathShader.indexOf('    if (material.kind == 5u) {');
  const end = pathShader.indexOf('    let coating=coatingProbability(material);', start);
  if (start < 0 || end < 0) throw new Error('PT dielectric specialization marker missing');
  return (pathShader.slice(0, start) + dielectric + '\n' + pathShader.slice(end)).replaceAll('params.transportMode', '0u');
}
