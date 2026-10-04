import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("editor fits the window, exposes working groups and exports PNG plus raw PFM metadata", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", {
    timeout: 20000,
  });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 700, height: 500 },
    { width: 500, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      })),
    ).toEqual(viewport);
    const canvasRect = (await page.locator("canvas").boundingBox())!;
    expect(canvasRect.height).toBeGreaterThan(200);
    expect(canvasRect.width).toBeCloseTo(canvasRect.height, 0);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator("[data-profile=reference]").click();
  await expect(page.locator("#mode")).toHaveValue("spectral");
  await expect(page.locator("#max-depth")).toHaveValue("64");
  await page.locator("[data-profile=quality]").click();
  await expect(page.locator("#integrator")).toHaveValue("sppm");
  await expect(page.locator("#denoiser")).toBeChecked();
  await page.locator("[data-profile=preview]").click();
  await expect(page.locator("#mode")).toHaveValue("rgb");
  await expect(page.locator("#integrator")).toHaveValue("pt");
  await expect
    .poll(async () =>
      Number(await page.locator("canvas").getAttribute("data-samples")),
    )
    .toBeGreaterThan(0);
  await page.locator("#pause").click();
  await page.locator("#export-png").evaluate((el) => {
    el.closest("details")!.open = true;
  });
  const pngPromise = page.waitForEvent("download");
  await page.locator("#export-png").click();
  const png = await pngPromise;
  const pngBytes = await readFile((await png.path())!);
  expect(pngBytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const downloads: import("@playwright/test").Download[] = [];
  page.on("download", (file) => downloads.push(file));
  await page.locator("#export-pfm").click();
  await expect.poll(() => downloads.length).toBe(2);
  const pfm = downloads.find((file) =>
      file.suggestedFilename().endsWith(".pfm"),
    )!,
    json = downloads.find((file) =>
      file.suggestedFilename().endsWith(".json"),
    )!;
  expect((await readFile((await pfm.path())!)).subarray(0, 2).toString()).toBe(
    "PF",
  );
  const metadata = JSON.parse(await readFile((await json.path())!, "utf8"));
  expect(metadata.settings.mode).toBe("rgb");
  expect(metadata.camera.verticalFov).toBe(40);
  expect(metadata.sampleCountRange[0]).toBeGreaterThan(0);
  await expect(page.locator("#error")).toBeHidden();
  await page.screenshot({ path: "test-results/stage9-editor.png" });
});

test("orbit uses natural vertical motion and returns from live Preview to Quality", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("[data-profile=quality]").click();
  await page.locator("#resolution").selectOption("19200");
  const canvas = page.locator("canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-samples")), {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 30,
    box.y + box.height / 2 + 40,
    { steps: 10 },
  );
  await expect(canvas).toHaveAttribute("data-interacting", "true");
  await expect(canvas).toHaveAttribute("data-integrator", "pt");
  await page.mouse.up();
  await expect(canvas).toHaveAttribute("data-interacting", "false");
  await expect(canvas).toHaveAttribute("data-integrator", "sppm");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-samples")), {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  await page.locator("#pause").click();
  await page.locator("#export-pfm").evaluate((el) => {
    el.closest("details")!.open = true;
  });
  const files: import("@playwright/test").Download[] = [];
  page.on("download", (file) => files.push(file));
  await page.locator("#export-pfm").click();
  await expect.poll(() => files.length).toBe(2);
  const metadata = JSON.parse(
    await readFile(
      (await files
        .find((file) => file.suggestedFilename().endsWith(".json"))!
        .path())!,
      "utf8",
    ),
  );
  expect(metadata.camera.position[1]).toBeGreaterThan(1);
  for (const view of [
    "material",
    "wavelength",
    "path-length",
    "photon-density",
    "beauty",
  ]) {
    await page.locator("#view").selectOption(view);
    await expect
      .poll(async () => Number(await canvas.getAttribute("data-frames")), {
        timeout: 20000,
      })
      .toBeGreaterThan(0);
    await expect(page.locator("#error")).toBeHidden();
  }
});

test("display filtering preserves raw samples, keeps glass raw and retains the complete frame during tiled reset", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const rendererUrl = "/src/render/intersection-renderer.ts",
      sceneUrl = "/src/scene/cornell.ts";
    const { IntersectionRenderer } = (await import(
      /* @vite-ignore */ rendererUrl
    )) as typeof import("../../src/render/intersection-renderer");
    const { cornellScene } = (await import(
      /* @vite-ignore */ sceneUrl
    )) as typeof import("../../src/scene/cornell");
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:160px;height:120px;z-index:10";
    document.body.append(canvas);
    let stats: any = {},
      stopAt = 2,
      partial = false,
      stopped = false;
    const errors: string[] = [];
    const renderer = new IntersectionRenderer(
      canvas,
      (info) => {
        stats = info;
        if (
          !stopped &&
          ((partial && info.samples === 0 && info.tile > 0) ||
            info.samples === stopAt)
        ) {
          stopped = true;
          renderer.pause();
        }
      },
      (error) => errors.push(error.message),
    );
    // Exercise a partial grid regardless of the adapter's calibrated tile size.
    (renderer as any).pathTileSize = 48;
    const wait = async (condition: () => boolean) => {
      const start = performance.now();
      while (!condition() && performance.now() - start < 15000)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!condition())
        throw new Error("Renderer stalled " + JSON.stringify(stats));
    };
    const pixels = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      const temp = document.createElement("canvas");
      temp.width = bitmap.width;
      temp.height = bitmap.height;
      temp.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      return temp.getContext("2d")!.getImageData(0, 0, temp.width, temp.height)
        .data;
    };
    const snapshot = async () => {
      // Queue completion precedes canvas presentation. Wait for the compositor
      // before comparing screenshots of the last complete frame.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const bitmap = await createImageBitmap(canvas);
      const temp = document.createElement("canvas");
      temp.width = bitmap.width;
      temp.height = bitmap.height;
      temp.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      return temp.getContext("2d")!.getImageData(0, 0, temp.width, temp.height)
        .data;
    };
    const gradient = (p: Uint8ClampedArray) => {
      let sum = 0;
      for (let y = 30; y < 60; y++)
        for (let x = 35; x < 65; x++) {
          const i = (y * 160 + x) * 4;
          sum +=
            Math.abs(p[i]! - p[i + 4]!) +
            Math.abs(p[i + 1]! - p[i + 5]!) +
            Math.abs(p[i + 2]! - p[i + 6]!);
        }
      return sum;
    };
    try {
      renderer.setSettings({ maxPixels: 19200, seed: 17, maxDepth: 32 });
      renderer.setDebugView("beauty");
      await renderer.setScene(cornellScene("glass"));
      await renderer.initialize();
      await wait(() => stopped);
      const raw = await renderer.capture(),
        before = await pixels(await renderer.capturePng());
      const shown = await snapshot();
      renderer.setDisplay({ enabled: true, passes: 3, strength: 3 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const filtered = await renderer.capture(),
        after = await pixels(await renderer.capturePng());
      const rawPreserved =
        raw.samples === filtered.samples &&
        raw.linearRgb.every((v, i) => v === filtered.linearRgb[i]);
      // Center of projected control sphere: the first-hit glass mask bypasses the filter.
      const glassPixel = (80 + 76 * 160) * 4;
      const glassPreserved = [0, 1, 2].every(
        (c) => before[glassPixel + c] === after[glassPixel + c],
      );
      renderer.setDisplay({ enabled: false });
      await new Promise((resolve) => setTimeout(resolve, 100));
      partial = true;
      stopped = false;
      renderer.setCamera({
        ...cornellScene().camera,
        position: [0.1, 1.1, 3.7],
      });
      await wait(() => stopped);
      const held = await snapshot();
      const completeHeld = held.every((v, i) => v === shown[i]);
      const partialRevisionHidden = stats.presentedRevision !== stats.revision;
      partial = false;
      stopAt = 1;
      stopped = false;
      renderer.resume();
      await wait(() => stopped);
      const current = await renderer.capture();
      canvas.style.width = "1600px";
      canvas.style.height = "1200px";
      renderer.setSettings({
        maxPixels: 2073600,
        memoryBudgetMiB: 64,
        integrator: "sppm",
        photonBatchSize: 4096,
        maxDepth: 64,
      });
      const budgetBounded =
        stats.bytes < 64 * 1048576 && stats.width * stats.height < 500000;
      return {
        errors,
        rawPreserved,
        glassPreserved,
        completeHeld,
        partialRevisionHidden,
        newFrameUniform: current.sampleCounts.every((v) => v === 1),
        gradientBefore: gradient(before),
        gradientAfter: gradient(after),
        budgetBounded,
        gpuMs: stats.gpuMs,
      };
    } finally {
      renderer.dispose();
      canvas.remove();
    }
  });
  console.log("Editor display acceptance:", JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.rawPreserved).toBe(true);
  expect(result.glassPreserved).toBe(true);
  expect(result.completeHeld).toBe(true);
  expect(result.partialRevisionHidden).toBe(true);
  expect(result.newFrameUniform).toBe(true);
  expect(result.gradientAfter).toBeLessThan(result.gradientBefore);
  expect(result.budgetBounded).toBe(true);
});
