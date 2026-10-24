/** @file Regression coverage for nested route stacks: signed-in legal pages retain Settings navigation without the history shortcut. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, expectApiFailure, hideTransientPwaNotices, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-07');

for (const missing of ['/notifications', '/notifications?cursor=old#history', '/notifications/obsolete', '/missing/deep/page?stale=true#section']) {
  test(`unknown address ${missing} replaces itself with Today without a history loop`, async ({ page, ux }) => {
    await ux.install('populated');
    const historyRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.searchParams.get('view') === 'history' || url.pathname.endsWith('/notifications/in-app/read-all')) {
        historyRequests.push(request.url());
      }
    });
    await page.goto('/progress');
    await expect(page.locator('#route-focus-title')).toHaveText('Progress');
    expectApiFailure(page, { method: 'GET', pathname: new URL(missing, 'http://localhost').pathname, status: 404 });
    await page.goto(missing);
    await expect(page).toHaveURL((url) => url.pathname === '/today' && !url.search && !url.hash);
    await expect(page).toHaveTitle('Today - Calibrate');
    await expect(page.getByTestId('notification-history')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('notifications-button')).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    for (let count = 0; count < 2; count += 1) {
      await page.goBack();
      await expect(page.getByTestId('notifications-button')).toBeVisible();
      await expect(page.locator('#route-focus-title')).toHaveText('Progress');
      await expect(page).toHaveURL((url) => url.pathname === '/progress');
      await page.goForward();
      await expect(page.getByTestId('notifications-button')).toBeVisible();
      await expect(page.locator('#route-focus-title')).toHaveText('Today');
      await expect(page).toHaveURL((url) => url.pathname === '/today');
    }
    expect(historyRequests).toEqual([]);
  });
}

test('signed-in legal pages retain Settings navigation without the history shortcut', async ({ page, ux }) => {
  await ux.install('populated');
  for (const route of ['/privacy', '/terms']) {
    await page.goto(route);
    const header = page.getByTestId('legal-app-header');
    await expect(header.getByRole('button', { name: 'Open notifications' })).toHaveCount(0);
    await header.getByRole('button', { name: 'Account & settings', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === route);
    await header.getByRole('button', { name: 'Back to Settings', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
  }
});

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectFocusedRouteTitle(page: Page, title: string, documentTitle: string) {
  const heading = page.locator('#route-focus-title');
  await expect(heading).toHaveText(title);
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle(documentTitle);
}

async function expectDirectEntryTitle(page: Page, title: string, documentTitle: string) {
  const heading = page.locator('#route-focus-title');
  await expect(heading).toHaveText(title);
  await expect(heading).not.toBeFocused();
  await expect(page).toHaveTitle(documentTitle);
}

async function capture(page: Page, filename: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, filename),
    fullPage: false,
  });
}

test('Trend keeps the app shell and browser Back collapses into Progress', async ({ page, ux }) => {
  await page.setViewportSize({ width: 1_024, height: 1_000 });
  await ux.install('populated');
  await page.goto('/progress');
  await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: 'Open full weight trend', exact: true }).click();

  await expect(page).toHaveURL((url) => url.pathname === '/progress');
  await expect(page.getByRole('button', { name: 'Back to Progress', exact: true })).toBeFocused();
  await expect(page.locator('#route-focus-title')).toHaveText('Progress');
  await expect(page.getByRole('button', { name: 'Open notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account & settings', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, 'trend-desktop-1024x1000.png');

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/progress');
  await expect(page.getByTestId('expanded-trend')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open full weight trend', exact: true })).toBeFocused();
  await page.goForward();
  await expect(page.getByTestId('expanded-trend')).toBeVisible();
});

test('Activity direct entry falls back to its registered Connections parent', async ({ page, ux }) => {
  await page.setViewportSize({ width: 1_024, height: 1_000 });
  await ux.install('populated');
  await page.goto('/activity');

  await expectDirectEntryTitle(page, 'Activity', 'Activity - Calibrate');
  await expect(page.getByRole('button', { name: 'Back to Connections', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open notifications' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, 'activity-desktop-1024x1000.png');

  await page.getByRole('button', { name: 'Back to Connections', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/connections');
  await expectFocusedRouteTitle(page, 'Connections', 'Connections - Calibrate');
});

test('Food log returns to Today with browser Back on a compact phone', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: /Food log\..*View full log/ }).click();

  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await expect(page.getByRole('button', { name: 'Back to Today', exact: true })).toBeFocused();
  await expect(page.locator('#route-focus-title')).toHaveText('Today');
  await expectNoHorizontalOverflow(page);
  await capture(page, 'food-log-phone-320x568.png');

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await expect(page.getByTestId('expanded-food')).toHaveCount(0);
});

test('Saved Foods is discoverable from Settings and returns through real history', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await page.goto('/settings');
  await page.getByTestId('settings-open-data').click();
  await expect(page).toHaveURL((url) => url.pathname === '/data');
  await page.getByRole('button', { name: 'Saved foods', exact: true }).click();

  await expect(page).toHaveURL((url) => url.pathname === '/my-foods');
  await expectFocusedRouteTitle(page, 'Saved foods', 'Saved foods - Calibrate');
  await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, 'saved-foods-phone-320x568.png');

  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/data');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/settings');
});

test('signed-in unknown addresses automatically open Today on a compact phone', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  expectApiFailure(page, { method: 'GET', pathname: '/missing-signed-in-page', status: 404 });
  await page.goto('/missing-signed-in-page');

  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await expectFocusedRouteTitle(page, 'Today', 'Today - Calibrate');
});

test('signed-out unknown addresses automatically reach sign-in on a compact phone', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('signed-out');
  expectApiFailure(page, { method: 'GET', pathname: '/missing-signed-out-page', status: 404 });
  expectApiFailure(page, { method: 'POST', pathname: '/auth/login', status: 401 });
  await page.route('**/auth/login', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({
      message: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
      retryable: false,
      request_id: 'fixture-signed-out',
    }),
  }));
  await page.goto('/missing-signed-out-page');

  await expect(page).toHaveURL((url) => url.pathname === '/login');
  await expect(page.getByTestId('notifications-button')).toHaveCount(0);
});
