import { expect, test } from '@playwright/test';

test('camera optics round trip with disabled settings and distances above 12m', async ({page}) => {
  await page.goto('/tests/fixtures/camera.html');
  const result=await page.evaluate(async()=>{
    const ui='/src/app/editor-ui.ts', links='/src/app/settings-link.ts';
    const {renderEditor}=await import(/* @vite-ignore */ ui);
    const {createSettingsLink,restoreSettingsLink}=await import(/* @vite-ignore */ links);
    const root=new DOMParser().parseFromString(renderEditor(true),'text/html');
    const camera={position:[0,1,100],target:[0,1,0],up:[0,1,0],verticalFov:40,
      depthOfField:{enabled:false,apertureDiameter:.075,focusMode:'point',focusDistance:17,focusPoint:[1,2,3],apertureShape:'polygon',blades:7,rotation:123}};
    const link=createSettingsLink(root,location.href,camera);
    return {camera,restored:restoreSettingsLink(root,new URL(link).searchParams,{...camera,depthOfField:undefined})};
  });
  expect(result.restored).toEqual(result.camera);
});

test('camera GPU matrix preserves pinhole, finite output and deterministic sampling', async ({page}) => {
  test.setTimeout(300000);
  await page.goto('/tests/fixtures/camera.html');
  for(const mode of ['rgb','spectral']) for(const integrator of ['pt','sppm']) {
    const result=await page.evaluate(async({mode,integrator})=>{
      const url='/src/debug/verify-camera.ts'; const {verifyCamera}=await import(/* @vite-ignore */ url);
      const result=await verifyCamera(mode,integrator);delete result.captures;return result;
    },{mode,integrator});
    expect(result.nonFinite).toBe(0);
    expect(result.disabledDifference).toBeLessThanOrEqual(1e-6);expect(result.zeroDifference).toBeLessThanOrEqual(1e-6);expect(result.repeatDifference).toBeLessThanOrEqual(1e-6);
    expect(result.disabledDisplayDifferences).toBe(0);expect(result.zeroDisplayDifferences).toBe(0);expect(result.repeatDisplayDifferences).toBe(0);
    if(integrator==='pt') expect(result.originalDifference).toBe(0);
    expect(result.blurDifference).toBeGreaterThan(0);
    expect(result.timings.every((t:{errors:number})=>t.errors===0)).toBe(true);
  }
});
