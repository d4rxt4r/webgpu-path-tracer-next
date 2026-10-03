import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

test("blue glass Buddha keeps valid media across narrow folds at high resolution", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", {
    timeout: 20000,
  });
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const url = "/src/debug/verify-buddha-glass.ts";
    const { verifyBuddhaGlass } = await import(/* @vite-ignore */ url);
    const failingPath = await verifyBuddhaGlass(960, 720, 1, {
      sample: 2,
      pixel: 309683,
    });
    const rectangular = await verifyBuddhaGlass(960, 720, 16);
    const square = await verifyBuddhaGlass(831, 831, 16);
    const renderUrl = "/src/debug/render-sppm.ts",
      sceneUrl = "/src/scene/buddha.ts";
    const { renderSppm } = await import(/* @vite-ignore */ renderUrl);
    const { buddhaScene } = await import(/* @vite-ignore */ sceneUrl);
    const sppm = await renderSppm(await buddhaScene("blue-glass"), {
      width: 128,
      height: 128,
      iterations: 64,
      photonsPerIteration: 4096,
      photonBatchSize: 1024,
      maxDepth: 32,
      initialRadius: 0.03,
    });
    return {
      failingPath,
      rectangular,
      square,
      sppm: {
        errors: sppm.errors,
        countsComplete: sppm.counts.every((n: number) => n === 64),
        emittedPhotons: sppm.emittedPhotons,
      },
    };
  });
  console.log("Buddha glass regression:", JSON.stringify(result));
  await writeFile(
    "docs/validation/buddha-glass-regression.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  expect(result.failingPath.failures).toEqual([]);
  expect(result.rectangular.paths).toBe(960 * 720 * 16);
  expect(result.rectangular.failures).toEqual([]);
  expect(result.square.paths).toBe(831 * 831 * 16);
  expect(result.square.failures).toEqual([]);
  expect(result.sppm.errors).toBe(0);
  expect(result.sppm.countsComplete).toBe(true);
});

test("Buddha intersections and wall occlusion agree with CPU from all six sides", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", {
    timeout: 20000,
  });
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const sceneUrl = "/src/scene/buddha.ts",
      checkUrl = "/src/debug/verify-occlusion.ts";
    const { buddhaScene } = await import(/* @vite-ignore */ sceneUrl);
    const { verifyOcclusion } = await import(/* @vite-ignore */ checkUrl);
    return verifyOcclusion(await buddhaScene());
  });
  await writeFile(
    "docs/validation/buddha-occlusion.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  expect(result.rays).toBe(294);
  expect(result.mismatches).toEqual([]);
  for (const side of result.sides)
    expect(side.actualSurface).toBe(side.surface);
});

test("polished stone conserves energy in PT strategies and SPPM", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", {
    timeout: 20000,
  });
  await page.locator("#pause").click();
  const result = await page.evaluate(async () => {
    const url = "/src/debug/verify-transport.ts";
    const { verifyTransport } = await import(/* @vite-ignore */ url);
    return verifyTransport(true);
  });
  console.log("Coated stone acceptance:", JSON.stringify(result));
  expect(result.errors).toBe(0);
  expect(result.sppm.errors).toBe(0);
  for (let c = 0; c < 3; c++) {
    for (const estimate of result.estimates)
      expect(Math.abs(estimate[c] / result.reference[c] - 1)).toBeLessThan(
        0.02,
      );
    expect(
      Math.abs(result.sppm.pixels[c] / result.reference[c] - 1),
    ).toBeLessThan(0.02);
  }
});

test("Buddha materials render live, restore other objects and keep the page within its window", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?scene=buddha");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", {
    timeout: 30000,
  });
  await page.locator("[data-profile=preview]").click();
  await page.locator("#resolution").selectOption("19200");
  await page.locator("#sample-limit").evaluate((el: HTMLInputElement) => {
    el.value = "16";
    el.dispatchEvent(new Event("input"));
  });
  const canvas = page.locator("canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-samples")), {
      timeout: 30000,
    })
    .toBeGreaterThanOrEqual(16);
  await expect(page.locator("#scene-name")).toContainText(
    "Happy Buddha / marble",
  );
  await expect(page.locator("#texture-group")).toBeVisible();
  await expect(page.locator("#lava-settings")).toBeHidden();
  const pixels = async () => {
    await page.locator("#export-png").evaluate((el) => {
      el.closest("details")!.open = true;
    });
    await expect(page.locator("#export-png")).toBeEnabled();
    const next = page.waitForEvent("download");
    await page.locator("#export-png").click();
    return readFile((await (await next).path())!);
  };
  const marble = await pixels();
  await page.locator("#material").evaluate((el) => {
    el.closest("details")!.open = true;
  });
  await page.locator("#material").selectOption("lava");
  await expect(page.locator("#scene-name")).toContainText(
    "Happy Buddha / lava",
  );
  await expect(page.locator("#lava-settings")).toBeVisible();
  // Resume after the sample limit pause; scene revisions reset sample counts.
  await page.locator("#pause").click();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-samples")), {
      timeout: 30000,
    })
    .toBeGreaterThanOrEqual(16);
  const lava = await pixels();
  expect(lava.equals(marble)).toBe(false);
  const floorBrightness = (png: Buffer) =>
    page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        ),
        image = document.createElement("canvas");
      image.width = bitmap.width;
      image.height = bitmap.height;
      const context = image.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let sum = 0,
        count = 0;
      for (
        let y = Math.floor(image.height * 0.85);
        y < image.height * 0.95;
        y++
      )
        for (
          let x = Math.floor(image.width * 0.25);
          x < image.width * 0.75;
          x++
        ) {
          const i = (y * image.width + x) * 4;
          sum +=
            0.2126 * pixels[i]! +
            0.7152 * pixels[i + 1]! +
            0.0722 * pixels[i + 2]!;
          count++;
        }
      return sum / count;
    }, Array.from(png));
  const glowingFloor = await floorBrightness(lava);
  const glowRevision = Number(await canvas.getAttribute("data-revision"));
  await page.locator("#lava-power").evaluate((el: HTMLInputElement) => {
    el.value = "0";
    el.dispatchEvent(new Event("input"));
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-revision")))
    .toBeGreaterThan(glowRevision);
  await page.locator("#pause").click();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-samples")), {
      timeout: 30000,
    })
    .toBeGreaterThanOrEqual(16);
  const cooledFloor = await floorBrightness(await pixels());
  console.log(
    "Lava illuminates floor:",
    JSON.stringify({ glowingFloor, cooledFloor }),
  );
  expect(glowingFloor).toBeGreaterThan(cooledFloor * 1.2);
  const revision = Number(await canvas.getAttribute("data-revision"));
  await page.locator("#texture-width").evaluate((el: HTMLInputElement) => {
    el.value = "0.25";
    el.dispatchEvent(new Event("input"));
  });
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-revision")))
    .toBeGreaterThan(revision);
  await expect(page.locator("#error")).toBeHidden();
  expect(
    await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    })),
  ).toEqual(page.viewportSize());
  await page.locator("#scene").evaluate((el) => {
    el.closest("details")!.open = true;
  });
  await page.locator("#scene").selectOption("suzanne");
  await expect(page.locator("#scene-name")).toContainText("Suzanne / lava");
  await page.locator("#material").selectOption("blue-glass");
  await expect(page.locator("#scene-name")).toContainText(
    "Suzanne / blue-glass",
  );
  await expect(page.locator("#texture-group")).toBeHidden();
  await expect(page.locator("#error")).toBeHidden();
  expect(errors).toEqual([]);
});
