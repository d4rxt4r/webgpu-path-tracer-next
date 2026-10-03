import { expect, test } from '@playwright/test';

test('GPU light/BSDF/MIS estimates agree with independent area quadrature', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const result = await page.evaluate(async () => {
    const url = '/src/debug/verify-transport.ts';
    const { verifyTransport } = await import(/* @vite-ignore */ url);
    return verifyTransport();
  });
  console.log('RGB acceptance:', JSON.stringify(result));
  expect(result.errors).toBe(0);
  expect(result.maxSamplerError).toBeLessThan(1e-7);
  expect(result.maxPdfError).toBeLessThan(1e-5);
  for (const estimate of result.estimates) for (let channel=0;channel<3;channel++) expect(Math.abs(estimate[channel]! / result.reference[channel]! - 1)).toBeLessThan(0.02);
  expect(Math.abs(result.rouletteMean / result.rouletteReference - 1)).toBeLessThan(0.02);
});

test('raw accumulation is deterministic, exposure preserves it, camera and integrator reset it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const result = await page.evaluate(async () => {
    const rendererUrl='/src/render/intersection-renderer.ts', sceneUrl='/src/scene/cornell.ts';
    const { IntersectionRenderer } = await import(/* @vite-ignore */ rendererUrl);
    const { cornellScene } = await import(/* @vite-ignore */ sceneUrl);
    const canvas = document.createElement('canvas'); canvas.style.cssText='width:160px;height:120px'; document.body.append(canvas);
    const errors: string[]=[];
    let stats={samples:0,tile:0,status:'recovering'};
    let target=8, stopped=false;
    const renderer = new IntersectionRenderer(canvas,(value:typeof stats)=>{
      stats=value;
      if (stats.samples===target && !stopped) { stopped=true; renderer.pause(); }
    },(error:Error)=>errors.push(error.message));
    const wait = async (condition:()=>boolean) => {
      const started=performance.now();
      while (!condition() && performance.now()-started<10000) await new Promise(resolve=>setTimeout(resolve,20));
      if (!condition()) throw new Error('RGB accumulation stalled: '+JSON.stringify(stats));
    };
    try {
      const scene=cornellScene(); renderer.setSettings({ maxPixels:19200, seed:17 }); renderer.setDebugView('beauty');
      await renderer.setScene(scene); await renderer.initialize(); await wait(()=>stopped);
      const first=await renderer.capture();
      const countUniform=first.sampleCounts.every((count:number)=>count===8);
      renderer.setExposure(1); await new Promise(resolve=>setTimeout(resolve,100));
      const exposed=await renderer.capture();
      const exposurePreserved=exposed.linearRgb.every((value:number,i:number)=>value===first.linearRgb[i]) && exposed.samples===8;
      renderer.setExposure(0);
      renderer.setCamera(scene.camera); // Same seed and camera reproduce the same raw estimate.
      renderer.setExposure(0);
      const cameraReset=stats.samples===0;
      stopped=false; renderer.resume(); await wait(()=>stopped);
      const repeated=await renderer.capture();
      const deterministic=repeated.linearRgb.every((value:number,i:number)=>value===first.linearRgb[i]);
      target=1; stopped=false;
      renderer.setSettings({ strategy:'bsdf' });
      const integratorReset=stats.samples===0;
      // A paused image redraw completes a full sweep without continuing accumulation.
      await wait(()=>stopped); const changed=await renderer.capture();
      const before=stats.samples; await new Promise(resolve=>setTimeout(resolve,150));
      const pausePreserved=stats.samples===before;
      return {errors,countUniform,exposurePreserved,cameraReset,integratorReset,deterministic,pausePreserved,changedSamples:changed.samples,positive:first.linearRgb.some((value:number)=>value>0)};
    } finally { renderer.dispose(); canvas.remove(); }
  });
  expect(result).toEqual({ errors:[],countUniform:true,exposurePreserved:true,cameraReset:true,integratorReset:true,deterministic:true,pausePreserved:true,changedSamples:1,positive:true });
});

test('RGB demo accumulates an illuminated Cornell box', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#resolution').selectOption('19200');
  await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-samples')),{timeout:15000}).toBeGreaterThanOrEqual(32);
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await page.locator('canvas').screenshot({path:'test-results/rgb-cornell.png'});
  await expect(page.locator('#error')).toBeHidden();
});
