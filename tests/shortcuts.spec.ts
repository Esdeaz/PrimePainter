import { test, expect } from '@playwright/test';

test('physical hotkeys work with Russian text keys without stealing undo from text fields', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__primePainter));
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'т', ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'т', ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'ц', bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => window.__primePainter.state.wireframe)).toBe(true);
  await page.locator('[data-action="add-paint"]').first().click();
  const layers = await page.locator('[data-layer]').count();
  await page.locator('#asset-search').fill('typing');
  const prevented = await page.locator('#asset-search').evaluate(input => {
    const event = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'я', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator('[data-layer]')).toHaveCount(layers);
  await page.locator('.renderer').focus();
  const size = await page.evaluate(() => window.__primePainter.engine.brush.size);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', key: 'ъ', bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => window.__primePainter.engine.brush.size)).toBeGreaterThan(size);
});
