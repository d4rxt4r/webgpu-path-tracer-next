import { expect, test } from "@playwright/test";

test("compute output, pause, resize and resume without GPU errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  await page.locator("#view").selectOption("normal");
  const canvas = page.locator("canvas");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(2);
  console.log("WebGPU:", await page.locator("#stats").textContent());
  await canvas.screenshot({ path: "test-results/intersections.png" });
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect(page.locator("#status")).toHaveText("Пауза");
  // Wait for the single already submitted frame to complete.
  await page.waitForTimeout(200);
  const pausedFrame = await canvas.getAttribute("data-frames");
  await page.waitForTimeout(200);
  expect(await canvas.getAttribute("data-frames")).toBe(pausedFrame);
  await page.setViewportSize({ width: 700, height: 700 });
  await expect
    .poll(async () =>
      canvas.evaluate((node) => (node as HTMLCanvasElement).width),
    )
    .toBeLessThan(700);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-frames")))
    .toBeGreaterThan(2);
  await expect(page.locator("#error")).toBeHidden();
  expect(errors).toEqual([]);
});

test("unsupported WebGPU has an actionable error", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined });
    Object.defineProperty(globalThis, "GPUShaderStage", { value: undefined });
  });
  await page.goto("/?scene=control");
  await expect(page.getByRole("alert")).toContainText("Chrome или Edge");
  await expect(page.locator("#pause")).toBeDisabled();
  await page.locator("#error-dismiss").click();
  await expect(page.getByRole("alert")).toBeHidden();
  await page.reload();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toBeHidden();
});
