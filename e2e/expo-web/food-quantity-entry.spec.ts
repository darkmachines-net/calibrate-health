/** @file Quantity-entry regressions for keyboard viewport changes, constrained sheets, and persisted six-decimal edits. */

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

for (const mode of ['add', 'edit'] as const) {
  test(`${mode} keeps keyboard focus while revealing content above an overlay keyboard`, async ({ page, ux }, testInfo) => {
    test.skip(testInfo.project.name !== 'android-phone-chrome', 'Exercise the visual viewport separately from the layout viewport.');
    await ux.install('populated', { foodEntriesByDate: { '2026-07-21': [ENTRY] } });
    await page.route('**/api/v1/my-foods*', route => route.fulfill({ json:
      new URL(route.request().url()).pathname.endsWith('/library')
        ? { items: [FOOD], next_cursor: null } : [FOOD],
    }));
    await page.route('**/api/v1/food/search?*', route => route.fulfill({ json: { items: [], provider: 'usda' } }));
    await page.goto('/food-log');
    await hideTransientPwaNotices(page);
    const isAdd = mode === 'add';
    await page.getByRole('button', { name: isAdd ? 'Add food' : `Edit ${FOOD.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: isAdd ? 'Add food' : 'Edit food', exact: true });
    if (isAdd) {
      await dialog.getByRole('radio', { name: 'Search', exact: true }).click();
      await dialog.getByLabel('Search foods').fill(FOOD.name);
      await dialog.getByText(FOOD.name, { exact: true }).click();
    }
    const amount = dialog.getByRole('textbox', { name: 'Amount', exact: true });
    await amount.fill('0.125');
    await amount.focus();
    // Model an overlay IME: the layout viewport stays tall while the visible area shrinks.
    const viewport = await page.evaluate(() => {
      const height = Math.round(window.innerHeight / 2);
      const top = 48; // A browser can pan the visual viewport without scrolling the layout viewport.
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => height });
      Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => top });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      return { height, top };
    });
    const root = page.getByTestId('bottom-sheet-root');
    await expect.poll(async () => (await root.boundingBox())?.height).toBe(viewport.height);
    await expect.poll(async () => (await root.boundingBox())?.y).toBe(viewport.top);
    await expect(amount).toBeFocused();
    await expect.poll(async () => {
      const box = await amount.boundingBox();
      return Boolean(box && box.y >= viewport.top && box.y + box.height <= viewport.top + viewport.height);
    }).toBe(true);

    const submit = dialog.getByRole('button', { name: isAdd ? 'Add & close' : 'Save', exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const box = await submit.boundingBox();
      return Boolean(box && box.y >= viewport.top && box.y + box.height <= viewport.top + viewport.height);
    }).toBe(true);
    await expect(amount).toBeFocused();
    await expect(amount).toHaveValue('0.125');
    // Dismissal restores the full sheet without dropping the draft.
    await amount.blur();
    const restoredHeight = await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'height');
      Reflect.deleteProperty(window.visualViewport!, 'offsetTop');
      window.visualViewport!.dispatchEvent(new Event('resize'));
      return Math.round(window.visualViewport!.height);
    });
    await expect.poll(async () => (await root.boundingBox())?.height).toBe(restoredHeight);
    await expect.poll(async () => (await root.boundingBox())?.y).toBe(0);
    await expect(amount).toHaveValue('0.125');
    const request = page.waitForRequest(request => request.method() === (isAdd ? 'POST' : 'PATCH')
      && new URL(request.url()).pathname === (isAdd ? '/api/v1/food' : '/api/v1/food/701'));
    await submit.click();
    expect((await request).postDataJSON()).toMatchObject({ servings_consumed: isAdd ? 0.125 : 0.5 });
    await expect(dialog).toBeHidden();
  });
}

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
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === '/api/v1/food/701');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({ servings_consumed: 1.000004 });
    expect((await saved).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    await page.reload();
    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: `Edit ${FOOD.name}`, exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Amount', exact: true })).toHaveValue('0.250001');
  });
}
