/** @file Regression coverage for launch 11 today control center: Today is legible, keyboard-operable, and unclipped at every configured viewport. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { calibrateDesignTokens } from '../../shared/designTokens';
import { expect, test, hideTransientPwaNotices, type AuthenticatedApiOptions } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-11');
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);
const CONFIGURED_VIEWPORT_WIDTHS: Record<string, number> = {
  'desktop-chrome': 1_440,
  'tablet-chrome': 820,
  'android-phone-chrome': 390,
  'compact-phone-chrome': 320,
};

for (const colorScheme of ['light', 'dark'] as const) {
  test(`incomplete days preserve the daily summary geometry in ${colorScheme}`, async ({ page, ux }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const options: AuthenticatedApiOptions = { foodDayStatus: 'COMPLETE', foodEntries: foodEntry(2310) };
    await ux.install('populated', options);
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    const summary = page.getByLabel(/^Daily balance\./);
    const foodHeading = page.getByTestId('today-food-preview');
    const heading = summary.getByRole('heading', { name: 'Daily balance', exact: true });
    await expect(summary).toContainText('kcal over target');
    const complete = { summary: (await summary.boundingBox())!, food: (await foodHeading.boundingBox())!, heading: (await heading.boundingBox())! };

    options.foodDayStatus = 'INCOMPLETE';
    options.foodEntries = [];
    await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    await expect(summary).toHaveAccessibleName('Daily balance. Incomplete day. 0 calories logged.');
    await expect(summary).toContainText('0 kcal logged');
    await expect(summary.getByTestId('calorie-gauge-progress')).toHaveCount(0);
    const incomplete = { summary: (await summary.boundingBox())!, food: (await foodHeading.boundingBox())!, heading: (await heading.boundingBox())! };
    expect(Math.abs(incomplete.summary.height - complete.summary.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(incomplete.heading.x - complete.heading.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(incomplete.food.y - complete.food.y)).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`incomplete-day-${colorScheme}.png`) });

    options.foodDayStatus = 'COMPLETE';
    options.foodEntries = foodEntry(2310);
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    await expect(summary).toContainText('kcal over target');
    expect(Math.abs((await foodHeading.boundingBox())!.y - incomplete.food.y)).toBeLessThanOrEqual(1);
  });
}

function foodEntry(calories: number, name = 'Fixture breakfast') {
  return [{
    id: 31,
    meal_period: 'BREAKFAST' as const,
    name,
    calories,
    servings_consumed: 1,
  }];
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectInside(outer: Locator, inner: Locator) {
  const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(outerBox).not.toBeNull();
  expect(innerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
}

async function expectFullWidthPrimary(surface: Locator, primary: Locator) {
  const [surfaceBox, primaryBox] = await Promise.all([surface.boundingBox(), primary.boundingBox()]);
  expect(surfaceBox).not.toBeNull();
  expect(primaryBox).not.toBeNull();
  expect(Math.abs(surfaceBox!.x - primaryBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(surfaceBox!.width - primaryBox!.width)).toBeLessThanOrEqual(2);
}

async function expectNoOverlap(first: Locator, second: Locator) {
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const overlapWidth = Math.max(
    0,
    Math.min(firstBox!.x + firstBox!.width, secondBox!.x + secondBox!.width)
      - Math.max(firstBox!.x, secondBox!.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(firstBox!.y + firstBox!.height, secondBox!.y + secondBox!.height)
      - Math.max(firstBox!.y, secondBox!.y),
  );
  expect(overlapWidth * overlapHeight).toBeLessThanOrEqual(1);
}

async function expectWithinViewportWidth(page: Page, locator: Locator) {
  const [viewport, box] = await Promise.all([page.viewportSize(), locator.boundingBox()]);
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

async function expectHorizontallyCentered(outer: Locator, inner: Locator) {
  const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(outerBox).not.toBeNull();
  expect(innerBox).not.toBeNull();
  const outerCenter = outerBox!.x + (outerBox!.width / 2);
  const innerCenter = innerBox!.x + (innerBox!.width / 2);
  expect(Math.abs(outerCenter - innerCenter)).toBeLessThanOrEqual(2);
}

function parseCssRgb(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error('Expected an RGB CSS color, received ' + value);
  }
  return channels as [number, number, number];
}

function relativeLuminance([red, green, blue]: [number, number, number]) {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

async function expectContrast(text: Locator, surface: Locator, minimumRatio: number) {
  const [foreground, background] = await Promise.all([
    text.evaluate((element) => getComputedStyle(element).color),
    surface.evaluate((element) => {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
        current = current.parentElement;
      }
      throw new Error('No painted ancestor behind the calorie text.');
    }),
  ]);
  const foregroundLuminance = relativeLuminance(parseCssRgb(foreground));
  const backgroundLuminance = relativeLuminance(parseCssRgb(background));
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  expect(ratio).toBeGreaterThanOrEqual(minimumRatio);
}

async function enlargeLeafText(page: Page) {
  await applyTwoHundredPercentText(page);
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  let filename: string | null = null;
  if (testInfo.project.name === 'desktop-chrome') {
    filename = 'today-control-center-desktop-1024x1000.png';
  } else if (testInfo.project.name === 'compact-phone-chrome') {
    filename = 'today-control-center-phone-320x568.png';
  }
  if (!filename) return;

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((transientTitles) => {
    for (const notice of document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')) {
      const title = notice.querySelector('span')?.textContent?.trim();
      if (title && transientTitles.includes(title)) notice.style.display = 'none';
    }
  }, [...TRANSIENT_PWA_TITLES]);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

async function expectUnderTargetDashboard(page: Page) {
  await hideTransientPwaNotices(page);
  const balanceCard = page.getByLabel(/^Daily balance\./);
  await expect(balanceCard).toHaveAccessibleName(
    'Daily balance. 1,740 kcal remaining. 360 eaten out of 2,100 calorie target.',
  );
  await expect(page.getByText('17%', { exact: true })).toBeVisible();
  await expect(page.getByTestId('calorie-balance-value')).toHaveText('1,740');
  await expect(page.getByText('kcal remaining', { exact: true })).toBeVisible();
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveAttribute(
    'stroke',
    calibrateDesignTokens.schemes.light.primary,
  );
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Complete day', exact: true })).toBeEnabled();
}

test('Today is legible, keyboard-operable, and unclipped at every configured viewport', async (
  { page, ux },
  testInfo,
) => {
  const configuredViewport = page.viewportSize();
  expect(configuredViewport).not.toBeNull();
  expect(configuredViewport!.width).toBe(CONFIGURED_VIEWPORT_WIDTHS[testInfo.project.name]);

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  await page.goto('/today');

  await expectUnderTargetDashboard(page);
  await expectNoHorizontalOverflow(page);

  const foodSurface = page.getByTestId('today-food-preview');
  const foodPrimary = foodSurface;
  const foodSecondary = page.getByTestId('today-action-dock');
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  const weightSurface = page.getByTestId('today-weight-card');
  const weightPrimary = page.getByTestId('today-weight-card-press-layer');

  await expectInside(foodSurface, foodPrimary);
  await expectInside(page.getByTestId('today-fixed-page'), foodSecondary);
  await expectInside(foodSecondary, addFood);
  await foodPrimary.getByTestId('food-preview-meal-EVENING_SNACK').scrollIntoViewIfNeeded();
  await expectNoOverlap(foodPrimary, foodSecondary);
  await page.getByTestId('today-food-scroll').evaluate(element => { element.scrollTop = 0; });
  await expectFullWidthPrimary(foodSurface, foodPrimary);
  await expectInside(weightSurface, weightPrimary);
  await expectFullWidthPrimary(weightSurface, weightPrimary);
  await expectNoOverlap(foodSurface, weightSurface);

  if (testInfo.project.name === 'desktop-chrome') {
    const balanceSurface = page.getByLabel(/^Daily balance\./);
    await expectContrast(page.getByTestId('calorie-balance-value'), balanceSurface, 3);

    await page.keyboard.press('Tab');
    await foodPrimary.focus();
    await expect(foodPrimary).toBeFocused();
    await expect.poll(() => foodPrimary.evaluate((element) => getComputedStyle(element).outlineWidth))
      .toBe('3px');
    await foodPrimary.press('Enter');
    await expect(page.getByTestId('expanded-food')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Today', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Back to Today', exact: true }).click();
    await expect(foodPrimary).toBeFocused();
    await expectUnderTargetDashboard(page);
    await expect(page).toHaveURL((url) => url.pathname === '/today');

    const todayPath = new URL(page.url()).pathname;
    await page.getByRole('button', { name: 'Add food', exact: true }).click();
    const addFoodDialog = page.getByRole('dialog', { name: 'Add food', exact: true });
    await expect(addFoodDialog).toBeVisible();
    const [searchLabelBox, savedFoodsBox] = await Promise.all([
      addFoodDialog.getByText('Search foods', { exact: true }).boundingBox(),
      addFoodDialog.getByRole('button', { name: 'Saved foods', exact: true }).boundingBox(),
    ]);
    expect(searchLabelBox).not.toBeNull();
    expect(savedFoodsBox).not.toBeNull();
    const searchLabelCenter = searchLabelBox!.y + (searchLabelBox!.height / 2);
    const savedFoodsCenter = savedFoodsBox!.y + (savedFoodsBox!.height / 2);
    expect(Math.abs(searchLabelCenter - savedFoodsCenter)).toBeLessThanOrEqual(2);
    const [panelBox, resultsBox] = await Promise.all([
      addFoodDialog.boundingBox(),
      addFoodDialog.getByTestId('food-search-results').boundingBox(),
    ]);
    expect(panelBox).not.toBeNull();
    expect(resultsBox).not.toBeNull();
    expect(Math.abs(
      (panelBox!.y + panelBox!.height) - (resultsBox!.y + resultsBox!.height),
    )).toBeLessThanOrEqual(2);
    expect(new URL(page.url()).pathname).toBe(todayPath);
    await page.keyboard.press('Escape');

    const currentWeightPrimary = page.getByTestId('today-weight-card-press-layer');
    await currentWeightPrimary.focus();
    await currentWeightPrimary.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Weight entry', exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    await page.keyboard.press('Escape');
    await expect(currentWeightPrimary).toBeFocused();

    await page.setViewportSize({ width: 1_024, height: 1_000 });
    await expectUnderTargetDashboard(page);
    await expectNoHorizontalOverflow(page);
    await expectHorizontallyCentered(page.getByRole('main'), page.getByLabel(/^Daily balance\./));
    await captureEvidence(page, testInfo);
  }

  if (testInfo.project.name === 'compact-phone-chrome') {
    await page.setViewportSize({ width: 320, height: 568 });
    await expectUnderTargetDashboard(page);

    const balanceCard = page.getByLabel(/^Daily balance\./);
    const balanceGauge = balanceCard.locator('svg').first();
    const balanceHeading = balanceCard.getByRole('heading', { name: 'Daily balance', exact: true });
    const balanceValue = page.getByTestId('calorie-balance-value');
    const [gaugeBox, headingBox, valueBox] = await Promise.all([
      balanceGauge.boundingBox(),
      balanceHeading.boundingBox(),
      balanceValue.boundingBox(),
    ]);
    if (!gaugeBox || !headingBox || !valueBox) {
      throw new Error('Daily balance hero geometry was not measurable at 320px.');
    }
    const copyLeft = Math.min(headingBox.x, valueBox.x);
    const gaugeBottom = gaugeBox.y + gaugeBox.height;
    const copyTop = Math.min(headingBox.y, valueBox.y);
    const copyBottom = Math.max(headingBox.y + headingBox.height, valueBox.y + valueBox.height);
    expect(Math.min(gaugeBottom, copyBottom) - Math.max(gaugeBox.y, copyTop)).toBeGreaterThan(0);
    expect(gaugeBox.x + gaugeBox.width).toBeLessThanOrEqual(copyLeft);

    const valueLineTops = await balanceValue.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...new Set(Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top)))];
    });
    expect(valueLineTops).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo);

    await enlargeLeafText(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId('calorie-balance-value')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    await expectWithinViewportWidth(page, page.getByTestId('today-food-preview'));
    await expectWithinViewportWidth(page, page.getByTestId('today-weight-card'));
    await expectNoOverlap(
      page.getByTestId('today-food-preview'),
      page.getByTestId('today-weight-card'),
    );
  }
});

test('under, at, over, empty, and paused days use the three exact truthful statuses', async (
  { page, ux },
  testInfo,
) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One desktop pass bounds the calorie/status matrix.');

  const options: AuthenticatedApiOptions = {
    foodEntries: foodEntry(1_680, 'Under-target breakfast'),
    foodDayStatus: 'OPEN',
  };
  await ux.install('populated', options);
  await page.goto('/today');

  let balanceCard = page.getByLabel(/^Daily balance\./);
  await expect(balanceCard).toHaveAccessibleName(
    'Daily balance. 420 kcal remaining. 1,680 eaten out of 2,100 calorie target.',
  );
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveAttribute(
    'stroke',
    calibrateDesignTokens.schemes.light.primary,
  );
  await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeEnabled();

  options.foodEntries = foodEntry(2_100, 'At-target breakfast');
  options.foodDayStatus = 'COMPLETE';
  await page.reload();

  balanceCard = page.getByLabel(/^Daily balance\./);
  await expect(balanceCard).toHaveAccessibleName(
    'Daily balance. 0 kcal remaining. 2,100 eaten out of 2,100 calorie target.',
  );
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveAttribute(
    'stroke',
    calibrateDesignTokens.schemes.light.primary,
  );
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Day completed', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Day completed', exact: true })).toBeVisible();

  options.foodEntries = foodEntry(2_310, 'Over-target breakfast');
  options.foodDayStatus = 'OPEN';
  await page.reload();

  balanceCard = page.getByLabel(/^Daily balance\./);
  await expect(balanceCard).toHaveAccessibleName(
    'Daily balance. 210 kcal over target. 2,310 eaten out of 2,100 calorie target.',
  );
  await expect(page.getByText('kcal over target', { exact: true })).toBeVisible();
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveAttribute(
    'stroke',
    calibrateDesignTokens.schemes.light.danger,
  );
  await expectContrast(page.getByTestId('calorie-balance-value'), balanceCard, 3);
  await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeEnabled();

  options.foodEntries = [];
  options.foodDayStatus = 'OPEN';
  await page.reload();

  await expect(page.getByLabel(/^Daily balance\./)).toHaveAccessibleName(
    'Daily balance. 2,100 kcal remaining. 0 eaten out of 2,100 calorie target.',
  );
  await expect(page.getByText("No food logged yet", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeEnabled();

  options.foodDayStatus = 'PAUSED';
  await page.reload();

  await expect(page.getByLabel(/^Daily balance\./)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Tracking paused', exact: true })).toBeVisible();
  await expect(page.getByTestId('today-food-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toBeVisible();
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Day completed', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('an initial Today failure never resembles an empty or completed day', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One desktop pass bounds the terminal failure state.');

  await ux.install('failed-request', { foodDayStatus: 'COMPLETE' });
  await page.goto('/today');

  await expect(page.getByText("Can't load today's log", { exact: true })).toBeVisible();
  await expect(page.getByText("No food logged yet", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Day completed', exact: true })).toHaveCount(0);
  await expect(page.getByText('Day status unavailable', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Daily balance\./)).toContainText('Day unavailable');
  await expect(page.getByText('Food log unavailable', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a failed refresh keeps cached Today data but retracts the completed status', async (
  { page, ux },
  testInfo,
) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One desktop pass bounds the stale refresh state.');

  await ux.install('stale', { foodDayStatus: 'COMPLETE' });
  await page.goto('/today');
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Day completed', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Next day', exact: true }).click();

  await expect(page.getByText("Couldn't refresh today's log", { exact: true })).toBeVisible();
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();
  await expect(page.getByText('Day status unavailable', { exact: true })).toBeVisible();
  await expect(page.getByTestId('today-action-dock').getByRole('button', { name: 'Day completed', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('offline cached Today data stays visible and explicitly identifies saved information', async (
  { page, ux },
  testInfo,
) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'One compact pass bounds cached offline truth.');

  const controller = await ux.install('offline', { foodDayStatus: 'COMPLETE' });
  await page.goto('/today');
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();

  await controller.activateOffline();

  await expect(page.getByText("You're offline", { exact: true })).toBeVisible();
  const savedInformationNotice = page.getByText(
    'Offline - showing saved information',
    { exact: true },
  );
  await expect(savedInformationNotice).toHaveCount(1);
  await expect(savedInformationNotice).toBeVisible();
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
