import {expect,test} from '@playwright/test';

test('PT and SPPM replay every forced path exactly once across overflow and pause',async({page})=>{
  test.setTimeout(120000);
  await page.goto('/?scene=control');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#pause').click();
  const result=await page.evaluate(async()=>{
    const url='/src/debug/verify-transport-replay.ts';
    const {verifyTransportReplay}=await import(/* @vite-ignore */ url);
    return verifyTransportReplay();
  });
  expect(result.forcedModules).toBeGreaterThanOrEqual(2);
  expect(result.pt.partialCounts).toBe(true);
  for(const image of [result.pt,result.sppm]) {
    expect(image.countsComplete).toBe(true);expect(image.nonFinite).toBe(0);
    expect(image.energy).toBeGreaterThan(0);expect(image.normalizedRmse).toBeLessThan(1e-5);
  }
  expect(result.sppm.errors).toBe(0);expect(result.sppm.emittedPhotons).toBe(512);
});
