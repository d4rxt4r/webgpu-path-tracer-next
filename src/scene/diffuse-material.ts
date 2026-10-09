import { hexToLinear, transmissionSpectrum } from './dielectric-settings';
import { constantSpectrum } from '../transport/spectrum';
import type { MaterialDescription, Vec3 } from './types';

export function diffuseMaterial(color='#ffffff', albedo=.65, roughness=0): MaterialDescription {
  if(!/^#[0-9a-f]{6}$/i.test(color) || !Number.isFinite(albedo) || albedo<0 || albedo>1 || !Number.isFinite(roughness) || roughness<0 || roughness>1) throw new Error('Invalid diffuse settings');
  const base=hexToLinear(color), reflectance=base.map(v=>v*albedo) as Vec3;
  const neutral=base.every(v=>v===base[0]);
  return {type:'diffuse',reflectance,roughness,spectrum:neutral?constantSpectrum(reflectance[0]):transmissionSpectrum(base).map(([nm,v])=>[nm,v*albedo])};
}

/** Reciprocal Oren-Nayar with a direction-independent hemispherical energy bound. */
export function diffuseCoefficients(roughness:number): [number,number] {
  const s2=(roughness*Math.PI/2)**2;
  const a=1-s2/(2*(s2+.33)), b=.45*s2/(s2+.09), scale=Math.max(1,a+b/2);
  return [a/scale,b/scale];
}
