import { diffuseMaterial } from '../scene/diffuse-material';
import type { SceneDescription } from '../scene/types';
export const diffuseControlIds=['diffuse-color','diffuse-r','diffuse-g','diffuse-b','diffuse-roughness'];
const field=(id:string)=>document.getElementById(id) as HTMLInputElement;
export function syncDiffuseChannels():void {
  ['r','g','b'].forEach((c,i)=>{
    const value=String(parseInt(field('diffuse-color').value.slice(1+2*i,3+2*i),16));
    field('diffuse-'+c).value=value;
    const number=document.getElementById('diffuse-'+c+'-value') as HTMLInputElement|null;
    if(number) number.value=value;
  });
}
export function setupDiffuseEditor():void {
  syncDiffuseChannels();
  field('diffuse-color').addEventListener('input',syncDiffuseChannels);
  for(const c of ['r','g','b']) field('diffuse-'+c).addEventListener('input',()=>{
    field('diffuse-color').value='#'+['r','g','b'].map(k=>Number(field('diffuse-'+k).value).toString(16).padStart(2,'0')).join('');
  });
}
export function applyDiffuseEditor(scene:SceneDescription):void {
  if(field('material').value==='diffuse') scene.materials[4]=diffuseMaterial(field('diffuse-color').value,Number(field('albedo').value),Number(field('diffuse-roughness').value));
}
export function syncDiffuseEditor(ready:boolean):void {
  syncDiffuseChannels();
  for(const id of diffuseControlIds) {
    const disabled=!ready||field('material').value!=='diffuse';field(id).disabled=disabled;
    const number=document.getElementById(id+'-value') as HTMLInputElement|null;if(number) number.disabled=disabled;
  }
}
