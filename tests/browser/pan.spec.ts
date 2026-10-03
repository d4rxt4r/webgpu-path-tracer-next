import { expect, test } from "@playwright/test";

test("middle-button dragging translates eye and target together, and reset restores both", async ({
  page,
}) => {
  await page.goto("/?scene=control");
  await expect(page.locator("#status")).toHaveText("WebGPU готов");
  const result = await page.evaluate(async () => {
    const url = "/src/app/orbit.ts";
    const { attachOrbit } = await import(/* @vite-ignore */ url);
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:200px;height:200px";
    document.body.append(canvas);
    const initial = {
      position: [0, 1, 3] as [number, number, number],
      target: [0, 1, 0] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
      verticalFov: 40,
    };
    const updates: any[] = [];
    const orbit = attachOrbit(canvas, initial, (camera: any) =>
      updates.push(camera),
    );
    (window as any).__panFixture = { initial, updates, orbit };
    return initial;
  });
  await page.mouse.move(100, 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(130, 120);
  await page.mouse.up({ button: "middle" });
  const pan = await page.evaluate(() =>
    (window as any).__panFixture.updates.at(-1),
  );
  expect(pan).toBeDefined();
  expect(pan.target[0]).toBeLessThan(result.target[0]);
  expect(pan.target[1]).toBeGreaterThan(result.target[1]);
  for (let i = 0; i < 3; i++)
    expect(pan.position[i] - pan.target[i]).toBeCloseTo(
      result.position[i]! - result.target[i]!,
      8,
    );
  await page.mouse.move(130, 120);
  await page.mouse.down();
  await page.mouse.move(150, 120);
  await page.mouse.up();
  const orbit = await page.evaluate(() =>
    (window as any).__panFixture.updates.at(-1),
  );
  expect(orbit.target).toEqual(pan.target);
  const reset = await page.evaluate(() => {
    const f = (window as any).__panFixture;
    f.orbit.reset();
    const camera = f.updates.at(-1);
    f.orbit.dispose();
    return camera;
  });
  expect(reset).toEqual(result);
});
