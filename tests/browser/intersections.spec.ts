import { expect, test } from '@playwright/test';

test('GPU closest/any hits agree with CPU brute force and errors are diagnosed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  // Pause the demo so it does not compete with the acceptance device.
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const result = await page.evaluate(async () => {
    const url = '/src/debug/verify-intersections.ts';
    const { verifyIntersections } = await import(/* @vite-ignore */ url);
    return verifyIntersections();
  });
  console.log('Intersection acceptance:', JSON.stringify(result));
  expect(result.mismatches).toEqual([]);
  expect(result.rays).toBe(2088);
  expect(result.rangeError).toBe(1);
  expect(result.stackError).toBe(2);
  expect(result.numericError).toBe(3);
  expect(result.workerCancelled).toBe(true);
});

test('debug views and orbit camera redraw while paused', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#view').selectOption('normal');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-frames'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.waitForTimeout(200);
  const canvas = page.locator('canvas');
  const normal = await canvas.screenshot({ path: 'test-results/normal.png' });
  await page.locator('#view').selectOption('depth');
  await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBeGreaterThan(0);
  const depth = await canvas.screenshot({ path: 'test-results/depth.png' });
  expect(depth.equals(normal)).toBe(false);
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down(); await page.mouse.move(rect!.x + rect!.width / 2 + 80, rect!.y + rect!.height / 2 + 20); await page.mouse.up();
  await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBeGreaterThan(0);
  const orbit = await canvas.screenshot(); expect(orbit.equals(depth)).toBe(false);
  await page.getByRole('button', { name: 'Сброс камеры' }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-frames'))).toBeGreaterThan(0);
  expect((await canvas.screenshot()).equals(depth)).toBe(true);
  await expect(page.locator('#status')).toHaveText('Пауза');
  await expect(page.locator('#error')).toBeHidden();
});

test('camera changes during Worker builds and repeated scene replacement remain live', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const result = await page.evaluate(async () => {
    const rendererUrl = '/src/render/intersection-renderer.ts', sceneUrl = '/src/scene/cornell.ts';
    const { IntersectionRenderer } = await import(/* @vite-ignore */ rendererUrl);
    const { cornellScene } = await import(/* @vite-ignore */ sceneUrl);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
    const errors: string[] = [];
    let stats = { frames: 0, bytes: 0 };
    const renderer = new IntersectionRenderer(canvas, (value: typeof stats) => { stats = value; }, (error: Error) => errors.push(error.message));
    const waitForFrame = async () => {
      const started = performance.now();
      while (stats.frames === 0 && performance.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 20));
      if (!stats.frames) throw new Error('Renderer stalled');
    };
    try {
      const scene = cornellScene();
      const build = renderer.setScene(scene);
      renderer.setCamera({ ...scene.camera, position: [0.2, 1, 3.7] });
      renderer.setDebugView('depth');
      await build; await renderer.initialize(); await waitForFrame();
      const initialBytes = stats.bytes;
      for (let i = 0; i < 3; i++) {
        const obsolete = renderer.setScene(scene).then(() => false, (error: Error) => error.name === 'AbortError');
        const latest = renderer.setScene(scene);
        renderer.setCamera(scene.camera);
        await latest;
        if (!await obsolete) throw new Error('Obsolete scene did not cancel');
        await waitForFrame();
      }
      return { errors, initialBytes, finalBytes: stats.bytes, frames: stats.frames };
    } finally { renderer.dispose(); canvas.remove(); }
  });
  expect(result.errors).toEqual([]);
  expect(result.finalBytes).toBe(result.initialBytes);
  expect(result.frames).toBeGreaterThan(0);
});
