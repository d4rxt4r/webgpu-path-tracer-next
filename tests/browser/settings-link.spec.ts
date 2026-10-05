import { expect, test } from "@playwright/test";

test("the copy icon produces a URL that restores all controls and the camera", async ({ page, context }) => {
  test.setTimeout(300000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?settings=1&scene=control&material=dielectric&profile=custom&mode=rgb&integrator=pt&resolution=19200&max-depth=8&sample-limit=2&roughness=.08&ior=1.45&dispersion=1&abbe=52&transmission-color=%23ddffee&repair-obj=0&object-rotation=27&object-x=.12&object-y=.7&light-power=9&fov=48&camera-position=1.2,1.3,3.2&camera-target=.1,.8,0&camera-up=0,1,0&denoiser=0&exposure=1.5&tone-mapper=aces");
  const copy = page.getByRole("button", { name: "Скопировать ссылку" });
  await expect(copy).toBeEnabled({ timeout: 120000 });
  await expect(copy).toHaveText("");
  const snapshot = () => page.locator(".inspector input[id], .inspector select[id]").evaluateAll(fields => Object.fromEntries(
    (fields as (HTMLInputElement | HTMLSelectElement)[]).filter(field => !field.id.endsWith("-value") && field.type !== "file")
      .map(field => [field.id, field.type === "checkbox" ? (field as HTMLInputElement).checked : field.value])));
  const before = await snapshot();
  await copy.click();
  await expect(page.locator("#share-status")).toHaveText("Ссылка скопирована.");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const query = new URL(link).searchParams;
  expect(query.get("camera-position")).toBe("1.2,1.3,3.2");
  expect(query.get("camera-target")).toBe("0.1,0.8,0");
  expect(query.has("obj-file")).toBe(false);
  await page.goto(link);
  await expect(copy).toBeEnabled({ timeout: 120000 });
  expect(await snapshot()).toEqual(before);
  await expect.poll(async () => Number(await page.locator("canvas").getAttribute("data-samples"))).toBeGreaterThan(0);
  await copy.click();
  await expect(page.locator("#share-status")).toHaveText("Ссылка скопирована.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await expect(page.locator("#error")).toBeHidden();
});
