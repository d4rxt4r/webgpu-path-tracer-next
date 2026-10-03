import { expect, test } from "@playwright/test";

test("Suzanne is occluded by all five walls, with BVH cost limited to the visible ray segment", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const url = "/src/debug/verify-occlusion.ts";
    const { verifyOcclusion } = await import(/* @vite-ignore */ url);
    return verifyOcclusion();
  });
  console.log("Six-side BVH acceptance:", JSON.stringify(result));
  expect(result.mismatches).toEqual([]);
  expect(result.rays).toBe(294);
  for (const side of result.sides) {
    expect(side.actualSurface).toBe(side.surface);
    expect(side.visibleVisits).toBeLessThanOrEqual(side.fullVisits);
  }
});
