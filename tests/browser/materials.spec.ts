import { expect, test } from "@playwright/test";

test("SPPM preserves transmission through rough glass", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?scene=control");
  const results = await page.evaluate(async () => {
    const path = "/src/debug/verify-rough-transmission.ts";
    const { verifyRoughTransmission } = await import(/* @vite-ignore */ path);
    return verifyRoughTransmission();
  });
  for (const result of results) {
    expect(result.errors).toBe(0);
    expect(result.mean).toBeGreaterThan(0.5);
    expect(result.mean).toBeLessThan(1.1);
    if (result.roughness === 0.01) {
      const smooth = results.find((candidate: { thin: boolean; roughness: number; mean: number }) => candidate.thin === result.thin && candidate.roughness === 0)!;
      expect(Math.abs(result.mean - smooth.mean) / smooth.mean).toBeLessThan(0.1);
    }
  }
});

test("material editor preserves dielectric and texture values, resets and exports", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 60000 });
  await page.locator("#material").evaluate(el => { el.closest("details")!.open = true; });
  expect(await page.locator('#material option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(['diffuse', 'dielectric', 'metal', 'plastic', 'emissive', 'textured']);
  await page.locator("#material").selectOption("dielectric");
  await page.locator("#ior-value").fill("1.8");
  await page.locator("#ior-value").press("Tab");
  await page.locator("#dispersion").check();
  await page.locator("#abbe-value").fill("40");
  await page.locator("#abbe-value").press("Tab");
  await page.locator("#material").selectOption("textured");
  await page.locator("#texture-scale-value").fill("12");
  await page.locator("#texture-scale-value").press("Tab");
  await page.locator("#texture-kind").selectOption("lava");
  await expect(page.locator("#texture-scale")).toHaveValue("6");
  await page.locator("#texture-kind").selectOption("marble");
  await expect(page.locator("#texture-scale")).toHaveValue("12");
  await page.locator("#material").selectOption("dielectric");
  await expect(page.locator("#ior")).toHaveValue("1.8");
  await expect(page.locator("#dispersion")).toBeChecked();
  await expect(page.locator("#abbe")).toHaveValue("40");
  await page.locator("#ior-value").click({ button: "middle" });
  await expect(page.locator("#ior")).toHaveValue("1.7");
  await page.locator("#dielectric-mode").selectOption("thin");
  await expect(page.locator("#transmission-depth")).toBeDisabled();
  await expect(page.locator("#roughness")).toBeEnabled();
  await page.locator("#roughness-value").fill("0.35");
  await page.locator("#roughness-value").press("Tab");
  await page.locator("#resolution").selectOption("19200");
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 30000 }).toBeGreaterThan(0);
  await page.locator("#pause").click();
  await page.locator("#export-pfm").evaluate(el => { el.closest("details")!.open = true; });
  const downloads: import("@playwright/test").Download[] = [];
  page.on("download", download => downloads.push(download));
  await page.locator("#export-pfm").click();
  await expect.poll(() => downloads.length).toBe(2);
  const json = downloads.find(download => download.suggestedFilename().endsWith(".json"))!;
  const { readFile } = await import("node:fs/promises");
  const metadata = JSON.parse(await readFile((await json.path())!, "utf8"));
  expect(metadata.materialSettings).toMatchObject({ mode: "thin", actualMode: "thin", roughness: 0.35, dispersion: true, abbe: 40 });
  await expect(page.locator("#error")).toBeHidden();
});

test("rough dielectric GPU PDF, energy, reciprocity and photon gather", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 60000 });
  await page.locator("#pause").click();
  const results = await page.evaluate(async () => {
    const path = "/src/debug/verify-rough-dielectric.ts";
    const { verifyRoughDielectric } = await import(/* @vite-ignore */ path);
    return verifyRoughDielectric();
  });
  for (const result of results) {
    expect(result.invalid).toBe(0);
    expect(result.energy).toBeGreaterThan(0);
    expect(result.energy).toBeLessThanOrEqual(1.01);
    expect(result.reciprocity).toBeLessThan(0.002);
    expect(result.mismatch).toBeLessThan(0.00001);
    if (result.roughness >= 0.6) {
      expect(Math.abs(result.accepted - result.pdfIntegral)).toBeLessThan(0.01);
      expect(Math.abs(result.energy - result.quadratureEnergy)).toBeLessThan(0.01);
    }
  }
  const gather = await page.evaluate(async () => {
    const path = "/src/debug/verify-sppm.ts";
    const { verifySppm } = await import(/* @vite-ignore */ path);
    return verifySppm(true);
  });
  expect(gather.errors).toBe(0);
  expect(gather.maxError).toBeLessThan(0.0001);
  expect(gather.counts).toEqual([3, 3, 1, 0]);
  const transport = await page.evaluate(async () => {
    const path = "/src/debug/verify-transport.ts";
    const { verifyTransport } = await import(/* @vite-ignore */ path);
    return verifyTransport(false, true);
  });
  expect(transport.errors).toBe(0);
  expect(transport.sppm!.errors).toBe(0);
  for (const estimate of [...transport.estimates, transport.sppm!.pixels])
    expect(Math.abs(estimate[0]! - transport.reference[0]!) / transport.reference[0]!).toBeLessThan(0.01);
});
