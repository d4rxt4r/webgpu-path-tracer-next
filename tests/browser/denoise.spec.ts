import { expect, test } from "@playwright/test";

test("GPU denoisers preserve colors, silhouettes, bypass, and comparison", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/tests/fixtures/denoise.html");
  const result = await page.evaluate(async () => {
    const { verifyDenoise } = await import("/src/debug/verify-denoise.ts" as string);
    return verifyDenoise();
  });
  expect(result.checks).toBeGreaterThan(1000);
  expect(result.rows).toHaveLength(18);
});

test("PT and spectral SPPM filters preserve accumulated radiance", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/tests/fixtures/denoise.html");
  for (const [integrator, mode] of [["pt", "rgb"], ["sppm", "spectral"]] as const) {
    const result = await page.evaluate(async ({ integrator, mode }) => {
      const { compareDenoise } = await import("/src/debug/compare-denoise.ts" as string);
      return compareDenoise({ integrator, mode, roughness: .12, low: 2, reference: 4 });
    }, { integrator, mode });
    expect(result.rawPreserved).toBe(true);
    expect(result.rows).toHaveLength(11);
    expect(result.errors).toEqual([]);
  }
});

test("denoise UI restores legacy glass links and runs NLM on pause", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?settings=1&scene=control&profile=custom&mode=rgb&integrator=pt&resolution=19200&max-depth=8&sample-limit=4&denoiser=1&filter-glass=1");
  await expect(page.locator("#glass-mode")).toHaveValue("surface");
  await expect(page.locator("#status")).toHaveText("Пауза", { timeout: 120000 });
  const samples = await page.locator("canvas").getAttribute("data-samples");
  await page.locator(".inspector details").filter({ has: page.locator("#denoiser") }).first().evaluate((e: HTMLDetailsElement) => e.open = true);
  await page.locator("#denoise-algorithm").selectOption("bilateral");
  await expect(page.locator("#denoise-passes")).toBeHidden();
  await expect(page.locator("#denoise-radius")).toBeVisible();
  await page.locator("#denoise-algorithm").selectOption("nlm");
  await expect(page.locator("#denoise-radius")).toHaveValue("3");
  await page.locator("#glass-mode").selectOption("image");
  await page.locator("#denoise-compare").check();
  await page.locator("#apply-nlm").click();
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("canvas")).toHaveAttribute("data-samples", samples!);
  await page.locator("#pause").click();
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples"))).toBeGreaterThan(Number(samples));
  await page.locator("#pause").click();
  await expect(page.locator("#error")).toBeHidden();
});
