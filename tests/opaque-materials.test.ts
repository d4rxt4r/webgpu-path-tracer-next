import { describe, expect, it, vi, afterEach } from 'vitest';
import { conductorData, conductorFresnel, metalPresets, presetF0, interpolate, plasticMaterial, emissiveMaterial } from '../src/scene/opaque-materials';
import { hexToLinear, transmissionSpectrum } from '../src/scene/dielectric-settings';
import { bakeSpectrum } from '../src/transport/spectrum';
import { cornellScene } from '../src/scene/cornell';
import { bakeTriangles } from '../src/accel/geometry';
import { buildBvh } from '../src/accel/bvh';
import { packTransport } from '../src/accel/materials';
import { definitions } from '../src/accel/pack';
import { exportPbrt } from '../src/debug/export-pbrt';
import type { MaterialDescription } from '../src/scene/types';
import { setupOpaqueEditor, opaqueControlIds, opaqueSettings } from '../src/app/opaque-editor';
import { createSettingsLink, restoreSettingsLink } from '../src/app/settings-link';
import { numericDefault } from '../src/app/settings-reset';
const sceneWith=(material:MaterialDescription)=>{const scene=cornellScene('diffuse');scene.materials[4]=material;if(material.type==='emissive') scene.lights.push({object:6});return scene;};
const pack=(material:MaterialDescription)=>{const scene=sceneWith(material);return packTransport(scene,buildBvh(bakeTriangles(scene)));};
describe('opaque materials',()=>{
  it('preserves pinned eta/k data and exact complex Fresnel',()=>{
    for(const preset of metalPresets) {
      const tables=conductorData[preset];
      for(const table of [tables.eta,tables.k]) {expect(bakeSpectrum(table).every(v=>v>0 && Number.isFinite(v))).toBe(true);}
      for(const nm of [360,460,550,610,830]) {
        const e=interpolate(tables.eta,nm), k=interpolate(tables.k,nm);
        expect(conductorFresnel(1,e,k)).toBeCloseTo(((e-1)**2+k*k)/((e+1)**2+k*k),12);
        expect(conductorFresnel(0,e,k)).toBeCloseTo(1,12);
        for(const c of [.01,.2,.5,.9]) expect(conductorFresnel(c,e,k)).toBeGreaterThan(0);
      }
      expect(presetF0(preset).every(v=>v>=0&&v<=1)).toBe(true);
    }
    expect(presetF0('gold')[0]).toBeGreaterThan(presetF0('gold')[2]);
  });
  it('uses linear colors and the requested defaults',()=>{
    expect(plasticMaterial()).toMatchObject({type:'plastic',reflectance:hexToLinear('#4f87c5'),ior:1.5,roughness:.2});
    expect(emissiveMaterial()).toMatchObject({type:'emissive',reflectance:hexToLinear('#808080'),emission:[10,10,10]});
    for(const hex of ['#000000','#ffffff','#123456']) expect(bakeSpectrum(transmissionSpectrum(hexToLinear(hex)),true).every(v=>v>=0&&v<=1)).toBe(true);
  });
  it('packs every material without changing the GPU layout or spectral readiness',()=>{
    const materials:MaterialDescription[]=[...metalPresets.map(preset=>({type:'metal' as const,preset,roughness:.2})),{type:'metal',preset:'custom',roughness:0,reflectance:[.2,.4,.6],spectrum:transmissionSpectrum([.2,.4,.6])},plasticMaterial(),emissiveMaterial()];
    for(const material of materials) {const packed=pack(material);expect(packed.spectralReady).toBe(true);expect(packed.materials.byteLength).toBe(5*definitions.structs.Material!.size);expect(new Float32Array(packed.spectra).every(Number.isFinite)).toBe(true);}
  });
  it('excludes zero-power emitters while retaining reflection and legacy emitters',()=>{
    expect(pack(emissiveMaterial(undefined,undefined,0)).lightCount).toBe(2);
    expect(pack(emissiveMaterial()).lightCount).toBeGreaterThan(2);
    const scene=sceneWith(emissiveMaterial(undefined,undefined,0));scene.materials[3]={type:'emissive',emission:[0,0,0]};
    expect(packTransport(scene,buildBvh(bakeTriangles(scene))).lightCount).toBe(0);
  });
  it('rejects nonfinite, out-of-range and overflowing transport parameters',()=>{
    for(const roughness of [-1,1.1,NaN,Infinity]) expect(()=>pack({type:'metal',preset:'gold',roughness})).toThrow();
    for(const ior of [.9,2.6,NaN]) expect(()=>pack(plasticMaterial(undefined,.2,ior))).toThrow();
    expect(()=>pack({type:'metal',preset:'custom',roughness:0,reflectance:[2,0,0]})).toThrow();
    expect(()=>pack(emissiveMaterial(undefined,undefined,3e38))).toThrow();
    expect(()=>pack(emissiveMaterial(undefined,undefined,80))).not.toThrow();
  });
  it('exports physical metals and reflecting emitters, rejects approximate models',()=>{
    for(const preset of metalPresets) expect(exportPbrt(sceneWith({type:'metal',preset,roughness:.2}),8,8,1,'x.exr')).toContain('Material "conductor"');
    const text=exportPbrt(sceneWith(emissiveMaterial()),8,8,1,'x.exr');expect(text).toContain('AreaLightSource');expect(text).toContain('0.2158605');
    for(const material of [plasticMaterial(),{type:'metal' as const,preset:'custom' as const,roughness:0,reflectance:[.2,.2,.2] as [number,number,number]}]) expect(()=>exportPbrt(sceneWith(material),8,8,1,'x.exr')).toThrow(/cannot exactly reproduce/);
  });
});
afterEach(()=>vi.unstubAllGlobals());
it('synchronizes palette and RGB, retains the first defaults and restored state',()=>{
  class Field {value='';checked=false;type='range';dataset:Record<string,string>={};listeners:Record<string,(()=>void)[]>={};addEventListener(name:string,fn:()=>void){(this.listeners[name]??=[]).push(fn);}fire(name:string){this.listeners[name]?.forEach(fn=>fn());}}
  const fields=Object.fromEntries([...opaqueControlIds,'emissive-power-value','material','scene'].map(id=>[id,new Field()]));
  fields['metal-preset']!.value='gold';fields['metal-color']!.value=fields['metal-color-default']!.value='#ffffff';fields['metal-custom-set']!.type='checkbox';
  vi.stubGlobal('location',{search:''});vi.stubGlobal('document',{getElementById:(id:string)=>fields[id],querySelector:(id:string)=>fields[id.slice(1)]});
  setupOpaqueEditor();fields['metal-preset']!.value='custom';fields['metal-preset']!.fire('change');
  const initial=fields['metal-color']!.value;expect(initial).not.toBe('#ffffff');expect(fields['metal-color-default']!.value).toBe(initial);
  fields['metal-color']!.value='#123456';fields['metal-color']!.fire('input');expect(['r','g','b'].map(c=>fields['metal-'+c]!.value)).toEqual(['18','52','86']);
  fields['metal-r']!.value='255';fields['metal-r']!.fire('input');expect(fields['metal-color']!.value).toBe('#ff3456');
  fields['metal-preset']!.value='silver';fields['metal-preset']!.fire('change');fields['metal-preset']!.value='custom';fields['metal-preset']!.fire('change');
  expect(fields['metal-color']!.value).toBe('#ff3456');expect(fields['metal-color-default']!.value).toBe(initial);expect(numericDefault('metal-r',true)).toBe(parseInt(initial.slice(1,3),16));
  const json=JSON.parse(JSON.stringify(opaqueSettings()));expect(json['metal-color-default']).toBe(initial);expect(json['metal-custom-set']).toBe(true);
  vi.stubGlobal('location',{search:'?metal-color=%23ff3456&metal-color-default='+encodeURIComponent(initial)});setupOpaqueEditor();expect(fields['metal-custom-set']!.checked).toBe(true);expect(fields['metal-color']!.value).toBe('#ff3456');
});

it('independent CPU quadrature bounds conductor and FresnelBlend energy and reciprocity',()=>{
  const dot=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i]!,0);
  const normalize=(a:number[])=>a.map(v=>v/Math.hypot(...a));
  const evaluate=(kind:number,o:number[],i:number[],roughness:number)=>{
    if(o[2]!<=0||i[2]!<=0)return 0;
    const h=normalize(o.map((v,c)=>v+i[c]!)),a=roughness**2,a2=a*a;
    const d=a2/(Math.PI*(h[0]!**2+h[1]!**2+a2*h[2]!**2)**2),oh=dot(o,h);
    const lambda=(v:number[])=>.5*(Math.sqrt(1+a2*(v[0]!**2+v[1]!**2)/v[2]!**2)-1);
    const f=kind===6?conductorFresnel(oh,.2,3.5):(kind===7?.5:.04)+(1-(kind===7?.5:.04))*(1-oh)**5;
    if(kind!==8)return f*d/(4*o[2]!*i[2]!*(1+lambda(o)+lambda(i)));
    return 28/(23*Math.PI)*.5*.96*(1-(1-.5*o[2]!)**5)*(1-(1-.5*i[2]!)**5)+f*d/(4*oh*Math.max(o[2]!,i[2]!));
  };
  for(const kind of [6,7,8])for(const roughness of [.2,.6,1])for(const o of [[0,0,1],[Math.sqrt(.75),0,.5]]) {
    let energy=0,maxReciprocity=0;const count=32768;
    for(let sample=0;sample<count;sample++){
      const z=(sample+.5)/count,phi=sample*2.399963229728653,r=Math.sqrt(1-z*z),i=[r*Math.cos(phi),r*Math.sin(phi),z];
      const forward=evaluate(kind,o,i,roughness),reverse=evaluate(kind,i,o,roughness);
      maxReciprocity=Math.max(maxReciprocity,Math.abs(forward-reverse)/Math.max(1,forward));energy+=forward*z*2*Math.PI/count;
    }
    expect(maxReciprocity).toBeLessThan(1e-7);expect(energy).toBeGreaterThan(0);expect(energy).toBeLessThanOrEqual(1.01);
  }
});

it('round-trips hidden material groups and custom defaults in settings links',()=>{
  const fields:Record<string,any>={};
  const add=(id:string,type:string,value:string,min='',max='',step='any')=>fields[id]={id,type,value,min,max,step,tagName:'INPUT'};
  add('fov','range','40');add('fov-value','number','40');add('camera-distance','number','3.7');
  add('metal-color','color','#123456');add('metal-color-default','color','#f6eda7');add('metal-custom-set','checkbox','');fields['metal-custom-set'].checked=true;
  add('emissive-power','range','40');add('emissive-power-value','number','80');add('plastic-ior','range','2','1','2.5');
  add('metal-preset','select-one','custom');Object.assign(fields['metal-preset'],{tagName:'SELECT',options:[{value:'custom'},{value:'gold'}]});
  const root={querySelectorAll:()=>Object.values(fields),querySelector:(selector:string)=>fields[selector.slice(1)]} as unknown as ParentNode;
  const camera={position:[0,1,3.7],target:[0,1,0],up:[0,1,0],verticalFov:40} as const;
  const original=structuredClone(camera) as any,url=createSettingsLink(root,'http://localhost/',original),query=new URL(url).searchParams;
  expect(query.get('emissive-power')).toBe('80');expect(query.get('metal-color-default')).toBe('#f6eda7');
  fields['metal-color'].value='#ffffff';fields['metal-color-default'].value='#ffffff';fields['metal-custom-set'].checked=false;fields['emissive-power-value'].value='10';fields['plastic-ior'].value='1.5';
  expect(restoreSettingsLink(root,query,original)).toEqual(original);
  expect(fields['metal-color'].value).toBe('#123456');expect(fields['metal-color-default'].value).toBe('#f6eda7');expect(fields['metal-custom-set'].checked).toBe(true);
  expect(fields['emissive-power-value'].value).toBe('80');expect(fields['plastic-ior'].value).toBe('2');
});
