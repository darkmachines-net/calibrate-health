/** @file Regression coverage for server admin: administrator changes persist and gate scanner entry points. */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { expect, hideTransientPwaNotices, test } from './fixtures';

test('administrator changes persist and gate scanner entry points', async ({ page, ux }, testInfo) => {
    await ux.install('populated');
    let enabled = false;
    await page.route('**/api/v1/server-settings', async (route) => {
        if (route.request().method() === 'PATCH') {
            enabled = route.request().postDataJSON().features.nutrition_label_scanning;
        }
        await route.fulfill({ json: { is_admin: true, features: { nutrition_label_scanning: enabled } } });
    });
    await page.goto('/settings');
    await page.getByRole('link', { name: 'Server administration', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Nutrition label scanning', exact: true });
    await expect(toggle).not.toBeChecked();
    await hideTransientPwaNotices(page);
    const directory = path.resolve('.codex-screenshots/server-admin');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${testInfo.project.name}-disabled.png`), fullPage: true });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText('Server settings saved.', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(directory, `${testInfo.project.name}-enabled.png`), fullPage: true });
    await page.goto('/my-foods');
    await expect(page.getByRole('button', { name: 'Scan label', exact: true })).toBeVisible();
    await page.goto('/server-admin');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.goto('/my-foods');
    await expect(page.getByRole('button', { name: 'Create food', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan label', exact: true })).toHaveCount(0);
    await page.goto('/nutrition-label');
    await expect(page.getByText(/scanning is unavailable on this server/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose photo', exact: true })).toHaveCount(0);
});

test('members cannot access administrator controls through navigation or a direct URL', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: 'Server administration', exact: true })).toHaveCount(0);
    await page.goto('/server-admin');
    await expect(page.getByText(/administrator access is required/)).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
});
