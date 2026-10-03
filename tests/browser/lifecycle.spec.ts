import { expect, test } from "@playwright/test";

test("real device destruction recovers the CPU scene and preserves pause/settings without optional features", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const gpu = navigator.gpu;
    const requestAdapter = gpu.requestAdapter.bind(gpu);
    (window as any).__devices = [];
    gpu.requestAdapter = async (options) => {
      const adapter = await requestAdapter(options);
      if (!adapter) return null;
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async () => {
        // Real baseline device: no timestamp-query, default WebGPU buffer limits.
        const device = await requestDevice();
        (window as any).__devices.push(device);
        return device;
      };
      return adapter;
    };
  });
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#view").selectOption("depth");
  await expect
    .poll(() => page.locator("canvas").getAttribute("data-frames"))
    .not.toBe("0");
  await page.locator("#pause").click();
  await page.evaluate(() => (window as any).__devices.at(-1).destroy());
  await expect
    .poll(() => page.evaluate(() => (window as any).__devices.length))
    .toBe(2);
  await expect(page.locator("#status")).toHaveText("Пауза");
  await expect(page.locator("#view")).toHaveValue("depth");
  await expect(page.locator("#error")).toBeHidden();
  await page.locator("#pause").click();
  await expect
    .poll(() => page.locator("canvas").getAttribute("data-frames"))
    .not.toBe("0");
  const features = await page.evaluate(() =>
    Array.from((window as any).__devices.at(-1).features),
  );
  expect(features).not.toContain("timestamp-query");
  expect(features).not.toContain("shader-f16");
  expect(features).not.toContain("subgroups");
  expect(await page.locator("#stats").textContent()).toContain(
    "GPU timestamp: недоступен",
  );
});

test("background visibility suspends work and respects a manually paused renderer", async ({
  page,
}) => {
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  const visibility = async (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: hidden,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await visibility(true);
  await expect(page.locator("#status")).toHaveText("Пауза");
  await page.waitForTimeout(150);
  const frames = await page.locator("canvas").getAttribute("data-frames");
  await page.waitForTimeout(150);
  expect(await page.locator("canvas").getAttribute("data-frames")).toBe(frames);
  await visibility(false);
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#pause").click();
  await visibility(true);
  await visibility(false);
  await expect(page.locator("#status")).toHaveText("Пауза");
});

test("high DPR and repeated PT/SPPM scene replacement retain bounded persistent resources", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const context = await browser.newContext({
    deviceScaleFactor: 3,
    viewport: { width: 1200, height: 800 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/?scene=control");
    await expect(page.locator("#status")).toHaveText("WebGPU готов");
    await page.locator("#pause").click();
    const result = await page.evaluate(async () => {
      const rendererUrl = "/src/render/intersection-renderer.ts",
        sceneUrl = "/src/scene/cornell.ts";
      const { IntersectionRenderer } = await import(
        /* @vite-ignore */ rendererUrl
      );
      const { cornellScene } = await import(/* @vite-ignore */ sceneUrl);
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;left:0;top:0;width:160px;height:120px";
      document.body.append(canvas);
      let stats: any = {},
        stopped = false;
      const errors: string[] = [],
        bytes: number[] = [];
      const renderer = new IntersectionRenderer(
        canvas,
        (s: any) => {
          stats = s;
          if (s.samples === 1 && !stopped) {
            stopped = true;
            renderer.pause();
          }
        },
        (e: Error) => errors.push(e.message),
      );
      const wait = async () => {
        const start = performance.now();
        while (!stopped && performance.now() - start < 10000)
          await new Promise((r) => setTimeout(r, 20));
        if (!stopped) throw new Error(`Stalled: ${errors}`);
      };
      try {
        renderer.setDebugView("beauty");
        renderer.setSettings({
          maxPixels: 19200,
          memoryBudgetMiB: 64,
          photonsPerIteration: 1024,
          photonBatchSize: 256,
        });
        await renderer.setScene(cornellScene());
        await renderer.initialize();
        await wait();
        const backing = {
          width: canvas.width,
          height: canvas.height,
          dpr: devicePixelRatio,
        };
        for (let cycle = 0; cycle < 3; cycle++) {
          for (const integrator of ["sppm", "pt"] as const) {
            stopped = false;
            renderer.setSettings({
              integrator,
              mode: "spectral",
              maxDepth: 32,
            });
            await renderer.setScene(cornellScene("nbk7"));
            renderer.resume();
            await wait();
            bytes.push(stats.bytes);
          }
        }
        return {
          errors,
          bytes,
          backing,
          width: stats.width,
          height: stats.height,
        };
      } finally {
        renderer.dispose();
        canvas.remove();
      }
    });
    console.log("Lifecycle acceptance:", JSON.stringify(result));
    expect(result.errors).toEqual([]);
    expect(result.backing.dpr).toBe(3);
    expect(result.backing.width).toBe(320);
    expect(result.width * result.height).toBeLessThanOrEqual(19200);
    expect(new Set(result.bytes.filter((_, i) => i % 2 === 0)).size).toBe(1);
    expect(new Set(result.bytes.filter((_, i) => i % 2 === 1)).size).toBe(1);
    expect(Math.max(...result.bytes)).toBeLessThan(64 * 1048576);
  } finally {
    await context.close();
  }
});
