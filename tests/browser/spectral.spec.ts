import { expect, test } from '@playwright/test';

test('GPU wavelength normalization and prism agree with independent integrals and Snell equations', async ({ page }) => {
  await page.goto('/?scene=control'); await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result = await page.evaluate(async () => {
    const url = '/src/debug/verify-spectral.ts';
    const { verifySpectral } = await import(/* @vite-ignore */ url); return verifySpectral();
  });
  console.log('Spectral acceptance:',JSON.stringify({...result,prismAngles:[result.prismAngles[0],result.prismAngles.at(-1)]}));
  expect(result.errors).toBe(0);
  for (const estimate of result.estimates) for(let c=0;c<3;c++) expect(Math.abs(estimate.mean[c]!-estimate.reference[c]!)).toBeLessThan(Math.max(...estimate.reference)*0.001);
  for (const mean of result.diffuseEstimates) for(let c=0;c<3;c++) expect(Math.abs(mean[c]!/result.diffuseReference[c]!-1)).toBeLessThan(0.02);
  expect(result.maxPrismError).toBeLessThan(1e-5); expect(result.constantSpread).toBeLessThan(1e-7);
  expect(result.constantAngleError).toBeLessThan(1e-5);
  expect(result.prismAngles.at(-1)!-result.prismAngles[0]!).toBeGreaterThan(1);
});

test('spectral N-BK7 renders and switching transport discards previous accumulation', async ({ page }) => {
  await page.goto('/?scene=control'); await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#resolution').selectOption('19200');
  await page.locator('#material').evaluate(el => { el.closest('details')!.open = true; }); await page.locator('#material').selectOption('nbk7'); await page.locator('#mode').selectOption('spectral');
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples')),{timeout:20000}).toBeGreaterThanOrEqual(16);
  await expect(page.locator('#error')).toBeHidden();
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await page.locator('canvas').screenshot({path:'test-results/spectral-cornell.png'});
  await page.locator('#material').evaluate(el => { el.closest('details')!.open = true; }); await page.locator('#material').selectOption('nbk7-constant');
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples'))).toBe(1);
  await page.locator('#mode').selectOption('rgb');
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples'))).toBe(1);
  await expect(page.locator('#error')).toBeHidden();
});

test('capture preserves raw XYZ, negative RGB and exposure-independent history', async ({ page }) => {
  await page.goto('/?scene=control'); await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  const result = await page.evaluate(async () => {
    const rendererUrl='/src/render/intersection-renderer.ts', sceneUrl='/src/scene/cornell.ts';
    const { IntersectionRenderer } = await import(/* @vite-ignore */ rendererUrl);
    const { cornellScene } = await import(/* @vite-ignore */ sceneUrl);
    const scene = cornellScene(); scene.meshes = [scene.meshes[0]]; scene.objects = [{mesh:0,material:0,transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}];
    scene.materials = [{type:'emissive',emission:[1,1,1],spectrum:[[360,0],[645,0],[650,1],[655,0],[830,0]]}]; scene.lights = [{object:0}];
    scene.camera = {position:[0,0.5,0],target:[0,0,0],up:[0,0,1],verticalFov:40};
    const canvas = document.createElement('canvas'); canvas.style.cssText='width:32px;height:32px'; document.body.append(canvas);
    const errors: string[]=[]; let stopped=false, samples=0;
    const renderer = new IntersectionRenderer(canvas,(stats:{samples:number})=>{ samples=stats.samples; if(samples===32&&!stopped) { stopped=true;renderer.pause(); } },(error:Error)=>errors.push(error.message));
    const wait = async(condition:()=>boolean)=>{ const started=performance.now(); while(!condition()&&performance.now()-started<10000) await new Promise(resolve=>setTimeout(resolve,20)); if(!condition()) throw new Error('Capture stalled'); };
    try {
      renderer.setDebugView('beauty'); renderer.setSettings({mode:'spectral',maxPixels:1024,seed:17}); await renderer.setScene(scene); await renderer.initialize(); await wait(()=>stopped);
      const first=await renderer.capture(); renderer.setExposure(2); await new Promise(resolve=>setTimeout(resolve,100)); const exposed=await renderer.capture();
      const xyzPreserved = first.linearXyz.every((v:number,i:number)=>v===exposed.linearXyz[i]);
      const rgbPreserved = first.linearRgb.every((v:number,i:number)=>v===exposed.linearRgb[i]);
      renderer.setSettings({mode:'rgb'}); const reset=samples===0; await wait(()=>samples===1); const rgb=await renderer.capture();
      return {errors,space:first.accumulationSpace,xyzNonnegative:first.linearXyz.every((v:number)=>v>=0&&Number.isFinite(v)),negativeRgb:first.linearRgb.some((v:number)=>v<0),xyzPreserved,rgbPreserved,counts:first.sampleCounts.every((v:number)=>v===32),reset,rgbSpace:rgb.accumulationSpace,rgbNoXyz:rgb.linearXyz===undefined,rgbOne:rgb.linearRgb.every((v:number)=>v===1)};
    } finally {renderer.dispose();canvas.remove();}
  });
  expect(result).toEqual({errors:[],space:'cie-xyz',xyzNonnegative:true,negativeRgb:true,xyzPreserved:true,rgbPreserved:true,counts:true,reset:true,rgbSpace:'linear-srgb',rgbNoXyz:true,rgbOne:true});
});
