/** @file Regression coverage for today short shell: Today restores page scrolling only when the fixed regions cannot fit. */

import { expect, hideTransientPwaNotices, test } from './fixtures';

test('Today restores page scrolling only when the fixed regions cannot fit', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'Cover a phone rotating between portrait and landscape.');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated', { foodDayStatus: 'OPEN', metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expect(page.getByTestId('today-food-scroll')).toBeVisible();

  await page.setViewportSize({ width: 568, height: 320 });
  const pageScroll = page.getByTestId('fixed-page-scroll');
  await expect(pageScroll).toBeVisible();
  await expect(page.getByTestId('today-food-scroll')).toHaveCount(0);

  // A cold landscape mount must choose the same fallback as rotation.
  await page.reload();
  await hideTransientPwaNotices(page);
  await expect(pageScroll).toBeVisible();
  await expect(page.getByTestId('today-food-scroll')).toHaveCount(0);

  const weight = page.getByTestId('today-weight-card-press-layer');
  await weight.scrollIntoViewIfNeeded();
  await expect(weight).toBeInViewport();
  await weight.click();
  const weightSheet = page.getByRole('dialog', { name: 'Weight entry', exact: true });
  await expect(weightSheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(weightSheet).toHaveCount(0);

  const lastMeal = page.getByTestId('food-preview-meal-EVENING_SNACK');
  await lastMeal.scrollIntoViewIfNeeded();
  await expect(lastMeal).toBeInViewport();
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  const completeDay = page.getByRole('button', { name: 'Complete day', exact: true });
  await addFood.scrollIntoViewIfNeeded();
  await expect(addFood).toBeInViewport();
  await expect(completeDay).toBeInViewport();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('today-landscape-actions.png') });
  await addFood.click();
  const foodSheet = page.getByRole('dialog', { name: 'Add food', exact: true });
  await expect(foodSheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(foodSheet).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 568 });
  const foodScroll = page.getByTestId('today-food-scroll');
  await expect(foodScroll).toBeVisible();
  await expect(pageScroll).toHaveCount(0);
  const before = await page.getByRole('toolbar', { name: 'Food log date' }).boundingBox();
  await foodScroll.hover();
  await page.mouse.wheel(0, 800);
  await expect(lastMeal).toBeInViewport();
  expect(await page.getByRole('toolbar', { name: 'Food log date' }).boundingBox()).toEqual(before);
  await expect(addFood).toBeInViewport();
  await expect(completeDay).toBeInViewport();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('today-portrait-restored.png') });
});
