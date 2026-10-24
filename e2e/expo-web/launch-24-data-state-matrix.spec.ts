/** @file Regression coverage for launch 24 data state matrix: Launch 24 exported-web data-state coverage. */

import type { Locator, Page, TestInfo } from '@playwright/test';
import {
  API_RESOURCE_FIXTURE_STATES,
  expect,
  test,
  type ApiResourceFixtureState,
  type UxStateController,
} from './fixtures';
import {
  LAUNCH_24_DATA_ROUTE_CASES,
  LAUNCH_24_DATA_STATES,
  LAUNCH_24_STATIC_ROUTE_IDS,
  type Launch24DataRouteCase,
  type SurfaceExpectation,
} from './launch-24-data-state-matrix';
import {
  ROUTE_IDS,
  ROUTE_REGISTRY,
} from '../../mobile/src/navigation/routeRegistry';

const RESTRICTED_LEGAL_USER = {
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
  onboarding_completed_at: '2026-01-02T12:00:00.000Z',
  account_access: {
    state: 'legal_acceptance_required',
    email_verified: true,
    legal_current: false,
  },
};

function runOnlyInDesktopProject(testInfo: TestInfo): void {
  test.skip(
    testInfo.project.name !== 'desktop-chrome',
    'The exhaustive state matrix is bounded to the reviewed desktop Chromium project.',
  );
}

function surfaceLocator(page: Page, surface: SurfaceExpectation): Locator {
  if (surface.kind === 'testId') return page.getByTestId(surface.value).first();
  if (surface.kind === 'label') return page.getByLabel(surface.value, { exact: true }).first();
  return page.getByText(surface.value, { exact: true }).first();
}

async function expectSurface(page: Page, surface: SurfaceExpectation): Promise<void> {
  await expect(surfaceLocator(page, surface)).toBeVisible();
}

async function installRouteSetup(page: Page, setup: Launch24DataRouteCase['setup']): Promise<void> {
  if (setup === 'restricted-legal') {
    await page.route('**/auth/me', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: RESTRICTED_LEGAL_USER }),
    }));
  }
  if (setup === 'health-connect-ready') {
    await page.addInitScript(() => {
      Object.defineProperty(window, '__CALIBRATE_HEALTH_CONNECT_E2E__', {
        configurable: true,
        writable: true,
        value: {
          state: 'ready',
          lastSuccessfulSyncAt: '2026-07-21T18:30:00.000Z',
          syncError: null,
        },
      });
    });
  }
}

function matchesResourceResponse(routeCase: Launch24DataRouteCase, responseUrl: string): boolean {
  const url = new URL(responseUrl);
  return url.pathname === routeCase.resource.pathname
    && (routeCase.resource.matches?.(url) ?? true);
}

async function triggerRefreshFailure(
  page: Page,
  routeCase: Launch24DataRouteCase,
  controller: Pick<UxStateController, 'activateOffline'>,
): Promise<void> {
  const failedRefresh = page.waitForResponse((response) => (
    response.status() === 503
    && matchesResourceResponse(routeCase, response.url())
  ));
  await controller.activateOffline();
  await page.context().setOffline(false);
  await failedRefresh;
}

test.describe('Launch 24 exported-web data-state coverage', () => {
  test.beforeEach(({}, testInfo) => runOnlyInDesktopProject(testInfo));

  test('partitions all canonical routes into data-backed and reviewed-static sets exactly once', () => {
    const dataRouteIds = LAUNCH_24_DATA_ROUTE_CASES.map(({ id }) => id);
    const staticRouteIds = [...LAUNCH_24_STATIC_ROUTE_IDS];
    const partition = [...dataRouteIds, ...staticRouteIds];

    expect(new Set(dataRouteIds).size).toBe(dataRouteIds.length);
    expect(new Set(staticRouteIds).size).toBe(staticRouteIds.length);
    expect(new Set(partition).size).toBe(ROUTE_IDS.length);
    expect([...partition].sort()).toEqual([...ROUTE_IDS].sort());
    expect([...LAUNCH_24_DATA_STATES].sort()).toEqual([...API_RESOURCE_FIXTURE_STATES].sort());

    for (const routeCase of LAUNCH_24_DATA_ROUTE_CASES) {
      expect(routeCase.path).toBe(ROUTE_REGISTRY[routeCase.id].path);
      expect(routeCase.resource.pathname).toMatch(/^\/(?:api\/v1|auth)\//);
    }
  });

  for (const routeCase of LAUNCH_24_DATA_ROUTE_CASES) {
    for (const state of LAUNCH_24_DATA_STATES) {
      test(`${routeCase.id} renders a truthful ${state} state`, async ({ page, ux }) => {
        const controller = await ux.install('populated', {
          apiResources: [{
            ...routeCase.resource,
            state: state as ApiResourceFixtureState,
          }],
        });
        await installRouteSetup(page, routeCase.setup);

        const response = await page.goto(routeCase.path);
        expect(response?.status()).toBe(200);

        if (state === 'loading') {
          await expectSurface(page, routeCase.loading);
          if (routeCase.contentVisibleWhileLoading) {
            await expectSurface(page, routeCase.content);
          } else {
            await expect(surfaceLocator(page, routeCase.content)).toHaveCount(0);
          }
          controller.releaseLoading();
          await expectSurface(page, routeCase.content);
          return;
        }

        if (state === 'content') {
          await expectSurface(page, routeCase.content);
          return;
        }

        if (state === 'empty') {
          await expectSurface(page, routeCase.empty);
          if (routeCase.empty.value !== routeCase.content.value) {
            await expect(surfaceLocator(page, routeCase.content)).toHaveCount(0);
          }
          return;
        }

        if (state === 'error') {
          // The terminal surface appears only after the product's bounded React Query retry cycle.
          await expect(page.getByText(routeCase.errorText, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
          if (routeCase.errorActionText) {
            await expect(page.getByText(routeCase.errorActionText, { exact: true }).first()).toBeVisible({
              timeout: 20_000,
            });
          }
          if (routeCase.terminalEmptyText) {
            await expect(page.getByText(routeCase.terminalEmptyText, { exact: true })).toHaveCount(0);
          }
          await expect(page.getByText(/private upstream detail/i)).toHaveCount(0);
          return;
        }

        await expectSurface(page, routeCase.content);
        if (state === 'stale') {
          await triggerRefreshFailure(page, routeCase, controller);
          // The stale surface appears only after the same bounded React Query retry cycle as terminal errors.
          await expect(page.getByText(routeCase.staleText, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
          await expectSurface(page, routeCase.content);
          await expect(page.getByText(/private upstream detail/i)).toHaveCount(0);
          return;
        }

        await controller.activateOffline();
        await expect(page.getByText(
          routeCase.offlineText ?? "You're offline",
          { exact: true },
        ).first()).toBeVisible();
        await expectSurface(page, routeCase.content);
      });
    }
  }
});
