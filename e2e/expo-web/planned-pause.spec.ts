/** @file Regression coverage for planned pause: real pause form, failed resume, recovery and preserved historical edit. */

import { expect, test, hideTransientPwaNotices, expectApiFailure, activateFixtureOffline, FROZEN_LOCAL_DATE, type UxHarness } from './fixtures';
import type { Page } from '@playwright/test';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';
import { applyTwoHundredPercentText } from './text-scaling';

const today = FROZEN_LOCAL_DATE;

async function install(page: Page, ux: UxHarness, target: string | null = '2026-08-03', active = true) {
    await ux.install('populated', { foodEntries: [] });
    const state = { active, target, startsOn: '2026-07-20', resumedOn: null as string | null, failResume: false, queueResume: false, failUpdate: false, queueUpdate: false, failRead: false, resumeAttempts: 0, overrides: new Map<string, string>(), rangeRequests: [] as string[] };
    const pause = () => ({ active: state.active, id: 9, starts_on: state.startsOn, expected_resume_on: state.target, resumed_on: state.resumedOn, started_at: '2026-07-20T12:00:00Z', resumed_at: null, materialized_through: today, resume_confirmation_due: state.active && state.target !== null && state.target <= today });
    const day = (date: string) => {
        let status = state.overrides.get(date) ?? ((date >= state.startsOn && (state.active || (state.resumedOn !== null && date < state.resumedOn))) ? 'PAUSED' : 'OPEN');
        if (date >= '2026-07-16' && date <= '2026-07-19') status = 'COMPLETE';
        const consumed = { '2026-07-16': 1900, '2026-07-17': 2200, '2026-07-18': 2600 }[date];
        return { date, status, origin: status === 'PAUSED' ? 'PAUSE' : 'USER', source: status === 'PAUSED' ? 'ACTIVE_PAUSE' : 'STORED', is_complete: status === 'COMPLETE', is_representative: status === 'COMPLETE', completed_at: null, updated_at: null,
            ...(consumed ? { calorie_comparison: { consumed_kcal: consumed, target_kcal: 2000, maintenance_kcal: 2500, captured_at: '2026-07-21T12:00:00Z' } } : {}) };
    };
    await page.route('**/api/v1/food-days/pause', async route => {
        const method = route.request().method();
        if (method === 'GET' && state.failRead) return route.fulfill({ status: 503, json: { message: 'Synthetic pause read failure' } });
        if (method === 'POST' || method === 'PATCH') {
            if (state.queueUpdate) return route.fulfill({ status: 503, json: { message: 'Synthetic retryable pause write failure' } });
            if (state.failUpdate) return route.fulfill({ status: 400, json: { message: 'Synthetic pause update rejected' } });
            const payload = route.request().postDataJSON();
            state.target = payload.expected_resume_on;
            if (method === 'POST') { state.active = true; state.startsOn = payload.starts_on; state.resumedOn = null; }
        }
        return route.fulfill({ json: { pause: pause() } });
    });
    await page.route('**/api/v1/food-days/resume', async route => {
        state.resumeAttempts++;
        if (state.queueResume) return route.fulfill({ status: 503, json: { message: 'Synthetic retryable resume failure' } });
        if (state.failResume) return route.fulfill({ status: 400, json: { message: 'Synthetic resume rejected' } });
        state.active = false; state.resumedOn = route.request().postDataJSON().resumed_on;
        return route.fulfill({ json: { pause: pause(), day: day(today) } });
    });
    await page.route('**/api/v1/food-days?*', route => route.fulfill({ json: day(new URL(route.request().url()).searchParams.get('date')!) }));
    await page.route('**/api/v1/food-days', async route => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        const payload = route.request().postDataJSON(); state.overrides.set(payload.date, payload.status);
        return route.fulfill({ json: day(payload.date) });
    });
    await page.route('**/api/v1/food-days/range?*', route => {
        const url = new URL(route.request().url()); const start = url.searchParams.get('start')!; const end = url.searchParams.get('end')!;
        expect(start <= end && end <= today).toBe(true); state.rangeRequests.push(`${start}/${end}`);
        const days = [];
        for (let date = start; date <= end; date = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) days.push(day(date));
        return route.fulfill({ json: { start_date: start, end_date: end, days } });
    });
    return state;
}

async function open(page: Page) {
    await page.goto('/today'); await hideTransientPwaNotices(page);
    await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toBeVisible();
}
async function calendar(page: Page) { await page.getByRole('button', { name: 'Choose date', exact: true }).click(); }

for (const theme of ['light', 'dark'] as const) {
    test(`dated plan and exact month boundary in ${theme}`, async ({ page, ux }, info) => {
        await page.emulateMedia({ colorScheme: theme });
        await install(page, ux); await open(page);
        await expect(page.getByText('Tracking paused', { exact: true })).toBeVisible();
        await expect(page.getByText('Expected to resume Aug 3, 2026', { exact: true })).toBeVisible();
        await expect(page.getByText('Weigh in', { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByText("Record today's weight", { exact: true })).toBeInViewport({ ratio: 1 });

        await calendar(page);
        await expect(page.getByTestId('calendar-day-2026-07-20')).toHaveAccessibleName(/tracking paused/);
        for (const [date, label] of [['16', 'at or below target'], ['17', 'at or below maintenance'], ['18', 'above maintenance'], ['19', 'comparison unavailable']]) await expect(page.getByTestId(`calendar-day-2026-07-${date}`)).toHaveAccessibleName(new RegExp(label));
        await expect(page.getByTestId('calendar-day-2026-07-22')).toBeDisabled();
        await page.getByTestId('calendar-day-2026-07-22').dispatchEvent('click');
        await page.getByTestId('calendar-day-2026-07-22').dispatchEvent('keydown', { key: 'Enter' });
        await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/selected/);
        await expect(page.getByTestId('calendar-day-2026-07-22')).toHaveAccessibleName(/planned tracking pause/);

        await page.getByRole('button', { name: 'Next month', exact: true }).click();
        await expect(page.getByTestId('calendar-day-2026-08-02')).toHaveAccessibleName(/planned tracking pause/);
        await expect(page.getByTestId('calendar-day-2026-08-03')).toHaveAccessibleName(/future date/);
        await expect(page.getByTestId('calendar-day-2026-08-02')).toBeDisabled();

        await expectNoBlockingAccessibilityViolations(page, info, { kind: 'route', surfaceId: 'planned-pause-calendar' });
        await page.getByRole('button', { name: 'Previous month', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Choose date', exact: true })).toBeFocused();
    });
}

test('real pause form, failed resume, recovery and preserved historical edit', async ({ page, ux }) => {
    const state = await install(page, ux, null, false); await open(page); await calendar(page);
    await page.getByRole('button', { name: 'Pause tracking', exact: true }).click();
    await page.getByRole('button', { name: 'Choose expected resume date', exact: true }).click();
    await page.getByLabel('Expected resume date', { exact: true }).fill('2026-08-03');
    await page.getByRole('button', { name: 'Pause with this date', exact: true }).click();
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();
    // Controlled earlier-start variant exercises the historical override independently of the form's today start.
    state.startsOn = '2026-07-20';
    await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    await expect(page.getByText('Tracking was paused', { exact: true })).toBeVisible();
    await expect(page.getByText(/Expected to resume/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit day', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
    expect(state.active).toBe(true);
    await page.getByRole('button', { name: 'Next day', exact: true }).click();
    state.failResume = true; expectApiFailure(page, { method: 'POST', pathname: '/api/v1/food-days/resume', status: 400 });
    await page.getByRole('button', { name: 'Resume tracking', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();

    state.failResume = false;
    await page.getByRole('button', { name: 'Resume tracking', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
});

test('due prompt failed update, until-resumed removal and explicit resume', async ({ page, ux }) => {
    const state = await install(page, ux, today); await open(page);
    await page.getByRole('button', { name: 'Extend pause', exact: true }).click();
    state.failUpdate = true; expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/food-days/pause', status: 400 });
    await page.getByRole('button', { name: 'Until I resume', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(); expect(state.target).toBe(today);

    state.failUpdate = false; await page.getByRole('button', { name: 'Until I resume', exact: true }).click();
    await expect(page.getByText('Until you resume', { exact: true })).toBeVisible();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-31')).toHaveAccessibleName(/planned tracking pause, until resumed/);
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();


});

test('year target, shortened plan on reload and unavailable metadata recovery', async ({ page, ux }) => {
    const state = await install(page, ux, '2027-01-02'); await open(page); await calendar(page);
    for (const month of ['August', 'September', 'October', 'November', 'December', 'January']) {
        await page.getByRole('button', { name: 'Next month', exact: true }).click();
        await expect(page.getByText(month + (month === 'January' ? ' 2027' : ' 2026'), { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('calendar-day-2027-01-01')).toHaveAccessibleName(/planned tracking pause/);
    await expect(page.getByTestId('calendar-day-2027-01-02')).toHaveAccessibleName(/future date/);

    expect(state.rangeRequests.every(range => range.endsWith(today))).toBe(true);
    state.target = '2026-07-23'; await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByText('Expected to resume Jul 23, 2026')).toBeVisible(); await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-22')).toHaveAccessibleName(/planned/);
    await expect(page.getByTestId('calendar-day-2026-07-23')).not.toHaveAccessibleName(/planned/);
    state.failRead = true; expectApiFailure(page, { method: 'GET', pathname: '/api/v1/food-days/pause', status: 503 });
    await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByText(/Pause plan unavailable|Offline - showing saved pause plan|Could not refresh the saved pause plan|Pending reconnection/).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toBeEnabled();

    state.failRead = false; await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByText('Expected to resume Jul 23, 2026')).toBeVisible();
});

test('planned pause remains readable at enlarged text', async ({ page, ux }, info) => {
    test.skip(info.project.name !== 'compact-phone-chrome');
    await install(page, ux); await open(page); await applyTwoHundredPercentText(page);
    await page.getByText('Expected to resume Aug 3, 2026').scrollIntoViewIfNeeded();
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeInViewport();
    await calendar(page);
    await page.getByRole('button', { name: 'Calendar key', exact: true }).click();
    await page.getByText('Planned pause (future, view only)', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByText('Planned pause (future, view only)', { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('reopening and month navigation refresh the plan and recover from a shortened horizon', async ({ page, ux }) => {
    const state = await install(page, ux); await open(page); await calendar(page);
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    await expect(page.getByTestId('calendar-day-2026-08-02')).toHaveAccessibleName(/planned/);
    state.target = '2026-07-23';
    await page.getByRole('button', { name: 'Previous month', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click();
    await expect(page.getByText('Expected to resume Jul 23, 2026')).toBeVisible();
    state.target = '2026-09-02'; await calendar(page);
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    state.target = null;
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    await expect(page.getByTestId('calendar-day-2026-07-31')).toHaveAccessibleName(/until resumed/);
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
});

test('due and overdue plans remain paused with no invented future interval', async ({ page, ux }) => {
    const state = await install(page, ux, today); await open(page);
    await expect(page.getByRole('button', { name: 'Extend pause', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Ready to resume tracking?' })).toHaveCount(0);
    await expect(page.getByText('Expected to resume today (Jul 21, 2026). Tracking is still paused.')).toBeVisible();
    await calendar(page); await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await page.keyboard.press('Escape');
    state.target = '2026-07-20'; await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByRole('button', { name: 'Extend pause', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByText('Expected resume date has passed (Jul 20, 2026). Tracking is still paused.')).toBeVisible();

    await calendar(page); await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await expect(page.getByRole('button', { name: 'Next month', exact: true })).toBeDisabled();
});

test('cached read failure keeps the saved plan visibly stale and reopening recovers it', async ({ page, ux }) => {
    const state = await install(page, ux); await open(page);
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();
    state.failRead = true; expectApiFailure(page, { method: 'GET', pathname: '/api/v1/food-days/pause', status: 503 });
    await calendar(page);
    await expect(page.getByRole('dialog', { name: 'Calendar' }).getByText(/Could not refresh the saved pause plan|Offline - showing saved pause plan|Showing saved tracking changes/)).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('calendar-day-2026-07-22')).toHaveAccessibleName(/planned/);

    state.failRead = false; state.target = '2026-07-23';
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click(); await calendar(page);
    await expect(page.getByText('Could not refresh the saved pause plan.')).toHaveCount(0);
    await expect(page.getByTestId('calendar-day-2026-07-23')).not.toHaveAccessibleName(/planned/);
});

test('offline cached plan and accepted queued resume converge after real browser outbox replay', async ({ page, ux }) => {
    const state = await install(page, ux); await open(page);
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();
    state.queueResume = true; expectApiFailure(page, { method: 'POST', pathname: '/api/v1/food-days/resume', status: 503 });
    await activateFixtureOffline(page);
    await expect(page.getByText('Offline - showing saved pause plan.', { exact: true })).toBeVisible();

    await page.context().setOffline(false);
    await expect(page.getByText('Offline - showing saved pause plan.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Resume tracking', exact: true }).click();
    expect(state.active).toBe(true);
    await expect.poll(() => state.resumeAttempts).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('calibrate-offline');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const records = db.transaction('queued_mutations', 'readonly').objectStore('queued_mutations').getAll();
            records.onsuccess = () => { resolve(records.result.filter(record => record.operation === 'food-tracking-pause.resume').length); db.close(); };
            records.onerror = () => { reject(records.error); db.close(); };
        };
    }))).toBe(1);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    await expect(page.getByText('Tracking paused', { exact: true })).toHaveCount(0);
    await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-21')).not.toHaveAccessibleName(/tracking paused/);
    await expect(page.getByTestId('calendar-day-2026-07-20')).toHaveAccessibleName(/tracking paused/);
    await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click();
    await activateFixtureOffline(page);
    state.queueResume = false;
    await page.context().setOffline(false);
    await expect.poll(() => state.active).toBe(false);
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await expect(page.getByTestId('calendar-day-2026-07-20')).toHaveAccessibleName(/tracking paused/);
});


test('queued pause metadata survives new observers, calendar refetch, reload and replay', async ({ page, ux }) => {
    const state = await install(page, ux, null, false); await open(page); await calendar(page);
    state.queueUpdate = true;
    expectApiFailure(page, { method: 'POST', pathname: '/api/v1/food-days/pause', status: 503 });
    await page.getByRole('button', { name: 'Pause tracking', exact: true }).click();
    await page.getByRole('button', { name: 'Choose expected resume date', exact: true }).click();
    await page.getByLabel('Expected resume date', { exact: true }).fill('2026-08-03');
    await page.getByRole('button', { name: 'Pause with this date', exact: true }).click();
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-22')).toHaveAccessibleName(/planned/);
    await page.getByRole('button', { name: 'Next month', exact: true }).click();
    await expect(page.getByTestId('calendar-day-2026-08-02')).toHaveAccessibleName(/planned/);
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click();
    await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByText('Tracking paused', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toHaveCount(0);
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-21')).toHaveAccessibleName(/tracking paused/);
    await expect(page.getByTestId('calendar-day-2026-07-22')).toHaveAccessibleName(/planned/);
    await activateFixtureOffline(page); state.queueUpdate = false; await page.context().setOffline(false);
    await expect.poll(() => state.active).toBe(true);
    await page.getByRole('button', { name: 'Close date picker', exact: true }).click();
    await expect(page.getByText('Expected to resume Aug 3, 2026')).toBeVisible();
    // A due server pause makes the existing extension controls available.
    state.target = today; await page.reload(); await hideTransientPwaNotices(page);
    await page.getByRole('button', { name: 'Extend pause', exact: true }).click();
    state.queueUpdate = true;
    expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/food-days/pause', status: 503 });
    await page.getByRole('button', { name: 'Until I resume', exact: true }).click();
    await expect(page.getByText('Until you resume', { exact: true })).toBeVisible();
    await calendar(page); await expect(page.getByTestId('calendar-day-2026-07-31')).toHaveAccessibleName(/until resumed/);
    await page.reload(); await hideTransientPwaNotices(page);
    await expect(page.getByText('Until you resume', { exact: true })).toBeVisible();
    await activateFixtureOffline(page); state.queueUpdate = false; await page.context().setOffline(false);
    await expect.poll(() => state.target).toBeNull();
    await expect(page.getByText('Until you resume', { exact: true })).toBeVisible();
});

test('explicit due-prompt resume clears the calendar plan and preserves prior pause', async ({page, ux}) => {
    await install(page, ux, today); await open(page);
    await page.getByRole('dialog', { name: 'Ready to resume tracking?' }).getByRole('button', { name: 'Resume tracking', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeEnabled();
    await calendar(page);
    await expect(page.getByTestId('calendar-day-2026-07-22')).not.toHaveAccessibleName(/planned/);
    await expect(page.getByTestId('calendar-day-2026-07-20')).toHaveAccessibleName(/tracking paused/);
});
