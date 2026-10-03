import { expect,test } from '@playwright/test';

test('actual photon pass disperses prism footprints and matches independent Snell and absorption',async({page})=>{
  await page.goto('/');await expect(page.locator('#status')).toHaveText('WebGPU готов',{timeout:20000});await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async()=>{const url='/src/debug/verify-sppm-prism.ts';const {verifySppmPrism}=await import(/* @vite-ignore */url);return verifySppmPrism();});
  console.log('SPPM photon prism acceptance:',JSON.stringify(result));expect(result.errors).toBe(0);expect(result.maxPositionError).toBeLessThan(0.0005);expect(result.maxFluxRelativeError).toBeLessThan(0.001);
  expect(result.results[0]!.matchedPaths).toBeGreaterThan(100);expect(result.results[0]!.meanFootprintSpread).toBeGreaterThan(0.005);expect(result.results[1]!.meanFootprintSpread).toBe(0);
});

test('shared iteration wavelengths integrate direct and indirect spectra with one PDF factor',async({page})=>{
  test.setTimeout(180000);await page.goto('/');await expect(page.locator('#status')).toHaveText('WebGPU готов',{timeout:20000});await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async()=>{
    const renderUrl='/src/debug/render-sppm.ts',sceneUrl='/src/scene/sppm-control.ts',spectrumUrl='/src/transport/spectrum.ts',referenceUrl='/src/debug/sppm-reference.ts';
    const {renderSppm}=await import(/* @vite-ignore */renderUrl);const {spectralEmitterScene,indirectSppmScene}=await import(/* @vite-ignore */sceneUrl);
    const {integrateXyz,d65Spectrum}=await import(/* @vite-ignore */spectrumUrl);const {indirectSppmReference}=await import(/* @vite-ignore */referenceUrl);
    const direct=await renderSppm(spectralEmitterScene(),{iterations:1024,photonsPerIteration:1,photonBatchSize:1,width:2,height:2});
    const indirect=await renderSppm(indirectSppmScene(),{iterations:1024,photonsPerIteration:8192,photonBatchSize:4096,initialRadius:0.2,maxDepth:4});
    return {direct,directReference:integrateXyz(d65Spectrum),indirect,indirectReference:indirectSppmReference()};
  });
  console.log('Spectral SPPM normalization:',JSON.stringify(result));
  expect(result.direct.errors).toBe(0);expect(result.direct.counts).toEqual([1024,1024,1024,1024]);
  for(let p=0;p<4;p++)for(let c=0;c<3;c++)expect(Math.abs(result.direct.pixels[p*3+c]!/result.directReference[c]!-1)).toBeLessThan(0.005);
  expect(result.indirect.errors).toBe(0);for(let c=0;c<3;c++)expect(Math.abs(result.indirect.pixels[c]!/result.indirectReference[c]!-1)).toBeLessThan(0.02);
});

test('spectral slab caustic agrees with independent angular CPU quadrature',async({page})=>{
  test.setTimeout(180000);await page.goto('/');await expect(page.locator('#status')).toHaveText('WebGPU готов',{timeout:20000});await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result=await page.evaluate(async()=>{
    const renderUrl='/src/debug/render-sppm.ts',sceneUrl='/src/scene/sppm-control.ts',referenceUrl='/src/debug/sppm-reference.ts';
    const {renderSppm}=await import(/* @vite-ignore */renderUrl);const {slabSppmScene}=await import(/* @vite-ignore */sceneUrl);const {slabSppmReference}=await import(/* @vite-ignore */referenceUrl);
    const slab=await renderSppm(slabSppmScene(),{iterations:4096,photonsPerIteration:8192,photonBatchSize:4096,initialRadius:0.15,maxDepth:32});
    return {slab,reference:slabSppmReference()};
  });
  console.log('Spectral SPPM slab acceptance:',JSON.stringify(result));expect(result.slab.errors).toBe(0);
  for(let c=0;c<3;c++)expect(Math.abs(result.slab.pixels[c]!/result.reference[c]!-1)).toBeLessThan(0.03);
});
