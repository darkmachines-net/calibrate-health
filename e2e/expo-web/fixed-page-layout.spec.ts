/** @file Regression coverage for fixed page layout: Today anchors its actions, puts weigh-in first, and shows concise chronological meal totals. */

import { applyTwoHundredPercentText } from './text-scaling';
import type { Locator, Page } from '@playwright/test';
import { expect, test, hideTransientPwaNotices, FROZEN_LOCAL_DATE, type AuthenticatedApiOptions } from './fixtures';

// Deliberately interleave API creation order; meal periods still determine on-page chronology.
const FOOD_ENTRIES: NonNullable<AuthenticatedApiOptions['foodEntries']> = [
  { id: 11, meal_period: 'DINNER', name: 'Grilled salmon', calories: 300 },
  { id: 1, meal_period: 'BREAKFAST', name: 'Oatmeal', calories: 200 },
  { id: 4, meal_period: 'MORNING_SNACK', name: 'Apple', calories: 90 },
  { id: 6, meal_period: 'LUNCH', name: 'Chicken and avocado wrap', calories: 520 },
  { id: 2, meal_period: 'BREAKFAST', name: 'Blueberries', calories: 30 },
  { id: 9, meal_period: 'AFTERNOON_SNACK', name: 'Greek yogurt', calories: 150 },
  { id: 12, meal_period: 'DINNER', name: 'Roasted potatoes', calories: 210 },
  { id: 13, meal_period: 'DINNER', name: 'Green beans with toasted almonds and lemon dressing', calories: 110 },
  { id: 15, meal_period: 'EVENING_SNACK', name: 'Dark chocolate', calories: 120 },
];
const MEAL_TOTALS = [
  ['BREAKFAST', '230 kcal'], ['MORNING_SNACK', '90 kcal'], ['LUNCH', '520 kcal'],
  ['AFTERNOON_SNACK', '150 kcal'], ['DINNER', '620 kcal'], ['EVENING_SNACK', '120 kcal']
] as const;

async function expectTouchTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(48);
  expect(box!.width).toBeGreaterThanOrEqual(48);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
}

async function expectMealSummary(page: Page) {
  const preview = page.getByTestId('today-food-preview');
  await expect(preview.getByTestId(/^food-preview-meal-/)).toHaveCount(6);
  for (const [meal, calories] of MEAL_TOTALS) {
    await expect(preview.getByTestId(`food-preview-meal-${meal}`)).toContainText(calories);
  }
  for (const food of FOOD_ENTRIES) await expect(preview.getByText(food.name, { exact: true })).toHaveCount(0);
  await expect(preview).toContainText('9 foods');
  return preview;
}

test('Today anchors its actions, puts weigh-in first, and shows concise chronological meal totals', async ({ page, ux }, testInfo) => {
  await ux.install('populated', { foodDayStatus: 'OPEN', foodEntries: FOOD_ENTRIES, metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const preview = await expectMealSummary(page);
  const weight = page.getByTestId('today-weight-card-press-layer');
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  const completeDay = page.getByRole('button', { name: 'Complete day', exact: true });
  await expect(weight).toContainText('Weigh in');
  await expect(page.getByText('No weigh-in yet', { exact: true })).toHaveCount(0);
  await expectTouchTarget(weight);
  await expectTouchTarget(preview);
  await expectTouchTarget(addFood);
  await expectTouchTarget(completeDay);
  const [weightBox, previewBox, addBox, completeBox, dockBox] = await Promise.all([
    weight.boundingBox(), preview.boundingBox(), addFood.boundingBox(), completeDay.boundingBox(), page.getByTestId('today-action-dock').boundingBox(),
  ]);
  expect(weightBox!.y + weightBox!.height).toBeLessThanOrEqual(previewBox!.y + 1);
  await preview.getByTestId('food-preview-meal-EVENING_SNACK').scrollIntoViewIfNeeded();
  const visiblePreview = (await preview.boundingBox())!;
  expect(visiblePreview.y + visiblePreview.height).toBeLessThanOrEqual(dockBox!.y + 1);
  expect(Math.abs(addBox!.y - completeBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(addBox!.height - completeBox!.height)).toBeLessThanOrEqual(1);

  // Tablet/phone retain bottom tabs; desktop deliberately moves those destinations to its rail.
  if (page.viewportSize()!.width < 960) {
    const navBox = (await page.locator('a[href="/progress"]').last().boundingBox())!;
    expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(navBox.y + 1);
    expect(addBox!.y + addBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('today-fixed-layout.png') });

  await preview.click();
  await expect(page.getByTestId('expanded-food')).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
});

test('320px Today scrolls only the food pane while its surrounding controls stay fixed', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'The minimum-height phone case is covered once.');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated', { foodDayStatus: 'OPEN', foodEntries: FOOD_ENTRIES, metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expectMealSummary(page);
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  await expectTouchTarget(addFood);
  const dock = (await page.getByTestId('today-action-dock').boundingBox())!;
  expect(dock.y + dock.height).toBeLessThanOrEqual(568);
  const fixedControls = [
    page.getByRole('toolbar', { name: 'Food log date' }),
    page.getByTestId('calorie-balance-hero'),
    page.getByTestId('today-weight-card-press-layer'),
    page.getByTestId('today-action-dock'),
  ];
  const before = await Promise.all(fixedControls.map(control => control.boundingBox()));
  const foodScroll = page.getByTestId('today-food-scroll');
  await expect(page.getByTestId('fixed-page-scroll')).toHaveCount(0);
  await foodScroll.hover();
  await page.mouse.wheel(0, 800);
  await expect.poll(() => foodScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const after = await Promise.all(fixedControls.map(control => control.boundingBox()));
  expect(after).toEqual(before);
  await expect(page).toHaveURL(url => url.pathname === '/today');
  const lastMeal = page.getByTestId('food-preview-meal-EVENING_SNACK');
  await expect(lastMeal).toBeInViewport();
  const latestRow = (await lastMeal.boundingBox())!;
  expect(latestRow.y + latestRow.height).toBeLessThanOrEqual(dock.y);
  await foodScroll.hover();
  await page.mouse.wheel(0, 800);
  expect(await Promise.all(fixedControls.map(control => control.boundingBox()))).toEqual(before);
  await expectNoHorizontalOverflow(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('today-320x568.png') });
});

test('completion applies immediately and toggles back to an editable log', async ({ page, ux }, testInfo) => {
  const options: AuthenticatedApiOptions = { foodDayStatus: 'OPEN', foodEntries: FOOD_ENTRIES };
  await ux.install('populated', options);
  const statuses: string[] = [];
  await page.route('**/api/v1/food-days**', async (route) => {
    if (route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON();
      expect(payload.date).toBe(FROZEN_LOCAL_DATE);
      options.foodDayStatus = payload.status;
      statuses.push(payload.status);
    }
    await route.fallback();
  });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const dock = page.getByTestId('today-action-dock');
  const completeDay = dock.getByRole('button', { name: 'Complete day', exact: true });
  await expect(completeDay).toBeVisible();
  const initialBox = (await dock.boundingBox())!;
  await completeDay.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const editDay = dock.getByRole('button', { name: 'Day completed', exact: true });
  await expect(editDay).toBeVisible();
  await expect(editDay).toHaveAttribute('aria-pressed', 'true');
  await expect(dock.getByRole('button', { name: 'Add food', exact: true })).toBeDisabled();
  await expect(completeDay).toHaveCount(0);
  expect(statuses).toEqual(['COMPLETE']);
  expect(Math.abs((await dock.boundingBox())!.height - initialBox.height)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('today-completed-dock.png') });
  await editDay.click();
  await expect(dock.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
  await expect(completeDay).toBeVisible();
  expect(statuses).toEqual(['COMPLETE', 'OPEN']);
});

test('weigh-in and Add food stay over Today and restore focus when cancelled', async ({ page, ux }) => {
  await ux.install('populated', { foodDayStatus: 'OPEN', metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const weight = page.getByTestId('today-weight-card-press-layer');
  await weight.click();
  const weightSheet = page.getByRole('dialog', { name: 'Weight entry', exact: true });
  await expect(weightSheet).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await page.keyboard.press('Escape');
  await expect(weightSheet).toHaveCount(0);
  await expect(weight).toBeFocused();
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  await addFood.click();
  const foodSheet = page.getByRole('dialog', { name: 'Add food', exact: true });
  await expect(foodSheet).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await page.keyboard.press('Escape');
  await expect(foodSheet).toHaveCount(0);
  await expect(addFood).toBeFocused();
});

test('Pause tracking is a date control only for the current open day', async ({ page, ux }) => {
  await ux.install('populated', { foodDayStatus: 'OPEN' });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expect(page.getByRole('button', { name: 'Pause tracking', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: 'Calendar', exact: true });
  await expect(calendar.getByRole('button', { name: 'Pause tracking', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(calendar).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(calendar).toBeVisible();
  await expect(calendar.getByRole('button', { name: 'Pause tracking', exact: true })).toHaveCount(0);
});

test('320px Today enlarges to natural scrolling at 200% text without losing actions', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'The enlarged minimum phone is covered once.');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated', { foodDayStatus: 'OPEN', foodEntries: FOOD_ENTRIES, metrics: [] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expectMealSummary(page);
  await applyTwoHundredPercentText(page);
  const preview = page.getByTestId('today-food-preview');
  await expect(preview.getByTestId(/^food-preview-meal-/)).toHaveCount(6);
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  await addFood.scrollIntoViewIfNeeded();
  await expectTouchTarget(addFood);
  await expectTouchTarget(page.getByRole('button', { name: 'Complete day', exact: true }));
  await expectNoHorizontalOverflow(page);
  const dock = page.getByTestId('today-action-dock');
  const lastRow = preview.getByTestId('food-preview-meal-EVENING_SNACK');
  await dock.scrollIntoViewIfNeeded();
  const [addBox, completeBox] = await Promise.all([
    addFood.boundingBox(), page.getByRole('button', { name: 'Complete day', exact: true }).boundingBox(),
  ]);
  expect(completeBox!.y).toBeGreaterThan(addBox!.y + addBox!.height);
  expect(completeBox!.width).toBe(addBox!.width);
  const [lastBox, dockBox] = await Promise.all([lastRow.boundingBox(), dock.boundingBox()]);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(dockBox!.y);
  await page.screenshot({ path: testInfo.outputPath('today-200-text-actions.png') });
  await addFood.click();
  await expect(page.getByRole('dialog', { name: 'Add food', exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === '/today');
});

test('Today preserves keyboard order and visible actions in forced colors', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One forced-colors keyboard cross-cut.');
  await page.emulateMedia({ forcedColors: 'active' });
  const options: AuthenticatedApiOptions = { foodDayStatus: 'OPEN', metrics: [] };
  await ux.install('populated', options);
  await page.route('**/api/v1/food-days**', async route => {
    if (route.request().method() === 'PATCH') options.foodDayStatus = route.request().postDataJSON().status;
    await route.fallback();
  });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const weight = page.getByTestId('today-weight-card-press-layer');
  const preview = page.getByTestId('today-food-preview');
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  const complete = page.getByRole('button', { name: 'Complete day', exact: true });
  await weight.focus();
  await page.keyboard.press('Tab');
  await expect(preview).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(addFood).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(complete).toBeFocused();
  await expectTouchTarget(addFood);
  await expectTouchTarget(complete);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('today-forced-colors-keyboard.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Day completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const empty of [false, true]) {
  test(`the ${empty ? 'empty' : 'populated'} food pane owns spare height and both side gutters`, async ({ page, ux }, testInfo) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 1200 });
    await ux.install('populated', { foodDayStatus: 'OPEN', foodEntries: empty ? [] : FOOD_ENTRIES.slice(0, 2), metrics: [] });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    const pane = page.getByTestId('today-food-preview');
    await expect(pane).toContainText(empty ? 'No food logged yet' : '2 foods');
    const dock = page.getByTestId('today-action-dock');
    await expect.poll(async () => {
      const [paneBox, dockBox] = await Promise.all([pane.boundingBox(), dock.boundingBox()]);
      return Math.abs(paneBox!.y + paneBox!.height - dockBox!.y);
    }).toBeLessThanOrEqual(2);
    const box = (await pane.boundingBox())!;
    const contentBox = (await page.getByRole('main').boundingBox())!;
    expect(box.x).toBe(contentBox.x);
    expect(box.width).toBe(contentBox.width);
    await page.screenshot({ path: testInfo.outputPath(`today-${empty ? 'empty' : 'sparse'}-full-pane.png`) });
    // Tap blank space at the bottom-right edge, outside the constrained reading column.
    await page.mouse.click(box.x + box.width - 4, box.y + box.height - 8);
    await expect(page.getByTestId('expanded-food')).toBeVisible();
  });
}

test('date navigation continues the navbar surface across date-based routes', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const toolbar = page.getByRole('toolbar', { name: 'Food log date', includeHidden: true });
  const initial = (await toolbar.boundingBox())!;
  for (const route of ['/food-log', '/activity', '/weight']) {
    await page.goto(route);
    const header = page.getByTestId('date-navigation-header');
    await expect(header).toBeAttached();
    const bounds = (await toolbar.boundingBox())!;
    expect(Math.abs(bounds.y - initial.y)).toBeLessThanOrEqual(1);
    if (page.viewportSize()!.width < 768) {
      expect(bounds.x).toBe(initial.x);
      expect(bounds.width).toBe(initial.width);
    }
    const presentation = await header.evaluate(element => {
      const banner = document.querySelector('[role="banner"]')!;
      const controls = element.querySelector('[role="toolbar"]')!;
      return {
        header: getComputedStyle(element).backgroundColor,
        banner: getComputedStyle(banner).backgroundColor,
        divider: getComputedStyle(banner).borderBottomWidth,
        toolbar: getComputedStyle(controls).borderTopWidth,
        buttons: [...controls.querySelectorAll('[role="button"]')].map(button => getComputedStyle(button).borderTopWidth)
      };
    });
    expect(presentation.header).toBe(presentation.banner);
    expect(presentation.divider).toBe('0px');
    expect(presentation.toolbar).toBe('1px');
    expect(presentation.buttons).toEqual(['0px', '0px', '0px']);
    if (route !== '/weight') await page.screenshot({ path: testInfo.outputPath(`${route.slice(1)}-attached-date.png`) });
  }
});
