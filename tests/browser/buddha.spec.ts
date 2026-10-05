import { expect, test } from "@playwright/test";

test("full Buddha repairs pinched edges and switches reversibly to the original mesh", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?scene=buddha");
  await expect(page.locator("#scene")).toBeEnabled({ timeout: 120000 });
  await expect(page.locator("#scene")).toHaveValue("buddha");
  await expect(page.locator("#material")).toHaveValue("textured");
  await expect(page.locator("#obj-status")).toContainText("1\u00a0087\u00a0424");
  await expect(page.locator("#obj-status")).toContainText("242");
  await expect(page.locator("#obj-status")).toContainText("Удалено дефектных граней: 50");
  await expect(page.locator("#obj-status")).not.toContainText("Ремонт не выполнен");
  await page.locator("#repair-obj").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#repair-obj").uncheck();
  await expect(page.locator("#obj-status")).not.toContainText("Ремонт не выполнен");
  await expect(page.locator("#obj-status")).toContainText("1\u00a0087\u00a0474");
  await page.locator("#material").evaluate(el => { el.closest("details")!.open = true; });
  await page.locator("#material").selectOption("dielectric");
  await expect(page.locator("#obj-status")).toContainText("Тонкое стекло");
  await page.locator("#repair-obj").check();
  await expect(page.locator("#obj-status")).toContainText("Объёмное стекло");
  await expect(page.locator("#obj-status")).toContainText("1\u00a0087\u00a0424");
  await expect(page.locator("#error")).toBeHidden();
});
