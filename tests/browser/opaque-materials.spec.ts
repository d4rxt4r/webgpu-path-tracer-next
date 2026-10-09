import { expect, test } from '@playwright/test';
test('opaque controls retain colors, channel defaults, links and hidden settings',async({page})=>{
  test.setTimeout(180000);
  await page.goto('/?scene=control&settings=1&resolution=19200&sample-limit=2');
  await expect(page.locator('#material')).toBeEnabled({timeout:120000});
  await page.locator('#material').selectOption('metal');
  await expect(page.locator('#metal-settings')).toHaveCSS('row-gap','10px');
  await page.locator('#metal-preset').selectOption('gold');await page.locator('#metal-preset').selectOption('custom');
  const initial=await page.locator('#metal-color').inputValue();
  await page.locator('#metal-r-value').fill('37');await page.locator('#metal-r-value').press('Tab');
  const edited=await page.locator('#metal-color').inputValue();expect(edited.slice(1,3)).toBe('25');
  await page.locator('#metal-preset').selectOption('silver');await page.locator('#metal-preset').selectOption('custom');
  await expect(page.locator('#metal-color')).toHaveValue(edited);
  await page.locator('#material').selectOption('emissive');await page.locator('#emissive-power-value').fill('80');await page.locator('#emissive-power-value').press('Tab');
  await expect(page.locator('#emissive-power-value')).toHaveValue('80');await expect(page.locator('#emissive-power')).toHaveValue('40');
  await page.locator('#material').selectOption('plastic');await page.locator('#plastic-ior-value').fill('2');await page.locator('#plastic-ior-value').press('Tab');
  const url=await page.evaluate(async()=>{const modulePath='/src/app/settings-link.ts';const {createSettingsLink}=await import(/* @vite-ignore */ modulePath);return createSettingsLink(document,location.href,{position:[0,1,3.7],target:[0,1,0],up:[0,1,0],verticalFov:40});});
  await page.goto(url);await expect(page.locator('#material')).toBeEnabled({timeout:120000});
  await expect(page.locator('#plastic-ior')).toHaveValue('2');await page.locator('#material').selectOption('metal');
  await expect(page.locator('#metal-color')).toHaveValue(edited);await expect(page.locator('#metal-color-default')).toHaveValue(initial);
  await page.locator('#metal-r-value').click({button:'middle'});await expect(page.locator('#metal-color')).toHaveValue(initial);
  await page.locator('#material').selectOption('emissive');await expect(page.locator('#emissive-power-value')).toHaveValue('80');
  await expect(page.locator('#error')).toBeHidden();
});
test('GPU opaque BSDF energy, PDF and reciprocity',async({page})=>{
  test.setTimeout(180000);await page.goto('/?scene=control&settings=1&resolution=19200&sample-limit=1');
  const results=await page.evaluate(async()=>{const path='/src/debug/verify-opaque-bsdf.ts';return (await import(/* @vite-ignore */ path)).verifyOpaqueBsdf();});
  for(const result of results){expect(result.invalid).toBe(0);expect(result.energy).toBeGreaterThan(0);expect(result.energy).toBeLessThanOrEqual(1.01);expect(result.reciprocity).toBeLessThan(.0001);expect(result.mismatch).toBeLessThan(.00001);expect(Math.abs(result.energy-result.quadratureEnergy)).toBeLessThan(.01);expect(Math.abs(result.accepted-result.pdfIntegral)).toBeLessThan(.01);}
});

test('opaque transport RGB/spectral PT/SPPM and precise replay',async({page})=>{
  test.setTimeout(480000);await page.goto('/?scene=control&settings=1&resolution=19200&sample-limit=1');
  const results=await page.evaluate(async()=>{const path='/src/debug/verify-opaque-transport.ts';return (await import(/* @vite-ignore */ path)).verifyOpaqueTransport(['gold-0','custom-.6','plastic-0','emissive-10'],128,true);});
  for(const row of results){
    expect(row.pt.errors).toBe(0);expect(row.sppm.errors).toBe(0);
    expect(row.pt.pixels.every(Number.isFinite)).toBe(true);expect(row.sppm.pixels.every(Number.isFinite)).toBe(true);
    expect(row.ptDeterministicDifference).toBe(0);expect(row.ptReplayRelativeL1).toBeLessThan(.01);expect(row.sppmReplayDifference).toBeLessThan(.0001);
    const meanDifference=row.pt.mean.reduce((sum:number,v:number,i:number)=>sum+Math.abs(v-row.sppm.mean[i]!),0)/row.pt.mean.reduce((sum:number,v:number)=>sum+Math.abs(v),0);
    expect(meanDifference).toBeLessThan(.05);
  }
});
