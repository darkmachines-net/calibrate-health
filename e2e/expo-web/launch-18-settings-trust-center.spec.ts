/** @file Regression coverage for launch 18 settings trust center: settings trust center preserves hierarchy, session control, reminder truth, and safe navigation. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route, TestInfo } from '@playwright/test';
import { expect, expectApiFailure, hideTransientPwaNotices as suppressTransientPwaNotices, test } from './fixtures';

const EVIDENCE_DIR = path.resolve('.codex-screenshots/launch-18');
const CURRENT_SESSION_ID = 'browser_11111111-1111-4111-8111-111111111111';
const REMOTE_SESSION_ID = 'mobile_22222222-2222-4222-8222-222222222222';
const TRANSIENT_PWA_TITLES = new Set([
  'Back online',
  'Update ready',
  'Update failed',
  'Updating Calibrate',
]);

type AccountSession = {
  id: string;
  kind: 'browser' | 'android_phone' | 'wear_os';
  device_label: string | null;
  created_at: string;
  last_activity_at: string | null;
  current: boolean;
};

type SettingsApiFixture = {
  sessions: AccountSession[];
  preferencePayloads: Array<Record<string, unknown>>;
  deletionPassword: string | null;
};

const settingsUser = {
  id: 17,
  email: 'release@example.invalid',
  created_at: '2026-01-01T12:00:00.000Z',
  onboarding_completed_at: '2026-01-02T12:00:00.000Z',
  weight_unit: 'KG',
  height_unit: 'CM',
  timezone: 'America/Los_Angeles',
  language: 'en',
  reminder_log_weight_enabled: true,
  reminder_log_food_enabled: true,
  reminder_log_weight_time: '09:00',
  reminder_log_food_time: '09:00',
  reminder_quiet_hours_start: null,
  reminder_quiet_hours_end: null,
  haptics_enabled: true,
  date_of_birth: '1985-05-12',
  sex: 'MALE',
  height_mm: 1_800,
  activity_level: 'LIGHT',
  profile_image_url: null,
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: status >= 400 ? { 'x-request-id': 'fixture-launch-18-settings' } : undefined,
    body: JSON.stringify(body),
  });
}

function initialSessions(): AccountSession[] {
  return [
    {
      id: CURRENT_SESSION_ID,
      kind: 'browser',
      device_label: null,
      created_at: '2026-08-09T10:00:00.000Z',
      last_activity_at: '2026-08-09T12:00:00.000Z',
      current: true,
    },
    {
      id: REMOTE_SESSION_ID,
      kind: 'android_phone',
      device_label: 'Pixel 9',
      created_at: '2026-08-08T10:00:00.000Z',
      last_activity_at: '2026-08-09T11:00:00.000Z',
      current: false,
    },
  ];
}

async function installSettingsApi(page: Page): Promise<SettingsApiFixture> {
  const fixture: SettingsApiFixture = {
    sessions: initialSessions(),
    preferencePayloads: [],
    deletionPassword: null,
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === '/auth/me' && method === 'GET') {
      return fulfillJson(route, { user: settingsUser });
    }
    if (pathname === '/auth/sessions' && method === 'GET') {
      return fulfillJson(route, { sessions: fixture.sessions });
    }
    if (pathname === '/auth/sessions/revoke-others' && method === 'POST') {
      const revoked = fixture.sessions.filter(({ current }) => !current).length;
      fixture.sessions = fixture.sessions.filter(({ current }) => current);
      return fulfillJson(route, { ok: true, revoked });
    }
    const revokeMatch = pathname.match(/^\/auth\/sessions\/(.+)$/);
    if (revokeMatch && method === 'DELETE') {
      const sessionId = decodeURIComponent(revokeMatch[1]);
      const target = fixture.sessions.find(({ id }) => id === sessionId);
      if (target?.current) {
        return fulfillJson(route, { message: 'Sign out to end the current session.' }, 400);
      }
      const originalLength = fixture.sessions.length;
      fixture.sessions = fixture.sessions.filter(({ id }) => id !== sessionId);
      return fulfillJson(route, { ok: true, revoked: fixture.sessions.length < originalLength });
    }
    if (pathname === '/api/v1/client-config' && method === 'GET') {
      return fulfillJson(route, {
        api_version: 1,
        server_version: '1.0.0',
        capabilities: {
          self_hosted_server_url: true,
          native_push: false,
          web_push: true,
          health_connect_activity: true,
          wear_os_ready: true,
        },
      });
    }
    if (pathname === '/api/v1/my-foods/library' && method === 'GET') {
      return fulfillJson(route, { items: [], next_cursor: null });
    }
    if (pathname === '/api/v1/user/preferences' && method === 'PATCH') {
      const payload = request.postDataJSON() as Record<string, unknown>;
      fixture.preferencePayloads.push(payload);
      Object.assign(settingsUser, payload);
      return fulfillJson(route, { user: settingsUser });
    }
    if (pathname === '/api/v1/user/account' && method === 'DELETE') {
      const payload = request.postDataJSON() as { current_password?: string };
      fixture.deletionPassword = payload.current_password ?? null;
      return fulfillJson(route, {
        message: 'Current password is incorrect',
        code: 'INVALID_CURRENT_PASSWORD',
        retryable: false,
        request_id: 'fixture-launch-18-settings',
      }, 400);
    }

    return route.fallback();
  });

  return fixture;
}

async function installDeniedBrowserPermission(page: Page) {
  await page.addInitScript(() => {
    let permission: NotificationPermission = 'default';
    const NativeNotification = window.Notification ?? class FixtureNotification {};
    const fixtureNotification = new Proxy(NativeNotification, {
      get(target, property, receiver) {
        if (property === 'permission') return permission;
        if (property === 'requestPermission') {
          return async () => {
            permission = 'denied';
            return permission;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    Object.defineProperty(window, 'Notification', { configurable: true, value: fixtureNotification });
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: class FixturePushManager {},
    });
    if (!('serviceWorker' in navigator)) {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          addEventListener() {},
          removeEventListener() {},
          getRegistration: async () => null,
          getRegistrations: async () => [],
        },
      });
    }
  });
}

async function confirmSessionAction(page: Page, action: () => Promise<void>, title: string) {
  await action();
  const confirmation = page.getByRole('dialog', { name: title });
  await expect(confirmation).toBeVisible();
  await confirmation.getByTestId('settings-session-confirm').click();
  await expect(confirmation).toHaveCount(0);
}

async function simulateTwoHundredPercentText(page: Page) {
  return page.evaluate(() => {
    let scaled = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const hasDirectText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      if (!hasDirectText || element.dataset.launch18TextScaled === 'true') continue;
      const computed = window.getComputedStyle(element);
      const fontSize = Number.parseFloat(computed.fontSize);
      if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
      element.style.fontSize = `${fontSize * 2}px`;
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (Number.isFinite(lineHeight) && lineHeight > 0) {
        element.style.lineHeight = `${lineHeight * 2}px`;
      }
      element.dataset.launch18TextScaled = 'true';
      scaled += 1;
    }
    return scaled;
  });
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

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.bodyWidth).toBeLessThanOrEqual(widths.clientWidth);
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

async function captureEvidence(
  page: Page,
  testInfo: TestInfo,
  state: 'sessions' | 'delete-account-200-percent',
) {
  if (process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1') return;
  const filename = state === 'sessions'
    ? 'settings-session-dialog-desktop-1024x1000.png'
    : 'settings-delete-account-phone-200-percent-text-320x568.png';
  await page.evaluate(() => document.fonts.ready);
  await hideTransientPwaNotices(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: false });
  const viewport = page.viewportSize();
  if (state === 'sessions') {
    expect(testInfo.project.name).toBe('desktop-chrome');
    expect(viewport).toEqual({ width: 1_024, height: 1_000 });
  } else {
    expect(testInfo.project.name).toBe('compact-phone-chrome');
    expect(viewport).toEqual({ width: 320, height: 568 });
  }
}

async function captureNavigationEvidence(
  page: Page,
  testInfo: TestInfo,
  screen: 'home' | 'profile',
) {
  const viewport = page.viewportSize();
  const viewportName = testInfo.project.name === 'desktop-chrome'
    ? 'desktop-1024x1000'
    : 'phone-320x568';
  const expectedViewport = testInfo.project.name === 'desktop-chrome'
    ? { width: 1_024, height: 1_000 }
    : { width: 320, height: 568 };
  expect(viewport).toEqual(expectedViewport);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await hideTransientPwaNotices(page);
  await page.locator('main').evaluateAll((routes) => {
    for (const route of routes) route.scrollTop = 0;
  });
  await expectNoHorizontalOverflow(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, `settings-${screen}-${viewportName}.png`),
    fullPage: false,
  });
}

test('settings trust center preserves hierarchy, session control, reminder truth, and safe navigation', async (
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
  if (project === 'tablet-chrome') await installDeniedBrowserPermission(page);
  const fixture = await installSettingsApi(page);

  if (project === 'desktop-chrome') {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('settings-home')).toBeVisible();
    const sectionIds = await page.locator('[data-testid^="settings-section-"]').evaluateAll((sections) =>
      sections.map((section) => section.getAttribute('data-testid')),
    );
    expect(sectionIds).toEqual([
      'settings-section-account',
      'settings-section-categories',
    ]);
    const categories = [
      {
        opener: 'settings-open-profile',
        path: '/profile',
        page: 'settings-category-profile',
        labels: ['Profile photo', 'Profile details', 'Preferences'],
      },
      {
        opener: 'settings-open-security',
        path: '/security',
        page: 'settings-category-security',
        labels: ['Password', 'Signed-in devices', 'Log out'],
      },
      {
        opener: 'settings-open-connections',
        path: '/connections',
        page: 'settings-category-connections',
        labels: ['Activity', 'Connected assistants'],
      },
      {
        opener: 'settings-open-data',
        path: '/data',
        page: 'settings-category-data',
        labels: ['Saved foods', 'Import from Lose It', 'Offline changes', 'Export account data', 'Delete account'],
      },
      {
        opener: 'settings-open-help',
        path: '/help',
        page: 'settings-category-help',
        labels: [
          'Support and feedback',
          'Privacy policy',
          'Terms of service',
          'Open-source licenses',
          'About Calibrate',
          'Advanced settings',
        ],
      },
    ] as const;
    for (const category of categories) {
      await expect(page.getByTestId(category.opener)).toBeVisible();
      await page.getByTestId(category.opener).click();
      await expect(page).toHaveURL((url) => url.pathname === category.path);
      const categoryPage = page.getByTestId(category.page);
      await expect(categoryPage).toBeVisible();
      for (const label of category.labels) {
        await expect(categoryPage.getByText(label, { exact: true }).first()).toBeAttached();
      }
      await page.getByRole('button', { name: 'Go back', exact: true }).click();
      await expect(page).toHaveURL((url) => url.pathname === '/settings');
      await expect(page.getByTestId('settings-home')).toBeVisible();
    }
    await expect(page.getByText('Email verification', { exact: true })).toHaveCount(0);

    await page.getByTestId('settings-open-connections').click();
    await expect(page.getByRole('button', { name: 'Health Connect', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Galaxy Watch', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await page.getByTestId('settings-open-security').click();
    await page.getByTestId('settings-open-sessions').click();
    const sessions = page.getByTestId('signed-in-devices-settings-page');
    await expect(page).toHaveURL((url) => url.pathname === '/devices');
    await expect(sessions.getByTestId('settings-sessions-list')).toBeVisible();
    const currentRow = sessions.getByTestId(`settings-session-${CURRENT_SESSION_ID}`);
    const remoteRow = sessions.getByTestId(`settings-session-${REMOTE_SESSION_ID}`);
    await expect(currentRow).toContainText('This session');
    await expect(currentRow.getByTestId(`settings-session-revoke-${CURRENT_SESSION_ID}`)).toHaveCount(0);
    await expect(remoteRow).toContainText('Pixel 9');
    await expect(remoteRow.getByTestId(`settings-session-revoke-${REMOTE_SESSION_ID}`)).toBeVisible();
    await expect(sessions.getByTestId('settings-session-revoke-others')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, testInfo, 'sessions');

    await confirmSessionAction(
      page,
      () => sessions.getByTestId('settings-session-revoke-others').click(),
      'Revoke all other sessions?',
    );
    await expect(sessions.getByTestId(`settings-session-${REMOTE_SESSION_ID}`)).toHaveCount(0);
    await expect(currentRow).toBeVisible();
    expect(fixture.sessions).toHaveLength(1);
    await expectNoHorizontalOverflow(page);
    return;
  }

  if (project === 'tablet-chrome') {
    await page.goto('/settings');
    await page.getByTestId('settings-open-security').click();
    await expect(page).toHaveURL((url) => url.pathname === '/security');
    await page.getByTestId('settings-open-sessions').click();
    const sessions = page.getByTestId('signed-in-devices-settings-page');
    await confirmSessionAction(
      page,
      () => sessions.getByTestId(`settings-session-revoke-${REMOTE_SESSION_ID}`).click(),
      'Revoke signed-in session?',
    );
    await expect(sessions.getByTestId(`settings-session-${REMOTE_SESSION_ID}`)).toHaveCount(0);
    await expect(sessions.getByTestId(`settings-session-${CURRENT_SESSION_ID}`)).toContainText('This session');
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(sessions).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === '/security');

    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.getByTestId('settings-open-profile').click();
    await expect(page).toHaveURL((url) => url.pathname === '/profile');
    await page.getByTestId('settings-open-preferences').click();
    const preferences = page.getByTestId('settings-preferences-page');
    await expect(page).toHaveURL((url) => url.pathname === '/preferences');
    const reminderIntent = preferences.getByTestId('settings-reminder-intent');
    const deliveryPermission = preferences.getByTestId('settings-delivery-permission');
    await expect(reminderIntent).toContainText('Choose which account reminders Calibrate should create.');
    await expect(deliveryPermission).toContainText('permission controls push delivery; it does not change your reminder choices.');
    await expect(preferences.getByTestId('settings-food-reminder-time')).toHaveValue('09:00');
    await expect(preferences.getByTestId('settings-weight-reminder-time')).toHaveValue('09:00');
    await expect(reminderIntent).toContainText(
      'Times stay at the same local wall-clock time in America/Los_Angeles, including through daylight-saving changes.',
    );
    await preferences.getByTestId('settings-food-reminder-time').fill('08:30');
    await preferences.getByTestId('settings-weight-reminder-time').fill('09:45');
    await preferences.getByTestId('settings-quiet-hours-start').fill('22:00');
    await preferences.getByTestId('settings-quiet-hours-end').fill('07:00');
    await reminderIntent.getByRole('switch', { name: 'Food reminders' }).click();
    await expect(reminderIntent.getByRole('switch', { name: 'Food reminders' })).not.toBeChecked();
    await expect(deliveryPermission).toContainText('Enable notifications in this browser');
    await deliveryPermission.getByRole('button', { name: 'Enable push notifications' }).click();
    await expect(deliveryPermission).toContainText('Notifications are blocked for this site.');
    await expect(deliveryPermission.getByRole('button', { name: 'Check again' })).toBeVisible();
    await preferences.getByRole('button', { name: 'Save preferences' }).click();
    await expect(preferences).toHaveCount(0);
    expect(fixture.preferencePayloads.at(-1)).toMatchObject({
      reminder_log_food_enabled: false,
      reminder_log_weight_enabled: true,
      reminder_log_food_time: '08:30',
      reminder_log_weight_time: '09:45',
      reminder_quiet_hours_start: '22:00',
      reminder_quiet_hours_end: '07:00',
    });
    await expectNoHorizontalOverflow(page);
    return;
  }

  if (project === 'android-phone-chrome') {
    await page.goto('/today');
    await suppressTransientPwaNotices(page);
    await page.getByRole('button', { name: 'Account & settings' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.getByTestId('settings-open-connections').click();
    await expect(page).toHaveURL((url) => url.pathname === '/connections');
    await page.getByText('Activity', { exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/activity');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/connections');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.getByTestId('settings-open-data').click();
    await expect(page).toHaveURL((url) => url.pathname === '/data');
    await page.getByText('Saved foods', { exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/my-foods');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/data');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.getByTestId('settings-open-help').click();
    await expect(page).toHaveURL((url) => url.pathname === '/help');
    await page.getByText('About Calibrate', { exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/about');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/help');
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/settings');
    await page.getByTestId('settings-open-data').click();
    await expect(page).toHaveURL((url) => url.pathname === '/data');
    await page.getByTestId('settings-export').click();
    await expect(page.getByTestId('settings-export-sheet')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Export your data' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-export-sheet')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    return;
  }

  await page.goto('/settings');
  await page.getByTestId('settings-open-data').click();
  await expect(page).toHaveURL((url) => url.pathname === '/data');
  await page.getByTestId('settings-delete-account').click();
  const deleteSheet = page.getByTestId('settings-delete-account-sheet');
  const dialog = page.getByRole('dialog', { name: 'Delete account permanently' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This cannot be undone.');
  await deleteSheet.getByRole('textbox', { name: 'Current password' }).fill('wrong-password');
  await deleteSheet.getByRole('textbox', { name: 'Type DELETE MY ACCOUNT' }).fill('DELETE MY ACCOUNT');
  const deleteForever = deleteSheet.getByRole('button', { name: 'Delete forever' });
  await expect(deleteForever).toBeEnabled();
  expect(await simulateTwoHundredPercentText(page)).toBeGreaterThan(10);
  await deleteForever.scrollIntoViewIfNeeded();
  const deleteFontSize = await deleteForever.locator('[dir="auto"]').evaluate((label) =>
    Number.parseFloat(window.getComputedStyle(label).fontSize),
  );
  expect(deleteFontSize).toBeGreaterThanOrEqual(28);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(568);
  await deleteForever.focus();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, testInfo, 'delete-account-200-percent');

  expectApiFailure(page, {
    method: 'DELETE',
    pathname: '/api/v1/user/account',
    status: 400,
  });
  await deleteForever.click();
  await expect(deleteSheet.getByRole('alert')).toContainText('Unable to delete this account.');
  expect(fixture.deletionPassword).toBe('wrong-password');
  await expectNoHorizontalOverflow(page);
});

test('settings screenshot evidence', async ({ page, ux }, testInfo) => {
  test.skip(process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1', 'Screenshot evidence is opt-in.');
  test.skip(
    !['desktop-chrome', 'compact-phone-chrome'].includes(testInfo.project.name),
    'Screenshot evidence covers desktop and compact-phone viewports.',
  );

  const isDesktop = testInfo.project.name === 'desktop-chrome';
  await page.setViewportSize(isDesktop
    ? { width: 1_024, height: 1_000 }
    : { width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  await installSettingsApi(page);

  await page.goto('/settings');
  await expect(page.getByTestId('settings-home')).toBeVisible();
  await captureNavigationEvidence(page, testInfo, 'home');

  await page.getByTestId('settings-open-profile').click();
  await expect(page).toHaveURL((url) => url.pathname === '/profile');
  await expect(page.getByTestId('settings-category-profile')).toBeVisible();
  await captureNavigationEvidence(page, testInfo, 'profile');
});
