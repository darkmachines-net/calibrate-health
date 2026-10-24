/** @file Regression coverage for async state: a failed Today resource never becomes an empty state and Retry is resource-scoped. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

const CORE_RESOURCE_PATHS = [
  '/api/v1/food',
  '/api/v1/food-days',
  '/api/v1/metrics',
  '/api/v1/user/profile',
] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function captureLaunchEvidence(page: Page, testInfo: TestInfo, state: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  const viewport = testInfo.project.name === 'desktop-chrome'
    ? 'desktop'
    : testInfo.project.name === 'compact-phone-chrome'
      ? 'compact-phone'
      : null;
  if (!viewport) return;

  const evidenceDir = path.resolve('.codex-screenshots/launch-02');
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, `${state}-${viewport}.png`),
    fullPage: true,
  });
}

test('a failed Today resource never becomes an empty state and Retry is resource-scoped', async ({ page, ux }, testInfo) => {
  await ux.install('failed-request');
  await page.goto('/today');

  await expect(page.getByText("Can't load today's log", { exact: true })).toBeVisible();
  await expect(page.getByText("No food logged yet", { exact: true })).toHaveCount(0);
  await expect(page.getByText('Day unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Food log unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeDisabled();
  await expect(page.getByText(/provider details that must stay private/)).toHaveCount(0);
  await captureLaunchEvidence(page, testInfo, 'today-error');

  const retriedPaths: string[] = [];
  const captureRequest = (request: { url(): string }) => {
    const pathname = new URL(request.url()).pathname;
    if ((CORE_RESOURCE_PATHS as readonly string[]).includes(pathname)) retriedPaths.push(pathname);
  };
  page.on('request', captureRequest);
  const retryResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/v1/food' && response.status() === 503
  ));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await retryResponse;
  page.off('request', captureRequest);

  expect(retriedPaths).toEqual(['/api/v1/food']);
  await expectNoHorizontalOverflow(page);
});

test('a failed refresh keeps cached food usable and labels it degraded', async ({ page, ux }, testInfo) => {
  await ux.install('stale');
  await page.goto('/today');
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Food log.*View full log/ }).click();
  await expect(page.getByTestId('expanded-food')).toBeVisible();
  await expect(page.getByText("Couldn't refresh food log", { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Food log', exact: true })).toBeVisible();
  await expect(page.getByText(/provider details that must stay private/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureLaunchEvidence(page, testInfo, 'food-log-degraded');
});

test('offline cached Today content stays visible and is explicitly labeled stale', async ({ page, ux }) => {
  const controller = await ux.install('offline');
  await page.goto('/today');
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();

  await controller.activateOffline();
  await expect(page.getByText("You're offline", { exact: true })).toBeVisible();
  const savedInformationNotice = page.getByText('Offline - showing saved information', { exact: true });
  await expect(savedInformationNotice).toHaveCount(1);
  await expect(savedInformationNotice).toBeVisible();
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('an uncached offline day shows connection guidance without Retry or empty reassurance', async ({ page, ux }) => {
  const controller = await ux.install('offline');
  await page.goto('/today');
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();

  await controller.activateOffline();
  // The immediately previous day is intentionally prefetched; the second is uncached.
  await page.getByRole('button', { name: 'Previous day', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Previous day', exact: true }).press('Enter');

  const terminalState = page.getByTestId('async-state-error');
  await expect(terminalState.getByText("You're offline", { exact: true })).toBeVisible();
  await expect(terminalState.getByText(
    "Connect to the internet to load today's log.",
    { exact: true },
  )).toBeVisible();
  await expect(terminalState.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.getByText("No food logged yet", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
