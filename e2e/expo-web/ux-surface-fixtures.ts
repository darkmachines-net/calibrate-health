/** @file ux surface fixtures: Resolves a typed UX locator contract to a test-ID or accessible-role locator. */

import type { Locator, Page, Route } from '@playwright/test';
import { expect } from './fixtures';
import { ROUTE_IDS } from '../../mobile/src/navigation/routeRegistry';
import type { UxLocatorContract } from './ux-matrix';
import { PLAN_CHECK_RECOMMENDATION_STATUS } from './plan-check.fixture';
import { installOnboardingAccount } from './onboarding.fixture';

const RESUME_CONFIRMATION_DUE_PAUSE_RESPONSE = {
  pause: {
    active: true,
    id: 4,
    starts_on: '2026-07-20',
    expected_resume_on: '2026-07-23',
    resumed_on: null,
    started_at: '2026-07-20T08:00:00.000Z',
    resumed_at: null,
    materialized_through: '2026-07-23',
    resume_confirmation_due: true,
  },
};

/** Resolves a typed UX locator contract to a test-ID or accessible-role locator. */
export function locatorForContract(page: Page, contract: UxLocatorContract): Locator {
  if (contract.kind === 'test-id') return page.getByTestId(contract.value);
  return page.getByRole(contract.role, {
    name: contract.name,
    exact: contract.exact,
  });
}

/** Waits for the contract's surface marker and loaded fonts before inspecting layout. */
export async function waitForReadySurface(page: Page, contract: UxLocatorContract): Promise<void> {
  await expect(locatorForContract(page, contract).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Adds synthetic route-specific API responses needed to exercise accessibility surfaces. */
export async function installAccessibilityApiExtensions(
  page: Page,
  routeId: (typeof ROUTE_IDS)[number],
  surfaceId: string,
) {
  if (routeId === 'server-admin') {
    await page.route('**/api/v1/server-settings', (route) => fulfillJson(route, {
      is_admin: true, features: { nutrition_label_scanning: false }
    }));
  }
  const sessions = [
    {
      id: 'browser_current',
      kind: 'browser',
      device_label: 'Chrome on Windows',
      created_at: '2026-08-01T12:00:00.000Z',
      last_activity_at: '2026-08-09T12:00:00.000Z',
      current: true,
    },
    {
      id: 'mobile_remote',
      kind: 'android_phone',
      device_label: 'Pixel 9',
      created_at: '2026-07-01T12:00:00.000Z',
      last_activity_at: null,
      current: false,
    },
  ];
  await page.route('**/auth/sessions', (route) => fulfillJson(route, { sessions }));
  await page.route('**/auth/mobile/sessions', (route) => fulfillJson(route, { sessions }));
  if (surfaceId === 'connected-app-revoke-confirmation') {
    await page.route('**/api/v1/user/connected-apps', (route) => fulfillJson(route, {
      connections: [{
        id: 'c13e23d9-b130-42bd-bb70-901fd65fbfe9',
        client_id: 'codex-client',
        client_name: 'Codex',
        scopes: ['calibrate:food:read', 'calibrate:weight:read'],
        resource: 'https://calibratehealth.app/mcp',
        created_at: '2026-08-19T12:00:00.000Z',
        last_used_at: null,
        expires_at: '2026-09-18T12:00:00.000Z',
      }],
    }));
  }
  await page.route('**/api/v1/my-foods/library**', (route) => fulfillJson(route, {
    items: [],
    next_cursor: null,
  }));

  if (surfaceId === 'plan-check-adjustment-review' || routeId === 'plan-check') {
    await page.route('**/api/v1/calibration/status', (route) => {
      return fulfillJson(route, PLAN_CHECK_RECOMMENDATION_STATUS);
    });
  }

  if (surfaceId === 'resume-tracking-prompt') {
    await page.route('**/api/v1/food-days/pause', (route) => {
      return fulfillJson(route, RESUME_CONFIRMATION_DUE_PAUSE_RESPONSE);
    });
  }

  if (routeId === 'legal-update') {
    await page.route('**/api/v1/legal/status', (route) => fulfillJson(route, {
      account_access: {
        state: 'legal_acceptance_required',
        email_verified: true,
        legal_current: false,
      },
      required: { terms_version: '2026-08-09', privacy_version: '2026-07-24' },
      accepted: { terms_version: null, privacy_version: null, accepted_at: null },
    }));
  }

  if (routeId === 'onboarding') {
    await installOnboardingAccount(page);
  }
}
