/** @file Browser regressions for local-day rollover and date navigation after background suspension. */

import { expect, test, hideTransientPwaNotices } from './fixtures';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', manualClock: true });

async function resumeOnNextDay(page: Page) {
  // Move only the browser clock: the app remains mounted and no timer needs to fire.
  await page.clock.setSystemTime(new Date('2026-07-22T15:00:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
}

test('resume updates the calendar and enables the new day without replacing the selected day', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await page.goto('/today?date=2026-07-21');
  await hideTransientPwaNotices(page);
  const date = page.getByRole('button', { name: 'Choose date', exact: true });
  const next = page.getByRole('button', { name: 'Next day', exact: true });
  await expect(date).toContainText('Today');
  await expect(next).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('before-resume.png') });

  await resumeOnNextDay(page);
  await expect(date).toContainText('Jul 21, 2026');
  await expect(next).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('after-resume.png') });
  await date.click();
  await expect(page.getByRole('button', { name: /Jul 22, 2026, today/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Jul 23, 2026, future date/ })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('updated-calendar.png') });
  await page.getByRole('button', { name: 'Close date picker', exact: true }).click();
  await next.click();
  await expect(date).toContainText('Today');
  await expect(next).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('new-today.png') });
});

test('offline resume updates date bounds without a server response', async ({ page, ux }) => {
  const fixture = await ux.install('populated');
  await page.goto('/today');
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
  await fixture.activateOffline();
  await resumeOnNextDay(page);
  await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toContainText('Jul 21, 2026');
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeEnabled();
});

test('foreground timer crosses midnight without another lifecycle event', async ({ page, ux }) => {
  await ux.install('populated');
  await page.goto('/today');
  const date = page.getByRole('button', { name: 'Choose date', exact: true });
  await expect(date).toContainText('Today');
  // Rearm at 23:59:30 local, then cross midnight using only the foreground timer.
  await page.clock.pauseAt(new Date('2026-07-22T06:59:30Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(30_000);
  await expect(date).toContainText('Jul 21, 2026');
  await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeEnabled();
  await page.clock.resume();
});

test('food draft survives overnight resume and submits to its original date', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Add food', exact: true });
  await sheet.getByRole('radio', { name: 'Quick', exact: true }).click();
  const calories = sheet.getByRole('textbox', { name: 'Calories', exact: true });
  const name = sheet.getByRole('textbox', { name: 'Food name (optional)', exact: true });
  await calories.fill('120');
  await name.fill('Late evening snack');
  await resumeOnNextDay(page);
  await expect(calories).toHaveValue('120');
  await expect(name).toHaveValue('Late evening snack');
  await page.screenshot({ path: testInfo.outputPath('preserved-food-draft.png') });
  const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/food');
  await sheet.getByRole('button', { name: 'Add & close', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({ date: '2026-07-21', name: 'Late evening snack', calories: 120 });
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toContainText('Jul 21, 2026');
});

test('weight draft survives overnight resume and submits to its original date', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByTestId('today-weight-card-press-layer').click();
  const sheet = page.getByRole('dialog', { name: 'Weight entry', exact: true });
  const weight = sheet.getByRole('textbox', { name: 'Weight in kilograms', exact: true });
  await weight.fill('87.9');
  await resumeOnNextDay(page);
  await expect(weight).toHaveValue('87.9');
  await expect(sheet).toContainText('Jul 21, 2026');
  await page.screenshot({ path: testInfo.outputPath('preserved-weight-draft.png') });
  const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/metrics');
  await sheet.getByRole('button', { name: /^(Log|Save) weight$/ }).click();
  expect((await request).postDataJSON()).toMatchObject({ date: '2026-07-21', weight: 87.9 });
});
