/** @file Regression coverage for saved target: Daily Balance retains a saved target through completion, refetch and reload. */

import { expect, test, hideTransientPwaNotices, type AuthenticatedApiOptions } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';

test.use({ serviceWorkers: 'block' });

test('Daily Balance retains a saved target through completion, refetch and reload', async ({ page, ux }) => {
  const date = '2026-07-21';
  const options: AuthenticatedApiOptions = { foodDayStatus: 'OPEN', foodEntriesByDate: {
    [date]: [{ id: 31, meal_period: 'BREAKFAST', name: 'Synthetic daily intake', calories: 1800 }]
  } };
  await ux.install('populated', options);
  await page.route('**/api/v1/food-days**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/v1/food-days') return route.fallback();
    if (route.request().method() === 'PATCH') options.foodDayStatus = route.request().postDataJSON().status;
    const complete = options.foodDayStatus === 'COMPLETE';
    await route.fulfill({ json: {
      date: url.searchParams.get('date') ?? date, status: options.foodDayStatus, source: 'STORED', origin: 'USER',
      is_complete: complete, is_representative: complete, completed_at: null, updated_at: null,
      calorie_comparison: complete ? { consumed_kcal: 1800, target_kcal: 2000, maintenance_kcal: 2500, captured_at: date + 'T19:00:00Z' } : null
    } });
  });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  // Today's current plan is 2100; completing the day must use its saved 2000 target instead.
  await expect(page.getByLabel(/Daily balance\. 300 kcal remaining/)).toBeVisible();
  await page.getByRole('button', { name: 'Complete day', exact: true }).click();
  await expect(page.getByLabel(/Daily balance\. 200 kcal remaining/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/Daily balance\. 200 kcal remaining/)).toBeVisible();
});

for (const comparison of [undefined, null]) {
  test(`legacy completed day uses labeled fallback with ${comparison === null ? 'null' : 'omitted'} comparison`, async ({ page, ux }, testInfo) => {
    await ux.install('populated', { foodDayStatus: 'COMPLETE' });
    await page.route('**/api/v1/food-days?*', async route => route.fulfill({ json: {
      date: new URL(route.request().url()).searchParams.get('date'), status: 'COMPLETE', source: 'STORED', origin: 'USER',
      is_complete: true, is_representative: true, completed_at: null, updated_at: null, calorie_comparison: comparison
    } }));
    await page.goto('/today?date=2026-07-20');
    await hideTransientPwaNotices(page);
    await expect(page.getByLabel(/Daily balance\..*Compared with current target/)).toBeVisible();
    await expect(page.getByText('kcal remaining', { exact: true })).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'historical-target' });
    await page.screenshot({ path: testInfo.outputPath('historical-current-target.png') });
    await page.reload();
    await hideTransientPwaNotices(page);
    await expect(page.getByLabel(/Daily balance\..*Compared with current target/)).toBeVisible();
    await applyTwoHundredPercentText(page);
    const caption = page.getByText('Compared with current target', { exact: true });
    await caption.scrollIntoViewIfNeeded();
    await expect(caption).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('historical-current-target-large-text.png') });
  });
}

test('past open fallback follows refetched plans and preserves paused/incomplete/unavailable handling', async ({ page, ux }) => {
  let clockAdvance = 0;
  async function reloadAndRefetch() {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toBeVisible();
    // The deterministic fixture resets time on reload; persisted queries can otherwise look future-dated.
    clockAdvance += 60_000;
    await page.evaluate(offset => {
      const now = Date.now;
      Date.now = () => now() + offset;
      window.dispatchEvent(new Event('visibilitychange'));
    }, clockAdvance);
    await hideTransientPwaNotices(page);
  }
  const options: AuthenticatedApiOptions = { foodDayStatus: 'OPEN', foodEntriesByDate: {
    '2026-07-20': [{ id: 31, meal_period: 'DINNER', name: 'Synthetic historical intake', calories: 1800 }]
  } };
  await ux.install('populated', options);
  let currentTarget: number | null = 2100;
  let planStatus = 'available';
  await page.route('**/api/v1/user/profile', async route => {
    await route.fulfill({ json: { profile: { timezone: 'America/Los_Angeles', date_of_birth: '1985-05-12',
      sex: 'MALE', height_mm: 1800, activity_level: 'LIGHT', weight_unit: 'KG', height_unit: 'CM' },
      latest_weight_grams: 88200, goal_daily_deficit: 500,
      calorieSummary: { planStatus, dailyCalorieTarget: currentTarget, tdee: 2600, bmr: 2000, deficit: 500, missing: [],
        eligibility: { status: 'eligible', reasonCode: null, ageYears: 41, localDate: '2026-07-21' },
        planReasonCode: null, minimumDailyCalorieTarget: 2000 } } });
  });
  await page.goto('/today?date=2026-07-20');
  await expect(page.getByLabel(/Daily balance\. 300 kcal remaining.*Compared with current target/)).toBeVisible();
  currentTarget = 2350;
  await reloadAndRefetch();
  await expect(page.getByLabel(/Daily balance\. 550 kcal remaining.*Compared with current target/)).toBeVisible();
  planStatus = 'requires_review'; currentTarget = null;
  await reloadAndRefetch();
  await expect(page.getByLabel(/Daily balance\. Plan needs review/)).toBeVisible();
  await expect(page.getByText('Compared with current target')).toHaveCount(0);
  options.foodDayStatus = 'INCOMPLETE'; planStatus = 'available'; currentTarget = 2350;
  await reloadAndRefetch();
  await expect(page.getByLabel(/Daily balance\. Incomplete day/)).toBeVisible();
  options.foodDayStatus = 'PAUSED';
  await reloadAndRefetch();
  await expect(page.getByText('Tracking was paused', { exact: true })).toBeVisible();
});
