/** @file Regression coverage for onboarding: editing details returns directly to the plan and preserves canonical measurements. */

import { expect, expectApiFailure, FROZEN_LOCAL_DATE, hideTransientPwaNotices, test } from './fixtures';
import {
  advanceOnboardingToActivity,
  advanceOnboardingToPlan,
  goalPaceOption,
  installOnboardingAccount,
} from './onboarding.fixture';

// These flows exercise onboarding; PWA lifecycle overlays have their own release gate.
test.use({ serviceWorkers: 'block' });

for (const goal of [
  { label: 'Lose', target: '82', deficit: 500 },
  { label: 'Maintain', target: '88.2', deficit: 0 },
  { label: 'Gain', target: '92', deficit: -500 },
] as const) {
  test(`${goal.label} completes in three steps and opens Today immediately`, async ({ page, ux }) => {
    await ux.install('populated');
    const account = await installOnboardingAccount(page);
    await page.goto('/onboarding');
    await hideTransientPwaNotices(page);
    await expect(page.getByText('Step 1 of 3', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: 'Sex used for calorie calculation' })
      .getByRole('radio', { checked: true })).toHaveCount(0);
    await advanceOnboardingToActivity(page);
    await expect(page.getByText('Step 2 of 3', { exact: true })).toBeVisible();
    const activity = page.getByRole('radiogroup', { name: 'Activity level', exact: true });
    await expect(activity.getByRole('radio')).toHaveCount(5);
    await expect(activity.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(activity).toContainText('Some walking or light exercise during a typical week.');
    await activity.getByRole('radio', { name: 'Lightly active', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
    await expect(page.getByText('Step 3 of 3', { exact: true })).toBeVisible();
    const direction = page.getByRole('radiogroup', { name: 'Goal direction', exact: true });
    await expect(direction.getByRole('radio', { checked: true })).toHaveCount(0);
    await direction.getByRole('radio', { name: goal.label, exact: true }).click();
    if (goal.deficit === 0) {
      await expect(page.getByRole('textbox', { name: 'Target weight (kg)', exact: true })).toHaveCount(0);
      await expect(page.getByRole('radiogroup', { name: 'Goal pace', exact: true })).toHaveCount(0);
    } else {
      await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill(goal.target);
      await expect(page.getByRole('radiogroup', { name: 'Goal pace', exact: true })
        .getByRole('radio', { checked: true })).toHaveCount(0);
      await goalPaceOption(page, 500).click();
    }
    await expect(page.getByText('Your daily calorie target', { exact: true })).toBeVisible();
    if (page.viewportSize()!.width < 1024) {
      await expect(page.getByText('Your daily calorie target', { exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeInViewport();
    }
    await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: 'Daily balance', exact: true })).toBeVisible();
    expect(account.completions).toHaveLength(1);
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
      .filter(key => key.startsWith('@calibrate/onboarding-draft/v1/')))).toEqual([]);
    expect(account.completions[0]).toMatchObject({
      current_weight_grams: 88_200,
      target_weight_grams: Number(goal.target) * 1_000,
      height_mm: 1_800,
      daily_deficit: goal.deficit,
      activity_level: 'LIGHT',
    });
    await expect(page.getByText(/Connect Health Connect|Set up Galaxy Watch|Import Lose It ZIP/)).toHaveCount(0);
    await page.goto('/onboarding');
    await hideTransientPwaNotices(page);
    await expect(page).toHaveURL(/\/today$/);
  });
}

test('editing details returns directly to the plan and preserves canonical measurements', async ({ page, ux }) => {
  const previews: Array<{ weight: { unit: string; value: number }; height: { unit: string; centimeters: number } }> = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/v1/calorie-plan/options') previews.push(request.postDataJSON());
  });
  await ux.install('populated');
  const account = await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Lose', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill('82.3');
  await goalPaceOption(page, 500).click();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
  const weightUnit = page.getByRole('button', { name: /^Weight unit:/ });
  const heightUnit = page.getByRole('button', { name: /^Height unit:/ });
  for (let index = 0; index < 3; index += 1) {
    await weightUnit.click();
    await expect(page.getByRole('textbox', { name: 'Current weight (lb)', exact: true })).not.toHaveValue('88.2');
    await heightUnit.click();
    await expect(page.getByRole('textbox', { name: 'Feet', exact: true })).toHaveValue('5');
    await weightUnit.click();
    await heightUnit.click();
  }
  await expect(page.getByRole('textbox', { name: 'Current weight (kg)', exact: true })).toHaveValue('88.2');
  await expect(page.getByRole('textbox', { name: 'Height (cm)', exact: true })).toHaveValue('180');
  await weightUnit.click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect(account.completions[0]).toMatchObject({
    current_weight_grams: 88_200,
    target_weight_grams: 82_300,
    weight_unit: 'LB',
    height_mm: 1_800,
  });
  expect(previews.at(-1)).toMatchObject({ weight: { unit: 'KG', value: 88.2 }, height: { unit: 'CM', centimeters: 180 } });
});

test('empty measurements remain empty when units change and field validation is accessible', async ({ page, ux }) => {
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Weight unit: kg. Switch to lb', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Current weight (lb)', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Height unit: cm. Switch to ft/in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Feet', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Inches', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Male', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Current weight (lb)', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('radio', { name: 'Male', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const birthDate = page.getByLabel('Date of birth', { exact: true });
  await expect(birthDate).toBeFocused();
  await birthDate.fill('1985-05-12');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Current weight (lb)', exact: true })).toBeFocused();
});

test('restart restores the current step and explicit choices without overwriting them', async ({ page, ux }) => {
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Gain', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill('93.2');
  await goalPaceOption(page, 250).click();
  await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('93.2')))).toBe(true);
  await page.reload();
  await hideTransientPwaNotices(page);
  await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Gain', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Target weight (kg)', exact: true })).toHaveValue('93.2');
  await expect(goalPaceOption(page, 250)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeEnabled();
});

test('a failed target request can be retried before completion', async ({ page, ux }) => {
  await ux.install('populated');
  await installOnboardingAccount(page);
  let failPreview = true;
  expectApiFailure(page, { method: 'POST', pathname: '/api/v1/calorie-plan/options', status: 503 });
  await page.route('**/api/v1/calorie-plan/options', route => {
    if (!failPreview) return route.fallback();
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
      code: 'SERVICE_UNAVAILABLE', message: 'Calorie options unavailable.', retryable: true,
    }) });
  });
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Maintain', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeDisabled();
  const retry = page.getByRole('button', { name: /retry|try again/i });
  await expect(retry).toBeVisible();
  failPreview = false;
  await retry.click();
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeEnabled();
});

test('a saved draft never appears for another account', async ({ page, ux }) => {
  await ux.install('populated');
  const account = await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToActivity(page);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .some(key => key.startsWith('@calibrate/onboarding-draft/v1/') && key.endsWith('/117')))).toBe(true);
  account.replaceUser({ id: 118, email: 'another@example.invalid' });
  await page.reload();
  await hideTransientPwaNotices(page);
  await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Current weight (kg)', exact: true })).toHaveValue('');
  await expect(page.getByRole('radiogroup', { name: 'Sex used for calorie calculation' })
    .getByRole('radio', { checked: true })).toHaveCount(0);
});

test('activity supports keyboard navigation and exposes its explanations', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Keyboard traversal is covered on desktop.');
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToActivity(page);
  const choices = page.getByRole('radiogroup', { name: 'Activity level', exact: true });
  const sitting = choices.getByRole('radio', { name: 'Mostly sitting', exact: true });
  await sitting.focus();
  await page.keyboard.press('ArrowDown');
  const light = choices.getByRole('radio', { name: 'Lightly active', exact: true });
  await expect(light).toBeFocused();
  await expect(light).toBeChecked();
  await expect(light).toHaveAccessibleDescription('Some walking or light exercise during a typical week.');
  await page.keyboard.press('End');
  await expect(choices.getByRole('radio', { name: 'Very active', exact: true })).toBeFocused();
  await expect(choices.getByRole('radio', { name: 'Very active', exact: true })).toBeChecked();
});

test('local storage failure leaves the full setup usable', async ({ page, ux }) => {
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.addInitScript(() => {
    const originalSet = Storage.prototype.setItem;
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('@calibrate/onboarding-draft/v1/')) throw new DOMException('Storage full', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
    Storage.prototype.getItem = function (key) {
      if (key.startsWith('@calibrate/onboarding-draft/v1/')) throw new DOMException('Storage unavailable', 'SecurityError');
      return originalGet.call(this, key);
    };
  });
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await expect(page.getByText('Progress could not be saved on this device. You can still finish setup.', { exact: true })).toBeVisible();
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Maintain', exact: true }).click();
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
});

test('completion disables its action until the atomic request finishes', async ({ page, ux }) => {
  await ux.install('populated');
  const account = await installOnboardingAccount(page);
  let releaseCompletion!: () => void;
  const pendingCompletion = new Promise<void>(resolve => { releaseCompletion = resolve; });
  let requestCount = 0;
  await page.route('**/api/v1/onboarding/complete', async route => {
    requestCount += 1;
    await pendingCompletion;
    await route.fallback();
  });
  try {
    await page.goto('/onboarding');
    await hideTransientPwaNotices(page);
    await advanceOnboardingToPlan(page);
    await page.getByRole('radio', { name: 'Maintain', exact: true }).click();
    const complete = page.getByTestId('onboarding-complete');
    await complete.click();
    await expect(complete).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Maintain', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit details', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit activity', exact: true })).toBeDisabled();
    await expect.poll(() => requestCount).toBe(1);
    await page.keyboard.press('Enter');
    expect(requestCount).toBe(1);
  } finally {
    releaseCompletion();
  }
  await expect(page).toHaveURL(/\/today$/);
  expect(account.completions).toHaveLength(1);
});

test('a target on the wrong side of current weight cannot complete setup', async ({ page, ux }) => {
  await ux.install('populated');
  const account = await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Lose', exact: true }).click();
  const target = page.getByRole('textbox', { name: 'Target weight (kg)', exact: true });
  await target.fill('92');
  await goalPaceOption(page, 500).click();
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Choose a target below your current weight.', { exact: true })).toBeVisible();
  expect(account.completions).toHaveLength(0);
  await target.fill('82');
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
});

test('an activity edit that invalidates the chosen pace requires a fresh choice', async ({ page, ux }) => {
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.route('**/api/v1/calorie-plan/options', route => {
    if (route.request().postDataJSON().activity_level !== 'SEDENTARY') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      eligibility: { status: 'eligible', reasonCode: null, ageYears: 41, localDate: FROZEN_LOCAL_DATE },
      bmr: 1_800, tdee: 2_300, minimumDailyCalorieTarget: 2_000,
      planOptions: [-1000, -750, -500, -250, 0, 250, 500, 750, 1000].map(dailyDeficit => ({
        dailyDeficit, available: dailyDeficit <= 250,
        dailyCalorieTarget: dailyDeficit <= 250 ? 2_300 - dailyDeficit : null,
        reasonCode: dailyDeficit <= 250 ? null : 'TARGET_BELOW_MINIMUM',
      })),
    }) });
  });
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  await advanceOnboardingToPlan(page);
  await page.getByRole('radio', { name: 'Lose', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill('82');
  await goalPaceOption(page, 500).click();
  await page.getByRole('button', { name: 'Edit activity', exact: true }).click();
  await page.getByRole('radio', { name: 'Mostly sitting', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
  await expect(goalPaceOption(page, 500)).toBeDisabled();
  await expect(page.getByRole('radiogroup', { name: 'Goal pace', exact: true })
    .getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeDisabled();
  await goalPaceOption(page, 250).click();
  await expect(page.getByRole('button', { name: 'Start tracking', exact: true })).toBeEnabled();
});
