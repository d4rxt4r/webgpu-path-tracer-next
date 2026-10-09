import { metalPresets, presetF0, plasticMaterial, emissiveMaterial, type MetalPreset } from '../scene/opaque-materials';
import { hexToLinear, linearToHex, transmissionSpectrum } from '../scene/dielectric-settings';
import { readControl } from './numeric-controls';
import type { MaterialDescription, SceneDescription } from '../scene/types';
export const opaqueControlIds=['metal-preset','metal-roughness','metal-color','metal-r','metal-g','metal-b','metal-custom-set','metal-color-default','plastic-color','plastic-roughness','plastic-ior','emissive-base','emissive-color','emissive-power'];
const field=(id:string)=>document.getElementById(id) as HTMLInputElement;
const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
function syncChannels(): void {
  for(const [i,c] of ['r','g','b'].entries()) {
    const id=`metal-${c}`;field(id).value=String(rgb(field('metal-color').value)[i]);
    field(id).dataset.default=String(rgb(field('metal-color-default').value)[i]);
    const number=document.getElementById(id+'-value') as HTMLInputElement|null;if(number) number.value=field(id).value;
  }
}
export function setupOpaqueEditor(): void {
  let preset=field('metal-preset').value;
  const query=new URLSearchParams(location.search);
  if(query.get('metal-custom-set')!=='0' && /^#[0-9a-f]{6}$/i.test(query.get('metal-color')??'')) {
    field('metal-custom-set').checked=true;
    if(!/^#[0-9a-f]{6}$/i.test(query.get('metal-color-default')??'')) field('metal-color-default').value=field('metal-color').value;
  }
  syncChannels();
  field('metal-preset').addEventListener('change',()=>{
    if(field('metal-preset').value==='custom' && !field('metal-custom-set').checked) {
      const source=metalPresets.includes(preset as MetalPreset)?preset as MetalPreset:'aluminum';
      field('metal-color').value=field('metal-color-default').value=linearToHex(presetF0(source));
      field('metal-custom-set').checked=true;syncChannels();
    }
    preset=field('metal-preset').value;
  });
  field('metal-color').addEventListener('input',()=>{field('metal-custom-set').checked=true;syncChannels();});
  for(const c of ['r','g','b']) field(`metal-${c}`).addEventListener('input',()=>{
    field('metal-color').value='#'+['r','g','b'].map(k=>Number(field(`metal-${k}`).value).toString(16).padStart(2,'0')).join('');
    field('metal-custom-set').checked=true;
  });
}
export function opaqueSettings(): Record<string,string|boolean> {
  return Object.fromEntries(opaqueControlIds.map(id=>[id,field(id).type==='checkbox'?field(id).checked:readControl(document,id)]));
}
export function applyOpaqueEditor(scene: SceneDescription): void {
  const type=field('material').value;let material:MaterialDescription;
  if(type==='metal') {
    const preset=field('metal-preset').value as MetalPreset|'custom';const reflectance=hexToLinear(field('metal-color').value);
    material={type,preset,roughness:Number(field('metal-roughness').value),...(preset==='custom'?{reflectance,spectrum:transmissionSpectrum(reflectance)}:{})};
  } else if(type==='plastic') material=plasticMaterial(field('plastic-color').value,Number(field('plastic-roughness').value),Number(field('plastic-ior').value));
  else if(type==='emissive') material=emissiveMaterial(field('emissive-base').value,field('emissive-color').value,Number(readControl(document,'emissive-power')));
  else return;
  scene.materials[4]=material;
  const existing=new Set(scene.lights.map(light=>light.object));
  scene.objects.forEach((object,i)=>{if(object.material===4 && type==='emissive' && !existing.has(i)) scene.lights.push({object:i});});
}
export function syncOpaqueEditor(ready:boolean): void {
  const type=field('material').value;
  for(const name of ['metal','plastic','emissive']) {
    const group=document.getElementById(name+'-settings')!;group.hidden=type!==name;
    for(const control of group.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input, select')) control.disabled=!ready || type!==name;
  }
  const custom=field('metal-preset').value==='custom';document.getElementById('metal-custom-settings')!.hidden=!custom;
  for(const c of document.getElementById('metal-custom-settings')!.querySelectorAll<HTMLInputElement>('input')) c.disabled=!ready || type!=='metal' || !custom;
  syncChannels();
}
