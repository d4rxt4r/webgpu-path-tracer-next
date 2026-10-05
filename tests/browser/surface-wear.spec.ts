import { expect, test, type Page } from "@playwright/test";

async function validationHost(page: Page): Promise<void> {
  await page.route("**/__wear-validation", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("/__wear-validation");
}

test("worn thin and volume glass preserve SPPM transmission in RGB and spectral mode", async ({ page }) => {
  test.setTimeout(180000);
  await validationHost(page);
  const results = await page.evaluate(async () => {
    const fixturePath = "/src/debug/shell-fixture.ts", renderPath = "/src/debug/render-sppm.ts";
    const { shellScene } = await import(/* @vite-ignore */ fixturePath);
    const { renderSppm } = await import(/* @vite-ignore */ renderPath);
    const results = [];
    for (const mode of ["rgb", "spectral"] as const) for (const thin of [false, true]) {
      const scene = shellScene("reference");
      Object.assign(scene.materials[0]!, { thin, absorption: [0, 0, 0], absorptionSpectrum: [[360, 0], [830, 0]], roughness: 0.03,
        surfaceWear: { scratches: 0.5, scuffs: 0.5, fingerprints: 0.5, seed: 1 } });
      const rendered = await renderSppm(scene, { width: 1, height: 1, mode, iterations: 8, photonsPerIteration: 64, photonBatchSize: 64, maxDepth: 8 });
      results.push({ errors: rendered.errors, pixels: rendered.pixels });
    }
    return results;
  });
  for (const result of results) {
    expect(result.errors).toBe(0);
    expect(result.pixels.every((value: number) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(Math.max(...result.pixels)).toBeGreaterThan(0.5);
  }
});

test("surface wear GPU normals, seed, transforms and sampling remain consistent", async ({ page }) => {
  test.setTimeout(180000);
  await validationHost(page);
  const result = await page.evaluate(async () => {
    const path = "/src/debug/verify-surface-wear.ts";
    const { verifySurfaceWear } = await import(/* @vite-ignore */ path);
    return verifySurfaceWear();
  });
  expect(result.cleanDifference).toBe(0);
  expect(result.seedDifference).toBeGreaterThan(0.01);
  expect(result.transformRoughness).toBeLessThan(0.0001);
  expect(result.transformNormal).toBeLessThan(0.00001);
  for (const row of result.results) {
    expect(row.invalid).toBe(0);
    expect(row.mismatch).toBeLessThan(0.00001);
    expect(row.inwardDifference).toBeLessThan(0.00001);
    expect(row.energy).toBeGreaterThan(0.98);
    expect(row.energy).toBeLessThan(1.01);
    if (row.wear.slice(0, 3).some((value: number) => value > 0)) {
      expect(row.changed).toBeGreaterThan(100);
      if (!row.thin && row !== result.results[9]) expect(row.sideDifference).toBeGreaterThan(0.001);
    } else {
      expect(row.changed).toBe(0);
    }
  }
});

test("wear editor preserves values, resets to model defaults, shares and exports", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?settings=1&scene=control&material=glass&profile=custom&integrator=pt&mode=rgb&resolution=19200&max-depth=8&sample-limit=2&wear-scratches=.3&wear-scuffs=.4&wear-fingerprints=.5&wear-seed=37");
  await expect(page.locator("#wear-seed")).toBeEnabled({ timeout: 120000 });
  for (const [id, expected] of [["wear-scratches", "0.3"], ["wear-scuffs", "0.4"], ["wear-fingerprints", "0.5"], ["wear-seed", "37"]])
    await expect(page.locator(`#${id}`)).toHaveValue(expected!);
  await page.locator("#material").selectOption("diffuse");
  await expect(page.locator("#wear-seed")).toBeDisabled();
  await page.locator("#material").selectOption("dielectric");
  await expect(page.locator("#wear-seed")).toHaveValue("37");
  await page.locator("#wear-scratches-value").click({ button: "middle" });
  await expect(page.locator("#wear-scratches")).toHaveValue("0");
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 60000 }).toBeGreaterThan(0);
  await page.locator("#export-pfm").evaluate(el => { el.closest("details")!.open = true; });
  const downloads: import("@playwright/test").Download[] = [];
  page.on("download", download => downloads.push(download));
  await page.locator("#export-pfm").click();
  await expect.poll(() => downloads.length).toBe(2);
  const { readFile } = await import("node:fs/promises");
  const json = downloads.find(download => download.suggestedFilename().endsWith(".json"))!;
  const metadata = JSON.parse(await readFile((await json.path())!, "utf8"));
  expect(metadata.materialSettings.surfaceWear).toEqual({ scratches: 0, scuffs: 0.4, fingerprints: 0.5, seed: 37 });
  const link = await page.evaluate(async () => {
    const path = "/src/app/settings-link.ts";
    const { createSettingsLink } = await import(/* @vite-ignore */ path);
    return createSettingsLink(document, location.href, { position: [0, 0.8, 3.5], target: [0, 0.8, 0], up: [0, 1, 0], verticalFov: 40 });
  });
  await page.goto(link);
  await expect(page.locator("#wear-seed")).toBeEnabled({ timeout: 120000 });
  await expect(page.locator("#wear-seed")).toHaveValue("37");
  await expect(page.locator("#wear-fingerprints")).toHaveValue("0.5");
  await page.locator("#scene").selectOption("rastagotchi");
  await expect(page.locator("#wear-scratches")).toHaveValue("0.5");
  await expect(page.locator("#wear-seed")).toHaveValue("1");
  await page.locator("#scene").selectOption("control");
  await expect(page.locator("#wear-scuffs")).toHaveValue("0");
  await expect(page.locator("#error")).toBeHidden();
});
