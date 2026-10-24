/** @file Regression coverage for today add food. */

import { expect, test, hideTransientPwaNotices, type AuthenticatedApiOptions } from './fixtures';

for (const status of ['COMPLETE', 'INCOMPLETE'] as const) {
  test(`Today reopens a ${status} day before offering its direct Add food action`, async ({ page, ux }, testInfo) => {
    const date = status === 'COMPLETE' ? '2026-07-21' : '2026-07-18';
    const options: AuthenticatedApiOptions = { foodDayStatus: status };
    await ux.install('populated', options);
    let reopenCount = 0;
    await page.route('**/api/v1/food-days**', async (route) => {
      if (route.request().method() === 'PATCH') {
        expect(route.request().postDataJSON()).toEqual({ date, status: 'OPEN' });
        options.foodDayStatus = 'OPEN';
        reopenCount += 1;
      }
      await route.fallback();
    });
    await page.goto(`/today?date=${date}`);
    await hideTransientPwaNotices(page);
    const addFood = page.getByRole('button', { name: 'Add food', exact: true });
    const editDay = page.getByRole('button', { name: status === 'COMPLETE' ? 'Day completed' : 'Edit day', exact: true });
    await expect(editDay).toBeVisible();
    if (status === 'COMPLETE') await expect(addFood).toBeDisabled();
    else await expect(addFood).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toHaveCount(0);
    expect((await editDay.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: testInfo.outputPath(`today-${status}-edit-day.png`) });
    expect(reopenCount).toBe(0);
    await editDay.click();
    await expect(addFood).toBeVisible();
    await expect(editDay).toHaveCount(0);
    expect(reopenCount).toBe(1);
    expect((await addFood.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await page.screenshot({ path: testInfo.outputPath(`today-${status}-add-food.png`) });
    await addFood.click();
    const sheet = page.getByRole('dialog', { name: 'Add food', exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Adding food reopens this day so you can complete it again.')).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === date);
    await page.screenshot({ path: testInfo.outputPath(`today-${status}-add-food-sheet.png`) });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(reopenCount).toBe(1);
    await expect(addFood).toBeFocused();

    await addFood.click();
    await sheet.getByRole('radio', { name: 'Quick', exact: true }).click();
    await sheet.getByRole('textbox', { name: 'Calories', exact: true }).fill('120');
    await sheet.getByRole('textbox', { name: 'Food name (optional)', exact: true }).fill('Extra afternoon snack');
    const foodRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/food');
    await sheet.getByRole('button', { name: 'Add & close', exact: true }).click();
    const loggedFood = (await foodRequest).postDataJSON();
    expect(loggedFood).toMatchObject({ date, name: 'Extra afternoon snack', calories: 120 });
    expect(reopenCount).toBe(1);
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname === '/today' && url.searchParams.get('date') === date);
    const addedRow = page.getByTestId('today-food-preview').getByTestId(`food-preview-meal-${loggedFood.meal_period}`);
    const expectedCalories = loggedFood.meal_period === 'BREAKFAST' ? '480 kcal' : '120 kcal';
    await expect(addedRow).toContainText(expectedCalories);
    await expect(page.getByTestId('today-food-preview')).toContainText('2 foods');
    await expect(page.getByTestId('today-food-preview').getByText('Extra afternoon snack', { exact: true })).toHaveCount(0);
    await expect(addFood).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeVisible();
  });
}
