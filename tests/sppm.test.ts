import { expect,it } from 'vitest';
import { sppmDefinitions } from '../src/transport/sppm-shader';
import { readFileSync } from 'node:fs';
import { sobolSample } from '../src/transport/sampler';
import { exportPbrt } from '../src/debug/export-pbrt';
import { cornellScene } from '../src/scene/cornell';
import { CIE_Y_INTEGRAL } from '../src/transport/spectrum';
it('packs visible-point history and reserved photon slots at WGSL offsets',()=>{
  const point=sppmDefinitions.structs.SppmPoint!,photon=sppmDefinitions.structs.Photon!;
  expect(point.size).toBe(160);expect(point.fields.radius!.offset).toBe(76);expect(point.fields.N!.offset).toBe(92);expect(point.fields.iterations!.offset).toBe(108);
  expect(photon.size).toBe(80);expect(photon.fields.cell!.offset).toBe(48);expect(sppmDefinitions.structs.SppmParams!.size).toBe(32);
});
it('stratifies the shared wavelength in consecutive power-of-two iteration blocks',()=>{
  const raw=readFileSync(new URL('../public/assets/sobol.bin',import.meta.url)),directions=new Uint32Array(raw.buffer,raw.byteOffset,raw.byteLength/4);
  for(const seed of [1,17,1234])for(const start of [0,1024]) {
    const strata=new Set<number>();for(let iteration=start;iteration<start+1024;iteration++)strata.add(Math.floor(sobolSample(iteration,2,0x7370706d,seed,directions)*1024));
    expect(strata.size).toBe(1024);
  }
});
it('exports the matching spectral mesh and absorption for PBRT without RGB upsampling',()=>{
  const source=exportPbrt(cornellScene('nbk7'),32,24,65536,'reference.pfm');
  expect(source.match(/Shape "trianglemesh"/g)).toHaveLength(7);expect(source).toContain('"spectrum eta" [360');expect(source).toContain('MediumInterface "glass-4" ""');expect(source).toContain('"spectrum sigma_a"');expect(source).toContain(`"float scale" [${Math.fround(12*CIE_Y_INTEGRAL)}]`);expect(source).toContain(`"float iso" [${100/CIE_Y_INTEGRAL}]`);expect(source).not.toContain('"rgb ');
  const invalid=cornellScene();invalid.materials[1]={type:'diffuse',reflectance:[0.6,0.1,0.1]};expect(()=>exportPbrt(invalid,32,24,16,'invalid.pfm')).toThrow('explicit spectra');
});
