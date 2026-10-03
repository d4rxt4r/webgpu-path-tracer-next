import { expect, test } from '@playwright/test';

test('final solid loads by default, renders all transport modes and switches scenes', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#scene')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#scene')).toHaveValue('suzanne');
  await expect(page.locator('#material')).toHaveValue('nbk7');
  await expect(page.locator('#stats')).toContainText('98748');
  await page.locator('#resolution').selectOption('19200');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-samples')), { timeout: 20000 }).toBeGreaterThan(0);
  await page.locator('#mode').selectOption('spectral');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-samples')), { timeout: 20000 }).toBeGreaterThan(0);
  await page.locator('#integrator').selectOption('sppm');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-samples')), { timeout: 30000 }).toBeGreaterThan(0);
  await page.locator('#mode').selectOption('rgb');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-samples')), { timeout: 30000 }).toBeGreaterThan(0);
  await page.locator('#scene').evaluate(el => { el.closest('details')!.open = true; }); await page.locator('#scene').selectOption('control');
  await expect(page.locator('#stats')).toContainText('972', { timeout: 20000 });
  await page.locator('#scene').evaluate(el => { el.closest('details')!.open = true; }); await page.locator('#scene').selectOption('suzanne');
  await expect(page.locator('#stats')).toContainText('98748', { timeout: 20000 });
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('missing final mesh reports a resource error', async ({ page }) => {
  await page.route('**/assets/suzanne.bin', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('#error')).toContainText('Suzanne resource: HTTP 404');
  await expect(page.locator('#scene')).toBeDisabled();
});
