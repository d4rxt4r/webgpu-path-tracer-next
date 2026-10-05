import { expect, test } from "@playwright/test";

test("Quality starts with a complete PT preview and compiles only requested pipelines", async ({page}) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    (window as any).__startupPipelines = [];
    GPUDevice.prototype.createComputePipelineAsync = function(descriptor) {
      (window as any).__startupPipelines.push({
        entry: descriptor.compute.entryPoint,
        samples: Number(document.querySelector("canvas")?.dataset.samples ?? 0),
        integrator: document.querySelector("canvas")?.dataset.integrator,
      });
      return original.call(this, descriptor);
    };
  });
  await page.goto("/?settings=1&scene=control&profile=custom&integrator=sppm&mode=rgb&resolution=1024&max-depth=4&photons=64&batch=64&sample-limit=2&denoiser=0");
  await expect(page.locator("canvas")).toHaveAttribute("data-integrator", "sppm", {timeout: 150000});
  await expect(page.locator("canvas")).toHaveAttribute("data-samples", "2", {timeout: 30000});
  await expect(page.locator("#error")).toBeHidden();
  const result = await page.evaluate(() => ({
    pipelines: (window as any).__startupPipelines,
    timings: JSON.parse(document.querySelector("canvas")!.dataset.startupTimings!),
  }));
  const camera = result.pipelines.find((entry: any) => entry.entry === "cameraMain");
  expect(camera.integrator).toBe("pt");
  expect(camera.samples).toBeGreaterThan(0);
  expect(result.pipelines.map((entry: any) => entry.entry)).not.toContain("guideMain");
  expect(result.pipelines.map((entry: any) => entry.entry)).not.toContain("densityMain");
  expect(result.timings["first-target"]).toBeGreaterThan(result.timings["first-preview"]);
  const entries = result.pipelines.map((entry: any) => entry.entry);
  expect(entries.filter((entry: string) => entry === "repairMain")).toHaveLength(1);
  expect(entries.filter((entry: string) => entry === "cameraRepairMain")).toHaveLength(1);
});
