import type { Vec3 } from '../scene/types';
import { CIE_Y_INTEGRAL, cieValue, d65Spectrum, nbk7Ior, spectrumValue, integrateXyz } from '../transport/spectrum';

/** Independent radial quadrature of two Lambertian propagation kernels.
 * A 2cm emitter approximates a point; omitted finite-size/multiple-bounce terms <0.1%.
 */
export function indirectSppmReference():Vec3 {
  const steps=65536;let sum=0;
  for(let i=0;i<=steps;i++) {
    const u=i/steps;
    const value=i===steps?0:0.25*(1-u)**2/((0.25+0.75*u)**2);
    sum+=value*(i===0||i===steps?1:i%2?4:2);
  }
  const scale=0.0004*0.001*0.5/Math.PI*sum/(3*steps);
  return integrateXyz(d65Spectrum).map(value=>value*scale) as Vec3;
}

/** Radiance through an infinite parallel slab, including internal reflection series.
 * Integrates incident directions, not photons or density estimates; no engine BSDF code.
 * The finite 20m slab and 0.001 floor add negligible edge/return terms on this fixture.
 */
export function slabIrradiance(ior:number,steps=4096):number {
  let sum=0;
  for(let i=0;i<=steps;i++) {
    const theta=(Math.PI/2)*i/steps,cos=Math.cos(theta),sin=Math.sin(theta);
    const sinGlass=sin/ior,cosGlass=Math.sqrt(1-sinGlass*sinGlass);
    const rs=(cos-ior*cosGlass)/(cos+ior*cosGlass),rp=(ior*cos-cosGlass)/(ior*cos+cosGlass);
    const F=(rs*rs+rp*rp)/2;let transmission=0;
    for(let bounce=0;bounce<8;bounce++) {
      const radius=0.75*sin/Math.max(cos,1e-30)+0.25*(2*bounce+1)*sinGlass/cosGlass;
      const azimuth=radius<=0.5?2*Math.PI:radius<Math.SQRT1_2?8*Math.asin(0.5/radius)-2*Math.PI:0;
      transmission+=(1-F)**2*F**(2*bounce)*azimuth;
    }
    sum+=cos*sin*transmission*(i===0||i===steps?1:i%2?4:2);
  }
  return sum*(Math.PI/2)/(3*steps);
}
export function slabSppmReference(dispersive=true):Vec3 {
  const result:Vec3=[0,0,0];
  for(let i=0;i<=470;i++) {
    const wavelength=360+i,ior=nbk7Ior(dispersive?wavelength:587.6);
    const factor=0.001/Math.PI*slabIrradiance(ior)*spectrumValue(d65Spectrum,wavelength)/CIE_Y_INTEGRAL*(i===0||i===470?0.5:1);
    const cie=cieValue(wavelength);for(let c=0;c<3;c++)result[c]!+=cie[c]!*factor;
  }
  return result;
}
