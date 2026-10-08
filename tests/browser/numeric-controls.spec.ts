import { expect, test } from '@playwright/test';

test('extended memory survives UI refresh, link reload and middle reset', async ({ page, context }) => {
  test.setTimeout(180000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?settings=1&scene=control&mode=rgb&integrator=pt&resolution=19200&sample-limit=2&auto-preview=0');
  const number = page.locator('#memory-budget-value');
  await expect(number).toBeEnabled({ timeout: 120000 });
  await number.fill('16384');
  await number.press('Tab');
  await expect(number).toHaveValue('16384');
  await expect(page.locator('#memory-budget')).toHaveValue('4096');
  await expect(page.locator('#memory-profile')).toHaveValue('custom');
  await page.locator('#view').selectOption('normal');
  await expect(number).toHaveValue('16384');
  await page.getByRole('button', { name: 'Скопировать ссылку' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.get('memory-budget')).toBe('16384');
  await page.goto(link);
  await expect(number).toBeEnabled({ timeout: 120000 });
  await expect(number).toHaveValue('16384');
  await number.fill('1e100');
  await number.press('Tab');
  await expect(number).toHaveValue('16384');
  await page.locator('#error-dismiss').click();
  await number.click({ button: 'middle' });
  await expect(number).toHaveValue('192');
});
