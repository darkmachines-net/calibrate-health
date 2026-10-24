/** @file Regression coverage for visual system: public server-rendered pages adopt the selected appearance after hydration. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { calibrateDesignTokens, type CalibrateColorScheme } from '../../shared/designTokens';
import { expect, test, hideTransientPwaNotices } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';

function cssRgb(hex: string): string {
  const channels = hex.match(/[A-Fa-f0-9]{2}/g);
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB hex color, received ${hex}`);
  return `rgb(${channels.map((channel) => Number.parseInt(channel, 16)).join(', ')})`;
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

test('public server-rendered pages adopt the selected appearance after hydration', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'Hydration behavior is viewport-independent.');
  await page.emulateMedia({ colorScheme: 'dark' });
  await ux.install('signed-out');
  for (const route of ['/forgot-password', '/account-deletion', '/privacy']) {
    await page.goto(route);
    await expect(page.getByRole('main')).toHaveCSS('background-color', cssRgb(calibrateDesignTokens.schemes.dark.background));
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveCSS('color', cssRgb(calibrateDesignTokens.schemes.dark.onSurface));
    await page.screenshot({ path: testInfo.outputPath(`${route.slice(1)}-dark.png`) });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.getByRole('main')).toHaveCSS('background-color', cssRgb(calibrateDesignTokens.schemes.light.background));
    await page.emulateMedia({ colorScheme: 'dark' });
  }
});

test('long nested page titles remain readable at 320px and 200 percent text', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'Minimum-width text reflow cross-cut.');
  await ux.install('populated');
  for (const route of ['/connected-apps', '/advanced']) {
    await page.goto(route);
    await hideTransientPwaNotices(page);
    const title = page.locator('#route-focus-title');
    await expect(title).toBeVisible();
    await enlargeLeafText(page);
    await expectNoHorizontalOverflow(page);
    await expect.poll(() => title.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`${route.slice(1)}-200-percent.png`) });
  }
});

test('weight measurement stays readable at 320px and 200 percent text', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'Minimum-width measurement cross-cut.');
  await ux.install('populated');
  await page.goto('/weight');
  const input = page.getByRole('textbox', { name: 'Weight in kilograms', exact: true });
  await expect(input).toBeVisible();
  await input.fill('88.2');
  await enlargeLeafText(page);
  await input.evaluate(element => {
    const field = element as HTMLInputElement;
    const style = getComputedStyle(field);
    field.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
    field.style.lineHeight = `${Number.parseFloat(style.lineHeight) * 2}px`;
  });
  await expect.poll(() => input.evaluate(element => {
    const field = element as HTMLInputElement;
    const style = getComputedStyle(field);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return context.measureText(field.value).width <= field.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      && field.clientHeight >= Number.parseFloat(style.lineHeight);
  })).toBe(true);
  await expect(input).toHaveCSS('font-size', '104px');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('weight-200-percent.png') });
  const save = page.getByRole('dialog', { name: 'Weight entry', exact: true }).getByRole('button', { name: 'Log weight', exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
});

async function expectInside(outer: Locator, inner: Locator) {
  const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
  expect(outerBox).not.toBeNull();
  expect(innerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(outerBox!.x + outerBox!.width + 1);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height + 1);
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

async function enlargeLeafText(page: Page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const hasDirectText = Array.from(element.childNodes).some((node) => (
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      ));
      if (!hasDirectText) continue;
      const computed = getComputedStyle(element);
      const fontSize = Number.parseFloat(computed.fontSize);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (Number.isFinite(fontSize)) element.style.fontSize = `${fontSize * 2}px`;
      if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * 2}px`;
    }
  });
}

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-05');

function shouldCaptureEvidence(testInfo: TestInfo): boolean {
  return process.env.CALIBRATE_CAPTURE_EVIDENCE === '1'
    && (testInfo.project.name === 'desktop-chrome' || testInfo.project.name === 'compact-phone-chrome');
}

async function capturePageEvidence(page: Page, testInfo: TestInfo, filename: string) {
  if (!shouldCaptureEvidence(testInfo)) return;
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

async function captureLocatorEvidence(locator: Locator, testInfo: TestInfo, filename: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1' || testInfo.project.name !== 'desktop-chrome') return;
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await locator.screenshot({ path: path.join(EVIDENCE_DIR, filename) });
}

async function captureDashboardEvidence(page: Page, testInfo: TestInfo) {
  const filename = testInfo.project.name === 'desktop-chrome'
    ? 'production-cards-focus-light-desktop.png'
    : testInfo.project.name === 'compact-phone-chrome'
      ? 'production-cards-focus-dark-compact-phone.png'
      : null;
  if (filename) await capturePageEvidence(page, testInfo, filename);
}

async function captureTokenReference(page: Page, testInfo: TestInfo, schemeName: CalibrateColorScheme) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1' || testInfo.project.name !== 'desktop-chrome') return;
  const scheme = calibrateDesignTokens.schemes[schemeName];
  const roles = [
    { label: 'Focus ring', color: scheme.focusRing, background: scheme.surface, foreground: scheme.onSurface, outline: scheme.focusRing },
    { label: 'Selection', color: scheme.selection, background: scheme.selectionContainer, foreground: scheme.onSelectionContainer },
    { label: 'Neutral emphasis', color: scheme.neutralEmphasis, background: scheme.neutralEmphasisContainer, foreground: scheme.onNeutralEmphasisContainer },
    { label: 'Positive', color: scheme.positive, background: scheme.positiveContainer, foreground: scheme.onPositiveContainer },
    { label: 'Caution', color: scheme.caution, background: scheme.cautionContainer, foreground: scheme.onCautionContainer },
    { label: 'Danger', color: scheme.danger, background: scheme.dangerContainer, foreground: scheme.onDangerContainer },
    { label: 'Celebration', color: scheme.celebration, background: scheme.celebrationContainer, foreground: scheme.onCelebrationContainer },
  ];
  const swatches = roles.map((role) => `
    <article class="swatch" style="background:${role.background};color:${role.foreground};${role.outline ? `outline:3px solid ${role.outline}` : ''}">
      <strong>${role.label}</strong><span>${role.color}</span>
    </article>`).join('');
  const typeSamples = Object.entries(calibrateDesignTokens.typography).map(([name, style]) => `
    <div class="type-sample" style="font-size:${style.fontSize}px;line-height:${style.lineHeight}px;font-weight:${style.fontWeight};letter-spacing:${style.letterSpacing}px">
      <span>${name}</span><small>${style.fontSize}/${style.lineHeight} | ${style.fontWeight}</small>
    </div>`).join('');

  await page.setViewportSize({ width: 1_024, height: 920 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;padding:40px;background:${scheme.background};color:${scheme.onBackground};font-family:Arial,sans-serif}
    header{margin-bottom:28px} h1{margin:0 0 8px;font-size:28px;line-height:34px} p{margin:0;color:${scheme.onSurfaceVariant};font-size:15px;line-height:22px}
    h2{font-size:18px;line-height:24px;margin:28px 0 14px}.swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
    .swatch{min-height:112px;border:1px solid ${scheme.outlineVariant};border-radius:16px;padding:18px;display:flex;flex-direction:column;justify-content:space-between}
    .swatch strong{font-size:16px;line-height:22px}.swatch span{font:600 13px/18px monospace}.type-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px}
    .type-sample{min-height:54px;border-bottom:1px solid ${scheme.outlineVariant};display:flex;align-items:center;justify-content:space-between;gap:18px}
    .type-sample span{text-transform:capitalize}.type-sample small{font:500 12px/16px monospace;color:${scheme.onSurfaceVariant};white-space:nowrap}
  </style></head><body><header><h1>Calibrate semantic visual system | ${schemeName}</h1><p>Rendered directly from shared/designTokens.ts. Each role is intentionally distinct from brand green.</p></header>
  <h2>Semantic roles</h2><section class="swatches">${swatches}</section><h2>Production typography scale</h2><section class="type-grid">${typeSamples}</section></body></html>`);
  await capturePageEvidence(page, testInfo, `semantic-tokens-type-${schemeName}.png`);
}

async function semanticColorAssertions(page: Page, testInfo: TestInfo, schemeName: CalibrateColorScheme) {
  const scheme = calibrateDesignTokens.schemes[schemeName];
  await page.emulateMedia({ colorScheme: schemeName });
  await page.goto('/progress');

  const projection = page.getByTestId('goal-projection');
  await expect(projection).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(projection).not.toHaveCSS('background-color', cssRgb(scheme.cautionContainer));
  await captureLocatorEvidence(projection, testInfo, `production-info-${schemeName}.png`);

  await page.goto('/weight-trend');
  const chart = page.getByTestId('weight-trend-chart-canvas');
  const selectedPoint = chart.locator('circle').last();
  await expect(selectedPoint).toHaveAttribute('fill', scheme.selectionContainer);
  await expect(selectedPoint).toHaveAttribute('stroke', scheme.selection);
  await expect(selectedPoint).not.toHaveAttribute('fill', scheme.cautionContainer);
  await captureLocatorEvidence(chart, testInfo, `production-selection-${schemeName}.png`);
}

test('Today rows keep labels inside a single target and Add food separate', async ({ page, ux }, testInfo) => {
  if (testInfo.project.name === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
  }
  const dashboardScheme: CalibrateColorScheme = testInfo.project.name === 'compact-phone-chrome' ? 'dark' : 'light';
  const dashboardColors = calibrateDesignTokens.schemes[dashboardScheme];
  await page.emulateMedia({ colorScheme: dashboardScheme });
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);

  const foodCard = page.getByTestId('today-food-preview');
  const foodPrimary = foodCard;
  const addFood = page.getByRole('button', { name: 'Add food', exact: true });
  const weightPrimary = page.getByLabel(/Today's weight.+weight/);
  const foodHeading = foodPrimary.getByText('Food log', { exact: true });
  const weightHeading = weightPrimary.getByText('Weigh in', { exact: true });

  await expectInside(foodCard, foodPrimary);
  await expectInside(page.getByTestId('today-action-dock'), addFood);
  await expectNoOverlap(foodPrimary, addFood);
  await expect(page.getByRole('button', { name: /Food log.*View full log/ })).toHaveCount(1);
  await expect(page.getByTestId('today-weight-card').getByRole('button')).toHaveCount(1);
  await expectInside(foodPrimary, foodHeading);
  await expectInside(weightPrimary, weightHeading);

  const [foodHeadingStyle, weightHeadingStyle] = await Promise.all([
    foodHeading.evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      lineHeight: getComputedStyle(element).lineHeight,
    })),
    weightHeading.evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      lineHeight: getComputedStyle(element).lineHeight,
    })),
  ]);
  expect(foodHeadingStyle).toEqual({ fontSize: '20px', lineHeight: '26px' });
  expect(weightHeadingStyle).toEqual(foodHeadingStyle);

  const [foodPrimaryBox, foodHeadingBox, weightPrimaryBox, weightHeadingBox] = await Promise.all([
    foodPrimary.boundingBox(),
    foodHeading.boundingBox(),
    weightPrimary.boundingBox(),
    weightHeading.boundingBox(),
  ]);
  expect(foodPrimaryBox).not.toBeNull();
  expect(foodHeadingBox).not.toBeNull();
  expect(weightPrimaryBox).not.toBeNull();
  expect(weightHeadingBox).not.toBeNull();
  expect(weightPrimaryBox!.y + weightPrimaryBox!.height).toBeLessThanOrEqual(foodPrimaryBox!.y + 1);
  expect(foodHeadingBox!.y).toBeGreaterThanOrEqual(foodPrimaryBox!.y);
  expect(weightHeadingBox!.y).toBeGreaterThanOrEqual(weightPrimaryBox!.y);

  const surfaceBeforePress = await foodPrimary.evaluate((element) => getComputedStyle(element).backgroundColor);
  await foodPrimary.hover();
  const foodPrimaryBoxForPress = await foodPrimary.boundingBox();
  expect(foodPrimaryBoxForPress).not.toBeNull();
  await page.mouse.move(
    foodPrimaryBoxForPress!.x + (foodPrimaryBoxForPress!.width / 2),
    foodPrimaryBoxForPress!.y + (foodPrimaryBoxForPress!.height / 2),
  );
  await page.mouse.down();
  await expect.poll(() => foodPrimary.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(surfaceBeforePress);
  await page.mouse.move(0, 0);
  await page.mouse.up();

  const todayPath = new URL(page.url()).pathname;
  await addFood.click();
  await expect(page.getByTestId('bottom-sheet-root')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(todayPath);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bottom-sheet-root')).toHaveCount(0);

  await page.keyboard.press('Tab');
  await foodPrimary.focus();
  await expect(foodPrimary).toHaveCSS('outline-color', cssRgb(dashboardColors.focusRing));
  await captureDashboardEvidence(page, testInfo);
  await applyTwoHundredPercentText(page);
  await expectNoHorizontalOverflow(page);
  await expectInside(page.getByRole('main'), page.getByRole('heading', { name: 'Daily balance', exact: true }));
});

test('Progress aligns the open Snapshot and flexible Trend with supporting metadata', async ({ page, ux }, testInfo) => {
  test.skip(
    !['compact-phone-chrome', 'desktop-chrome'].includes(testInfo.project.name),
    'Progress heading geometry is covered at the compact phone and desktop cross-cuts.',
  );
  if (testInfo.project.name === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
  }
  await ux.install('populated');
  await page.goto('/progress');

  const snapshotCard = page.getByTestId('progress-snapshot-card');
  const trendCard = page.getByTestId('weight-trend-preview-card');
  const snapshotHeading = page.getByRole('heading', { name: 'Snapshot', exact: true });
  const trendHeading = page.getByRole('heading', { name: 'Trend', exact: true });
  await expect(snapshotHeading).toBeVisible();
  await expect(trendHeading).toBeVisible();

  const [snapshotCardBox, trendCardBox, snapshotHeadingBox, trendHeadingBox] = await Promise.all([
    snapshotCard.boundingBox(),
    trendCard.boundingBox(),
    snapshotHeading.boundingBox(),
    trendHeading.boundingBox(),
  ]);
  expect(snapshotCardBox).not.toBeNull();
  expect(trendCardBox).not.toBeNull();
  expect(snapshotHeadingBox).not.toBeNull();
  expect(trendHeadingBox).not.toBeNull();

  const snapshotTopInset = snapshotHeadingBox!.y - snapshotCardBox!.y;
  const trendTopInset = trendHeadingBox!.y - trendCardBox!.y;
  expect(snapshotTopInset).toBeGreaterThanOrEqual(0);
  expect(snapshotTopInset).toBeLessThanOrEqual(12);
  expect(trendTopInset).toBeGreaterThanOrEqual(0);
  expect(trendTopInset).toBeLessThanOrEqual(2);
  expect(snapshotHeadingBox!.x).toBe(trendHeadingBox!.x);
  await expect(snapshotCard).toHaveCSS('border-top-width', '0px');

  if (testInfo.project.name === 'compact-phone-chrome') {
    const trendMetadata = page.getByText(/underlying trend$/);
    const metadataGeometry = await trendMetadata.boundingBox();
    expect(metadataGeometry).not.toBeNull();
    expect(metadataGeometry!.y).toBeGreaterThanOrEqual(trendHeadingBox!.y + trendHeadingBox!.height);
    await expectInside(trendCard, trendMetadata);
  }
});

test('informational projection and selected trend point remain distinct from caution in light and dark', async ({ page, ux }, testInfo) => {
  if (testInfo.project.name === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
  }
  await ux.install('populated');
  await semanticColorAssertions(page, testInfo, 'light');
  await semanticColorAssertions(page, testInfo, 'dark');
  await expectNoHorizontalOverflow(page);
});

test('semantic token and typography reference is rendered from shipped definitions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'One reviewed desktop reference per color scheme is sufficient.');
  expect(calibrateDesignTokens.schemes.light.focusRing).not.toBe(calibrateDesignTokens.schemes.light.positive);
  expect(calibrateDesignTokens.schemes.dark.danger).not.toBe(calibrateDesignTokens.schemes.dark.celebration);
  await captureTokenReference(page, testInfo, 'light');
  await captureTokenReference(page, testInfo, 'dark');
});

test('production caution, danger, and focus roles remain visually distinct', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The reviewed semantic-state crops use the desktop layout.');
  const scheme = calibrateDesignTokens.schemes.light;
  await page.emulateMedia({ colorScheme: 'light' });
  await ux.install('populated', {
    metrics: [{ id: 4, date: '2026-07-21', weight: 82 }],
    trendMetrics: [{
      id: 4,
      user_id: 17,
      date: '2026-07-21',
      weight: 82,
      body_fat_percent: null,
      trend_weight: 82,
      trend_ci_lower: 81.8,
      trend_ci_upper: 82.2,
    }],
  });
  await page.route('**/api/v1/goals', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 7,
        start_weight: 90,
        target_weight: 82,
        target_date: null,
        daily_deficit: 500,
        created_at: '2026-07-01T12:00:00.000Z',
        plan_status: 'available',
        plan_reason_code: null,
        projection: { status: 'reached', projected_end_date: null, reason_code: null },
      }),
    });
  });
  await page.goto('/progress');

  const cautionMessage = page.getByText(/plan remains active until you set another goal\./).locator('..');
  await expect(cautionMessage).toHaveCSS('background-color', cssRgb(scheme.cautionContainer));
  await captureLocatorEvidence(cautionMessage, testInfo, 'production-caution-light.png');

  await page.goto('/settings');
  await page.getByTestId('settings-open-data').click();
  await expect(page).toHaveURL((url) => url.pathname === '/data');
  await expect(page.locator('#route-focus-title')).toBeFocused();
  const deleteAccount = page.getByRole('button', { name: 'Delete account', exact: true });
  await deleteAccount.scrollIntoViewIfNeeded();
  await page.keyboard.press('Tab');
  await deleteAccount.focus();
  await expect(deleteAccount).toHaveCSS('outline-color', cssRgb(scheme.focusRing));
  await expect(deleteAccount.getByText('Delete account', { exact: true })).toHaveCSS('color', cssRgb(scheme.danger));
  await captureLocatorEvidence(deleteAccount, testInfo, 'production-danger-focus-light.png');
});
