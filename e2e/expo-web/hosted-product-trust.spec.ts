/** @file Regression coverage for hosted product trust: hosted web entry and sign-in share canonical public trust destinations. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { CALIBRATE_PRODUCT_LINKS } from '../../shared/product';
import { expect, expectApiFailure, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-10');
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectHorizontallyCentered(page: Page, locator: Locator) {
  const [viewport, box] = await Promise.all([page.viewportSize(), locator.boundingBox()]);
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  const elementCenter = box!.x + (box!.width / 2);
  expect(Math.abs(elementCenter - (viewport!.width / 2))).toBeLessThanOrEqual(2);
}

async function expectLink(page: Page, label: string, href: string) {
  await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
}

async function captureEvidence(page: Page, filename: string) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
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

test('hosted web entry and sign-in share canonical public trust destinations', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Desktop evidence uses the exact acceptance viewport.');
  await page.setViewportSize({ width: 1_024, height: 1_000 });
  await ux.install('signed-out');
  expectApiFailure(page, { method: 'POST', pathname: '/auth/login', status: 401 });
  await page.route('**/auth/login', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({
      message: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
      retryable: false,
      request_id: 'fixture-hosted-trust-signed-out',
    }),
  }));

  await page.goto('/');
  const publicHeading = page.getByRole('heading', { name: 'calibrate', level: 1, exact: true });
  await expect(publicHeading).toBeVisible();
  await expect(page.getByTestId('hosted-landing-trust')).toContainText('Your account stays under your control.');
  await expectLink(page, 'Privacy policy', CALIBRATE_PRODUCT_LINKS.privacy);
  await expectLink(page, 'Terms of service', CALIBRATE_PRODUCT_LINKS.terms);
  await expectLink(page, 'Support', CALIBRATE_PRODUCT_LINKS.support);
  await expect(page.getByRole('main')).not.toContainText(/\b(?:API|OTA|runtime|server URL)\b/i);
  await expectNoHorizontalOverflow(page);
  await expectHorizontallyCentered(page, publicHeading);

  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/login');
  const loginHeading = page.getByRole('heading', { name: 'calibrate', level: 1, exact: true });
  await expect(loginHeading).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expectLink(page, 'Privacy policy', CALIBRATE_PRODUCT_LINKS.privacy);
  await expectLink(page, 'Terms of service', CALIBRATE_PRODUCT_LINKS.terms);
  await expectLink(page, 'Support', CALIBRATE_PRODUCT_LINKS.support);
  await expect(page.getByRole('main')).not.toContainText(/\b(?:API|OTA|runtime|server URL)\b/i);
  await expectNoHorizontalOverflow(page);
  await expectHorizontallyCentered(page, loginHeading);
  await captureEvidence(page, 'hosted-sign-in-desktop-1024x1000.png');

  await page.getByRole('link', { name: 'Support', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === CALIBRATE_PRODUCT_LINKS.support);
  await expect(page.getByRole('heading', { name: 'Support', level: 1, exact: true })).toBeVisible();
  await expectLink(page, 'Privacy policy', CALIBRATE_PRODUCT_LINKS.privacy);
  await expectLink(page, 'Terms of service', CALIBRATE_PRODUCT_LINKS.terms);
  await expectNoHorizontalOverflow(page);
});

test('About keeps product and trust links distinct on compact web', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome', 'Phone evidence uses the exact acceptance viewport.');
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await page.goto('/about');

  const heading = page.locator('#route-focus-title');
  await expect(heading).toHaveText('About Calibrate');
  await expect(heading).toHaveAttribute('aria-level', '1');
  await expect(heading).not.toBeFocused();
  await expectLink(page, 'Privacy policy', CALIBRATE_PRODUCT_LINKS.privacy);
  await expectLink(page, 'Terms of service', CALIBRATE_PRODUCT_LINKS.terms);
  await expectLink(page, 'Support', CALIBRATE_PRODUCT_LINKS.support);
  await expectLink(page, 'Feedback', CALIBRATE_PRODUCT_LINKS.feedback);
  await expectLink(page, 'Open-source licenses', CALIBRATE_PRODUCT_LINKS.licenses);
  await expectLink(page, 'Release notes', CALIBRATE_PRODUCT_LINKS.releases);

  await expect(page.getByRole('button', { name: 'Show advanced details', exact: true })).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, 'about-phone-320x568.png');
});
