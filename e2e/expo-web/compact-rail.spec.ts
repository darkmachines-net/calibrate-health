/** @file Regression coverage for compact rail: rail links, keyboard, history, resizing and enlarged text. */

import { expect, hideTransientPwaNotices, test } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';

test.use({ serviceWorkers: 'block' });

for (const width of [1024, 1440]) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const route of ['today', 'progress']) {
      test(`compact rail ${route} ${width} ${scheme}`, async ({ page, ux }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop-chrome');
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: scheme });
        await ux.install('populated');
        await page.goto(`/${route}`);
        await hideTransientPwaNotices(page);
        await expect(page.getByRole('heading', { name: route === 'today' ? 'Daily balance' : 'Snapshot', exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(scheme);
        const tab = page.getByRole('tab', { name: route === 'today' ? /Today$/ : /Progress$/ });
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        expect((await page.getByTestId('web-navigation-rail').boundingBox())!.width).toBe(88);
        for (const label of ['Today', 'Progress']) {
          const target = page.getByRole('tab', { name: label, exact: true });
          const bounds = (await target.boundingBox())!;
          expect(bounds.width).toBeGreaterThanOrEqual(48);
          expect(bounds.height).toBeGreaterThanOrEqual(48);
          expect(await target.locator('span').last().evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      });
    }
  }
}

test('rail links, keyboard, history, resizing and enlarged text', async ({ page, ux, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome');
  await ux.install('empty');
  await page.goto('/today');
  await hideTransientPwaNotices(page);
  const today = page.getByRole('tab', { name: /Today$/ });
  const progress = page.getByRole('tab', { name: /Progress$/ });
  await expect(today).toHaveAttribute('href', '/today');
  await expect(progress).toHaveAttribute('href', '/progress');
  for (let count = 0; count < 60 && !await progress.evaluate(node => node === document.activeElement); count++) {
    await page.keyboard.press('Tab');
  }
  await expect(progress).toBeFocused();
  expect(await progress.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/progress$/);
  await expect(progress).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\/today$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/progress$/);
  const popupPromise = context.waitForEvent('page');
  await today.click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await popup.waitForURL(/\/today$/);
  await popup.close();
  await expect(page).toHaveURL(/\/progress$/);
  // Move the pointer away before resizing so it does not hover a relocated control.
  await page.mouse.move(0, 0);
  for (const width of [1023, 1024, 820, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(progress).toBeVisible();
    // A breakpoint replaces the tab host; wait for the destination geometry, not the outgoing node.
    await expect.poll(async () => {
      const bounds = await progress.boundingBox();
      if (!bounds) return false;
      if (width < 1024) return bounds.y > 700;
      return bounds.x < 176;
    }).toBe(true);
    await expect(progress).toHaveAttribute('aria-selected', 'true');
  }
  await page.setViewportSize({ width: 1024, height: 480 });
  await applyTwoHundredPercentText(page);
  await expect(progress).toBeVisible();
  expect(await progress.locator('span').last().evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`rail shell alignment, feedback, notifications and offline notice ${scheme}`, async ({ page, ux }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome');
    await page.emulateMedia({ colorScheme: scheme });
    const fixture = await ux.install('populated');
    await page.route('**/api/v1/notifications/in-app**', route => route.fulfill({ json: {
      notifications: [{ id: 1, type: 'LOG_WEIGHT_REMINDER', local_date: '2026-07-21',
        title: 'Time to weigh in', body: 'Keep your trend current.', action_url: '/log?quickAdd=weight',
        read_at: null, dismissed_at: null, created_at: '2026-07-21T12:00:00.000Z' }], unread_count: 1,
    } }));
    await page.goto('/food-log');
    await hideTransientPwaNotices(page);
    await expect(page.getByRole('heading', { name: 'Meals', exact: true })).toBeVisible();
    const today = page.getByRole('tab', { name: /Today$/ });
    await expect(today).toHaveAttribute('aria-selected', 'true');
    const fab = page.getByRole('button', { name: 'Add food', exact: true });
    const date = page.getByRole('toolbar', { name: 'Food log date' });
    const fabBox = (await fab.boundingBox())!;
    const dateBox = (await date.boundingBox())!;
    expect(Math.abs(fabBox.x + fabBox.width - dateBox.x - dateBox.width)).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Meals', exact: true })).toBeVisible();
    await expect(today).toHaveAttribute('aria-selected', 'true');
    const notifications = page.getByRole('button', { name: 'Open notifications, 1 unread', exact: true });
    await expect(notifications).toBeVisible();
    await notifications.click();
    await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(page.getByText('Time to weigh in', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await fixture.activateOffline();
    await expect(page.getByText("You're offline", { exact: true })).toBeVisible();
    await expect(today).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account & settings', exact: true })).toBeVisible();
    await page.context().setOffline(false);
    await hideTransientPwaNotices(page);
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await expect(today).toHaveAttribute('aria-selected', 'true');
    const pill = today.locator('[data-rail-pill]');
    const selectedBackground = await pill.evaluate(node => getComputedStyle(node).backgroundColor);
    await today.hover();
    expect(await pill.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
    await page.mouse.down();
    expect(await pill.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(selectedBackground);
    await page.mouse.up();
    await page.emulateMedia({ forcedColors: 'active' });
    await today.hover();
    expect(await pill.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('dashed');
    await page.mouse.down();
    expect(await pill.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('double');
    await page.mouse.up();
  });
}
