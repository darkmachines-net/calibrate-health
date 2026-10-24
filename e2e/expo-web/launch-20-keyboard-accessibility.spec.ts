/** @file Regression coverage for launch 20 keyboard accessibility: critical web flows remain keyboard-operable across forced colors, reflow, and chart alternatives. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-20');
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

async function focusWithKeyboard(page: Page, target: Locator, maximumTabs = 160) {
  await expect(target).toBeVisible();
  for (let index = 0; index < maximumTabs; index += 1) {
    if (await target.evaluate((node) => node === document.activeElement || node.contains(document.activeElement))) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard focus did not reach ${await target.evaluate((node) => node.outerHTML.slice(0, 240))}`);
}

async function activateWithKeyboard(page: Page, target: Locator) {
  await focusWithKeyboard(page, target);
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
}

async function expectRouteFocus(page: Page, title: string) {
  const routeTitle = page.locator('#route-focus-title');
  await expect(routeTitle).toHaveRole('heading');
  await expect(routeTitle).toHaveText(title);
  await expect(routeTitle).toBeFocused();
  await expect(page.locator('[role="main"]:visible')).toHaveCount(1);
}

async function expectDirectEntryKeepsSkipLinkFirst(page: Page, title: string) {
  const routeTitle = page.locator('#route-focus-title');
  await expect(routeTitle).toHaveText(title);
  await expect(page.locator('[role="main"]:visible')).toHaveCount(1);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(await routeTitle.evaluate((node) => node === document.activeElement)).toBe(false);

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('button', { name: 'Skip to main content', exact: true });
  await expect(skipLink).toBeVisible();
  await expect(skipLink).toBeFocused();
}

async function expectNoDuplicateIds(page: Page) {
  const duplicates = await page.evaluate(() => {
    const counts = new Map<string, number>();
    for (const node of document.querySelectorAll<HTMLElement>('[id]')) {
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 1);
  });
  expect(duplicates).toEqual([]);
}

async function expectOneDimensionalReflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const horizontalDocumentOverflow = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - viewportWidth;
    const twoDimensionalScrollers = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((node) => node.getClientRects().length > 0)
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const scrollsX = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 2;
        const scrollsY = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
        return scrollsX && scrollsY;
      })
      .map((node) => ({
        testId: node.getAttribute('data-testid'),
        role: node.getAttribute('role'),
        tag: node.tagName,
      }));
    return { horizontalDocumentOverflow, twoDimensionalScrollers };
  });
  expect(result.horizontalDocumentOverflow).toBeLessThanOrEqual(1);
  expect(result.twoDimensionalScrollers).toEqual([]);
}

async function simulateTwoHundredPercentText(page: Page) {
  return page.evaluate(() => {
    let scaled = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const hasDirectText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      if (!hasDirectText || element.dataset.launch20TextScaled === 'true') continue;
      const computed = window.getComputedStyle(element);
      const fontSize = Number.parseFloat(computed.fontSize);
      if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
      element.style.fontSize = `${fontSize * 2}px`;
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (Number.isFinite(lineHeight) && lineHeight > 0) {
        element.style.lineHeight = `${lineHeight * 2}px`;
      }
      element.dataset.launch20TextScaled = 'true';
      scaled += 1;
    }
    return scaled;
  });
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

async function captureEvidence(page: Page, testInfo: TestInfo, filename: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  await page.evaluate(() => document.fonts.ready);
  await hideTransientPwaNotices(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
  if (testInfo.project.name === 'desktop-chrome') {
    expect(page.viewportSize()).toEqual({ width: 1_024, height: 1_000 });
  } else {
    expect(testInfo.project.name).toBe('compact-phone-chrome');
    expect(page.viewportSize()).toEqual({ width: 320, height: 568 });
  }
}

test('critical web flows remain keyboard-operable across forced colors, reflow, and chart alternatives', async (
  { page, ux },
  testInfo,
) => {
  const project = testInfo.project.name;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  if (project === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', forcedColors: 'active' });
    await ux.install('signed-out');

    await page.goto('/');
    expect(await page.evaluate(() => window.matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(page.getByTestId('hosted-landing')).toBeVisible();
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('button', { name: 'Skip to main content', exact: true });
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press('Enter');
    const main = page.locator('[role="main"]:visible');
    expect(await main.evaluate((node) => node === document.activeElement)).toBe(true);

    const landingSignIn = page.getByTestId('hosted-landing-actions').getByRole('link', { name: 'Sign in' });
    await activateWithKeyboard(page, landingSignIn);
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await expectRouteFocus(page, 'calibrate');
    await expect(page.getByRole('img', { name: /calibrate/i })).toHaveCount(0);

    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    await focusWithKeyboard(page, email);
    await page.keyboard.type('release@example.invalid');
    const password = page.getByLabel('Password', { exact: true });
    await focusWithKeyboard(page, password);
    await page.keyboard.type('not-the-password');
    const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    await focusWithKeyboard(page, signIn);
    const focusStyle = await signIn.evaluate((node) => {
      const style = window.getComputedStyle(node);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineStyle).toBe('solid');
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
    await expectOneDimensionalReflow(page);
    await expectNoDuplicateIds(page);
    await captureEvidence(page, testInfo, 'keyboard-forced-colors-auth-desktop-1024x1000.png');

    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Use HTTPS for this server.');
    return;
  }

  await ux.install('populated');

  if (project === 'tablet-chrome') {
    await page.goto('/today');
    await expectDirectEntryKeepsSkipLinkFirst(page, 'Today');

    const addFood = page.getByRole('button', { name: 'Add food', exact: true });
    await activateWithKeyboard(page, addFood);
    const addFoodDialog = page.getByRole('dialog', { name: 'Add food', exact: true });
    await expect(addFoodDialog).toBeVisible();
    await expect(addFoodDialog.getByRole('radiogroup', { name: 'Add food method' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addFoodDialog).toHaveCount(0);
    await expect(addFood).toBeFocused();

    const weightCard = page.getByTestId('today-weight-card-press-layer');
    await activateWithKeyboard(page, weightCard);
    const weightDialog = page.getByRole('dialog', { name: 'Weight entry', exact: true });
    await expect(weightDialog).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
    await page.keyboard.press('Escape');
    await expect(weightDialog).toHaveCount(0);
    await expect(weightCard).toBeFocused();
    await expectOneDimensionalReflow(page);
    await expectNoDuplicateIds(page);
    return;
  }

  if (project === 'android-phone-chrome') {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/progress');
    await expectDirectEntryKeepsSkipLinkFirst(page, 'Progress');
    await expect(page.getByRole('progressbar', { name: 'Goal progress', exact: true })).toHaveAttribute('aria-valuenow');

    const openTrend = page.getByRole('button', { name: 'Open full weight trend', exact: true });
    await activateWithKeyboard(page, openTrend);
    await expect(page.getByTestId('expanded-trend')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Progress', exact: true })).toBeFocused();

    const chart = page.getByRole('img', { name: /^Weight chart from/ });
    await expect(chart).toHaveCount(1);
    await expect(chart).toHaveAccessibleName(/Latest smoothed weight 88\.4 kg\. 95% estimated trend range 88 kg - 88\.8 kg\./);
    const chartKeyboardTarget = page.getByRole('button', { name: 'Select nearest weigh-in', exact: true });
    await focusWithKeyboard(page, chartKeyboardTarget);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('weight-trend-selection-announcement')).toContainText('Selected Jul 11, 2026');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('selected-trend-summary')).toContainText('Jul 4, 2026');
    await page.keyboard.press('End');
    await expect(page.getByTestId('selected-trend-summary')).toContainText('Jul 18, 2026');

    await expectOneDimensionalReflow(page);
    await expectNoDuplicateIds(page);
    return;
  }

  expect(project).toBe('compact-phone-chrome');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/weight-trend');
  await expectDirectEntryKeepsSkipLinkFirst(page, 'Trend');
  await expect(page.getByRole('button', { name: 'View data table', exact: true })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^Weight chart from/ })).toHaveCount(1);
  expect(await simulateTwoHundredPercentText(page)).toBeGreaterThan(10);
  await expectOneDimensionalReflow(page);

  await page.route('**/auth/sessions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [] }),
  }));
  const restoredSession = page.waitForResponse((response) => new URL(response.url()).pathname === '/auth/me');
  await page.goto('/settings');
  const { user } = await (await restoredSession).json();
  await page.route('**/api/v1/user/preferences', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ user: { ...user, ...route.request().postDataJSON() } }),
  }));
  await expectDirectEntryKeepsSkipLinkFirst(page, 'Settings');
  await activateWithKeyboard(page, page.getByTestId('settings-open-profile'));
  await expect(page).toHaveURL((url) => url.pathname === '/profile');
  const preferences = page.getByTestId('settings-open-preferences');
  await activateWithKeyboard(page, preferences);
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  await expectRouteFocus(page, 'Preferences');
  const preferencesPage = page.getByTestId('settings-preferences-page');
  await expect(preferencesPage).toBeVisible();
  const weightUnit = preferencesPage.getByRole('radiogroup', { name: 'Weight unit', exact: true });
  await expect(weightUnit).toHaveAttribute('aria-orientation', 'horizontal');
  const kilograms = weightUnit.getByRole('radio', { name: 'kg', exact: true });
  const pounds = weightUnit.getByRole('radio', { name: 'lb', exact: true });
  await focusWithKeyboard(page, kilograms);
  await page.keyboard.press('ArrowRight');
  await expect(pounds).toBeFocused();
  await expect(pounds).toBeChecked();
  await page.keyboard.press('Home');
  await expect(kilograms).toBeFocused();
  await expect(kilograms).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(pounds).toBeFocused();
  await expect(pounds).toBeChecked();
  expect(await simulateTwoHundredPercentText(page)).toBeGreaterThan(10);
  const pageBox = await preferencesPage.boundingBox();
  expect(pageBox).not.toBeNull();
  expect(pageBox!.x).toBeGreaterThanOrEqual(0);
  expect(pageBox!.x + pageBox!.width).toBeLessThanOrEqual(320);
  await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true');
  await expectOneDimensionalReflow(page);
  await expectNoDuplicateIds(page);
  await captureEvidence(page, testInfo, 'settings-preferences-keyboard-200-percent-phone-320x568.png');

  const preferenceUpdate = page.waitForRequest((request) => (
    new URL(request.url()).pathname === '/api/v1/user/preferences' && request.method() === 'PATCH'
  ));
  await activateWithKeyboard(page, preferencesPage.getByRole('button', { name: 'Save preferences', exact: true }));
  expect((await preferenceUpdate).postDataJSON()).toMatchObject({ weight_unit: 'LB' });
  await expect(page).toHaveURL((url) => url.pathname === '/profile');
  await expectRouteFocus(page, 'Profile & preferences');
  await activateWithKeyboard(page, preferences);
  await expectRouteFocus(page, 'Preferences');
  await expect(pounds).toBeChecked();
  await activateWithKeyboard(page, preferencesPage.getByRole('button', { name: 'Cancel', exact: true }));
  await expect(page).toHaveURL((url) => url.pathname === '/profile');
  await expectRouteFocus(page, 'Profile & preferences');
});
