/** @file onboarding: Layer onboarding lifecycle responses over the normal app fixture, including post-save refresh. */

import type { Page } from '@playwright/test';
import type { OnboardingCompleteData, UserClientPayload } from '../../packages/api-client/src/types';
import { expect, FROZEN_NOW, hideTransientPwaNotices } from './fixtures';

// New accounts deliberately have no demographic or activity selections to restore.
const NEW_ONBOARDING_USER: UserClientPayload = {
  id: 117,
  email: 'onboarding@example.invalid',
  created_at: FROZEN_NOW,
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'America/Los_Angeles',
  language: 'en',
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  haptics_enabled: true,
  date_of_birth: null,
  sex: null,
  height_mm: null,
  activity_level: null,
  profile_image_url: null,
  onboarding_completed_at: null,
};

/** Layer onboarding lifecycle responses over the normal app fixture, including post-save refresh. */
export async function installOnboardingAccount(
  page: Page,
  overrides: Partial<UserClientPayload> = {},
  { locale = 'en-CA' }: { locale?: string | null } = {},
) {
  // Preserve metric baseline fixtures without masking locale-specific tests that pass null.
  if (locale !== null) await page.addInitScript(language => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: language });
    Object.defineProperty(navigator, 'languages', { configurable: true, value: [language] });
  }, locale);
  let user = { ...NEW_ONBOARDING_USER, ...overrides };
  const completions: OnboardingCompleteData[] = [];
  await page.route('**/auth/me', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ user }),
  }));
  await page.route('**/api/v1/onboarding/complete', async route => {
    const { data } = route.request().postDataJSON() as { data: OnboardingCompleteData };
    completions.push(data);
    user = { ...user, ...data, onboarding_completed_at: FROZEN_NOW };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user,
        receipt: {
          operation_id: route.request().headers()['x-client-operation-id'] ?? 'onboarding-fixture',
          completed_at: FROZEN_NOW,
          goal_id: 77,
          metric_id: 88,
          sync_cursor: '99',
        },
      }),
    });
  });
  return { completions, replaceUser(next: Partial<UserClientPayload>) { user = { ...user, ...next }; } };
}

/** Fills the About you step with the shared synthetic profile after its heading is visible. */
export async function fillOnboardingDetails(page: Page) {
  await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
  await hideTransientPwaNotices(page);
  await page.getByRole('textbox', { name: 'Current weight (kg)', exact: true }).fill('88.2');
  await page.getByRole('textbox', { name: 'Height (cm)', exact: true }).fill('180');
  await page.getByLabel('Date of birth', { exact: true }).fill('1985-05-12');
  await page.getByRole('radiogroup', { name: 'Sex used for calorie calculation', exact: true })
    .getByRole('radio', { name: 'Male', exact: true }).click();
}

/** Completes the profile fixture and advances to the activity step. */
export async function advanceOnboardingToActivity(page: Page) {
  await fillOnboardingDetails(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
}

/** Selects the fixture activity level and advances to the calorie-plan step. */
export async function advanceOnboardingToPlan(page: Page) {
  await advanceOnboardingToActivity(page);
  await page.getByRole('radiogroup', { name: 'Activity level', exact: true })
    .getByRole('radio', { name: 'Lightly active', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your plan', exact: true })).toBeVisible();
}

/** Locates a goal-pace radio by its displayed daily calorie magnitude. */
export function goalPaceOption(page: Page, magnitude: number) {
  return page.getByRole('radiogroup', { name: 'Goal pace', exact: true })
    .getByRole('radio').filter({ hasText: `${magnitude} kcal/day` });
}
