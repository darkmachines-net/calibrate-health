/** @file Regression coverage for launch 17 notification center: empty reminders remain accessible from Today, Progress and Settings without an archive. */

import { expect, expectApiFailure, FROZEN_LOCAL_DATE, hideTransientPwaNotices, test } from './fixtures';
import {
  emitNotificationUpdate,
  installDeniedBrowserPermission,
  installNotificationApi,
  installRealtimeHarness,
} from './notification-reminders.fixture';

test('empty reminders remain accessible from Today, Progress and Settings without an archive', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page, true);
  for (const route of ['/today', '/progress', '/settings']) {
    await page.goto(route);
    await hideTransientPwaNotices(page);
    const bell = page.getByTestId('notifications-button');
    await bell.focus();
    await bell.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Notifications', exact: true });
    await expect(panel.getByText('All caught up', { exact: true })).toBeVisible();
    await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Close notifications' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Close notifications' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(bell).toBeFocused();
    await bell.click();
    await page.getByTestId('notifications-drawer-backdrop').click({ position: { x: 1, y: 1 } });
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === route);
  }
  expect(fixture.listViews.every((view) => view === 'active')).toBe(true);
  expect(fixture.readAllRequests).toBe(0);
});

test('five reminders retain global count, new-arrival refresh, dismissal and local-date actions', async ({ page, ux }) => {
  await ux.install('populated');
  await installRealtimeHarness(page);
  const fixture = await installNotificationApi(page);
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await expect(page.getByTestId('notifications-badge')).toHaveText('20');
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  for (const id of [121, 120, 119]) await expect(panel.getByTestId(`notification-card-${id}`)).toHaveCount(0);
  await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
  await panel.getByTestId('notification-dismiss-123').click();
  await expect(panel.getByTestId('notification-card-123')).toHaveCount(0);
  await expect(panel.getByText('19 unread', { exact: true })).toBeVisible();
  await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
  const incoming = fixture.addIncoming();
  incoming.local_date = '2026-07-20';
  await emitNotificationUpdate(page);
  await expect(panel.getByTestId('notification-card-124')).toContainText('A new reminder arrived');
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  await panel.getByTestId('notification-open-124').click();
  await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === '2026-07-20');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Add food', exact: true }).last()).toBeVisible();
  expect(fixture.listViews.every((view) => view === 'active')).toBe(true);
  expect(fixture.readAllRequests).toBe(0);
});

test('weight reminder routing survives close/reopen and browser Back/Forward', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page);
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await page.getByTestId('notifications-button').click();
  await panel.getByTestId('notification-open-123').click();
  await expect(page).toHaveURL((url) => url.pathname === '/weight' && url.searchParams.get('date') === FROZEN_LOCAL_DATE);
  await expect(panel).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/today');
  await page.goForward();
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
  expect(fixture.listViews.every((view) => view === 'active')).toBe(true);
  expect(fixture.readAllRequests).toBe(0);
});

test('fetch failure never reassures falsely and Retry restores current reminders', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page);
  fixture.failFetchRequests = 10;
  expectApiFailure(page, { method: 'GET', pathname: '/api/v1/notifications/in-app', status: 503 });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByText("Can't load notifications", { exact: true })).toBeVisible();
  await expect(panel.getByText('Unread count unavailable')).toBeVisible();
  await expect(panel.getByText('All caught up')).toHaveCount(0);
  await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
  fixture.failFetchRequests = 0;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
});

test('loading reminders exposes no archive or false empty state and settles honestly', async ({ page, ux }) => {
  const controller = await ux.install('populated', { apiResources: [{
    pathname: '/api/v1/notifications/in-app', state: 'loading',
    content: { notifications: [], unread_count: 0 }, empty: { notifications: [], unread_count: 0 },
  }] });
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByText('Unread count unavailable')).toBeVisible();
  await expect(panel.getByText('All caught up')).toHaveCount(0);
  await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
  controller.releaseLoading();
  await expect(panel.getByText('All caught up')).toBeVisible();
  await expect(panel.getByText('0 unread', { exact: true })).toBeVisible();
});

test('the populated reminder panel is retained on Progress and Settings', async ({ page, ux }) => {
  await ux.install('populated');
  await installNotificationApi(page);
  for (const route of ['/progress', '/settings']) {
    await page.goto(route);
    await hideTransientPwaNotices(page);
    await page.getByTestId('notifications-button').click();
    const panel = page.getByTestId('notifications-drawer-panel');
    await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
    await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
    await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close notifications' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === route);
  }
});

test('cached reminders survive offline and failed refresh before recovery', async ({ page, ux }) => {
  const controller = await ux.install('offline');
  await installRealtimeHarness(page);
  const fixture = await installNotificationApi(page);
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
  await controller.activateOffline();
  await expect(panel.getByText('Offline - showing saved information', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('notification-card-123')).toBeVisible();
  await expect(panel.getByTestId('view-all-notifications')).toHaveCount(0);
  fixture.failFetchRequests = 10;
  expectApiFailure(page, { method: 'GET', pathname: '/api/v1/notifications/in-app', status: 503 });
  await page.context().setOffline(false);
  await emitNotificationUpdate(page);
  await expect(panel.getByText("Couldn't refresh notifications", { exact: true })).toBeVisible();
  await expect(panel.getByTestId('notification-card-123')).toBeVisible();
  fixture.failFetchRequests = 0;
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByText("Couldn't refresh notifications", { exact: true })).toHaveCount(0);
  await panel.getByTestId('notification-open-123').click();
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
});

for (const action of ['read', 'dismiss'] as const) {
  test(`${action} failure preserves reminder/count, blocks repeated actions, and recovers`, async ({ page, ux }) => {
    await ux.install('populated');
    const fixture = await installNotificationApi(page);
    fixture.holdActions = true;
    fixture.failActions = 1;
    expectApiFailure(page, { method: 'PATCH', pathname: `/api/v1/notifications/in-app/123/${action}`, status: 503 });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await page.getByTestId('notifications-button').click();
    const panel = page.getByTestId('notifications-drawer-panel');
    const button = panel.getByTestId(`notification-${action === 'read' ? 'open' : 'dismiss'}-123`);
    await button.click();
    await expect(button).toBeDisabled();
    await button.dispatchEvent('click');
    await expect.poll(() => fixture.actionRequests).toBe(1);
    await expect.poll(() => fixture.releaseAction !== null).toBe(true);
    fixture.releaseAction!();
    await expect(panel.getByText('Unable to update that notification. Try again.')).toBeVisible();
    await expect(panel.getByTestId('notification-card-123')).toBeVisible();
    await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
    fixture.holdActions = false;
    await button.click();
    if (action === 'read') await expect(page).toHaveURL((url) => url.pathname === '/weight');
    else await expect(panel.getByText('19 unread', { exact: true })).toBeVisible();
    expect(fixture.actionRequests).toBe(2);
  });
}

test('an offline reminder open settles without trapping the editor and can recover online', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page);
  await page.goto('/preferences');
  await hideTransientPwaNotices(page);
  const time = page.getByTestId('settings-food-reminder-time');
  await time.fill('08:30');
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  fixture.failActions = 1;
  expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/notifications/in-app/123/read', status: 503 });
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const confirmation = page.waitForEvent('dialog');
  const click = panel.getByTestId('notification-open-123').click();
  await (await confirmation).accept();
  await click;
  await expect(panel.getByText('Unable to update that notification. Try again.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Close notifications' })).toBeEnabled();
  await expect(panel.getByTestId('notification-card-123')).toBeVisible();
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close notifications' }).click();
  await expect(time).toHaveValue('08:30');
  await page.context().setOffline(false);
  fixture.failActions = 0;
  await page.getByTestId('notifications-button').click();
  const retryConfirmation = page.waitForEvent('dialog');
  const retryClick = panel.getByTestId('notification-open-123').click();
  await (await retryConfirmation).accept();
  await retryClick;
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
});

test('a successful reminder read navigates while its refresh is paused offline and recovers online', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page);
  await page.goto('/preferences');
  await hideTransientPwaNotices(page);
  const time = page.getByTestId('settings-food-reminder-time');
  const originalTime = await time.inputValue();
  await time.fill('08:30');
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  expectApiFailure(page, { method: 'GET', pathname: '/api/v1/notifications/in-app', status: 503 });
  let refreshStarted = false;
  await page.route('**/api/v1/notifications/in-app?*', async (route) => {
    refreshStarted = true;
    await page.context().setOffline(true);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Refresh unavailable.' }) });
  }, { times: 1 });
  const confirmation = page.waitForEvent('dialog');
  const click = panel.getByTestId('notification-open-123').click();
  await (await confirmation).accept();
  await click;
  await expect.poll(() => refreshStarted).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
  await expect(panel).toHaveCount(0);
  expect(fixture.actionRequests).toBe(1);
  expect(fixture.history.find(({ id }) => id === 123)?.read_at).not.toBeNull();
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  await expect(time).toHaveValue(originalTime);
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Open notifications, 19 unread', exact: true }).click();
  await expect(panel.getByTestId(/^notification-card-/)).toHaveCount(5);
  await expect(panel.getByTestId('notification-card-123')).toHaveCount(0);
  await expect(panel.getByText('19 unread', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close notifications' }).click();
});

test('a failed reminder read preserves the dirty Preferences draft and permits a guarded retry', async ({ page, ux }) => {
  await ux.install('populated');
  const fixture = await installNotificationApi(page);
  await page.goto('/preferences');
  await hideTransientPwaNotices(page);
  const time = page.getByTestId('settings-food-reminder-time');
  const originalTime = await time.inputValue();
  await time.fill('08:30');
  await page.getByTestId('notifications-button').click();
  const panel = page.getByTestId('notifications-drawer-panel');
  fixture.failActions = 1;
  fixture.holdActions = true;
  expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/notifications/in-app/123/read', status: 503 });
  const confirmation = page.waitForEvent('dialog');
  const click = panel.getByTestId('notification-open-123').click();
  await (await confirmation).accept();
  await click;
  const open = panel.getByTestId('notification-open-123');
  await expect(open).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Close notifications' })).toBeDisabled();
  await expect(panel.getByText('Opening reminder...', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('notifications-drawer-backdrop').click({ position: { x: 1, y: 1 } });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Tab');
  await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(time).toHaveValue('08:30');
  await open.dispatchEvent('click');
  await expect.poll(() => fixture.actionRequests).toBe(1);
  await expect.poll(() => fixture.releaseAction !== null).toBe(true);
  fixture.releaseAction!();
  await expect(panel.getByText('Unable to update that notification. Try again.')).toBeVisible();
  await expect(panel.getByTestId('notification-card-123')).toBeVisible();
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  await panel.getByRole('button', { name: 'Close notifications' }).click();
  await expect(time).toHaveValue('08:30');

  await page.getByTestId('notifications-button').click();
  const canceledConfirmation = page.waitForEvent('dialog');
  const canceledClick = panel.getByTestId('notification-open-123').click();
  await (await canceledConfirmation).dismiss();
  await canceledClick;
  expect(fixture.actionRequests).toBe(1);
  fixture.holdActions = false;
  const retryConfirmation = page.waitForEvent('dialog');
  const retryClick = panel.getByTestId('notification-open-123').click();
  await (await retryConfirmation).accept();
  await retryClick;
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
  expect(fixture.actionRequests).toBe(2);
  await expect(page.getByRole('dialog', { name: 'Weight entry', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  await expect(time).toHaveValue(originalTime);
  expect(fixture.readAllRequests).toBe(0);
  expect(fixture.listViews.every((view) => view === 'active')).toBe(true);
});

test('Preferences retains browser permission recovery and guarded reminder navigation', async ({ page, ux }) => {
  await ux.install('populated');
  await installDeniedBrowserPermission(page);
  const fixture = await installNotificationApi(page);
  await page.goto('/settings');
  await page.getByTestId('settings-open-profile').click();
  await page.getByTestId('settings-open-preferences').click();
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  await hideTransientPwaNotices(page);
  const delivery = page.getByTestId('settings-delivery-permission');
  await expect(delivery).toContainText('Enable notifications in this browser');
  await delivery.getByRole('button', { name: 'Enable push notifications' }).click();
  await expect(delivery).toContainText('Notifications are blocked for this site.');
  await delivery.getByRole('button', { name: 'Check again' }).click();
  await page.getByTestId('settings-food-reminder-time').fill('08:30');
  await page.getByTestId('notifications-button').click();
  const confirmation = page.waitForEvent('dialog');
  const canceledClick = page.getByTestId('notification-open-123').click();
  const guard = await confirmation;
  expect(guard.type()).toBe('confirm');
  expect(guard.message()).toContain('Discard changes?');
  await guard.dismiss();
  await canceledClick;
  await expect(page).toHaveURL((url) => url.pathname === '/preferences');
  expect(fixture.actionRequests).toBe(0);
  const panel = page.getByTestId('notifications-drawer-panel');
  await expect(panel.getByTestId('notification-card-123')).toBeVisible();
  await expect(panel.getByText('20 unread', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await expect(page.getByTestId('settings-food-reminder-time')).toHaveValue('08:30');
  await page.getByTestId('notifications-button').click();
  fixture.holdActions = true;
  const acceptedConfirmation = page.waitForEvent('dialog');
  const acceptedClick = panel.getByTestId('notification-open-123').click();
  await (await acceptedConfirmation).accept();
  await acceptedClick;
  const openButton = panel.getByTestId('notification-open-123');
  await expect(openButton).toBeDisabled();
  await openButton.dispatchEvent('click');
  await expect.poll(() => fixture.actionRequests).toBe(1);
  await expect.poll(() => fixture.releaseAction !== null).toBe(true);
  fixture.releaseAction!();
  await expect(page).toHaveURL((url) => url.pathname === '/weight');
  expect(fixture.actionRequests).toBe(1);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Weight entry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close weight entry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open notifications, 19 unread', exact: true }).getByTestId('notifications-badge')).toHaveText('19');
  expect(fixture.listViews.every((view) => view === 'active')).toBe(true);
});
