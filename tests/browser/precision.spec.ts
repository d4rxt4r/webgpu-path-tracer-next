import { expect,test } from "@playwright/test";

test("GPU surface reconstruction obeys float64 bounds and orders narrow-fold boundaries",async ({page})=>{
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#pause").click();
  const result=await page.evaluate(async()=>{
    const url="/src/debug/verify-precision.ts";
    const {verifyPrecision}=await import(/* @vite-ignore */ url);
    return verifyPrecision();
  });
  expect(result.cases).toBe(1024);expect(result.maxBoundRatio).toBeLessThanOrEqual(1.001);
  expect(result.wrongSide).toBe(0);expect(result.nonFinite).toBe(0);
  expect(result.preciseWrongSide).toBe(0);expect(result.maxPreciseDisplacement).toBeLessThan(4e-12);
  expect(result.retreatedWrongSide).toBe(0);expect(result.minRetreatMarginRatio).toBeGreaterThan(.9);expect(result.maxRetreatBoundRatio).toBeLessThan(1.001);
  expect(result.nearest).toEqual([50750,39459]);expect(result.errors).toEqual([0,0]);
});

test("photon edge predicates select the CPU float64 exit instead of leaking glass",async ({page})=>{
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#pause").click();
  const results=await page.evaluate(async()=>{
    const url="/src/debug/replay-buddha-transport.ts";
    const {replayBuddhaTransport}=await import(/* @vite-ignore */ url);
    const values=[];
    for(const [sample,index] of [[2,6711],[49,2851]])
      values.push(await replayBuddhaTransport({phase:"photon",sample:sample!,index:index!}));
    return values;
  });
  for(const result of results) expect(result.errors[0]).toBe(0);
  expect(results[0]!.steps[4]!.triangle).toBe(results[0]!.cpu[4]!.index);
  expect(results[1]!.steps[4]!.triangle).toBe(results[1]!.cpu[4]!.index);
});


test("compensated plane distances match float64 for grazing rays and several scales", async ({page}) => {
  await page.goto("/?scene=control");
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const url = "/src/debug/verify-plane-distance.ts";
    const {verifyPlaneDistance} = await import(/* @vite-ignore */ url);
    return verifyPlaneDistance();
  });
  expect(result.cases).toBe(1024);
  expect(result.nonFinite).toBe(0);
  expect(result.maxNormalizedError).toBeLessThan(1e-9);
});
