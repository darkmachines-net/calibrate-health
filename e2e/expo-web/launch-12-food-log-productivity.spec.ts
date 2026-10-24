/** @file Regression coverage for launch 12 food log productivity: Food Log supports fast add, edit, recoverable delete, and meal/day copy. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, FROZEN_LOCAL_DATE, hideTransientPwaNotices, test, type AuthenticatedApiOptions } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-12');
const PREVIOUS_LOCAL_DATE = '2026-07-20';
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

const FOOD_LOG_OPTIONS: AuthenticatedApiOptions = {
  foodEntriesByDate: {
    [FROZEN_LOCAL_DATE]: [
      {
        id: 31,
        meal_period: 'BREAKFAST',
        name: 'Greek yogurt',
        calories: 180,
        servings_consumed: 1.5,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'cup',
        calories_per_serving_snapshot: 120,
      },
      {
        id: 32,
        meal_period: 'DINNER',
        name: 'Salmon bowl',
        calories: 540,
        servings_consumed: 1,
        serving_size_quantity_snapshot: 1,
        serving_unit_label_snapshot: 'bowl',
        calories_per_serving_snapshot: 540,
      },
    ],
    [PREVIOUS_LOCAL_DATE]: [],
  },
};

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  let filename: string | null = null;
  if (testInfo.project.name === 'desktop-chrome') {
    filename = 'food-log-productivity-desktop-1024x1000.png';
  } else if (testInfo.project.name === 'compact-phone-chrome') {
    filename = 'food-log-copy-phone-320x568.png';
  }
  if (!filename) return;

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((transientTitles) => {
    for (const notice of document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')) {
      const title = notice.querySelector('span span')?.textContent?.trim();
      if (title && transientTitles.includes(title)) notice.style.display = 'none';
    }
  }, [...TRANSIENT_PWA_TITLES]);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

test('Food Log supports fast add, edit, recoverable delete, and meal/day copy', async ({ page, ux }, testInfo) => {
  test.skip(
    !['desktop-chrome', 'compact-phone-chrome'].includes(testInfo.project.name),
    'Desktop interaction depth and one compact dialog view bound this productivity pass.',
  );

  const isDesktop = testInfo.project.name === 'desktop-chrome';
  await page.setViewportSize(isDesktop ? { width: 1_024, height: 1_000 } : { width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated', FOOD_LOG_OPTIONS);
  await page.goto('/food-log');
  await hideTransientPwaNotices(page);

  await expect(page.getByText('Greek yogurt', { exact: true })).toBeVisible();
  await expect(page.getByText('Salmon bowl', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Breakfast' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Dinner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Morning Snack' })).toHaveCount(0);
  await expect(page.getByText('No entries', { exact: true })).toHaveCount(4);
  await expectNoHorizontalOverflow(page);

  if (!isDesktop) {
    await page.getByRole('button', { name: 'Copy Breakfast' }).click();
    const copyMealDialog = page.getByRole('dialog', { name: 'Copy meal' });
    await expect(copyMealDialog).toBeVisible();
    await expect(copyMealDialog.getByLabel('Copy to date')).toHaveValue(PREVIOUS_LOCAL_DATE);
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo);
    return;
  }

  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const addFoodDialog = page.getByRole('dialog', { name: 'Add food' });
  await addFoodDialog.getByRole('radio', { name: 'Quick' }).click();
  await addFoodDialog.getByLabel('Calories').fill('210');
  await addFoodDialog.getByLabel('Food name (optional)').fill('Blueberry snack');
  await addFoodDialog.getByRole('button', { name: 'Add & close' }).click();
  await expect(addFoodDialog).toBeHidden();
  await expect(page.getByText('Blueberry snack', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Blueberry snack' }).click();
  await page.getByLabel('Food name').fill('Blueberry yogurt snack');
  await page.getByRole('textbox', { name: 'Calories', exact: true }).fill('225');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Blueberry yogurt snack', { exact: true })).toBeVisible();
  await expect(page.getByText('225 kcal', { exact: true })).toHaveCount(2);

  await page.getByRole('button', { name: 'Copy Breakfast' }).click();
  let copyDialog = page.getByRole('dialog', { name: 'Copy meal' });
  await copyDialog.getByLabel('Copy to date').fill(PREVIOUS_LOCAL_DATE);
  await copyDialog.getByRole('combobox', { name: 'Copy to meal' }).click();
  await page.getByRole('option', { name: 'Dinner' }).click();
  await copyDialog.getByRole('button', { name: 'Copy meal', exact: true }).click();
  await expect(page.getByText('1 entry copied to Jul 20, 2026.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.getByText('Greek yogurt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Dinner' })).toBeVisible();
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.getByText('Blueberry yogurt snack', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Copy day' }).click();
  copyDialog = page.getByRole('dialog', { name: 'Copy day' });
  await expect(copyDialog.getByLabel('Copy to date')).toHaveValue(PREVIOUS_LOCAL_DATE);
  await copyDialog.getByRole('button', { name: 'Copy day', exact: true }).click();
  await expect(page.getByText('3 entries copied to Jul 20, 2026.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Delete Blueberry yogurt snack' }).click();
  await expect(page.getByText('Deleted Blueberry yogurt snack.', { exact: true })).toBeVisible();
  await expect(page.getByText('Blueberry yogurt snack', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Blueberry yogurt snack', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo);
});
