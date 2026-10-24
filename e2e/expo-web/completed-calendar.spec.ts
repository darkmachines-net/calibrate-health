/** @file Regression coverage for completed calendar: calendar refresh, uncached month failure, retry, and completion reopening stay honest. */

import { expect, test, expectApiFailure, hideTransientPwaNotices, type AuthenticatedApiOptions } from './fixtures';
import { calibrateDesignTokens } from '../../shared/designTokens';
import { applyTwoHundredPercentText } from './text-scaling';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';

const comparisons = [
  [0, 2000, 2500, 'target'], [1999, 2000, 2500, 'target'], [2000, 2000, 2500, 'target'],
  [2001, 2000, 2500, 'between'], [2499, 2000, 2500, 'between'], [2500, 2000, 2500, 'between'], [2501, 2000, 2500, 'beyond'],
  [2499, 3000, 2500, 'beyond'], [2500, 3000, 2500, 'between'], [2501, 3000, 2500, 'between'],
  [2999, 3000, 2500, 'between'], [3000, 3000, 2500, 'target'], [3001, 3000, 2500, 'target'],
  [2499, 2500, 2500, 'target'], [2500, 2500, 2500, 'target'], [2501, 2500, 2500, 'beyond']
] as const;
const incompleteNumbers = new Set([1, 4, 7, 8, 9, 12, 14, 16]);
function date(number: number) { return `2026-07-${String(number).padStart(2, '0')}`; }
function row(number: number, status = 'COMPLETE', source = 'STORED') {
  return { date: date(number), status, source, origin: 'USER', is_complete: status === 'COMPLETE', is_representative: status === 'COMPLETE', completed_at: null, updated_at: null, calorie_comparison: null as null | { consumed_kcal: number; target_kcal: number; maintenance_kcal: number; captured_at: string } };
}
function history() {
  return [...comparisons.map(([consumed, target, maintenance], index) => ({ ...row(index + 1, incompleteNumbers.has(index + 1) ? 'INCOMPLETE' : 'COMPLETE'), calorie_comparison: {
    consumed_kcal: consumed, target_kcal: target, maintenance_kcal: maintenance, captured_at: date(index + 1) + 'T19:00:00Z'
  } })), row(17), row(18, 'INCOMPLETE'), row(19, 'INCOMPLETE', 'INFERRED_EMPTY'), row(20, 'PAUSED'), {
    ...row(21, 'OPEN'), calorie_comparison: { consumed_kcal: 2100, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-21T19:00:00Z' }
  }];
}
function rgb(hex: string) { return `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`; }

for (const colorScheme of ['light', 'dark'] as const) {
  test(`completed calendar boundaries and selection in ${colorScheme}`, async ({ page, ux }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await ux.install('populated');
    await page.route('**/api/v1/food-days/range?*', route => route.fulfill({ json: { start_date: date(1), end_date: date(21), days: history() } }));
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: 'Choose date', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Calendar' })).toBeVisible();
    const colors = calibrateDesignTokens.schemes[colorScheme];
    for (const [index, [consumed, target, maintenance, band]] of comparisons.entries()) {
      const day = page.getByTestId(`calendar-day-${date(index + 1)}`);
      const gain = target > maintenance;
      let label = gain ? 'at or above target' : 'at or below target';
      if (band === 'between') label = gain ? 'below target, at or above maintenance' : 'above target, at or below maintenance';
      if (band === 'beyond') label = gain ? 'below maintenance' : 'above maintenance';
      const incomplete = incompleteNumbers.has(index + 1);
      await expect(day, `${consumed}/${target}/${maintenance}`).toHaveAccessibleName(new RegExp((incomplete ? 'incomplete, ' : 'completed, ') + label));
      const background = { target: colors.success, between: colors.calendarBetween, beyond: colors.calendarBeyond }[band];
      const badge = page.getByTestId(`calendar-date-badge-${date(index + 1)}`);
      if (incomplete) {
        await expect(badge).toHaveCSS('border-color', rgb(background));
        await expect(badge).toHaveCSS('border-top-width', '2px');
        await expect(badge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      } else {
        await expect(badge).toHaveCSS('background-color', rgb(background));
      }
      await expect(page.getByTestId(`calendar-date-badge-${date(index + 1)}`)).toHaveText(String(index + 1));
    }
    await expect(page.getByTestId('calendar-day-2026-07-17')).toHaveAccessibleName(/completed, comparison unavailable/);
    await expect(page.getByTestId('calendar-date-badge-2026-07-17')).toHaveText('17');
    await expect(page.getByTestId('calendar-date-badge-2026-07-17')).toHaveCSS('background-color', rgb(colors.success));
    const keyToggle = page.getByRole('button', { name: 'Calendar key', exact: true });
    await expect(keyToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('calendar-key-content')).toHaveCount(0);
    await keyToggle.click();
    await expect(keyToggle).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Met target', 'Near target', 'Off target']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Complete: comparison unavailable', { exact: true })).toHaveCount(0);
    const alignment = await Promise.all(['Met target', 'Near target', 'Off target'].map(label =>
      page.getByText(label, { exact: true }).locator('..').evaluate(element => {
        const column = element.getBoundingClientRect();
        const children = Array.from(element.children).map(child => child.getBoundingClientRect());
        return { columnLeft: column.left, columnRight: column.right, contentLeft: children[0].left, contentRight: children[children.length - 1].right };
      })));
    expect(Math.abs(alignment[0].contentLeft - alignment[0].columnLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs((alignment[1].contentLeft + alignment[1].contentRight) - (alignment[1].columnLeft + alignment[1].columnRight))).toBeLessThanOrEqual(1);
    expect(Math.abs(alignment[2].contentRight - alignment[2].columnRight)).toBeLessThanOrEqual(1);
    const pausedCircle = (await page.getByTestId('calendar-date-badge-2026-07-20').boundingBox())!;
    const pauseGlyph = (await page.getByTestId('calendar-pause-glyph-2026-07-20').boundingBox())!;
    expect(pauseGlyph.width).toBe(8);
    expect(pauseGlyph.height).toBe(8);
    expect(pauseGlyph.y + pauseGlyph.height).toBeLessThanOrEqual(pausedCircle.y + pausedCircle.height - 3);
    expect(pauseGlyph.x).toBeGreaterThan(pausedCircle.x + 3);
    const notStartedBadge = page.getByTestId('calendar-date-badge-2026-07-19');
    await expect(notStartedBadge).toHaveCSS('background-color', rgb(colors.surfaceContainer));
    await expect(notStartedBadge).toHaveCSS('border-top-width', '0px');
    const notStartedCircle = (await notStartedBadge.boundingBox())!;
    const xGlyph = (await page.getByTestId('calendar-not-started-glyph-2026-07-19').boundingBox())!;
    expect(xGlyph.width).toBe(8); expect(xGlyph.height).toBe(8);
    expect(xGlyph.y + xGlyph.height).toBeLessThanOrEqual(notStartedCircle.y + notStartedCircle.height - 3);
    await expect(page.getByTestId('calendar-marker-incomplete')).toHaveCSS('border-color', rgb(colors.onSurfaceVariant));
    await expect(page.getByTestId('calendar-marker-paused')).toHaveCSS('border-color', rgb(colors.onSurfaceVariant));
    await page.getByRole('dialog', { name: 'Calendar' }).screenshot({ path: testInfo.outputPath('calendar-key-expanded.png') });
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'overlay', surfaceId: 'expanded-calendar-key' });
    await expect(page.getByTestId('calendar-color-guide')).toHaveCount(0);
    await page.getByRole('button', { name: 'How colors work', exact: true }).click();
    await expect(page.getByText('Between the saved target and maintenance.', { exact: true })).toBeVisible();
    await keyToggle.click();
    await expect(page.getByTestId('calendar-key-content')).toHaveCount(0);
    await page.getByRole('dialog', { name: 'Calendar' }).screenshot({ path: testInfo.outputPath('calendar-key-collapsed.png') });
    await expect(page.getByTestId('calendar-day-2026-07-18')).toHaveAccessibleName(/incomplete/);
    await expect(page.getByTestId('calendar-day-2026-07-19')).toHaveAccessibleName(/not started/);
    await expect(page.getByTestId('calendar-day-2026-07-20')).toHaveAccessibleName(/tracking paused/);
    await expect(page.getByTestId('calendar-day-2026-07-22')).toBeDisabled();
    await page.getByTestId('calendar-day-2026-07-09').click();
    await expect(page.getByRole('dialog', { name: 'Calendar' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose date', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Calendar key', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('calendar-day-2026-07-09')).toHaveAccessibleName(/incomplete, below target, at or above maintenance, selected$/);
    await page.evaluate(() => document.fonts.ready);
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'completed-calendar' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Calendar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toBeFocused();
  });
}

test('calendar refresh, uncached month failure, retry, and completion reopening stay honest', async ({ page, ux }) => {
  test.skip(test.info().project.name !== 'desktop-chrome');
  const options: AuthenticatedApiOptions = { foodDayStatus: 'COMPLETE', foodEntriesByDate: { '2026-07-21': [{ id: 31, meal_period: 'BREAKFAST', name: 'Synthetic daily intake', calories: 2000 }] } };
  await ux.install('populated', options);
  const days = history();
  days[20] = { ...row(21), calorie_comparison: { consumed_kcal: 2000, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-21T19:00:00Z' } };
  await page.route('**/api/v1/food/31', async route => {
    if (route.request().method() === 'PATCH') {
      expect(options.foodDayStatus).toBe('OPEN');
      days[20].calorie_comparison!.consumed_kcal = route.request().postDataJSON().calories;
    }
    await route.fallback();
  });
  let fail = false;
  await page.route('**/api/v1/food-days/range?*', async route => {
    if (fail) return route.fulfill({ status: 503, json: { message: 'Synthetic unavailable history' } });
    const url = new URL(route.request().url());
    const start = url.searchParams.get('start')!;
    return route.fulfill({ json: { start_date: start, end_date: url.searchParams.get('end'), days: start.startsWith('2026-07') ? days : [] } });
  });
  await page.route('**/api/v1/food-days', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const payload = route.request().postDataJSON();
    options.foodDayStatus = payload.status ?? (payload.is_complete ? 'COMPLETE' : 'OPEN');
    days[20].status = options.foodDayStatus!;
    days[20].is_complete = options.foodDayStatus === 'COMPLETE';
    await route.fulfill({ json: days[20] });
  });
  await page.goto('/today'); await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/completed, at or below target/);
  await page.getByRole('button', { name: 'Close date picker' }).click();
  await page.getByRole('button', { name: 'Day completed', exact: true }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/in progress/);
  await page.getByRole('button', { name: 'Close date picker' }).click();
  await page.getByTestId('today-food-preview').click();
  await page.getByRole('button', { name: 'Edit Synthetic daily intake', exact: true }).click();
  await page.getByRole('textbox', { name: 'Calories', exact: true }).fill('2501');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('1 food | 2,501 kcal', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Today', exact: true }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/in progress, above maintenance/);
  await expect(page.getByTestId('calendar-date-badge-2026-07-21')).toHaveCSS('border-color', rgb(calibrateDesignTokens.schemes.light.calendarBeyond));
  await page.getByRole('button', { name: 'Close date picker' }).click();
  await page.getByRole('button', { name: 'Complete day', exact: true }).click();
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/completed, above maintenance/);
  expectApiFailure(page, { method: 'GET', pathname: '/api/v1/food-days/range', status: 503 });
  fail = true;
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(page.getByText("Can't load tracking history", { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-06-21')).toBeVisible();
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/completed, above maintenance/);
});

test('calendar remains usable with enlarged text on a small browser viewport', async ({ page, ux }, testInfo) => {
  test.skip(testInfo.project.name !== 'compact-phone-chrome');
  await ux.install('populated');
  await page.route('**/api/v1/food-days/range?*', route => route.fulfill({ json: { start_date: date(1), end_date: date(21), days: history() } }));
  await page.goto('/today'); await hideTransientPwaNotices(page);
  await page.getByRole('button', { name: 'Choose date', exact: true }).click();
  await expect(page.getByTestId('calendar-day-2026-07-17')).toBeVisible();
  await applyTwoHundredPercentText(page);
  const pausedBadge = page.getByTestId('calendar-date-badge-2026-07-20');
  const pausedCircle = (await pausedBadge.boundingBox())!;
  const pauseGlyph = (await page.getByTestId('calendar-pause-glyph-2026-07-20').boundingBox())!;
  expect(pauseGlyph.y + pauseGlyph.height).toBeLessThanOrEqual(pausedCircle.y + pausedCircle.height - 3);
  await pausedBadge.screenshot({ path: testInfo.outputPath('calendar-pause-enlarged.png') });
  const notStartedBadge = page.getByTestId('calendar-date-badge-2026-07-19');
  const notStartedCircle = (await notStartedBadge.boundingBox())!;
  const xGlyph = (await page.getByTestId('calendar-not-started-glyph-2026-07-19').boundingBox())!;
  expect(xGlyph.y + xGlyph.height).toBeLessThanOrEqual(notStartedCircle.y + notStartedCircle.height - 3);
  await notStartedBadge.screenshot({ path: testInfo.outputPath('calendar-not-started-enlarged.png') });
  await page.getByRole('button', { name: 'Calendar key', exact: true }).click();
  const legend = page.getByText('Off target', { exact: true });
  await legend.scrollIntoViewIfNeeded(); await expect(legend).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const dialog = page.getByRole('dialog', { name: 'Calendar' });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'How colors work', exact: true }).click();
  const help = page.getByTestId('calendar-color-guide');
  await help.scrollIntoViewIfNeeded();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByTestId('calendar-day-2026-07-12').scrollIntoViewIfNeeded();
  await page.getByTestId('calendar-day-2026-07-12').click();
  await expect(dialog).toHaveCount(0);
});
