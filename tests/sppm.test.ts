import { expect,it } from 'vitest';
import { sppmDefinitions } from '../src/transport/sppm-shader';
it('packs visible-point history and reserved photon slots at WGSL offsets',()=>{
  const point=sppmDefinitions.structs.SppmPoint!,photon=sppmDefinitions.structs.Photon!;
  expect(point.size).toBe(112);expect(point.fields.radius!.offset).toBe(76);expect(point.fields.N!.offset).toBe(92);expect(point.fields.iterations!.offset).toBe(108);
  expect(photon.size).toBe(64);expect(photon.fields.cell!.offset).toBe(48);expect(sppmDefinitions.structs.SppmParams!.size).toBe(32);
});
