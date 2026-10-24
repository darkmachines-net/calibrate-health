/** @file Regression coverage for onboarding units: uses regional units with a compact accessible switch beside each measurement. */

import type { Locator } from '@playwright/test';
import { expect, hideTransientPwaNotices, test } from './fixtures';
import { fillOnboardingDetails, goalPaceOption, installOnboardingAccount } from './onboarding.fixture';

test.use({ serviceWorkers: 'block' });

async function expectCompactUnitControl(input: Locator, toggle: Locator) {
  const field = await input.boundingBox();
  const control = await toggle.boundingBox();
  expect(field).not.toBeNull();
  expect(control).not.toBeNull();
  expect(control!.width).toBeGreaterThanOrEqual(48);
  expect(control!.height).toBeGreaterThanOrEqual(48);
  expect(control!.width).toBeLessThanOrEqual(112);
  expect(control!.x).toBeGreaterThanOrEqual(field!.x + field!.width);
  expect(Math.abs(control!.y + control!.height / 2 - field!.y - field!.height / 2)).toBeLessThanOrEqual(2);
}

for (const localeCase of [
  { locale: 'en-US', weight: 'lb', nextWeight: 'kg', height: 'ft/in', nextHeight: 'cm', field: 'Feet' },
  { locale: 'en-GB', weight: 'lb', nextWeight: 'kg', height: 'ft/in', nextHeight: 'cm', field: 'Feet' },
  { locale: 'fr-FR', weight: 'kg', nextWeight: 'lb', height: 'cm', nextHeight: 'ft/in', field: 'Height (cm)' },
] as const) {
  test.describe(`new account with ${localeCase.locale} device locale`, () => {
    test.use({ locale: localeCase.locale });
    test('uses regional units with a compact accessible switch beside each measurement', async ({ page, ux }) => {
      await ux.install('populated');
      await installOnboardingAccount(page, {}, { locale: null });
      await page.goto('/onboarding');
      await hideTransientPwaNotices(page);
      await expect(page.getByRole('heading', { name: 'About you', exact: true })).toBeVisible();
      const currentWeight = page.getByRole('textbox', { name: `Current weight (${localeCase.weight})`, exact: true });
      const weightSwitch = page.getByRole('button', { name: `Weight unit: ${localeCase.weight}. Switch to ${localeCase.nextWeight}`, exact: true });
      const heightSwitch = page.getByRole('button', { name: `Height unit: ${localeCase.height}. Switch to ${localeCase.nextHeight}`, exact: true });
      await expect(currentWeight).toHaveValue('');
      await expect(page.getByRole('textbox', { name: localeCase.field, exact: true })).toHaveValue('');
      await expectCompactUnitControl(currentWeight, weightSwitch);
      await expect(heightSwitch).toBeVisible();
      const heightControlBounds = await heightSwitch.boundingBox();
      expect(heightControlBounds!.width).toBeGreaterThanOrEqual(48);
      expect(heightControlBounds!.height).toBeGreaterThanOrEqual(48);
      await expect(page.getByRole('radiogroup', { name: /^(Weight|Height) unit$/ })).toHaveCount(0);
    });
  });
}

test('unit choices and physical quantities survive restart and a target-unit switch', async ({ page, ux }) => {
  await ux.install('populated');
  const account = await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await fillOnboardingDetails(page);
  await page.getByRole('button', { name: 'Weight unit: kg. Switch to lb', exact: true }).click();
  await page.getByRole('button', { name: 'Height unit: cm. Switch to ft/in', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage).some(([key, value]) =>
    key.startsWith('@calibrate/onboarding-draft/v1/')
    && JSON.parse(value).form.weightUnit === 'LB'
    && JSON.parse(value).form.heightUnit === 'FT_IN'))).toBe(true);
  await page.reload();
  await hideTransientPwaNotices(page);
  await expect(page.getByRole('textbox', { name: 'Current weight (lb)', exact: true })).toHaveValue('194.4');
  await expect(page.getByRole('textbox', { name: 'Feet', exact: true })).toHaveValue('5');
  await expect(page.getByRole('textbox', { name: 'Inches', exact: true })).toHaveValue('11');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'Lightly active', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: 'Lose', exact: true }).click();
  await page.getByRole('textbox', { name: 'Target weight (lb)', exact: true }).fill('181.4');
  await page.getByRole('button', { name: 'Weight unit: lb. Switch to kg', exact: true }).click();
  const target = page.getByRole('textbox', { name: 'Target weight (kg)', exact: true });
  await expect(target).toHaveValue('82.3');
  await expectCompactUnitControl(target, page.getByRole('button', { name: 'Weight unit: kg. Switch to lb', exact: true }));
  await goalPaceOption(page, 500).click();
  await page.getByRole('button', { name: 'Start tracking', exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
  expect(account.completions[0]).toMatchObject({
    weight_unit: 'KG', height_unit: 'FT_IN',
    current_weight_grams: 88_200, height_mm: 1_800,
    target_weight_grams: Math.round(181.4 * 453.59237),
  });
});

test('unit switches work from the keyboard and announce the next unit', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Keyboard traversal is covered on desktop.');
  await ux.install('populated');
  await installOnboardingAccount(page);
  await page.goto('/onboarding');
  await hideTransientPwaNotices(page);
  const weightSwitch = page.getByRole('button', { name: /^Weight unit:/ });
  await weightSwitch.focus();
  await page.keyboard.press('Enter');
  await expect(weightSwitch).toBeFocused();
  await expect(weightSwitch).toHaveAccessibleName('Weight unit: lb. Switch to kg');
  await page.keyboard.press('Space');
  await expect(weightSwitch).toHaveAccessibleName('Weight unit: kg. Switch to lb');
  const heightSwitch = page.getByRole('button', { name: /^Height unit:/ });
  await heightSwitch.focus();
  await page.keyboard.press('Enter');
  await expect(heightSwitch).toBeFocused();
  await expect(heightSwitch).toHaveAccessibleName('Height unit: ft/in. Switch to cm');
  await page.keyboard.press('Space');
  await expect(heightSwitch).toBeFocused();
  await expect(heightSwitch).toHaveAccessibleName('Height unit: cm. Switch to ft/in');
});

test.describe('saved profile preferences', () => {
  test.use({ locale: 'en-US' });
  test('preserves saved metric units independently of an imperial device locale', async ({ page, ux }) => {
    await ux.install('populated');
    await installOnboardingAccount(page, { sex: 'MALE', weight_unit: 'KG', height_unit: 'CM' }, { locale: null });
    await page.goto('/onboarding');
    await expect(page.getByRole('textbox', { name: 'Current weight (kg)', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Height (cm)', exact: true })).toBeVisible();
  });
});
