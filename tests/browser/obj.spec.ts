import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test("high poly Suzanne is the default and the original preset remains available", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 60000 });
  await expect(page.locator("#scene")).toHaveValue("suzanne-high-poly");
  await expect(page.locator("#scene option")).toHaveText(["Suzanne high poly", "Suzanne", "Happy Buddha", "Контрольная сфера"]);
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 4");
  await expect(page.locator("#repair-obj")).toBeChecked();
  await page.locator("#scene").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#scene").selectOption("suzanne");
  await expect(page.locator("#obj-status")).toContainText("1\u00a0002 треугольников");
  await page.locator("#scene").selectOption("suzanne-high-poly");
  await expect(page.locator("#obj-status")).toContainText("252\u00a0568 треугольников");
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 20000 }).toBeGreaterThan(0);
  await expect(page.locator("#error")).toBeHidden();
});

test("multiple OBJ shells repair reversibly and render intersections in PT and SPPM", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  for (const id of ["repair-obj", "material", "profile"]) await page.locator(`#${id}`).evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#material").selectOption("glass");
  await page.locator("#obj-file").setInputFiles(fixture("overlap-open.obj"));
  await expect(page.locator("#obj-status")).toContainText("Оболочек: 2");
  await expect(page.locator("#repair-obj")).toBeChecked();
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 2");
  await expect(page.locator("#obj-status")).toContainText("Объёмное стекло");
  for (const profile of ["reference", "quality"]) {
    await page.locator("#profile").selectOption(profile);
    await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 15000 }).toBeGreaterThan(0);
    await expect(page.locator("#error")).toBeHidden();
  }
  await page.locator("#repair-obj").uncheck();
  await expect(page.locator("#obj-status")).toContainText("6 треугольников");
  await page.locator("#obj-file").setInputFiles(fixture("overlap.obj"));
  await expect(page.locator("#repair-obj")).toBeChecked();
  await expect(page.locator("#obj-status")).toContainText("Объёмное стекло");
});

test("GPU medium tracking matches a solid slab for overlapping and nested shells", async ({ page }) => {
  test.setTimeout(90000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  await page.locator("#pause").click();
  for (const precise of [false, true]) {
    const results = await page.evaluate(async precise => {
      const path = "/src/debug/verify-shells.ts";
      const { verifyShells } = await import(/* @vite-ignore */ path);
      return verifyShells(precise);
    }, precise);
    for (const result of results) {
      expect(result.errors).toBe(0);
      if (result.difference !== undefined) expect(result.difference).toBeLessThan(0.00001);
    }
  }
});

test("OBJ repair closes a hole and reversibly restores the original mesh", async ({ page }) => {
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  await page.locator("#repair-obj").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#obj-file").setInputFiles(fixture("hole.obj"));
  await expect(page.locator("#repair-obj")).toBeChecked();
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 1");
  await expect(page.locator("#obj-status")).toContainText("4 треугольников");
  await page.locator("#repair-obj").uncheck();
  await expect(page.locator("#obj-status")).toContainText("3 треугольников");
  await page.locator("#repair-obj").check();
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 1");
  await page.locator("#obj-file").setInputFiles(fixture("open.obj"));
  await expect(page.locator("#repair-obj")).toBeChecked();
  await expect(page.locator("#obj-status")).toContainText("open.obj");
  await page.locator("#repair-obj").check();
  await expect(page.locator("#obj-status")).toContainText("Ремонт не выполнен");
  await expect(page.locator("#error")).toBeHidden();
});

test("original Suzanne remains available with runtime repair enabled", async ({ page }) => {
  await page.goto("/?scene=suzanne");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  await expect(page.locator("#scene")).toHaveValue("suzanne");
  await expect(page.locator("#repair-obj")).toBeChecked();
  await expect(page.locator("#repair-obj")).toBeEnabled();
  await expect(page.locator("#obj-status")).toContainText("Оболочек: 3");
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 4");
  await page.locator("#repair-obj").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#repair-obj").uncheck();
  await expect(page.locator("#obj-status")).toContainText("968 треугольников");
  await expect(page.locator("#obj-status")).toContainText("Тонкое стекло");
  await expect(page.locator("#absorption")).toBeDisabled();
  await page.locator("#repair-obj").check();
  await expect(page.locator("#obj-status")).toContainText("Закрыто отверстий: 4");
  await expect(page.locator("#absorption")).toBeEnabled();
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.locator("#error")).toBeHidden();
});

test("OBJ replaces the object, selects thin or solid glass and rolls back invalid imports", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  await page.locator("#scene").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#material").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#material").selectOption("glass");
  await page.locator("#obj-file").setInputFiles(fixture("open.obj"));
  await expect(page.locator("#obj-status")).toContainText("Тонкое стекло");
  await expect(page.locator("#scene")).toHaveValue("uploaded");
  await expect(page.locator("#absorption")).toBeDisabled();
  await page.locator("#object-rotation-x-value").fill("30");
  await page.locator("#object-rotation-x-value").press("Tab");
  await page.locator("#object-rotation-z-value").fill("45");
  await page.locator("#object-rotation-z-value").press("Tab");
  await expect(page.locator("#object-rotation-x")).toHaveValue("30");
  await expect(page.locator("#object-rotation-z")).toHaveValue("45");
  for (const profile of ["preview", "reference", "quality"]) {
    await page.locator("#profile").selectOption(profile);
    await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples")), { timeout: 15000 }).toBeGreaterThan(0);
    await expect(page.locator("#error")).toBeHidden();
  }
  await page.locator("#obj-file").setInputFiles(fixture("solid.obj"));
  await expect(page.locator("#obj-status")).toContainText("Объёмное стекло");
  await expect(page.locator("#object-rotation-x")).toHaveValue("0");
  await page.locator("#obj-file").setInputFiles(fixture("invalid.obj"));
  await expect(page.locator("#error-message")).toContainText("индекс");
  await expect(page.locator("#scene-name")).toContainText("solid.obj");
  await page.locator("#error-dismiss").click();
  await page.locator("#scene").selectOption("control");
  await expect(page.locator("#scene-name")).toContainText("Sphere");
  await expect(page.locator("#material")).toHaveValue("glass");
  await page.locator("#scene").selectOption("uploaded");
  await expect(page.locator("#scene-name")).toContainText("solid.obj");
  await page.locator("#obj-file").setInputFiles(fixture("solid.obj"));
  await expect(page.locator("#obj-status")).toContainText("Объёмное стекло");
});

test("thin glass GPU optics conserve energy and transmit without angular refraction", async ({ page }) => {
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов", { timeout: 25000 });
  await page.locator("#pause").click();
  const values = await page.evaluate(async () => {
    const path = "/src/debug/verify-thin-glass.ts";
    const { verifyThinGlass } = await import(/* @vite-ignore */ path);
    return verifyThinGlass();
  });
  expect(values[0]).toBeCloseTo(1 / 13, 6);
  expect(values.slice(1, 4)).toEqual([1, 0, 0]);
  expect(values[4]).toBeCloseTo(0.6, 6);
  expect(values[5]).toBeCloseTo(-0.8, 6);
  expect(values[7]).toBe(1);
  expect(values[9]).toBeCloseTo(0.8, 6);
  expect(values[11]).toBe(1);
  expect(values[12]).toBeCloseTo(1 / 13, 3);
  expect(values[13]).toBe(1);
});
