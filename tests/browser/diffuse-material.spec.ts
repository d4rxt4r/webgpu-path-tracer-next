import { expect, test } from '@playwright/test';
test('diffuse color, channels, roughness, reset and hidden link state',async({page})=>{
  test.setTimeout(180000);
  await page.goto('/?scene=control&settings=1&material=diffuse&resolution=19200&sample-limit=2');
  await expect(page.locator('#material')).toBeEnabled({timeout:120000});
  await expect(page.locator('#diffuse-color')).toHaveValue('#ffffff');await expect(page.locator('#diffuse-roughness')).toHaveValue('0');
  await expect(page.locator('#diffuse-settings')).toHaveCSS('row-gap','10px');
  await page.locator('#diffuse-color').fill('#2865d4');await page.locator('#diffuse-color').dispatchEvent('input');
  await expect(page.locator('#diffuse-r-value')).toHaveValue('40');await expect(page.locator('#diffuse-g-value')).toHaveValue('101');await expect(page.locator('#diffuse-b-value')).toHaveValue('212');
  await page.locator('#diffuse-r-value').fill('80');await page.locator('#diffuse-r-value').press('Tab');await expect(page.locator('#diffuse-color')).toHaveValue('#5065d4');
  await page.locator('#diffuse-roughness-value').fill('0.5');await page.locator('#diffuse-roughness-value').press('Tab');
  await page.locator('#material').selectOption('metal');
  const url=await page.evaluate(async()=>{const path='/src/app/settings-link.ts';const {createSettingsLink}=await import(/* @vite-ignore */ path);return createSettingsLink(document,location.href,{position:[0,1,3.7],target:[0,1,0],up:[0,1,0],verticalFov:40});});
  await page.goto(url);await expect(page.locator('#material')).toBeEnabled({timeout:120000});await page.locator('#material').selectOption('diffuse');
  await expect(page.locator('#diffuse-color')).toHaveValue('#5065d4');await expect(page.locator('#diffuse-roughness-value')).toHaveValue('0.5');
  await page.locator('#diffuse-r-value').click({button:'middle'});await expect(page.locator('#diffuse-color')).toHaveValue('#ff65d4');
  await page.locator('#diffuse-roughness-value').click({button:'middle'});await expect(page.locator('#diffuse-roughness-value')).toHaveValue('0');
  await expect(page.locator('#error')).toBeHidden();
});
test('diffuse GPU RGB/spectral PT/SPPM agree with deterministic precise transport',async({page})=>{
  test.setTimeout(480000);await page.goto('/?scene=control&settings=1&resolution=19200&sample-limit=1');
  const results=await page.evaluate(async()=>{const path='/src/debug/verify-opaque-transport.ts';return (await import(/* @vite-ignore */ path)).verifyOpaqueTransport(['diffuse-white-0','diffuse-blue-0.5','diffuse-white-1','diffuse-black','diffuse-tiny'],128,true,undefined,false);});
  for(const row of results){
    expect(row.pt.errors).toBe(0);expect(row.sppm.errors).toBe(0);expect(row.pt.pixels.every(Number.isFinite)).toBe(true);expect(row.sppm.pixels.every(Number.isFinite)).toBe(true);
    expect(row.ptDeterministicDifference).toBe(0);expect(row.ptReplayRelativeL1).toBeLessThan(.01);expect(row.sppmReplayDifference).toBeLessThan(.0001);
    const difference=row.pt.mean.reduce((s:number,v:number,i:number)=>s+Math.abs(v-row.sppm.mean[i]!),0)/Math.max(1e-9,row.pt.mean.reduce((s:number,v:number)=>s+Math.abs(v),0));expect(difference).toBeLessThan(.05);
  }
});
