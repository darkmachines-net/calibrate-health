/** @file Regression coverage for launch 16 activity truth: Activity keeps connection, sync, source, and calorie-target truth across responsive layouts. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import { expect, FROZEN_LOCAL_DATE, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-16');
const HEALTH_CONNECT_FIXTURE_EVENT = 'calibrate:health-connect-fixture';
const HEALTH_CONNECT_FIXTURE_GLOBAL = '__CALIBRATE_HEALTH_CONNECT_E2E__';
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

type HealthConnectFixtureState =
  | 'disconnected'
  | 'denied'
  | 'syncing'
  | 'stale'
  | 'empty'
  | 'failed_sync'
  | 'ready';

type HealthConnectFixture = {
  state: HealthConnectFixtureState;
  lastSuccessfulSyncAt?: string | null;
  syncError?: string | null;
};

type ActivityFixture = {
  hasData: boolean;
};

const ACTIVITY_GUARDRAIL = 'Imported activity never automatically changes your calorie target.';
const FAILED_SYNC_MESSAGE = 'Health activity could not sync. Try again from Health Connect settings.';

function activityRecord(
  id: number,
  recordType: 'STEPS' | 'ACTIVE_CALORIES' | 'TOTAL_CALORIES' | 'EXERCISE_SESSION' | 'WEIGHT',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    record_type: recordType,
    record_id: `launch-16-${recordType.toLowerCase()}-${id}`,
    data_origin: 'com.sec.android.app.shealth',
    client_record_id: null,
    client_record_version: null,
    source_updated_at: '2026-07-21T18:30:00.000Z',
    start_time: '2026-07-21T17:00:00.000Z',
    end_time: null,
    start_zone_offset_seconds: -25_200,
    end_zone_offset_seconds: -25_200,
    local_date: FROZEN_LOCAL_DATE,
    count: null,
    energy_kcal: null,
    weight_grams: null,
    exercise_type: null,
    title: null,
    notes: null,
    recording_method: 1,
    device_type: 2,
    device_manufacturer: 'Samsung',
    device_model: 'Galaxy Watch 7',
    created_at: '2026-07-21T18:31:00.000Z',
    updated_at: '2026-07-21T18:31:00.000Z',
    ...overrides,
  };
}

function populatedDay(localDate = FROZEN_LOCAL_DATE) {
  const datePrefix = `${localDate}T`;
  return {
    local_date: localDate,
    summary: {
      id: localDate === FROZEN_LOCAL_DATE ? 201 : 200,
      local_date: localDate,
      steps: localDate === FROZEN_LOCAL_DATE ? 8_432 : 7_105,
      active_calories_kcal: localDate === FROZEN_LOCAL_DATE ? 540 : 462,
      total_calories_kcal: localDate === FROZEN_LOCAL_DATE ? 2_480 : 2_355,
      exercise_minutes: localDate === FROZEN_LOCAL_DATE ? 38 : 31,
      observed_at: `${datePrefix}18:30:00.000Z`,
      created_at: `${datePrefix}18:31:00.000Z`,
      updated_at: `${datePrefix}18:31:00.000Z`,
    },
    records: localDate === FROZEN_LOCAL_DATE ? [
      activityRecord(301, 'STEPS', { count: 8_432 }),
      activityRecord(302, 'ACTIVE_CALORIES', { energy_kcal: 540 }),
      activityRecord(303, 'TOTAL_CALORIES', { energy_kcal: 2_480 }),
      activityRecord(304, 'EXERCISE_SESSION', {
        end_time: '2026-07-21T17:38:00.000Z',
        exercise_type: 79,
        title: 'Morning walk',
      }),
      activityRecord(305, 'WEIGHT', { weight_grams: 88_400 }),
    ] : [],
  };
}

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installActivityFixture(page: Page): Promise<ActivityFixture> {
  const fixture: ActivityFixture = { hasData: true };
  await page.route('**/api/v1/activity/days**', (route) => {
    const url = new URL(route.request().url());
    const startDate = url.searchParams.get('start') ?? FROZEN_LOCAL_DATE;
    const endDate = url.searchParams.get('end') ?? startDate;
    if (!fixture.hasData) {
      return fulfillJson(route, { start_date: startDate, end_date: endDate, days: [] });
    }
    const days = startDate === endDate
      ? [populatedDay(startDate)]
      : [populatedDay('2026-07-20'), populatedDay(FROZEN_LOCAL_DATE)];
    return fulfillJson(route, { start_date: startDate, end_date: endDate, days });
  });
  return fixture;
}

async function installInitialHealthConnectState(page: Page, fixture: HealthConnectFixture) {
  await page.addInitScript(({ globalName, value }) => {
    Object.defineProperty(window, globalName, {
      configurable: true,
      writable: true,
      value,
    });
  }, { globalName: HEALTH_CONNECT_FIXTURE_GLOBAL, value: fixture });
}

async function setHealthConnectState(page: Page, fixture: HealthConnectFixture) {
  await page.evaluate(({ eventName, globalName, value }) => {
    Object.assign(window, { [globalName]: value });
    window.dispatchEvent(new Event(eventName));
  }, {
    eventName: HEALTH_CONNECT_FIXTURE_EVENT,
    globalName: HEALTH_CONNECT_FIXTURE_GLOBAL,
    value: fixture,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyWidth).toBeLessThanOrEqual(widths.clientWidth);
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function expectMinimumTouchTarget(page: Page, name: string) {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  expect(box, `${name} should have a measurable touch target`).not.toBeNull();
  expect(box!.height, `${name} touch target height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${name} touch target width`).toBeGreaterThanOrEqual(44);
}

async function hideTransientPwaNotices(page: Page) {
  await page.locator('[role="status"], [role="alert"]').evaluateAll((notices, titles) => {
    for (const notice of notices) {
      const text = notice.textContent ?? '';
      if ((titles as string[]).some((title) => text.includes(title))) {
        (notice as HTMLElement).style.display = 'none';
      }
    }
  }, [...TRANSIENT_PWA_TITLES]);
}

async function captureEvidence(page: Page, testInfo: TestInfo) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = testInfo.project.name === 'desktop-chrome'
    ? 'activity-populated-details-desktop-1024x1000.png'
    : testInfo.project.name === 'compact-phone-chrome'
      ? 'activity-disconnected-phone-320x568.png'
      : null;
  if (!filename) return;

  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await hideTransientPwaNotices(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
}

async function expectSharedActivityTruth(page: Page) {
  await expect(page.locator('#route-focus-title')).toHaveText('Activity');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByTestId('activity-summary')).toBeVisible();
  await expect(page.getByText('Device-estimated total burn', { exact: true })).toBeVisible();
  await expect(page.getByText('Calibrate TDEE', { exact: false })).toHaveCount(0);
  await expect(page.getByText('calories added back', { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('activity-recent-days')).toBeVisible();
  await expectNoHorizontalOverflow(page);
}

test('Activity keeps connection, sync, source, and calorie-target truth across responsive layouts', async (
  { page, ux },
  testInfo,
) => {
  const project = testInfo.project.name;
  if (project === 'desktop-chrome') {
    await page.setViewportSize({ width: 1_024, height: 1_000 });
  } else if (project === 'compact-phone-chrome') {
    await page.setViewportSize({ width: 320, height: 568 });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  const activityFixture = await installActivityFixture(page);

  if (project === 'compact-phone-chrome') {
    activityFixture.hasData = false;
    await installInitialHealthConnectState(page, { state: 'disconnected' });
    await page.goto('/activity');

    const connectionState = page.getByTestId('activity-connection-state');
    await expect(connectionState).toContainText(
      'Connect Health Connect to import read-only activity from apps on this phone.',
    );
    await expect(page.getByRole('button', { name: 'Connect Health Connect', exact: true })).toHaveCount(1);
    await expect(page.getByText(ACTIVITY_GUARDRAIL, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Recent Days', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('activity-recent-days')).toHaveCount(0);
    await expectMinimumTouchTarget(page, 'Connect Health Connect');
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo);

    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: 'Connect Health Connect', exact: true }).click();
    await expect(page.getByText(
      'Health Connect is connected. No imported activity is available yet.',
      { exact: true },
    )).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByText('No imported activity for this day', { exact: true })).toBeVisible();
    await expect(page.getByTestId('activity-recent-days')).toContainText(
      'No imported activity was found in the latest 14 days.',
    );
    await expectNoHorizontalOverflow(page);
    return;
  }

  const initialFixture: HealthConnectFixture = project === 'tablet-chrome'
    ? { state: 'stale', lastSuccessfulSyncAt: '2026-07-20T08:00:00.000Z' }
    : project === 'android-phone-chrome'
      ? { state: 'denied' }
      : { state: 'ready', lastSuccessfulSyncAt: '2026-07-21T18:30:00.000Z' };
  await installInitialHealthConnectState(page, initialFixture);
  await page.goto('/activity');
  await expectSharedActivityTruth(page);

  if (project === 'tablet-chrome') {
    await expect(page.getByTestId('activity-connection-state')).toContainText(
      'Health Connect has not synced recently.',
    );
    await expect(page.getByRole('button', { name: 'Manage Health Connect', exact: true })).toHaveCount(1);
    await setHealthConnectState(page, { state: 'syncing' });
    await expect(page.getByTestId('activity-connection-state')).toContainText(
      'Syncing activity from Health Connect...',
    );
    await expect(page.getByTestId('activity-summary')).toContainText('8,432');
    await expectNoHorizontalOverflow(page);
    return;
  }

  if (project === 'android-phone-chrome') {
    await expect(page.getByTestId('activity-connection-state')).toContainText(
      'Health Connect access needs review.',
    );
    await expect(page.getByRole('button', { name: 'Manage Health Connect', exact: true })).toHaveCount(1);
    await expect(page.getByTestId('activity-summary')).toContainText('8,432');
    await setHealthConnectState(page, { state: 'failed_sync', syncError: FAILED_SYNC_MESSAGE });
    await expect(page.getByRole('alert')).toContainText(FAILED_SYNC_MESSAGE);
    await expect(page.getByTestId('activity-summary')).toContainText('8,432');
    await expect(page.getByText(ACTIVITY_GUARDRAIL, { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    return;
  }

  await expect(page.getByTestId('activity-summary')).toContainText('8,432');
  await expect(page.getByTestId('activity-summary')).toContainText('540 kcal');
  await expect(page.getByTestId('activity-summary')).toContainText('38 min');
  await expect(page.getByTestId('activity-summary')).toContainText('2,480 kcal');
  await expect(page.getByText('Morning walk', { exact: true })).toBeVisible();

  const detailsToggle = page.getByRole('button', { name: 'Show activity details', exact: true });
  await expect(page.getByTestId('activity-details-content')).toHaveCount(0);
  await expectMinimumTouchTarget(page, 'Show activity details');
  await detailsToggle.click();
  await expect(page.getByRole('button', { name: 'Hide activity details', exact: true })).toBeVisible();
  const details = page.getByTestId('activity-details-content');
  await expect(details).toContainText('Sources and sync');
  await expect(details).toContainText('Samsung Health');
  await expect(details).toContainText('Imported weight');
  await expect(details).toContainText('88.4 kg');
  await expect(details).toContainText('Device: Samsung Galaxy Watch 7');
  await expect(details).toContainText('Calibrate keeps using your profile estimate for its calorie target.');
  await expect(details.getByText(ACTIVITY_GUARDRAIL, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo);

  await page.getByRole('button', { name: 'View activity for Jul 20, 2026', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Jul 20, 2026', exact: true })).toBeVisible();
  await expect(page.getByTestId('activity-summary')).toContainText('7,105');
  await page.getByRole('button', { name: 'Back to Connections', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/connections');
  await expect(page.locator('#route-focus-title')).toHaveText('Connections');
  await expectNoHorizontalOverflow(page);
});

test('Activity date navigation stays anchored and usable after scrolling', async ({ page, ux }, testInfo) => {
  await ux.install('populated');
  await installActivityFixture(page);
  await installInitialHealthConnectState(page, { state: 'ready' });
  await page.goto('/activity');
  await expect(page.getByTestId('activity-summary')).toContainText('8,432');
  await page.getByRole('button', { name: 'Show activity details', exact: true }).click();

  const header = page.getByTestId('date-navigation-header');
  const content = page.getByRole('main');
  await expect(header.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
  const initialHeaderBox = await header.boundingBox();
  expect(initialHeaderBox).not.toBeNull();

  await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await header.boundingBox())?.y).toBe(initialHeaderBox!.y);
  await expect(header.getByRole('button', { name: 'Choose date', exact: true })).toBeInViewport();
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE === '1') {
    const directory = path.resolve('.codex-screenshots/stack-review');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `369-activity-scrolled-${testInfo.project.name}.png`) });
  }

  await header.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(header).toContainText('Jul 20, 2026');
  await expect(page.getByTestId('activity-summary')).toContainText('7,105');
  await header.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(header).toContainText('Today');
  await expect(page.getByTestId('activity-summary')).toContainText('8,432');
  await expect(header.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});
