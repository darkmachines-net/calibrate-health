/** @file Regression coverage for launch 15 progress trend: Progress and Trend explain fresh, stale, gapped, and raw-only weight history. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-15');
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

type TrendRange = 'week' | 'month' | 'year' | 'all';
type MonthFreshness = 'current' | 'stale' | 'outdated';

type TrendMetric = {
  id: number;
  user_id: number;
  date: string;
  weight: number;
  body_fat_percent: null;
  trend_is_materialized: boolean;
  trend_weight: number;
  trend_ci_lower: number;
  trend_ci_upper: number;
  trend_std: number;
  trend_segment_start?: boolean;
};

type TrendFixture = {
  monthFreshness: MonthFreshness;
};

const MODELED_MONTH_METRICS: TrendMetric[] = [
  metric(101, '2026-06-20', 90, 89.7, { segmentStart: true }),
  metric(102, '2026-06-21', 89.6, 89.5),
  metric(103, '2026-07-16', 88.8, 88.6, { segmentStart: true }),
  metric(104, '2026-07-18', 88.2, 88.4),
];

const STALE_WEEK_METRICS: TrendMetric[] = [
  metric(201, '2026-07-10', 89.1, 88.9),
  metric(202, '2026-07-11', 88.9, 88.8),
];

const OUTDATED_MONTH_METRICS: TrendMetric[] = [
  metric(301, '2026-06-30', 89.5, 89.2),
  metric(302, '2026-07-01', 89.2, 89),
];

const RAW_ONLY_HISTORY = metric(1, '2025-01-02', 94.2, 94.2, { materialized: false });

function metric(
  id: number,
  date: string,
  weight: number,
  trendWeight: number,
  options: { materialized?: boolean; segmentStart?: boolean } = {},
): TrendMetric {
  const materialized = options.materialized ?? true;
  return {
    id,
    user_id: 17,
    date,
    weight,
    body_fat_percent: null,
    trend_is_materialized: materialized,
    trend_weight: materialized ? trendWeight : weight,
    trend_ci_lower: materialized ? trendWeight - 0.4 : weight,
    trend_ci_upper: materialized ? trendWeight + 0.4 : weight,
    trend_std: materialized ? 0.2 : 0,
    ...(options.segmentStart ? { trend_segment_start: true } : {}),
  };
}

function trendSummary(
  freshness: MonthFreshness,
  metrics: TrendMetric[],
  options: { modeledStartDate?: string | null } = {},
) {
  const latest = [...metrics].sort((left, right) => left.date.localeCompare(right.date)).at(-1)!;
  const modeled = metrics.filter((entry) => entry.trend_is_materialized);
  const latestModeled = [...modeled].sort((left, right) => left.date.localeCompare(right.date)).at(-1);
  const daysSinceLatest = freshness === 'current' ? 3 : freshness === 'stale' ? 10 : 20;
  return {
    status: freshness === 'stale' ? 'stale' : 'sufficient',
    evidence: 'sufficient',
    freshness,
    model_version: 2,
    as_of_date: latest.date,
    scope_start_date: metrics[0].date,
    scope_end_date: latest.date,
    latest_observation_date: latest.date,
    days_since_latest: daysSinceLatest,
    modeled_start_date: options.modeledStartDate ?? modeled[0]?.date ?? null,
    latest_trend: latestModeled ? {
      weight: latestModeled.trend_weight,
      lower: latestModeled.trend_ci_lower,
      upper: latestModeled.trend_ci_upper,
    } : null,
    weekly_rate: {
      estimate: -0.25,
      lower: -0.5,
      upper: 0,
      point_count: modeled.length,
      span_days: 28,
      evidence: 'provisional',
    },
    short_term_variation: {
      standard_deviation: 0.2,
      central_80_half_width: 0.3,
    },
    returned_points: metrics.length,
    modeled_points: modeled.length,
    modeled_observations: modeled.length,
    returned_modeled_points: modeled.length,
    observation_span_days: 28,
    segment_start_date: modeled[0]?.date ?? null,
    interval_kind: 'latent_weight_model_uncertainty',
    confidence_level: 0.95,
  };
}

function trendResponse(range: TrendRange, monthFreshness: MonthFreshness) {
  let metrics = MODELED_MONTH_METRICS;
  let freshness = monthFreshness;
  let modeledStartDate: string | null | undefined;

  if (range === 'week') {
    metrics = STALE_WEEK_METRICS;
    freshness = 'stale';
  } else if (range === 'year' || range === 'all') {
    metrics = [RAW_ONLY_HISTORY, ...MODELED_MONTH_METRICS];
    freshness = 'current';
    modeledStartDate = MODELED_MONTH_METRICS[0].date;
  } else if (monthFreshness === 'outdated') {
    metrics = OUTDATED_MONTH_METRICS;
  } else if (monthFreshness === 'stale') {
    metrics = STALE_WEEK_METRICS;
  }

  return {
    metrics,
    meta: {
      weekly_rate: -0.25,
      volatility: 'low',
      total_points: metrics.length,
      total_span_days: range === 'all' ? 563 : 28,
      trend_summary: trendSummary(freshness, metrics, { modeledStartDate }),
    },
  };
}

async function installTrendFixture(page: Page): Promise<TrendFixture> {
  const fixture: TrendFixture = { monthFreshness: 'current' };
  await page.route('**/api/v1/metrics**', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('include_trend') !== 'true') return route.fallback();
    const requestedRange = url.searchParams.get('range');
    const range: TrendRange = requestedRange === 'week'
      || requestedRange === 'year'
      || requestedRange === 'all'
      ? requestedRange
      : 'month';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trendResponse(range, fixture.monthFreshness)),
    });
  });
  return fixture;
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function hideTransientPwaNotices(page: Page) {
  await page.locator('[role="status"], [role="alert"]').evaluateAll((notices, titles) => {
    for (const notice of notices) {
      const text = notice.textContent ?? '';
      if ((titles as string[]).some((title) => text.includes(title))) {
        (notice as HTMLElement).style.display = 'none';
      }
    }
  }, [...TRANSIENT_PWA_TITLES]);
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = testInfo.project.name === 'desktop-chrome'
    ? 'trend-details-desktop-1024x1000.png'
    : testInfo.project.name === 'compact-phone-chrome'
      ? 'trend-details-phone-320x568.png'
      : null;
  if (!filename) return;

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await hideTransientPwaNotices(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

test('Progress and Trend explain fresh, stale, gapped, and raw-only weight history', async ({ page, ux }, testInfo) => {
  if (testInfo.project.name === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
  } else if (testInfo.project.name === 'compact-phone-chrome') {
    await page.setViewportSize({ width: 320, height: 568 });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  const trendFixture = await installTrendFixture(page);

  await page.goto('/progress');
  await expect(page.locator('#route-focus-title')).toHaveText('Progress');
  await expect(page.getByText('Current weight', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Goal date at selected pace', { exact: true })).toBeVisible();
  await expect(page.getByTestId('trend-preview-heading-line')).toContainText('Trend');
  await expect(page.getByTestId('trend-preview-heading-line')).toContainText(
    '88.4 kg underlying trend',
  );
  await expect(page.getByLabel('Four-week underlying weight trend with scale readings and 95% estimated range')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Open full weight trend', exact: true }).click();
  await expect(page.getByTestId('expanded-trend')).toBeVisible();
  await expect(page.locator('#route-focus-title')).toHaveText('Progress');

  const chartCanvas = page.getByTestId('weight-trend-chart-canvas');
  const chartBox = await chartCanvas.boundingBox();
  const viewport = page.viewportSize();
  expect(chartBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  const desktopChart = viewport!.width >= 840;
  expect(chartBox!.height).toBeGreaterThanOrEqual(desktopChart ? 260 : 188);
  expect(chartBox!.height).toBeLessThan(viewport!.height);
  expect(chartBox!.width).toBeLessThanOrEqual(viewport!.width);

  const selectedSummary = page.getByTestId('selected-trend-summary');
  await expect(selectedSummary).toContainText('Jul 18, 2026');
  await expect(selectedSummary).toContainText('Underlying weight estimate');
  await expect(selectedSummary).toContainText('88.4 kg');
  await expect(selectedSummary).toContainText('95% trend range 88 kg - 88.8 kg');
  await expect(selectedSummary).toContainText('Scale reading');
  await expect(selectedSummary).toContainText('88.2 kg');
  await expect(page.getByRole('button', { name: 'Next weigh-in', exact: true })).toBeDisabled();

  const legend = page.getByTestId('expanded-trend').getByLabel('Chart legend');
  await expect(legend.getByText('Scale reading', { exact: true })).toBeVisible();
  await expect(legend.getByText('Underlying trend', { exact: true })).toBeVisible();
  await expect(legend.getByText('95% estimate range', { exact: true })).toBeVisible();
  await expect(page.getByTestId('expanded-trend').getByTestId('weight-trend-smoothed-path-0')).toBeVisible();
  await expect(page.getByTestId('expanded-trend').getByTestId('weight-trend-smoothed-path-1')).toBeVisible();
  await expect(page.getByTestId('expanded-trend').getByTestId('weight-trend-range-0')).toBeVisible();
  await expect(page.getByTestId('expanded-trend').getByTestId('weight-trend-range-1')).toBeVisible();
  await expect(page.getByText('Current pace estimate', { exact: true })).toBeHidden();
  await expect(page.getByText('Goal date at selected pace', { exact: true })).toBeHidden();
  await captureEvidence(page, testInfo);

  await selectedSummary.scrollIntoViewIfNeeded();
  await hideTransientPwaNotices(page);
  const summaryBeforeHelp = await selectedSummary.boundingBox();
  const help = page.getByRole('button', { name: 'About the 95% trend range', exact: true });
  await help.click();
  await expect(page.getByTestId('trend-range-tooltip')).toContainText(
    'This range shows uncertainty in the estimate, not expected scale readings.',
  );
  const summaryAfterHelp = await selectedSummary.boundingBox();
  expect(summaryAfterHelp?.height).toBe(summaryBeforeHelp?.height);
  expect(summaryAfterHelp?.width).toBe(summaryBeforeHelp?.width);

  const chartKeyboardTarget = page.getByRole('button', { name: 'Select nearest weigh-in', exact: true });
  await chartKeyboardTarget.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(selectedSummary).toContainText('Jul 16, 2026');
  await expect(page.getByTestId('weight-trend-selection-announcement')).toContainText('Selected Jul 16, 2026');
  await page.keyboard.press('ArrowRight');
  await expect(selectedSummary).toContainText('Jul 18, 2026');
  await page.keyboard.press('Home');
  await expect(selectedSummary).toContainText('Jun 20, 2026');
  await page.keyboard.press('End');
  await expect(selectedSummary).toContainText('Jul 18, 2026');
  await page.getByRole('button', { name: 'Previous weigh-in', exact: true }).click();
  await expect(selectedSummary).toContainText('Jul 16, 2026');
  await page.getByRole('button', { name: 'Next weigh-in', exact: true }).click();
  await expect(selectedSummary).toContainText('Jul 18, 2026');

  await hideTransientPwaNotices(page);
  await page.getByText('All', { exact: true }).click();
  await expect(page.getByTestId('weight-trend-model-boundary')).toHaveCount(1);
  await expect(page.getByText(
    'Smoothed trend starts Jun 20, 2026. Earlier dots are measurements only.',
    { exact: true },
  )).toBeVisible();
  await chartKeyboardTarget.focus();
  await page.keyboard.press('Home');
  await expect(selectedSummary).toContainText('Jan 2, 2025');
  await expect(selectedSummary).toContainText('This older point has no underlying trend estimate.');
  await expect(selectedSummary).not.toContainText('95% trend range');
  await expect(legend.getByText('Underlying trend', { exact: true })).toBeVisible();
  await expect(legend.getByText('95% estimate range', { exact: true })).toBeVisible();

  await hideTransientPwaNotices(page);
  await page.getByText('Week', { exact: true }).click();
  await expect(selectedSummary).toContainText('Jul 11, 2026');
  await expect(selectedSummary).toContainText('Based on an older weigh-in');
  await expect(selectedSummary).not.toContainText('Current underlying trend');

  await hideTransientPwaNotices(page);
  await page.getByText('Month', { exact: true }).click();
  await expect(selectedSummary).toContainText('Jul 18, 2026');
  await page.getByRole('button', { name: 'Back to Progress', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/progress');
  await expect(page.locator('#route-focus-title')).toHaveText('Progress');

  trendFixture.monthFreshness = 'stale';
  await page.reload();
  await expect(page.getByTestId('trend-preview-heading-line')).toContainText(
    'Underlying trend: 88.8 kg | As of Jul 11',
  );
  await expect(page.getByTestId('trend-preview-heading-line')).not.toContainText('Current underlying trend');
  await expect(page.getByRole('button', { name: 'Log weight', exact: true })).toHaveCount(0);

  trendFixture.monthFreshness = 'outdated';
  await page.reload();
  await expect(page.getByTestId('trend-preview-heading-line')).toContainText(
    'Estimate out of date | Last scale weight Jul 1',
  );
  await expect(page.getByText(
    'Log a current scale weight to refresh the underlying trend estimate.',
    { exact: true },
  )).toBeVisible();
  await expect(page.getByLabel('Four-week underlying weight trend with scale readings and 95% estimated range')).toHaveCount(0);
  await page.getByRole('button', { name: 'Log weight', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
  await expectNoHorizontalOverflow(page);
});
