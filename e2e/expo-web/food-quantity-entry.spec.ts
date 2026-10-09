import { expect, hideTransientPwaNotices, test } from './fixtures';

const FOOD = {
  id: 901, type: 'FOOD', name: 'Quarter-cup oats', serving_size_quantity: 0.25,
  serving_unit_label: 'cup', calories_per_serving: 100, is_pinned: false,
};
const ENTRY = {
  id: 701, name: FOOD.name, meal_period: 'BREAKFAST' as const, calories: 100,
  servings_consumed: 1, serving_size_quantity_snapshot: 0.25,
  serving_unit_label_snapshot: 'cup', calories_per_serving_snapshot: 100,
};

test('selected food stays reachable in a short sheet and keeps the typed amount', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-phone-chrome', 'One touch browser viewport exercises the constrained sheet.');
  await ux.install('populated', { foodEntriesByDate: { '2026-07-21': [ENTRY] } });
  await page.route('**/api/v1/my-foods*', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/library')
      ? { items: [FOOD], next_cursor: null } : [FOOD],
  }));
  await page.route('**/api/v1/food/search?*', route => route.fulfill({ json: { items: [], provider: 'usda' } }));
  await page.goto('/food-log');
  await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: 'Add food', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add food', exact: true });
  await dialog.getByRole('radio', { name: 'Search', exact: true }).click();
  await dialog.getByLabel('Search foods').fill(FOOD.name);
  await dialog.getByText(FOOD.name, { exact: true }).click();
  const amount = dialog.getByRole('textbox', { name: 'Amount', exact: true });
  await amount.fill('0.125');
  await page.setViewportSize({ width: 390, height: 420 });
  await amount.focus();
  await amount.scrollIntoViewIfNeeded();
  await expect(amount).toBeInViewport({ ratio: 1 });
  const submit = dialog.getByRole('button', { name: 'Add & close', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport({ ratio: 1 });
  const request = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/v1/food');
  await submit.click();
  expect((await request).postDataJSON()).toMatchObject({ my_food_id: FOOD.id, servings_consumed: 0.125 });
  await expect(dialog).toBeHidden();
});

for (const blurBeforeSave of [false, true]) {
  test(`one-millionth amount edit survives ${blurBeforeSave ? 'blur then' : 'immediate'} save and reload`, async ({ page, ux }, testInfo) => {
    test.skip(testInfo.project.name !== 'android-phone-chrome', 'One touch browser covers input and mutation ordering.');
    await ux.install('populated', { foodEntriesByDate: { '2026-07-21': [ENTRY] } });
    await page.goto('/food-log');
    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: `Edit ${FOOD.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit food', exact: true });
    const amount = dialog.getByRole('textbox', { name: 'Amount', exact: true });
    await expect(amount).toHaveValue('0.25');
    await amount.fill('0.250001');
    if (blurBeforeSave) await amount.press('Tab');
    const request = page.waitForRequest(request => request.method() === 'PATCH'
      && new URL(request.url()).pathname === '/api/v1/food/701');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ servings_consumed: 1.000004 });
    await expect(dialog).toBeHidden();
    await page.reload();
    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: `Edit ${FOOD.name}`, exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('0.250001');
  });
}
