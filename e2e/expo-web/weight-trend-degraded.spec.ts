/** @file Regression coverage for weight trend degraded: Trend Details keeps raw measurements visible when the trend estimate is unavailable. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function captureLaunchEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  const viewport = testInfo.project.name === 'desktop-chrome'
    ? 'desktop'
    : testInfo.project.name === 'compact-phone-chrome'
      ? 'compact-phone'
      : null;
  if (!viewport) return;

  const evidenceDir = path.resolve('.codex-screenshots/launch-03');
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, 'weight-trend-unavailable-' + viewport + '.png'),
    fullPage: true,
  });
}

test('Trend Details keeps raw measurements visible when the trend estimate is unavailable', async ({ page, ux }, testInfo) => {
  await ux.install('populated', { trendAvailability: 'unavailable' });
  await page.goto('/weight-trend');

  const unavailable = page.getByTestId('weight-trend-unavailable');
  await expect(unavailable.getByText('Trend estimate temporarily unavailable', { exact: true })).toBeVisible();
  await expect(unavailable.getByText(
    'Your scale readings are still shown. Try again later for the underlying trend.',
    { exact: true },
  )).toBeVisible();

  await expect(page.getByTestId('weight-trend-chart')).toBeVisible();
  await expect(page.getByTestId('weight-trend-smoothed-path-0')).toHaveCount(0);
  await expect(page.getByTestId('weight-trend-range-0')).toHaveCount(0);
  const legend = page.getByLabel('Chart legend');
  await expect(legend.getByText('Scale reading', { exact: true })).toBeVisible();
  await expect(legend.getByText('Underlying trend', { exact: true })).toBeVisible();
  await expect(legend.getByText('95% estimate range', { exact: true })).toBeVisible();

  for (const label of ['Week', 'Month', 'Year', 'All']) {
    const box = await page.getByText(label, { exact: true }).boundingBox();
    expect(box?.height).toBeLessThan(30);
  }

  const selected = page.getByTestId('selected-trend-summary');
  await expect(selected.getByText('88.2 kg', { exact: true })).toBeVisible();
  await expect(selected.getByText(
    'The underlying trend is temporarily unavailable, but this scale reading is saved.',
    { exact: true },
  )).toBeVisible();

  await expectNoHorizontalOverflow(page);
  await captureLaunchEvidence(page, testInfo);
});
