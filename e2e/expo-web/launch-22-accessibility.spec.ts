/** @file Regression coverage for launch 22 accessibility: Launch 22 accessibility coverage contracts. */

import type { Page, TestInfo } from '@playwright/test';
import { ROUTE_IDS, ROUTE_REGISTRY } from '../../mobile/src/navigation/routeRegistry';
import { expect, hideTransientPwaNotices, test } from './fixtures';
import { fillOnboardingDetails, goalPaceOption, installOnboardingAccount } from './onboarding.fixture';
import { installAccessibilityApiExtensions, locatorForContract, waitForReadySurface } from './ux-surface-fixtures';
import {
  attachAccessibilitySummary,
  collectBlockingAccessibilityViolations,
  expectNoBlockingAccessibilityViolations,
} from './ux-a11y';
import {
  UX_ACCESSIBILITY_OVERLAY_CASES,
  UX_ACCESSIBILITY_ROUTE_CASES,
} from './ux-matrix';

const SEMANTIC_PROJECTS = new Set(['desktop-chrome', 'ux-phone-320', 'ux-desktop-1024']);
test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

function runOnlyInSemanticProject(testInfo: TestInfo): void {
  test.skip(
    !SEMANTIC_PROJECTS.has(testInfo.project.name),
    'The semantic matrix runs only at the reviewed compact-phone and desktop viewports.',
  );
}

test.describe('Launch 22 accessibility coverage contracts', () => {
  test.beforeEach(({}, testInfo) => runOnlyInSemanticProject(testInfo));

  test('declares every canonical route exactly once', () => {
    const ids = UX_ACCESSIBILITY_ROUTE_CASES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ROUTE_IDS.length);
    expect([...ids].sort()).toEqual([...ROUTE_IDS].sort());

    for (const routeCase of UX_ACCESSIBILITY_ROUTE_CASES) {
      expect(routeCase.path).toBe(ROUTE_REGISTRY[routeCase.id].path);
      expect(routeCase.authClass).toBe(ROUTE_REGISTRY[routeCase.id].authClass);
      expect(routeCase.fixtureState).toBe(
        routeCase.authClass === 'authenticated' ? 'populated' : 'signed-out',
      );
    }
  });

  test('declares unique, authenticated overlay entry points', () => {
    const ids = UX_ACCESSIBILITY_OVERLAY_CASES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'add-food',
      'weight-entry',
      'historical-calendar',
      'goal-editor',
      'goal-daily-calorie-options',
      'plan-check-adjustment-review',
      'notifications-drawer',
      'profile-time-zone-options',
      'profile-photo',
      'password',
      'import',
      'offline',
      'saved-food-new-food',
      'saved-food-new-recipe',
      'food-log-edit',
      'food-log-copy-day',
      'food-log-copy-meal',
      'food-log-copy-meal-destination',
      'food-log-save-recipe',
      'pause-tracking',
      'resume-tracking-prompt',
      'session-revoke-confirmation',
      'session-revoke-others-confirmation',
      'connected-app-revoke-confirmation',
      'account-export',
      'delete-account',
    ]));

    for (const overlayCase of UX_ACCESSIBILITY_OVERLAY_CASES) {
      expect(ROUTE_REGISTRY[overlayCase.routeId].authClass).toBe('authenticated');
      expect(overlayCase.path).toBe(ROUTE_REGISTRY[overlayCase.routeId].path);
      if (overlayCase.opensAutomatically) {
        expect(overlayCase.open).toHaveLength(0);
      } else {
        expect(overlayCase.open.length).toBeGreaterThan(0);
      }
      expect(overlayCase.ready).toMatchObject({ kind: 'role', role: 'dialog' });
    }
  });

  test('declares query-driven overlays as automatic entry points', () => {
    expect(UX_ACCESSIBILITY_OVERLAY_CASES
      .filter(({ opensAutomatically }) => opensAutomatically)
      .map(({ id }) => id)).toEqual([
        'resume-tracking-prompt',
      ]);
  });
});

test.describe('Launch 22 canonical route accessibility', () => {
  test.beforeEach(({}, testInfo) => runOnlyInSemanticProject(testInfo));

  for (const routeCase of UX_ACCESSIBILITY_ROUTE_CASES) {
    test(`${routeCase.id} has no critical or serious WCAG A/AA findings`, async ({ page, ux }, testInfo) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await ux.install(routeCase.fixtureState);
      await installAccessibilityApiExtensions(page, routeCase.id, routeCase.id);
      await page.goto(routeCase.path);
      await waitForReadySurface(page, routeCase.ready);
      await expectNoBlockingAccessibilityViolations(page, testInfo, {
        kind: 'route',
        surfaceId: routeCase.id,
      });
    });
  }
});

test.describe('Launch 22 open overlay accessibility', () => {
  test.beforeEach(({}, testInfo) => runOnlyInSemanticProject(testInfo));

  for (const overlayCase of UX_ACCESSIBILITY_OVERLAY_CASES) {
    test(`${overlayCase.id} has no critical or serious WCAG A/AA findings`, async ({ page, ux }, testInfo) => {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await ux.install(overlayCase.fixtureState);
      await installAccessibilityApiExtensions(page, overlayCase.routeId, overlayCase.id);
      await page.goto(overlayCase.path);
      if (overlayCase.routeId === 'today') await hideTransientPwaNotices(page);

      for (const action of overlayCase.open) {
        const trigger = locatorForContract(page, action).first();
        await expect(trigger).toBeVisible();
        if (overlayCase.routeId === 'today') {
          // Today can reparent the dock after measuring its loading and loaded layouts.
          await trigger.click();
        } else {
          await trigger.evaluate((element: HTMLElement) => element.click());
        }
      }

      await waitForReadySurface(page, overlayCase.ready);
      await expectNoBlockingAccessibilityViolations(page, testInfo, {
        kind: 'overlay',
        surfaceId: overlayCase.id,
      });
    });
  }
});

test.describe('Launch 22 accessibility gate probes', () => {
  test.beforeEach(({}, testInfo) => runOnlyInSemanticProject(testInfo));

  async function prepareProbe(page: Page, install: () => Promise<unknown>): Promise<void> {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await install();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  }

  test('detects an unnamed button', async ({ page, ux }, testInfo) => {
    await prepareProbe(page, () => ux.install('signed-out'));
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'launch-22-unnamed-button-probe';
      button.style.cssText = 'position:fixed;left:8px;top:8px;width:40px;height:40px;z-index:9999';
      document.body.append(button);
    });

    const violations = await collectBlockingAccessibilityViolations(page);
    await attachAccessibilitySummary(page, testInfo, {
      kind: 'probe',
      surfaceId: 'unnamed-button',
    }, violations);
    expect(violations).toContainEqual(expect.objectContaining({
      rule: 'button-name',
      impact: 'critical',
    }));
  });

  test('detects insufficient text contrast', async ({ page, ux }, testInfo) => {
    await prepareProbe(page, () => ux.install('signed-out'));
    await page.evaluate(() => {
      const text = document.createElement('p');
      text.id = 'launch-22-contrast-probe';
      text.textContent = 'Contrast gate probe';
      text.style.cssText = [
        'position:fixed',
        'left:8px',
        'top:8px',
        'z-index:9999',
        'color:#999999',
        'background:#ffffff',
        'font-size:20px',
        'font-weight:400',
      ].join(';');
      document.body.append(text);
    });

    const violations = await collectBlockingAccessibilityViolations(page);
    await attachAccessibilitySummary(page, testInfo, {
      kind: 'probe',
      surfaceId: 'contrast',
    }, violations);
    expect(violations).toContainEqual(expect.objectContaining({
      rule: 'color-contrast',
      impact: 'serious',
    }));
  });

  test('detects positive tabindex focus-order overrides', async ({ page, ux }, testInfo) => {
    await prepareProbe(page, () => ux.install('signed-out'));
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'launch-22-focus-order-probe';
      button.textContent = 'Focus order probe';
      button.tabIndex = 2;
      button.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999';
      document.body.append(button);
    });

    const violations = await collectBlockingAccessibilityViolations(page);
    await attachAccessibilitySummary(page, testInfo, {
      kind: 'probe',
      surfaceId: 'focus-order',
    }, violations);
    expect(violations).toContainEqual({
      rule: 'focus-order-positive-tabindex',
      impact: 'serious',
      help: 'Focusable elements must not use a positive tabindex.',
      nodeCount: 1,
    });
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`onboarding all steps have no blocking accessibility findings in ${scheme}`, async ({ page, ux }, testInfo) => {
    runOnlyInSemanticProject(testInfo);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await ux.install('populated');
    await installOnboardingAccount(page);
    await page.goto('/onboarding');
    await fillOnboardingDetails(page);
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: `onboarding-details-${scheme}` });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: `onboarding-activity-${scheme}` });
    await page.getByRole('radiogroup', { name: 'Activity level', exact: true })
      .getByRole('radio', { name: 'Lightly active', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: 'Lose', exact: true }).click();
    await page.getByRole('textbox', { name: 'Target weight (kg)', exact: true }).fill('82');
    await goalPaceOption(page, 500).click();
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: `onboarding-plan-${scheme}` });
  });
}
