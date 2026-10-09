import data from '../transport/conductor-data.json';
import type { MaterialDescription, SpectrumTable, Vec3 } from './types';
import { hexToLinear, transmissionSpectrum } from './dielectric-settings';
import { rgbIlluminantSpectrum } from '../transport/environment-spectrum';
export const metalPresets = ['aluminum', 'gold', 'copper', 'silver'] as const;
export type MetalPreset = typeof metalPresets[number];
export const conductorData = data as Record<MetalPreset, { eta: SpectrumTable; k: SpectrumTable }>;
export function interpolate(table: SpectrumTable, nm: number): number {
  if (nm <= table[0]![0]) return table[0]![1];
  for (let i=1;i<table.length;i++) { const [b,y]=table[i]!, [a,x]=table[i-1]!; if(nm<=b) return x+(y-x)*(nm-a)/(b-a); }
  return table.at(-1)![1];
}
/** Exact unpolarized Fresnel for a complex refractive index, incident medium air. */
export function conductorFresnel(cosine: number, eta: number, k: number): number {
  const c=Math.min(1,Math.abs(cosine)), c2=c*c, s2=1-c2, e2=eta*eta, k2=k*k;
  const t0=e2-k2-s2, a2b2=Math.sqrt(t0*t0+4*e2*k2), a=Math.sqrt(Math.max(0,(a2b2+t0)/2));
  const rs=(a2b2+c2-2*c*a)/(a2b2+c2+2*c*a);
  const rp=rs*(c2*a2b2+s2*s2-2*c*a*s2)/(c2*a2b2+s2*s2+2*c*a*s2);
  return (rs+rp)/2;
}
export function presetF0(preset: MetalPreset): Vec3 {
  return [610,550,460].map(nm=>conductorFresnel(1,interpolate(data[preset].eta as SpectrumTable,nm),interpolate(data[preset].k as SpectrumTable,nm))) as Vec3;
}
export function plasticMaterial(color='#4f87c5', roughness=.2, ior=1.5): MaterialDescription {
  const reflectance=hexToLinear(color);return {type:'plastic',reflectance,spectrum:transmissionSpectrum(reflectance),roughness,ior};
}
export function emissiveMaterial(base='#808080', color='#ffffff', power=10): MaterialDescription {
  const reflectance=hexToLinear(base), emission=hexToLinear(color).map(v=>v*power) as Vec3;
  return {type:'emissive',reflectance,reflectanceSpectrum:transmissionSpectrum(reflectance),emission,
    spectrum:Array.from({length:471},(_,i)=>[360+i,rgbIlluminantSpectrum(emission,360+i)])};
}
