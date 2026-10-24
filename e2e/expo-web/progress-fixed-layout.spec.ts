/** @file Regression coverage for progress fixed layout: Trend heading, fullscreen icon, and graph share one full-width navigation target. */

import { applyTwoHundredPercentText } from './text-scaling';
import type { Page } from '@playwright/test';
import { expect, test, hideTransientPwaNotices } from './fixtures';
import { PLAN_CHECK_RECOMMENDATION_STATUS } from './plan-check.fixture';

async function installPlanCheck(page: Page) {
  await page.route('**/api/v1/calibration/status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(PLAN_CHECK_RECOMMENDATION_STATUS),
  }));
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test('Trend heading, fullscreen icon, and graph share one full-width navigation target', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  for (const region of ['trend-preview-heading-line', 'trend-preview-expand-icon', 'weight-trend-preview-canvas']) {
    await page.goto('/progress');
    await hideTransientPwaNotices(page);
    const target = page.getByRole('button', { name: 'Open full weight trend', exact: true });
    await expect(target).toBeVisible();
    await expect(target.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Weight trend details', exact: true })).toHaveCount(0);
    const bounds = (await target.boundingBox())!;
    const pageBounds = (await page.getByTestId('progress-fixed-page').boundingBox())!;
    expect(bounds.x).toBe(pageBounds.x);
    expect(bounds.width).toBe(pageBounds.width);
    const child = (await page.getByTestId(region).boundingBox())!;
    const position = { x: child.x + child.width / 2 - bounds.x, y: child.y + child.height / 2 - bounds.y };
    await target.hover({ position });
    await expect(target).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByTestId('trend-preview-expand-icon')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByTestId('weight-trend-preview-canvas')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    if (region === 'trend-preview-expand-icon') {
      await page.screenshot({ path: testInfo.outputPath('progress-trend-shared-hover.png') });
    }
    await target.click({ position });
    await expect(page.getByTestId("expanded-trend")).toBeVisible();
  }
});

test('Progress gives the complete chart available space and keeps Plan check reachable', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await installPlanCheck(page);
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  const snapshot = page.getByTestId('progress-snapshot-card');
  const canvas = page.getByTestId('weight-trend-preview-canvas');
  const summary = page.getByTestId('plan-check-summary');
  await expect(summary).toContainText('Your recent weight trend is slower than your goal');
  await expect(summary).toHaveAttribute('role', 'button');
  await expect(summary.getByRole('button')).toHaveCount(0);
  const [snapshotBox, canvasBox, summaryBox] = await Promise.all([snapshot.boundingBox(), canvas.boundingBox(), summary.boundingBox()]);
  expect(snapshotBox!.y + snapshotBox!.height).toBeLessThan(canvasBox!.y);
  expect(canvasBox!.height).toBeGreaterThanOrEqual(188);
  expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(summaryBox!.y);
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toBeInViewport({ ratio: 1 });
  const axisFontSizes = await canvas.locator('text').evaluateAll(elements => elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(axisFontSizes.length).toBeGreaterThanOrEqual(4);
  expect(axisFontSizes.every(size => size >= 12)).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('progress-fixed-layout.png') });
  await summary.click();
  await expect(page.getByTestId("expanded-plan")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review suggested 1,750 calorie daily target', exact: true })).toBeVisible();
});

test('Progress fits a Galaxy Ultra-sized viewport without scrolling the overview', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-phone-chrome', 'One large-phone cross-cut.');
  // Also allow for the usable height left by browser and device chrome.
  await page.setViewportSize({ width: 412, height: 820 });
  await ux.install('populated');
  await installPlanCheck(page);
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  const canvas = page.getByTestId('weight-trend-preview-canvas');
  const summary = page.getByTestId('plan-check-summary');
  await expect(summary).toContainText('Your recent weight trend is slower than your goal');
  await expect(page.getByLabel('Chart legend', { exact: true })).toHaveCount(0);
  const scroller = page.getByTestId('fixed-page-scroll');
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  const canvasBox = (await canvas.boundingBox())!;
  const summaryBox = (await summary.boundingBox())!;
  expect(canvasBox.height).toBeGreaterThanOrEqual(188);
  expect(summaryBox.y - canvasBox.y - canvasBox.height).toBeLessThanOrEqual(5);
  await expect(summary).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('progress-galaxy-ultra.png') });
});

test('outdated Trend scrolls its recovery action and Plan check only when they do not fit', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-phone-chrome', 'One phone cross-cut with changing usable heights.');
  const outdatedTrend = {
    metrics: [],
    meta: {
      total_points: 2, total_span_days: 19, weekly_rate: null, volatility: 'low',
      trend_summary: {
        status: 'stale', evidence: 'provisional', freshness: 'outdated', model_version: 2,
        as_of_date: '2026-07-21', scope_start_date: '2026-06-23', scope_end_date: '2026-07-21',
        latest_observation_date: '2026-07-01', days_since_latest: 20,
        modeled_points: 2, observation_span_days: 1, segment_start_date: '2026-06-30',
        latest_trend: { weight: 168.2, lower: 167.8, upper: 168.6 },
        weekly_rate: null, short_term_variation: null,
      },
    },
  };
  await ux.install('populated', {
    apiResources: [{
      pathname: '/api/v1/metrics', matches: url => url.searchParams.get('include_trend') === 'true',
      state: 'content', content: outdatedTrend, empty: outdatedTrend,
    }],
  });
  await installPlanCheck(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  const scroller = page.getByTestId('fixed-page-scroll');
  const canvas = page.getByTestId('weight-trend-preview-canvas');
  const action = page.getByRole('button', { name: 'Log weight', exact: true });
  const summary = page.getByTestId('plan-check-summary');
  await expect(page.getByTestId('trend-preview-heading')).toContainText('Estimate out of date');
  for (const { width, height, shouldScroll } of [
    { width: 390, height: 700, shouldScroll: true },
    { width: 320, height: 760, shouldScroll: true },
    { width: 390, height: 800, shouldScroll: false },
  ]) {
    await page.setViewportSize({ width, height });
    await expect(scroller.getByTestId('plan-check-summary')).toHaveCount(shouldScroll ? 1 : 0);
    const canvasBox = (await canvas.boundingBox())!;
    const actionBox = (await action.boundingBox())!;
    const summaryBox = (await summary.boundingBox())!;
    expect(canvasBox.height).toBeGreaterThanOrEqual(188);
    expect(actionBox.height).toBeGreaterThanOrEqual(48);
    expect(canvasBox.y + canvasBox.height).toBeLessThanOrEqual(actionBox.y);
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(summaryBox.y);
    if (shouldScroll) {
      await summary.scrollIntoViewIfNeeded();
    } else {
      await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    }
    await expect(summary).toBeInViewport({ ratio: 1 });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`progress-outdated-${width}x${height}.png`) });
  }
  await action.click();
  await expect(page).toHaveURL(/\/weight$/);
});

test('short Progress scrolls Plan check after a complete chart', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'One minimum phone cross-cut.');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await installPlanCheck(page);
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  const canvas = page.getByTestId('weight-trend-preview-canvas');
  const summary = page.getByTestId('plan-check-summary');
  await expect(canvas).toHaveCSS('height', '188px');
  const canvasBox = (await canvas.boundingBox())!;
  const summaryBox = (await summary.boundingBox())!;
  expect(canvasBox.y + canvasBox.height).toBeLessThan(summaryBox.y);
  const scroller = page.getByTestId('fixed-page-scroll');
  expect(await scroller.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('progress-320-complete-chart.png') });
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('progress-320-plan-check.png') });
});

test('200 percent Progress text keeps the chart and diagnosis in natural page order', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'One enlarged-text cross-cut.');
  await ux.install('populated');
  await installPlanCheck(page);
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  await expect(page.getByTestId('plan-check-summary')).toBeVisible();
  await applyTwoHundredPercentText(page);
  const canvas = page.getByTestId('weight-trend-preview-canvas');
  const summary = page.getByTestId('plan-check-summary');
  await expect(canvas).toHaveCSS('height', '376px');
  const canvasBox = (await canvas.boundingBox())!;
  const summaryBox = (await summary.boundingBox())!;
  expect(canvasBox.y + canvasBox.height).toBeLessThan(summaryBox.y);
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toBeInViewport({ ratio: 1 });
  await expect(summary).toHaveCSS('overflow', 'visible');
  await expect(summary.getByText('Your recent weight trend is slower than your goal', { exact: true })).toHaveCSS('font-size', '32px');
  const labels = await canvas.locator('text').evaluateAll(elements => elements.map(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
  for (const label of labels) {
    expect(label.left).toBeGreaterThanOrEqual(canvasBox.x - 1);
    expect(label.right).toBeLessThanOrEqual(canvasBox.x + canvasBox.width + 1);
  }
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('progress-200-percent-text.png') });
});

test('Plan check detail navigation preserves recommendation review, apply, and undo', async ({ page, ux }) => {
  await ux.install('populated');
  const scheduledChange = { recommendationId: 7, targetAdjustmentKcal: -150, dailyCalorieBudgetKcal: 1750, effectiveLocalDate: '2026-08-01' };
  let applied = false;
  const mutations: string[] = [];
  await page.route('**/api/v1/calibration/status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(applied
      ? { ...PLAN_CHECK_RECOMMENDATION_STATUS, recommendation: null, scheduledChange }
      : PLAN_CHECK_RECOMMENDATION_STATUS),
  }));
  await page.route('**/api/v1/calibration/recommendations/7/apply', (route) => {
    expect(route.request().method()).toBe('POST');
    mutations.push('apply');
    applied = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scheduledChange) });
  });
  await page.route('**/api/v1/calibration/recommendations/7/cancel', (route) => {
    expect(route.request().method()).toBe('POST');
    mutations.push('cancel');
    applied = false;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAN_CHECK_RECOMMENDATION_STATUS) });
  });
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  await page.getByTestId('plan-check-summary').click();
  await expect(page.getByTestId("expanded-plan")).toBeVisible();
  await page.getByRole('button', { name: 'Review suggested 1,750 calorie daily target', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review calorie target', exact: true });
  await expect(review).toBeVisible();
  expect(mutations).toEqual([]);
  await review.getByRole('button', { name: 'Apply 1,750 kcal', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo scheduled calorie target update', exact: true })).toBeVisible();
  expect(mutations).toEqual(['apply']);
  await page.getByRole('button', { name: "Back to Progress", exact: true }).click();
  await expect(page.getByTestId('plan-check-summary')).toContainText('A calorie target update is scheduled.');
  await page.getByTestId('plan-check-summary').click();
  await page.getByRole('button', { name: 'Undo scheduled calorie target update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review suggested 1,750 calorie daily target', exact: true })).toBeVisible();
  expect(mutations).toEqual(['apply', 'cancel']);
});

test('unavailable calorie plans keep a Plan check destination', async ({ page, ux }) => {
  await ux.install('populated', { caloriePlanFixture: 'requires-review' });
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  const summary = page.getByTestId('plan-check-summary');
  await expect(summary).toContainText('Review your calorie plan to restart this check.');
  await summary.click();
  await expect(page.getByTestId("expanded-plan")).toBeVisible();
});
