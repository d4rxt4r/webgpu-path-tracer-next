import {expect,test} from '@playwright/test';

test('GPU retry queue preserves compact jobs and every overflowed invocation',async({page})=>{
  await page.goto('/?scene=control');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#pause').click();
  const results=await page.evaluate(async()=>{
    const url='/src/debug/verify-transport-queue.ts';
    const {verifyTransportQueue}=await import(/* @vite-ignore */ url);
    return verifyTransportQueue();
  });
  expect(results[0]).toMatchObject({count:256,dense:0,missed:0,duplicated:0,unexpected:0});
  expect(results[1]).toMatchObject({count:70001,dense:1,missed:0,duplicated:0,unexpected:0});
});
