import { expect, test } from '@playwright/test';

test('GPU dielectric agrees with Fresnel, Snell, TIR and transport-mode equations', async ({ page }) => {
  await page.goto('/?scene=control');
  const result = await page.evaluate(async () => {
    const url = '/src/debug/verify-dielectric.ts';
    const { verifyDielectric } = await import(/* @vite-ignore */ url);
    return verifyDielectric();
  });
  const expected = [0.04, 1, 1, 0, 0.4, -Math.sqrt(0.84), 0, 1 / 2.25, 0.6, -0.8, 0, 1, 0.4, -Math.sqrt(0.84), 0, 1, Math.sqrt(0.75), 0.5, 0, 0, Math.exp(-0.4), Math.exp(-1), Math.exp(-2), 1, 0.28, 1, 1, 0, 0, 0, 0, 0];
  result.forEach((value: number, i: number) => expect(value).toBeCloseTo(expected[i]!, 5));
});

test('closed glass sphere accumulates without invalid medium transitions', async ({ page }) => {
  await page.goto('/?scene=control');
  await expect(page.locator('#status')).toHaveText('WebGPU готов');
  await page.locator('#resolution').selectOption('19200');
  await page.locator('#material').evaluate(el => { el.closest('details')!.open = true; }); await page.locator('#material').selectOption('glass');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-samples')), { timeout: 20000 }).toBeGreaterThanOrEqual(16);
  await expect(page.locator('#error')).toBeHidden();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await page.locator('canvas').screenshot({ path: 'test-results/glass-cornell.png' });
});

test('absorbing plate matches the analytic sum of internal reflections', async ({ page }) => {
  await page.goto('/?scene=control');
  const result = await page.evaluate(async () => {
    const url = '/src/debug/verify-plate.ts';
    const { verifyPlate } = await import(/* @vite-ignore */ url);
    return { outside: await verifyPlate(), inside: await verifyPlate(true) };
  });
  console.log('Glass plate acceptance:', JSON.stringify(result));
  for (const estimate of [result.outside, result.inside]) {
    expect(estimate.errors).toBe(0);
    estimate.mean.forEach((value: number, i: number) => expect(Math.abs(value / estimate.reference[i]! - 1)).toBeLessThan(0.01));
  }
});
