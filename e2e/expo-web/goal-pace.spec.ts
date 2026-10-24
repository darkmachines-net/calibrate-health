/** @file Regression coverage for goal pace. */

import { test, expect, expectApiFailure, hideTransientPwaNotices } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';
for (const colorScheme of ['light', 'dark'] as const) {
    test(`pace adjustment preserves the goal and explicit new goal resets intentionally in ${colorScheme}`, async ({ page, ux }, testInfo) => {
        await page.emulateMedia({ colorScheme });
        await ux.install('populated', { metrics: [{ id: 1, date: '2026-07-21', weight: 85 }] });
        expectApiFailure(page, { method: 'PATCH', pathname: '/api/v1/goals/7/pace', status: 503 });
        let goal = { id: 7, start_weight: 90, target_weight: 75, target_date: '2027-02-01T00:00:00Z',
            created_at: '2026-01-01T12:00:00Z', daily_deficit: 500, plan_status: 'available', plan_reason_code: null,
            projection: { status: 'projected', projected_end_date: '2026-12-22', reason_code: null } };
        let writes = 0, creates = 0, externalChanges = 0, loseResponse = true;
        const receipts = new Map<string, typeof goal>();
        const operations: string[] = [];
        await page.route('**/api/v1/goals', async (route) => {
            if (route.request().method() === 'POST') {
                creates++;
                const payload = route.request().postDataJSON();
                goal = { ...goal, ...payload, id: 8, created_at: '2026-07-21T19:00:00Z',
                    projection: { status: 'projected', projected_end_date: '2027-05-25', reason_code: null } };
            }
            return route.fulfill({ json: goal });
        });
        await page.route('**/api/v1/user/profile', async (route) => {
            await route.fulfill({ json: { profile: { timezone: 'America/Los_Angeles', date_of_birth: '1985-01-01', sex: 'MALE',
                        height_mm: 1800, activity_level: 'MODERATE', weight_unit: 'KG', height_unit: 'CM' }, latest_weight_grams: 85000,
                    goal_daily_deficit: goal.daily_deficit, calorieSummary: { dailyCalorieTarget: 2600 - goal.daily_deficit,
                        tdee: 2600, bmr: 2000, deficit: goal.daily_deficit, missing: [], planStatus: 'available', planReasonCode: null,
                        eligibility: { status: 'eligible', reasonCode: null, ageYears: 41, localDate: '2026-07-21' } } } });
        });
        await page.route('**/api/v1/goals/pace-options', route => route.fulfill({ json: {
                goal, expected_plan_version: String(writes + externalChanges).padStart(64, '0'), effective_local_date: '2026-07-21',
                eligibility: { status: 'eligible', reasonCode: null, ageYears: 41, localDate: '2026-07-21' }, bmr: 2000, tdee: 2600, minimumDailyCalorieTarget: 2000,
                planOptions: [250, 500, 750, 1000].map(dailyDeficit => ({ dailyDeficit, available: dailyDeficit <= 500,
                    dailyCalorieTarget: dailyDeficit <= 500 ? 2600 - dailyDeficit : null, reasonCode: dailyDeficit <= 500 ? null : 'TARGET_BELOW_MINIMUM' }))
            } }));
        await page.route('**/api/v1/goals/7/pace', async (route) => {
            const operation = route.request().headers()['x-client-operation-id'];
            operations.push(operation);
            if (!receipts.has(operation)) {
                writes++;
                goal = { ...goal, daily_deficit: route.request().postDataJSON().daily_deficit,
                    projection: { status: 'projected', projected_end_date: '2027-05-25', reason_code: null } };
                receipts.set(operation, goal);
            }
            if (loseResponse) {
                loseResponse = false;
                return route.fulfill({ status: 503, json: { message: 'Synthetic lost response after commit', retryable: true } });
            }
            return route.fulfill({ json: receipts.get(operation) });
        });
        await page.goto('/progress');
        await hideTransientPwaNotices(page);
        await expect(page.getByText('33% complete')).toBeVisible();
        await expect(page.getByText('Current target: 2,100 kcal/day')).toBeVisible();
        await expect(page.getByTestId('progress-snapshot-card').getByRole('button')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Set a new goal', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        const sheet = page.getByRole('dialog', { name: 'Edit goal' });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByText(/Started 2026-01-01/)).toBeVisible();
        await page.getByRole('combobox', { name: 'Select daily calorie change' }).click();
        await page.getByRole('option', { name: new RegExp("250 kcal/day deficit") }).click();
        await expect(page.getByText('New target: 2,350 kcal/day')).toBeVisible();
        await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'goal-pace' });
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        expect(writes).toBe(0);
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        await page.getByRole('combobox', { name: 'Select daily calorie change' }).click();
        await page.getByRole('option', { name: new RegExp("250 kcal/day deficit") }).click();
        await page.getByRole('button', { name: 'Save pace', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: /Unable|Synthetic/ })).toBeVisible();
        await page.getByRole('button', { name: 'Save pace', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        expect(writes).toBe(1);
        expect(operations[0]).toBe(operations[1]);
        await expect(page.getByText('33% complete')).toBeVisible();
        await expect(page.getByText('Current target: 2,350 kcal/day')).toBeVisible();
        await page.route('**/api/v1/food-days?date=*', route => route.fulfill({ json: {
                date: new URL(route.request().url()).searchParams.get('date'), status: 'COMPLETE', origin: 'USER', source: 'STORED',
                is_complete: true, is_representative: true, completed_at: '2026-07-20T20:00:00Z', updated_at: null,
                calorie_comparison: { consumed_kcal: 360, target_kcal: 2100, maintenance_kcal: 2600, captured_at: '2026-07-20T20:00:00Z' }
            } }));
        await page.goto('/today?date=2026-07-20');
        await hideTransientPwaNotices(page);
        await expect(page.getByLabel(/Daily balance.*2,100 calorie target/)).toBeVisible();
        await page.goto('/progress');
        await page.reload();
        await hideTransientPwaNotices(page);
        await expect(page.getByText('33% complete')).toBeVisible();
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        await expect(page.getByRole('combobox', { name: 'Select daily calorie change' })).toContainText('250 kcal/day deficit');
        await expect(page.getByText(/Started 2026-01-01/)).toBeVisible();
        goal = { ...goal, daily_deficit: 500 };
        externalChanges++;
        await sheet.getByRole('button', { name: 'Retry plan check', exact: true }).click();
        await expect(page.getByRole('combobox', { name: 'Select daily calorie change' })).toContainText('500 kcal/day deficit');
        await expect(page.getByText('New target: 2,100 kcal/day')).toBeVisible();
        expect(writes).toBe(1);
        await page.getByRole('combobox', { name: 'Select daily calorie change' }).click();
        await page.getByRole('option', { name: new RegExp('250 kcal/day deficit') }).click();
        await page.getByRole('button', { name: 'Save pace', exact: true }).click();
        await expect(sheet).toHaveCount(0);
        expect(writes).toBe(2);
        expect(operations[2]).not.toBe(operations[0]);
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Edit goal', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        await page.getByRole('combobox', { name: 'Select daily calorie change' }).click();
        await page.getByRole('option', { name: new RegExp('500 kcal/day deficit') }).click();
        page.once('dialog', dialog => dialog.dismiss());
        await sheet.getByRole('button', { name: 'Set a new goal', exact: true }).click();
        await expect(sheet).toBeVisible();
        expect(creates).toBe(0);
        expect(writes).toBe(2);
        page.once('dialog', dialog => dialog.accept());
        await sheet.getByRole('button', { name: 'Set a new goal', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Set a new goal' })).toBeVisible();
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Edit goal', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
        await sheet.getByRole('button', { name: 'Set a new goal', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Set a new goal' })).toBeVisible();
        await page.getByRole('button', { name: 'Save goal', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Set a new goal' })).toHaveCount(0);
        expect(creates).toBe(1);
        expect(goal.id).toBe(8);
        expect(goal.start_weight).toBe(85);
        expect(goal.created_at).toContain('2026-07-21');
        await expect(page.getByText('0% complete')).toBeVisible();
        if (testInfo.project.name === 'compact-phone-chrome' && colorScheme === 'light') {
            await page.getByRole('button', { name: 'Edit goal', exact: true }).click();
            await applyTwoHundredPercentText(page);
            await page.getByRole('button', { name: 'Save pace', exact: true }).scrollIntoViewIfNeeded();
            await expect(page.getByRole('button', { name: 'Save pace', exact: true })).toBeVisible();
            await page.getByRole('button', { name: 'Close edit goal', exact: true }).click();
            await expect(sheet).toHaveCount(0);
        }
    });
}
