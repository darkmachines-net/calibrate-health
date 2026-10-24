/** @file Regression coverage for page refinements: full-width rows include the page gutters in their hover and tap targets. */

import { expect, test, hideTransientPwaNotices, type AuthenticatedApiOptions } from './fixtures';

test('full-width rows include the page gutters in their hover and tap targets', async ({ page, ux }, testInfo) => {
  await ux.install('populated', { metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const main = page.getByTestId('today-fixed-page');
  const bounds = (await main.boundingBox())!;
  for (const id of ['today-weight-card-press-layer', 'today-food-preview']) {
    const row = page.getByTestId(id);
    const box = (await row.boundingBox())!;
    expect(Math.abs(box.x - bounds.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - bounds.width)).toBeLessThanOrEqual(1);
  }
  const weight = page.getByTestId('today-weight-card-press-layer');
  await weight.hover({ position: { x: 2, y: 16 } });
  await page.screenshot({ path: testInfo.outputPath('today-edge-hover.png') });
  await weight.click({ position: { x: 2, y: 16 } });
  await expect(page.getByRole('dialog', { name: 'Weight entry', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/progress');
  const plan = page.getByTestId('plan-check-summary');
  await plan.scrollIntoViewIfNeeded();
  const planBox = (await plan.boundingBox())!;
  expect(Math.abs(planBox.x - bounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(planBox.width - bounds.width)).toBeLessThanOrEqual(1);
  await plan.click({ position: { x: 2, y: 16 } });
  await expect(page.getByTestId('expanded-plan')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`completed day is the dominant toggle in ${scheme}`, async ({ page, ux }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    const options: AuthenticatedApiOptions = { foodDayStatus: 'COMPLETE' };
    await ux.install('populated', options);
    await page.route('**/api/v1/food-days**', async route => {
      if (route.request().method() === 'PATCH') options.foodDayStatus = route.request().postDataJSON().status;
      await route.fallback();
    });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    const add = page.getByRole('button', { name: 'Add food', exact: true });
    const completed = page.getByRole('button', { name: 'Day completed', exact: true });
    await expect(add).toBeDisabled();
    await expect(completed).toHaveAttribute('aria-pressed', 'true');
    const [a, c] = await Promise.all([add.boundingBox(), completed.boundingBox()]);
    expect(a!.height).toBe(c!.height);
    // The disabled button's outline adds one pixel at each edge.
    expect(Math.abs(a!.width - c!.width)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath(`day-completed-${scheme}.png`) });
    await completed.click();
    await expect(add).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(url => url.pathname === '/today');
  });
}

test('detailed Trend uses extra page height and contracts when the viewport shrinks', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/weight-trend');
  await hideTransientPwaNotices(page);
  const chart = page.getByTestId('weight-trend-chart-canvas');
  const controls = page.getByRole('toolbar', { name: 'Selected weigh-in navigation', exact: true });
  await expect(controls).toBeVisible();
  const original = (await chart.boundingBox())!.height;
  await page.setViewportSize({ width, height: 1400 });
  await expect.poll(async () => (await chart.boundingBox())!.height).toBeGreaterThan(original + 390);
  const shell = (await page.getByTestId('weight-trend-chart-shell').boundingBox())!;
  const main = (await page.getByRole('main').boundingBox())!;
  expect(main.y + main.height - shell.y - shell.height).toBeLessThan(24);
  await page.screenshot({ path: testInfo.outputPath('trend-fills-height.png') });
  await page.setViewportSize({ width, height: 1000 });
  await expect.poll(async () => Math.abs((await chart.boundingBox())!.height - original)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
