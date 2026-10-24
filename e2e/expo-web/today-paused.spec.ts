/** @file Regression coverage for today paused: a past paused day replaces an expanded food log and can be backfilled. */

import { expect, test, hideTransientPwaNotices, FROZEN_LOCAL_DATE, type AuthenticatedApiOptions } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';
import type { Page } from '@playwright/test';

async function expectWeightBoundary(page: Page, paused: boolean) {
  const row = page.getByTestId('today-weight-card');
  const action = page.getByTestId('today-weight-card-press-layer');
  const lower = await action.evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.borderBottomWidth, color: style.borderBottomColor };
  });
  await expect(row).toHaveCSS('border-top-width', paused ? lower.width : '0px');
  if (paused) {
    expect(parseFloat(lower.width)).toBeGreaterThan(0);
    await expect(row).toHaveCSS('border-top-color', lower.color);
    const rowBounds = await row.boundingBox();
    const actionBounds = await action.boundingBox();
    expect(rowBounds!.x).toBe(actionBounds!.x);
    expect(rowBounds!.width).toBe(actionBounds!.width);
  }
}

const retainedFood = [{ id: 31, meal_period: 'BREAKFAST' as const, name: 'Saved breakfast', calories: 360 }];

for (const colorScheme of ['light', 'dark'] as const) {
  test(`paused Today preserves weight entry and resumes with existing food in ${colorScheme}`, async ({ page, ux }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const options: AuthenticatedApiOptions = { foodDayStatus: 'PAUSED', foodEntries: retainedFood };
    await ux.install('paused', options);
    let savedMetric: { id: number; date: string; weight: number } | null = null;
    await page.route('**/api/v1/metrics', async route => {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON();
        expect(payload).toMatchObject({ date: FROZEN_LOCAL_DATE, weight: 88 });
        savedMetric = { id: 99, date: payload.date, weight: payload.weight };
        return route.fulfill({ json: savedMetric });
      }
      if (savedMetric) return route.fulfill({ json: [savedMetric] });
      return route.fallback();
    });
    await page.route('**/api/v1/food-days/resume', async route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ resumed_on: FROZEN_LOCAL_DATE });
      options.foodDayStatus = 'OPEN';
      await route.fulfill({ json: { pause: { active: false } } });
    });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await expect(page.getByRole('heading', { name: 'Tracking paused', exact: true })).toBeVisible();
    await expect(page.getByLabel(/^Daily balance\./)).toHaveCount(0);
    await expect(page.getByTestId('today-food-preview')).toHaveCount(0);
    await expect(page.getByText('No food logged yet', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toBeInViewport();
    await page.evaluate(() => document.fonts.ready);
    await expectWeightBoundary(page, true);
    await page.screenshot({ path: testInfo.outputPath(`paused-today-${colorScheme}.png`) });
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'paused-today' });

    await page.getByTestId('today-weight-card-press-layer').click();
    await expect(page.getByRole('heading', { name: 'Log weight', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log weight', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Close weight entry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tracking paused', exact: true })).toBeVisible();
    await page.getByTestId('today-weight-card-press-layer').click();
    await page.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('88.0');
    await page.getByRole('button', { name: 'Log weight', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByTestId('today-weight-card')).toContainText('88 kg');
    await expectWeightBoundary(page, true);
    await expect(page.getByRole('heading', { name: 'Tracking paused', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Resume tracking', exact: true }).click();
    await expect(page.getByTestId('paused-day-message')).toHaveCount(0);
    await expectWeightBoundary(page, false);
    await expect(page.getByLabel(/^Daily balance\./)).toBeVisible();
    await expect(page.getByTestId('today-food-preview')).toContainText('360 kcal');
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
  });
}

test('a past paused day replaces an expanded food log and can be backfilled', async ({ page, ux }, testInfo) => {
  const options: AuthenticatedApiOptions = { foodDayStatus: 'OPEN', foodEntries: [] };
  await ux.install('paused', options);
  await page.route('**/api/v1/food-days', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ date: '2026-07-20', status: 'OPEN' });
    options.foodDayStatus = 'OPEN';
    await route.fulfill({ json: { date: '2026-07-20', status: 'OPEN', source: 'STORED', origin: 'USER', is_complete: false, is_representative: false, completed_at: null, updated_at: null } });
  });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expectWeightBoundary(page, false);
  await page.getByTestId('today-food-preview').click();
  await expect(page.getByRole('button', { name: 'Back to Today', exact: true })).toBeVisible();
  options.foodDayStatus = 'PAUSED';
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tracking was paused', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Today', exact: true })).toHaveCount(0);
  await expect(page.getByText(/It is not counted as a zero-calorie day/)).toBeVisible();
  await expect(page.getByTestId('today-food-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expectWeightBoundary(page, true);
  await page.screenshot({ path: testInfo.outputPath('paused-past-day.png') });
  await page.getByTestId('today-weight-card-press-layer').click();
  await expect(page.getByRole('heading', { name: 'Log weight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close weight entry', exact: true }).click();
  await page.getByRole('button', { name: 'Edit day', exact: true }).click();
  await expect(page.getByTestId('paused-day-message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
});

test('paused-day copy and actions remain reachable at 200% text on a short phone', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('paused');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expect(page.getByTestId('paused-day-message')).toBeVisible();
  await applyTwoHundredPercentText(page);
  const explanation = page.getByText('Weight logging is always available.', { exact: true });
  await explanation.scrollIntoViewIfNeeded();
  await expect(explanation).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('paused-large-text.png') });
  await page.getByTestId('today-weight-card-press-layer').scrollIntoViewIfNeeded();
  await page.getByTestId('today-weight-card-press-layer').click();
  await expect(page.getByRole('heading', { name: 'Log weight', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
