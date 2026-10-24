/** @file Regression coverage for launch 13 saved foods library: Saved foods supports create, search, pin, edit, deep recipe use, and snapshot-safe delete. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';
import { DEEP_SAVED_FOOD_NAME, installSavedFoodsFixture } from './saved-foods.fixture';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-13');
const CREATED_FOOD_NAME = 'Launch almond crunch';
const EDITED_FOOD_NAME = 'Launch almond crunch edited';
const RECIPE_NAME = 'Launch library bowl';
const MEAL_LABELS = {
  BREAKFAST: 'Breakfast',
  MORNING_SNACK: 'Morning Snack',
  LUNCH: 'Lunch',
  AFTERNOON_SNACK: 'Afternoon Snack',
  DINNER: 'Dinner',
  EVENING_SNACK: 'Evening Snack',
} as const;
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function revealLoggedMeal(page: Page, mealPeriod: keyof typeof MEAL_LABELS) {
  const expandMeal = page.getByRole('button', { name: `Expand ${MEAL_LABELS[mealPeriod]}`, exact: true });
  if (await expandMeal.count()) await expandMeal.click();
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = testInfo.project.name === 'desktop-chrome'
    ? 'saved-foods-recipe-lifecycle-desktop-1024x1000.png'
    : 'saved-foods-library-phone-320x568.png';
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

test('Saved foods supports create, search, pin, edit, deep recipe use, and snapshot-safe delete', async ({ page, ux }, testInfo) => {
  test.skip(
    !['desktop-chrome', 'compact-phone-chrome'].includes(testInfo.project.name),
    'Desktop interaction depth and one compact layout frame bound this Saved Foods pass.',
  );
  const isDesktop = testInfo.project.name === 'desktop-chrome';
  await page.setViewportSize(isDesktop ? { width: 1_024, height: 1_000 } : { width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  await installSavedFoodsFixture(page);
  await page.route('**/api/v1/food/search?*', (route) => route.fulfill({
    json: { items: [], provider: 'usda' }
  }));
  await page.goto('/my-foods');

  await expect(page.locator('#route-focus-title')).toHaveText('Saved foods');
  await expect(page.getByText('Showing 24 saved items so far', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  if (!isDesktop) {
    const firstPinAction = page.getByRole('button', { name: 'Pin Saved pantry 01', exact: true });
    await firstPinAction.scrollIntoViewIfNeeded();
    await expect(page.getByLabel('Search saved foods')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'All', exact: true })).toBeVisible();
    await expect(firstPinAction).toBeVisible();
    await captureEvidence(page, testInfo);
    return;
  }

  await page.getByRole('button', { name: 'Create food', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'New food', exact: true });
  await editor.getByLabel('Name').fill(CREATED_FOOD_NAME);
  await editor.getByRole('textbox', { name: 'Calories per serving', exact: true }).fill('175');
  await editor.getByRole('button', { name: 'Save food', exact: true }).click();
  await expect(editor).toBeHidden();

  const librarySearch = page.getByLabel('Search saved foods');
  await librarySearch.fill(CREATED_FOOD_NAME);
  await expect(page.getByText(CREATED_FOOD_NAME, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Pin ${CREATED_FOOD_NAME}` }).click();
  await expect(page.getByRole('button', { name: `Unpin ${CREATED_FOOD_NAME}` })).toBeVisible();

  await page.getByRole('button', { name: `Edit ${CREATED_FOOD_NAME}` }).click();
  editor = page.getByRole('dialog', { name: 'Edit food', exact: true });
  await editor.getByLabel('Name').fill(EDITED_FOOD_NAME);
  await editor.getByRole('button', { name: 'Save food', exact: true }).click();
  await librarySearch.fill(EDITED_FOOD_NAME);
  await expect(page.getByText(EDITED_FOOD_NAME, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
  const recipeEditor = page.getByRole('dialog', { name: 'Recipe builder', exact: true });
  await recipeEditor.getByLabel('Recipe name').fill(RECIPE_NAME);
  await recipeEditor.getByRole('button', { name: `Add ${EDITED_FOOD_NAME} to recipe` }).click();
  await recipeEditor.getByRole('button', { name: 'Load more saved foods', exact: true }).click();
  await recipeEditor.getByLabel('Search saved foods', { exact: true }).fill(DEEP_SAVED_FOOD_NAME);
  await recipeEditor.getByRole('button', { name: `Add ${DEEP_SAVED_FOOD_NAME} to recipe` }).click();
  await expect(recipeEditor.getByRole('button', { name: `Remove ${DEEP_SAVED_FOOD_NAME}` })).toBeVisible();
  await recipeEditor.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(recipeEditor).toBeHidden();

  await page.goto('/food-log');
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const addFoodDialog = page.getByRole('dialog', { name: 'Add food', exact: true });
  await expect(addFoodDialog.getByRole('radio', { name: 'Recipes', exact: true })).toHaveCount(0);
  await addFoodDialog.getByRole('radio', { name: 'Search', exact: true }).click();
  await addFoodDialog.getByLabel('Search foods').fill(RECIPE_NAME);
  await addFoodDialog.getByText(RECIPE_NAME, { exact: true }).click();
  const foodLogRequestPromise = page.waitForRequest((request) => (
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/food'
  ));
  await addFoodDialog.getByRole('button', { name: 'Add & close', exact: true }).click();
  const foodLogRequest = await foodLogRequestPromise;
  const loggedRecipe = foodLogRequest.postDataJSON() as {
    meal_period: keyof typeof MEAL_LABELS;
    my_food_id: number;
  };
  expect(loggedRecipe.my_food_id).toBeGreaterThan(0);
  await expect(addFoodDialog).toBeHidden();
  await revealLoggedMeal(page, loggedRecipe.meal_period);
  await expect(page.getByText(RECIPE_NAME, { exact: true })).toBeVisible();

  await page.goto('/my-foods');
  await page.getByLabel('Search saved foods').fill(EDITED_FOOD_NAME);
  await page.getByRole('button', { name: `Edit ${EDITED_FOOD_NAME}` }).click();
  editor = page.getByRole('dialog', { name: 'Edit food', exact: true });
  page.once('dialog', (dialog) => dialog.accept());
  await editor.getByRole('button', { name: 'Delete food', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByText(EDITED_FOOD_NAME, { exact: true })).toHaveCount(0);

  const mainSearch = page.getByLabel('Search saved foods');
  await mainSearch.fill(RECIPE_NAME);
  await page.getByRole('button', { name: `Edit ${RECIPE_NAME}` }).click();
  const savedRecipeEditor = page.getByRole('dialog', { name: 'Edit recipe', exact: true });
  await expect(savedRecipeEditor.getByText(EDITED_FOOD_NAME, { exact: true })).toBeVisible();
  await expect(savedRecipeEditor.getByText(DEEP_SAVED_FOOD_NAME, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo);

  await page.goto('/food-log');
  await revealLoggedMeal(page, loggedRecipe.meal_period);
  await expect(page.getByText(RECIPE_NAME, { exact: true })).toBeVisible();
});
