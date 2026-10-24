/** @file Regression coverage for calorie safety: server-unavailable options expose disabled semantics and safe reason copy. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';
import { advanceOnboardingToPlan, goalPaceOption, installOnboardingAccount } from './onboarding.fixture';

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectFullyWithinViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function captureEvidence(
  page: Page,
  testInfo: TestInfo,
  names: Partial<Record<'desktop-chrome' | 'compact-phone-chrome', string>>,
  prepareDesktopCapture?: () => Promise<void>,
) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const name = names[testInfo.project.name as keyof typeof names];
  if (!name) return;
  const evidenceDir = path.resolve('.codex-screenshots/launch-04');
  await mkdir(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, name);
  if (testInfo.project.name === 'desktop-chrome') {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Desktop evidence requires a configured viewport.');
    await page.setViewportSize({ width: 1_024, height: 1_000 });
    await prepareDesktopCapture?.();
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await page.setViewportSize(viewport);
    return;
  }
  await page.screenshot({ path: screenshotPath, fullPage: false });
}

test('server-unavailable options expose disabled semantics and safe reason copy', async ({ page, ux }, testInfo) => {
  await ux.install('populated', { caloriePlanFixture: 'selected-options-unavailable' });
  await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await advanceOnboardingToPlan(page);
  await page.getByRole('radiogroup', { name: 'Goal direction', exact: true })
    .getByRole('radio', { name: 'Lose', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill('82');

  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeDisabled();
  const unsafeOption = goalPaceOption(page, 500);
  await expect(unsafeOption).toBeVisible();
  await expect(unsafeOption).toBeDisabled();
  await expect(unsafeOption).toContainText(
    'This choice would put the daily target below the server-calculated safety minimum.',
  );
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo, {
    'desktop-chrome': 'plan-options-desktop.png',
  });
  await goalPaceOption(page, 250).click();
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeEnabled();
});

test('reviewed plans keep history while suppressing target, projection, and calibration', async ({ page, ux }, testInfo) => {
  await ux.install('populated', { caloriePlanFixture: 'requires-review' });
  await page.goto('/today');

  await expect(page.getByText('Review calorie plan', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Plan needs review', { exact: true })).toBeVisible();
  await expect(page.getByTestId('today-food-preview').getByTestId('food-preview-meal-BREAKFAST').getByText('360 kcal', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Daily balance\./)).toHaveAccessibleName(
    'Daily balance. Plan needs review. 360 calories logged.',
  );
  await expect(page.getByTestId('calorie-balance-value')).toHaveCount(0);
  await expect(page.getByTestId('calorie-gauge-progress')).toHaveCount(0);
  await expect(page.getByText('0%', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo, {
    'desktop-chrome': 'unsafe-plan-review-desktop.png',
    'compact-phone-chrome': 'unsafe-plan-review-compact-phone.png',
  }, async () => {
    await expectNoHorizontalOverflow(page);
    await expectFullyWithinViewport(page, page.getByTestId('today-food-preview'));
    await expectFullyWithinViewport(page, page.getByTestId('today-weight-card-press-layer'));
    await expectFullyWithinViewport(page, page.getByRole('button', { name: 'Add food', exact: true }));
  });

  await page.goto('/progress');
  await expect(page.getByText('88.2 kg', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Nov 20, 2026', { exact: true })).toHaveCount(0);
  await expect(page.getByText('See how your calorie plan is working', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('safe server options keep maintenance goal editing functional', async ({ page, ux }) => {
  await ux.install('populated', { caloriePlanFixture: 'available' });
  await page.goto('/progress');

  await expect(page.getByText('Nov 20, 2026', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
  const editor = page.getByRole('dialog').filter({ hasText: 'Set a new goal' });
  await editor.getByRole('radio', { name: 'Maintain', exact: true }).click();
  await expect(editor.getByText('Maintenance goals use a steady calorie target with no daily deficit or surplus.')).toBeVisible();
  await expect(editor.getByText(/Server target: 2,600 kcal\/day/)).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save goal', exact: true })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
});
