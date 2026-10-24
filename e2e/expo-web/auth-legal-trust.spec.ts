/** @file Regression coverage for auth legal trust: legal update keeps restricted account controls visible in a desktop composition. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-08');
const RESTRICTED_USER = {
  id: 17,
  email: 'release@example.invalid',
  created_at: '2026-01-01T12:00:00.000Z',
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'America/Los_Angeles',
  language: 'en',
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  haptics_enabled: true,
  date_of_birth: '1985-05-12',
  sex: 'MALE',
  height_mm: 1800,
  activity_level: 'LIGHT',
  profile_image_url: null,
  account_access: {
    state: 'legal_acceptance_required',
    email_verified: true,
    legal_current: false,
  },
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
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

test('legal update keeps restricted account controls visible in a desktop composition', async ({ page, ux }) => {
  await page.setViewportSize({ width: 1_024, height: 1_000 });
  await ux.install('populated');
  await page.route('**/auth/me', (route) => fulfillJson(route, { user: RESTRICTED_USER }));
  await page.route('**/api/v1/legal/status', (route) => fulfillJson(route, {
    account_access: RESTRICTED_USER.account_access,
    required: { terms_version: '2026-08-09', privacy_version: '2026-07-24' },
    accepted: { terms_version: null, privacy_version: null, accepted_at: null },
  }));
  await page.route('**/api/v1/legal/acceptance', async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({
      terms_version: '2026-08-09',
      privacy_version: '2026-07-24',
      accept_terms: true,
      accept_privacy: true,
    });
    await fulfillJson(route, {
      account_access: { state: 'full', email_verified: true, legal_current: true },
      required: { terms_version: '2026-08-09', privacy_version: '2026-07-24' },
      accepted: {
        terms_version: '2026-08-09',
        privacy_version: '2026-07-24',
        accepted_at: '2026-08-09T12:00:00.000Z',
      },
    });
  });

  await page.goto('/legal-update');
  await expect(page.getByRole('heading', { name: 'Review legal updates' })).toBeVisible();
  await expect(page.getByText('Account data and deletion')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'I agree to the current Terms of service' }).click();
  await page.getByRole('checkbox', { name: 'I accept the current Privacy policy' }).click();
  await expectNoHorizontalOverflow(page);

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'legal-update-desktop-1024x1000.png'),
    fullPage: false,
  });

  await page.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(page.getByText('Legal acceptance updated.')).toBeVisible();
});

test('password reset scrubs the token and reflows at 320x568 with 200% text', async ({ page, ux }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ux.install('populated');
  await page.goto('/reset-password#token=one-time-secret');

  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await expect.poll(() => page.url()).not.toContain('token=');
  await enlargeLeafText(page);
  await expectNoHorizontalOverflow(page);
  const newPassword = page.getByRole('textbox', { name: 'New password', exact: true });
  await expect(newPassword).toBeVisible();
  await newPassword.focus();
  await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible();

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'reset-password-phone-320x568-200-percent-text.png'),
    fullPage: false,
  });
});
