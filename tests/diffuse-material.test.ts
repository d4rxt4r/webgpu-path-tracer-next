import { afterEach, expect, it, vi } from 'vitest';
import { diffuseMaterial, diffuseCoefficients } from '../src/scene/diffuse-material';
import { hexToLinear } from '../src/scene/dielectric-settings';
import { cornellScene } from '../src/scene/cornell';
import { packTransport } from '../src/accel/materials';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { exportPbrt } from '../src/debug/export-pbrt';
import { setupDiffuseEditor, syncDiffuseEditor, applyDiffuseEditor, diffuseControlIds } from '../src/app/diffuse-editor';
import { createSettingsLink, restoreSettingsLink } from '../src/app/settings-link';
import { numericDefault } from '../src/app/settings-reset';
const pack=(material:ReturnType<typeof diffuseMaterial>)=>{const scene=cornellScene('diffuse');scene.materials[4]=material;return packTransport(scene,buildBvh(bakeTriangles(scene)));};
afterEach(()=>vi.unstubAllGlobals());
it('preserves Lambert defaults and multiplies linear color and spectra by albedo',()=>{
  expect(diffuseMaterial()).toEqual({type:'diffuse',reflectance:[.65,.65,.65],roughness:0,spectrum:[[360,.65],[830,.65]]});
  const color=diffuseMaterial('#2865d4',.4,.5);expect(color).toMatchObject({roughness:.5,reflectance:hexToLinear('#2865d4').map(v=>v*.4)});
  expect(color.type==='diffuse'&&color.spectrum!.every(([,v])=>v>=0&&v<=.4)).toBe(true);
  const legacy=pack({type:'diffuse',reflectance:[.65,.65,.65]});const explicit=pack(diffuseMaterial());
  expect(new Uint8Array(legacy.materials)).toEqual(new Uint8Array(explicit.materials));expect(new Float32Array(legacy.spectra)).toEqual(new Float32Array(explicit.spectra));
  expect(new Uint8Array(pack(diffuseMaterial('#2865d4',.65,.5)).materials)).not.toEqual(new Uint8Array(explicit.materials));
});
it('rejects invalid settings and exports only exactly supported diffuse surfaces',()=>{
  for(const value of [-1,1.01,NaN,Infinity]) {
    expect(()=>diffuseMaterial('#ffffff',value)).toThrow();expect(()=>diffuseMaterial('#ffffff',.65,value)).toThrow();
    expect(()=>pack({type:'diffuse',reflectance:[.5,.5,.5],roughness:value})).toThrow();
  }
  expect(()=>diffuseMaterial('no-color')).toThrow();
  const scene=cornellScene('diffuse');scene.materials[4]=diffuseMaterial('#2865d4');expect(exportPbrt(scene,8,8,1,'x.exr')).toContain('Material "diffuse"');
  scene.materials[4]=diffuseMaterial('#2865d4',.65,.5);expect(()=>exportPbrt(scene,8,8,1,'x.exr')).toThrow(/Oren-Nayar/);
});
it('bounds hemispherical energy and preserves reciprocity including grazing angles',()=>{
  const f=(o:number[],i:number[],a:number,b:number)=>{
    const ci=i[2]!,co=o[2]!,si=Math.sqrt(Math.max(0,1-ci*ci)),so=Math.sqrt(Math.max(0,1-co*co));
    const angular=si>1e-4&&so>1e-4?Math.max(0,(i[0]!*o[0]!+i[1]!*o[1]!)/(si*so))*si*so/Math.max(1e-7,ci,co):0;
    return (a+b*angular)/Math.PI;
  };
  for(const roughness of [0,.01,.1,.5,1])for(const co of [1,.5,.001]){
    const [a,b]=diffuseCoefficients(roughness),o=[Math.sqrt(1-co*co),0,co];let energy=0,reciprocity=0;
    for(let k=0;k<32768;k++){
      const ci=(k+.5)/32768,phi=k*2.399963229728653,r=Math.sqrt(1-ci*ci),i=[r*Math.cos(phi),r*Math.sin(phi),ci];
      const forward=f(o,i,a,b);
      energy+=forward*ci*2*Math.PI/32768;reciprocity=Math.max(reciprocity,Math.abs(forward-f(i,o,a,b)));
    }
    expect(energy).toBeGreaterThan(0);expect(energy).toBeLessThanOrEqual(1.001);expect(reciprocity).toBeLessThan(1e-12);
  }
  expect(diffuseCoefficients(0)).toEqual([1,0]);
});
it('synchronizes palette/RGB, defaults and hidden settings across links',()=>{
  const fields:Record<string,any>={};
  for(const id of ['material','albedo',...diffuseControlIds]){
    const handlers:Record<string,(()=>void)[]>={};fields[id]={id,value:id==='material'?'diffuse':id==='diffuse-color'?'#ffffff':id==='albedo'?'.65':id==='diffuse-roughness'?'0':'255',type:id==='diffuse-color'?'color':'range',min:'0',max:id.endsWith('roughness')?'1':'255',step:'1',tagName:'INPUT',dataset:{default:id==='albedo'?'.65':id==='diffuse-roughness'?'0':'255'},addEventListener:(e:string,f:()=>void)=>(handlers[e]??=[]).push(f),fire:(e:string)=>handlers[e]?.forEach(f=>f())};
  }
  const root={getElementById:(id:string)=>fields[id]??null,querySelector:(s:string)=>fields[s.slice(1)],querySelectorAll:()=>Object.values(fields)};
  fields.scene={id:'scene',value:'control',type:'text',tagName:'INPUT'};
  fields.fov={id:'fov',value:'40',min:'15',max:'179',step:'1',type:'range',tagName:'INPUT'};
  fields['fov-value']={id:'fov-value',value:'40',type:'number',tagName:'INPUT'};
  fields['diffuse-roughness'].step='.01';fields.albedo.step='.01';
  fields['camera-distance']={id:'camera-distance',value:'3.7',min:'.001',max:'10000',step:'any',type:'number',tagName:'INPUT'};
  vi.stubGlobal('document',root);setupDiffuseEditor();fields['diffuse-color'].value='#2865d4';fields['diffuse-color'].fire('input');
  expect(['r','g','b'].map(c=>fields['diffuse-'+c].value)).toEqual(['40','101','212']);
  fields['diffuse-r'].value='255';fields['diffuse-r'].fire('input');expect(fields['diffuse-color'].value).toBe('#ff65d4');expect(numericDefault('diffuse-r',true)).toBe(255);
  fields['diffuse-roughness'].value='0.5';const scene=cornellScene('diffuse');applyDiffuseEditor(scene);expect(scene.materials[4]).toEqual(diffuseMaterial('#ff65d4',.65,.5));
  fields.material.value='metal';syncDiffuseEditor(true);expect(fields['diffuse-color'].disabled).toBe(true);
  const url=createSettingsLink(root as unknown as ParentNode,'http://localhost/',scene.camera);fields['diffuse-color'].value='#ffffff';fields['diffuse-roughness'].value='0';
  restoreSettingsLink(root as unknown as ParentNode,new URL(url).searchParams,scene.camera);syncDiffuseEditor(true);
  expect(fields['diffuse-color'].value).toBe('#ff65d4');expect(fields['diffuse-roughness'].value).toBe('0.5');
  expect(JSON.parse(JSON.stringify(Object.fromEntries(diffuseControlIds.map(id=>[id,fields[id].value]))))['diffuse-color']).toBe('#ff65d4');
});
