/** @file Regression coverage for nested settings routes: promoted settings routes have category fallbacks on direct entry. */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, expectApiFailure, hideTransientPwaNotices, test } from './fixtures';

const destinations = [
  { path: '/profile-details', parent: '/profile', back: 'Profile & preferences', title: 'Profile details' },
  { path: '/preferences', parent: '/profile', back: 'Profile & preferences', title: 'Preferences' },
  { path: '/devices', parent: '/security', back: 'Security & access', title: 'Signed-in devices' },
  { path: '/health-connect', parent: '/connections', back: 'Connections', title: 'Health Connect' },
  { path: '/watch', parent: '/connections', back: 'Connections', title: 'Galaxy Watch' },
  { path: '/connected-apps', parent: '/connections', back: 'Connections', title: 'Connected assistants' },
] as const;

test('promoted settings routes have category fallbacks on direct entry', async ({ context, ux }) => {
  await ux.install('populated');
  for (const destination of destinations) {
    const page = await context.newPage();
    await ux.installOnPage(page);
    await page.goto(destination.path);
    await expect(page.getByRole('heading', { name: destination.title, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to ' + destination.back, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === destination.parent);
    await page.close();
  }
});

for (const editor of [
  { path: '/profile-details', title: 'Profile details', field: 'Height', value: '181', endpoint: 'profile', save: 'Save' },
  { path: '/preferences', title: 'Preferences', field: 'Food reminder time', value: '08:30', endpoint: 'preferences', save: 'Save preferences' },
]) {
  test(editor.title + ' preserves a draft when back is cancelled and discards on confirmation', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/profile');
    await page.getByRole('button', { name: editor.title, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === editor.path);
    const field = page.getByRole('textbox', { name: editor.field, exact: true });
    await field.fill(editor.value);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === editor.path);
    await expect(field).toHaveValue(editor.value);

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === editor.path);
    await expect(field).toHaveValue(editor.value);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/profile');
    await page.goForward();
    await expect(page).toHaveURL((url) => url.pathname === editor.path);
    await expect(field).not.toHaveValue(editor.value);
    await field.fill(editor.value);
    page.once('dialog', (dialog) => dialog.accept());
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === '/profile');
  });

  test(editor.title + ' guards tab and header pushes and re-arms on return', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/profile');
    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: editor.title, exact: true }).click();
    const field = page.getByRole('textbox', { name: editor.field, exact: true });
    const originalValue = await field.inputValue();
    const destinations = [
      { control: page.getByRole('tab', { name: /Today$/ }), path: '/today' },
      { control: page.getByRole('tab', { name: /Progress$/ }), path: '/progress' },
      { control: page.getByRole('button', { name: 'Account & settings', exact: true }), path: '/settings' },
    ];
    for (const destination of destinations) {
      const activate = () => destination.path === '/progress'
        ? destination.control.press('Enter')
        : destination.control.click();
      await field.fill(editor.value);
      let cancelled = false;
      page.once('dialog', async (dialog) => { cancelled = true; await dialog.dismiss(); });
      await activate();
      await expect(page).toHaveURL((url) => url.pathname === editor.path);
      await expect(field).toHaveValue(editor.value);
      expect(cancelled).toBe(true);

      page.once('dialog', (dialog) => dialog.accept());
      await activate();
      await expect(page).toHaveURL((url) => url.pathname === destination.path);
      await page.goBack();
      await expect(page).toHaveURL((url) => url.pathname === editor.path);
      await expect(field).toHaveValue(originalValue);
    }
  });

  test(editor.title + ' blocks tabs and pushes while saving', async ({ page, ux }) => {
    await ux.install('populated');
    expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/user/' + editor.endpoint, status: 500 });
    let releaseSave = () => {};
    const pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    await page.route('**/api/v1/user/' + editor.endpoint, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await pendingSave;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Save failed' }) });
    });
    await page.goto(editor.path);
    await hideTransientPwaNotices(page);
    const field = page.getByRole('textbox', { name: editor.field, exact: true });
    await field.fill(editor.value);
    await page.getByRole('button', { name: editor.save, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
    const prompts: string[] = [];
    page.on('dialog', async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
    try {
      for (const control of [
        page.getByRole('tab', { name: /Today$/ }),
        page.getByRole('tab', { name: /Progress$/ }),
        page.getByRole('button', { name: 'Account & settings', exact: true }),
      ]) {
        await control.click();
        await expect(page).toHaveURL((url) => url.pathname === editor.path);
        await expect(field).toHaveValue(editor.value);
      }
      expect(prompts).toEqual([]);
    } finally {
      releaseSave();
    }
    await expect(page.getByRole('button', { name: editor.save, exact: true })).toBeEnabled();
    await page.getByRole('tab', { name: /Today$/ }).click();
    await expect(page).toHaveURL((url) => url.pathname === editor.path);
    expect(prompts).toHaveLength(1);
  });
}

test('Today weight entry stays on Today and can be opened again', async ({ page, ux }) => {
  await ux.install('populated');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByTestId('today-weight-card-press-layer').click();
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    const dialog = page.getByRole('dialog', { name: 'Weight entry', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL((url) => url.pathname === '/today');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('today-weight-card-press-layer')).toBeFocused();
  }
});

test('Today saves the selected historical weight without changing tabs', async ({ page, ux }) => {
  await ux.install('populated');
  const selectedDate = '2026-07-11';
  let savedWeight = 89;
  await page.route('**/api/v1/metrics', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({ date: selectedDate, weight: 88.9 });
      savedWeight = payload.weight;
      await route.fulfill({ json: { id: 2, date: selectedDate, weight: savedWeight } });
      return;
    }
    await route.fulfill({ json: [{ id: 2, date: selectedDate, weight: savedWeight }] });
  });
  await page.goto(`/today?date=${selectedDate}`);
  await hideTransientPwaNotices(page);
  const weightRow = page.getByTestId('today-weight-card-press-layer');
  await weightRow.click();
  const dialog = page.getByRole('dialog', { name: 'Weight entry', exact: true });
  const input = dialog.getByRole('textbox', { name: 'Weight in kilograms', exact: true });
  await expect(input).toHaveValue('89');
  await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === selectedDate);
  await input.fill('88.9');
  await dialog.getByRole('button', { name: 'Save weight', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Weight progress update', exact: true });
  await expect(result.getByLabel('Saved weight 88.9 kg', { exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === selectedDate);
  await result.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(weightRow).toContainText('88.9 kg');
  await expect(weightRow).toBeFocused();
  await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === selectedDate);
});

test('web direct links do not expose Android integration controls', async ({ page, ux }) => {
  await ux.install('populated');
  await page.goto('/connections');
  await expect(page.getByRole('button', { name: 'Health Connect', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Galaxy Watch', exact: true })).toHaveCount(0);
  await page.goto('/health-connect');
  await expect(page.getByText('Health Connect is available in the Android app.')).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);
  await page.goto('/watch');
  await expect(page.getByText('Galaxy Watch pairing is available in the Android app.')).toBeVisible();
  await expect(page.getByRole('button', { name: /check.*watch/i })).toHaveCount(0);
});

test('nested settings PR screenshot evidence', async ({ page, ux }, testInfo) => {
  test.skip(process.env.CALIBRATE_CAPTURE_EVIDENCE !== '1', 'Screenshot capture is opt-in.');
  test.skip(!['desktop-chrome', 'android-phone-chrome'].includes(testInfo.project.name));
  const phone = testInfo.project.name === 'android-phone-chrome';
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1024, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await ux.install('populated');
  const directory = path.resolve('.codex-screenshots');
  await page.route('**/auth/sessions', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ sessions: [
      { id: 'browser_current', kind: 'browser', device_label: 'Chrome on Windows', current: true,
        created_at: '2026-08-01T12:00:00.000Z', last_activity_at: '2026-08-27T12:00:00.000Z' },
      { id: 'mobile_remote', kind: 'android_phone', device_label: 'Pixel 9', current: false,
        created_at: '2026-08-01T12:00:00.000Z', last_activity_at: null },
    ] }),
  }));
  await mkdir(directory, { recursive: true });
  const shots = phone ? [
    { path: '/preferences', file: 'nested-content-preferences-phone-390x844.png' },
  ] : [
    { path: '/settings', file: 'nested-content-settings-desktop-1024x1000.png' },
    { path: '/profile-details', file: 'nested-content-profile-desktop-1024x1000.png' },
    { path: '/devices', file: 'nested-content-devices-contextual-sheet-desktop-1024x1000.png' },
  ];
  for (const shot of shots) {
    await page.goto(shot.path);
    await hideTransientPwaNotices(page);
    const title = shot.path === '/settings' ? 'Settings' : destinations.find((entry) => entry.path === shot.path)!.title;
    await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
    if (shot.path === '/devices') {
      await page.getByTestId('settings-session-revoke-mobile_remote').click();
      await expect(page.getByRole('dialog', { name: 'Revoke signed-in session?', exact: true })).toBeVisible();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(directory, shot.file), fullPage: false });
  }
});
