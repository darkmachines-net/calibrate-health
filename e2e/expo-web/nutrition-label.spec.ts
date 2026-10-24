/** @file Regression coverage for nutrition label: photo upload is reviewed, titled, and saved with the printed serving size. */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { expect, hideTransientPwaNotices, test } from './fixtures';

const LABEL_PHOTO = path.resolve('backend/test/fixtures/nutrition-label.png');
const draft = {
    calories_per_serving: 190, serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)',
    serving_text: '2 tbsp (32 g)', warnings: []
};

test('photo upload is reviewed, titled, and saved with the printed serving size', async ({ page, ux }, testInfo) => {
    await ux.install('populated');
    await page.route('**/api/v1/server-settings', (route) => route.fulfill({ json: {
        is_admin: false, features: { nutrition_label_scanning: true }
    } }));
    const saved: Record<string, unknown>[] = [];
    await page.route('**/api/v1/nutrition-labels/scan', async (route) => {
        expect(route.request().headers()['content-type']).toContain('multipart/form-data');
        // Browser interception omits uploaded file bytes but retains multipart field metadata.
        expect(route.request().postData()).toContain('name="image"');
        await route.fulfill({ json: draft });
    });
    await page.route('**/api/v1/my-foods/library*', (route) => route.fulfill({ json: { items: saved, next_cursor: null } }));
    await page.route('**/api/v1/my-foods/foods', async (route) => {
        saved.push({ id: 701, type: 'FOOD', is_pinned: false, ...route.request().postDataJSON() });
        await route.fulfill({ json: saved[0] });
    });
    await page.goto('/my-foods');
    await page.getByRole('button', { name: 'Scan label', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scan nutrition label', exact: true })).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose photo', exact: true }).click();
    await (await chooserPromise).setFiles(LABEL_PHOTO);
    await expect(page.getByLabel('Calories per serving', { exact: false })).toHaveValue('190');
    await expect(page.getByLabel('Serving quantity', { exact: false })).toHaveValue('2');
    await expect(page.getByLabel('Serving unit', { exact: false })).toHaveValue('tbsp (32 g)');
    expect(saved).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Save food', exact: true })).toBeDisabled();
    await page.getByLabel('Food title', { exact: false }).fill('Label-scanned peanut butter');
    await page.getByLabel('Calories per serving', { exact: false }).fill('200');
    const widths = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await page.getByRole('heading', { name: 'Scan nutrition label', exact: true }).scrollIntoViewIfNeeded();
    await hideTransientPwaNotices(page);
    await page.screenshot({ path: testInfo.outputPath('label-photo.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save food', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('label-review.png'), fullPage: true });
    if (process.env.CALIBRATE_CAPTURE_EVIDENCE === '1' &&
        ['desktop-chrome', 'compact-phone-chrome'].includes(testInfo.project.name)) {
        const directory = path.resolve('.codex-screenshots/nutrition-label-scanning');
        await mkdir(directory, { recursive: true });
        const device = testInfo.project.name === 'desktop-chrome' ? 'desktop' : 'phone';
        await page.screenshot({ path: path.join(directory, `review-${device}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Save food', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Food saved', exact: true })).toBeVisible();
    expect(saved).toEqual([{
        id: 701, type: 'FOOD', is_pinned: false, name: 'Label-scanned peanut butter',
        calories_per_serving: 200, serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)'
    }]);
    await page.getByRole('button', { name: 'View saved foods', exact: true }).click();
    await expect(page.getByText('Label-scanned peanut butter', { exact: true })).toBeVisible();
});

test('label scanning is reachable for both missing and incorrect barcode matches', async ({ page, ux }) => {
    await ux.install('populated');
    await page.route('**/api/v1/server-settings', (route) => route.fulfill({ json: {
        is_admin: false, features: { nutrition_label_scanning: true }
    } }));
    let hasMatch = false;
    await page.route('**/api/v1/food/search?**', (route) => route.fulfill({ json: {
        items: hasMatch ? [{
            id: 'wrong-match', source: 'openFoodFacts', description: 'Wrong barcode food',
            nutrientsPer100g: { calories: 100 },
            availableMeasures: [{ label: '100 g', gramWeight: 100, quantity: 100, unit: 'g' }]
        }] : [],
        provider: 'openFoodFacts'
    } }));
    for (const match of [false, true]) {
        hasMatch = match;
        await page.goto('/barcode?date=2026-07-21&meal=DINNER&returnTo=food-log');
        await page.getByRole('button', { name: 'Enter barcode', exact: true }).click();
        await page.getByLabel('EAN or UPC barcode').fill('012345678905');
        await page.getByRole('button', { name: 'Look up barcode', exact: true }).click();
        if (match) await expect(page.getByText('Found Wrong barcode food.', { exact: true })).toBeVisible();
        else await expect(page.getByText(/No food matched this barcode/)).toBeVisible();
        await hideTransientPwaNotices(page);
        await page.getByRole('button', { name: 'Scan nutrition label', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Scan nutrition label', exact: true })).toBeVisible();
    }
});
