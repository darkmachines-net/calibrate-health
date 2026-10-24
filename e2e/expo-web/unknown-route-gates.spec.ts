/** @file Regression coverage for unknown route gates: unknown-route fallback waits for the existing session gate before exposing Today. */

import { expect, expectApiFailure, test } from './fixtures';

for (const missing of ['/notifications?cursor=stale#history', '/missing/account/page?old=true#section']) {
  test(`${missing} respects sign-in gating on direct entry and reload`, async ({ page, ux }) => {
    await ux.install('signed-out');
    expectApiFailure(page, { method: 'GET', pathname: new URL(missing, 'http://localhost').pathname, status: 404 });
    await page.goto(missing);
    await expect(page).toHaveURL((url) => url.pathname === '/login' && !url.search && !url.hash);
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === '/login');
    await expect(page.getByTestId('notifications-button')).toHaveCount(0);
  });

  for (const [state, destination] of [
    ['email_verification_required', '/verify-email'],
    ['legal_acceptance_required', '/legal-update'],
  ] as const) {
    test(`${missing} respects the ${state} account gate`, async ({ page, ux }) => {
      await ux.install('populated');
      await page.route('**/auth/me', (route) => route.fulfill({
        json: { user: {
          id: 17, email: 'release@example.invalid', timezone: 'America/Los_Angeles', language: 'en',
          weight_unit: 'KG', height_unit: 'CM', created_at: '2026-01-01T12:00:00.000Z',
          account_access: { state, email_verified: state !== 'email_verification_required', legal_current: false },
        } },
      }));
      expectApiFailure(page, { method: 'GET', pathname: new URL(missing, 'http://localhost').pathname, status: 404 });
      await page.goto(missing);
      await expect(page).toHaveURL((url) => url.pathname === destination && !url.search && !url.hash);
      await page.reload();
      await expect(page).toHaveURL((url) => url.pathname === destination);
      await expect(page.getByTestId('notifications-button')).toHaveCount(0);
    });
  }

  test(`${missing} respects incomplete-profile onboarding`, async ({ page, ux }) => {
    await ux.install('populated', { apiResources: [{
      pathname: '/api/v1/user/profile', state: 'content', empty: null,
      content: {
        profile: { timezone: 'America/Los_Angeles', date_of_birth: null, sex: null, height_mm: null, activity_level: null },
        latest_weight_grams: null, goal_daily_deficit: null,
        calorieSummary: { missing: ['profile'], eligibility: { status: 'ineligible' }, planStatus: 'unavailable' },
      },
    }] });
    expectApiFailure(page, { method: 'GET', pathname: new URL(missing, 'http://localhost').pathname, status: 404 });
    await page.goto(missing);
    await expect(page).toHaveURL((url) => url.pathname === '/onboarding');
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === '/onboarding');
    await expect(page.getByTestId('notifications-button')).toHaveCount(0);
  });
}

test('unknown-route fallback waits for the existing session gate before exposing Today', async ({ page, ux }) => {
  await ux.install('populated');
  let releaseSession!: () => void;
  let sessionRequested = false;
  const heldSession = new Promise<void>((resolve) => { releaseSession = resolve; });
  await page.route('**/auth/me', async (route) => {
    sessionRequested = true;
    await heldSession;
    await route.fallback();
  });
  expectApiFailure(page, { method: 'GET', pathname: '/missing/loading-session', status: 404 });
  await page.goto('/missing/loading-session');
  await expect.poll(() => sessionRequested).toBe(true);
  await expect(page.getByTestId('notifications-button')).toHaveCount(0);
  releaseSession();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await expect(page.getByTestId('notifications-button')).toBeVisible();
});
