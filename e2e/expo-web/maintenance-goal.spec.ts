/** @file Exercises goal setup presets, calorie tracking, and weight-only maintenance across Today and Progress. */
import type { GoalChange, GoalStatus } from '@calibrate/api-client';
import { expect, hideTransientPwaNotices, test } from './fixtures';
import { applyTwoHundredPercentText } from './text-scaling';
import { expectNoBlockingAccessibilityViolations } from './ux-a11y';
import { advanceOnboardingToPlan, installOnboardingAccount } from './onboarding.fixture';

test('both next-goal choices open the setup page and keep the previous budget until save', async ({ page, ux }, testInfo) => {
    if (testInfo.project.name === 'compact-phone-chrome') await page.setViewportSize({ width: 320, height: 568 });
    await ux.install('populated');
    const target = 75_000;
    let state: GoalStatus = {
        expected_version: '0'.repeat(64),
        goal: { id: 7, daily_deficit: -500, target_weight_grams: target, completed_on: '2026-07-21' },
        tracking: true, weight_unit: 'KG', starting_weight_grams: 74_800,
        trend: { date: '2026-07-21', weight_grams: 74_800, lower_grams: 74_000, upper_grams: 76_000 },
        evidence: 'current', target_kcal: 2900, recovery_range: null, maintenance: null,
        budget_options: [{ offset_kcal: 0, target_kcal: 2400 }, { offset_kcal: -250, target_kcal: 2150 }, { offset_kcal: 250, target_kcal: 2650 }],
        pace_options: [
            { dailyDeficit: -500, available: false, dailyCalorieTarget: null, reasonCode: 'SERVER_POLICY_UNAVAILABLE' },
            { dailyDeficit: -250, available: true, dailyCalorieTarget: 2650, reasonCode: null },
            { dailyDeficit: 250, available: true, dailyCalorieTarget: 2150, reasonCode: null },
            { dailyDeficit: 500, available: true, dailyCalorieTarget: 1900, reasonCode: null },
            { dailyDeficit: 1000, available: false, dailyCalorieTarget: null, reasonCode: 'TARGET_BELOW_MINIMUM' }
        ]
    };
    const transitions: GoalChange[] = [];
    await page.route('**/api/v1/client-config', route => route.fulfill({ json: {
        api_version: 1, server_version: '1.0.0', capabilities: { maintenance_goals: true }
    } }));
    await page.route('**/api/v1/goals/status', route => route.fulfill({ json: state }));
    await page.route('**/api/v1/goals/transition', async route => {
        const change = route.request().postDataJSON() as GoalChange;
        transitions.push(change);
        if (change.daily_deficit !== 0) {
            await route.fulfill({ json: { goal_id: 9 } });
            return;
        }
        state = { ...state, goal: { id: 8, daily_deficit: 0, target_weight_grams: target, completed_on: null }, tracking: false, target_kcal: 2400,
            maintenance: { range: { target_weight_grams: target, lower_weight_grams: change.lower_weight_grams!, upper_weight_grams: change.upper_weight_grams! },
                status: 'within_range', offset_kcal: 0, return_to_neutral: false } };
        await route.fulfill({ json: { goal_id: 8 } });
    });
    await page.goto('/progress');
    await hideTransientPwaNotices(page);
    await expect(page.getByTestId('goal-completion-notice')).toBeVisible();
    await page.locator('a[href="/today"]').click();
    const todayChoice = page.getByRole('button', { name: 'Goal reached. Choose your next goal' });
    await expect(todayChoice).toBeVisible();
    await expect(page.getByText('Previous calorie plan', { exact: true })).toBeVisible();
    await expect(page.getByTestId('today-fixed-page').getByTestId('goal-completion-notice')).toHaveCount(0);
    await expect(page.getByTestId('today-food-preview')).toBeVisible();
    await todayChoice.click();
    const choices = page.getByRole('dialog', { name: 'You reached your 75 kg goal!' });
    await expect(choices.getByRole('heading', { name: 'You reached your 75 kg goal!' })).toBeVisible();
    await expect(choices.getByText(/^Your trend is now 74\.8 kg\. Maintain a range/)).toBeVisible();
    await expect(choices.getByRole('button', { name: 'Set new goal target' })).toBeVisible();
    await choices.getByRole('button', { name: 'Close goal choices' }).click();
    await expect(todayChoice).toBeVisible();
    await todayChoice.click();
    await choices.getByRole('button', { name: 'Maintain this weight', exact: true }).click();
    await expect(page).toHaveURL(/\/goal-setup\?mode=maintain$/);
    await expect(choices).toHaveCount(0);
    const review = page.getByTestId('goal-setup-page');
    await expect(page.getByRole('heading', { name: 'Goal setup', exact: true })).toBeVisible();
    const directions = review.getByRole('radiogroup', { name: 'Goal type' });
    const maintain = directions.getByRole('radio', { name: 'Maintain', exact: true });
    const lose = directions.getByRole('radio', { name: 'Lose', exact: true });
    const gain = directions.getByRole('radio', { name: 'Gain', exact: true });
    const targetField = review.getByLabel('Target weight (kg)');
    const distance = review.getByLabel('Range on either side (kg)', { exact: true });
    const tracking = review.getByRole('switch', { name: 'Track calories' });
    const goalTypes = directions.getByRole('radio');
    await expect(goalTypes.nth(0)).toHaveAccessibleName('Lose');
    await expect(goalTypes.nth(1)).toHaveAccessibleName('Maintain');
    await expect(goalTypes.nth(2)).toHaveAccessibleName('Gain');
    await expect(maintain).toBeChecked();
    await expect(targetField).toHaveValue('75.0');
    await expect(distance).toHaveValue('1');
    await expect(tracking).not.toBeChecked();
    await lose.click();
    await expect(targetField).toHaveValue('');
    await expect(tracking).toHaveCount(0);
    const back = page.getByRole('button', { name: 'Go back', exact: true });
    page.once('dialog', dialog => dialog.dismiss());
    await back.click();
    await expect(review).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await back.click();
    await expect(page).toHaveURL(/\/today(?:\?|$)/);
    await expect(todayChoice).toBeVisible();

    await page.goto('/progress');
    await hideTransientPwaNotices(page);
    await expect(page.getByText(/previous plan of 2,900 kcal\/day/)).toBeVisible();
    const choose = page.getByRole('button', { name: 'Choose your next goal', exact: true });
    await choose.click();
    await choices.getByRole('button', { name: 'Decide later' }).click();
    await expect(choose).toBeVisible();
    expect(transitions).toHaveLength(0);
    await choose.click();
    await choices.getByRole('button', { name: 'Set new goal target', exact: true }).click();
    await expect(page).toHaveURL(/\/goal-setup$/);
    await expect(choices).toHaveCount(0);
    await expect(lose).toBeChecked();
    const confirm = review.getByRole('button', { name: 'Save goal' });
    await expect(targetField).toHaveAttribute('aria-required', 'true');
    await expect(targetField).toHaveAttribute('placeholder', 'Enter a target weight');
    const pace = review.getByRole('combobox', { name: 'Calorie Deficit', exact: true });
    const paceOptions = page.getByRole('listbox', { name: 'Calorie Deficit options' });
    await expect(pace).toContainText('500 kcal/day deficit');
    await gain.click();
    await expect(review.getByRole('combobox', { name: 'Calorie Surplus', exact: true })).toContainText('Choose an available pace');
    await expect(tracking).toHaveCount(0);
    await lose.click();
    await expect(pace).toContainText('500 kcal/day deficit');
    await expect(paceOptions).toHaveCount(0);
    await pace.press('Enter');
    await expect(paceOptions.getByRole('option', { name: '1,000 kcal/day deficit' })).toBeDisabled();
    await paceOptions.getByRole('option', { name: '250 kcal/day deficit' }).click();
    await expect(pace).toContainText('2,150 kcal/day');
    await expect(pace).toHaveAttribute('aria-expanded', 'false');
    await expect(confirm).toBeDisabled();
    const actions = review.getByTestId('goal-editor-actions');
    const error = actions.getByRole('alert');
    await targetField.fill('74.8');
    await expect(confirm).toBeDisabled();
    await expect(error).toHaveText('Enter a target below your current weight of 74.8 kg.');
    await expect(targetField).toHaveAttribute('aria-invalid', 'true');
    await expect(targetField).toHaveAccessibleDescription('Enter a target below your current weight of 74.8 kg.');
    await targetField.fill('72');
    await expect(confirm).toBeEnabled();
    await expect(targetField).toHaveAttribute('aria-invalid', 'false');
    await maintain.click();
    const rangePreview = review.getByTestId('maintenance-range-preview');
    await expect(targetField).toHaveValue('75.0');
    await expect(distance).toHaveValue('1');
    await expect(rangePreview.getByText('74 kg', { exact: true })).toBeVisible();
    await expect(rangePreview.getByText('76 kg', { exact: true })).toBeVisible();
    await expect(confirm).toBeInViewport();
    const footerPosition = (await confirm.boundingBox())?.y;
    await tracking.scrollIntoViewIfNeeded();
    expect((await confirm.boundingBox())?.y).toBe(footerPosition);
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'goal-setup' });
    if (testInfo.project.name === 'compact-phone-chrome') await applyTwoHundredPercentText(page);
    await expect(tracking).not.toBeChecked();
    await expect(review.getByText(/Choose a target weight to maintain/)).toBeVisible();
    await expect(review.getByText(/By default, calorie tracking is disabled for a Maintenance goal/)).toBeVisible();
    const trackingDescription = review.getByText('Calorie tracking will be enabled with an estimated maintenance budget of 2,400 kcal/day.', { exact: true });
    await expect(trackingDescription).toHaveCount(0);
    await tracking.press('Space');
    await expect(tracking).toBeChecked();
    await expect(trackingDescription).toBeVisible();
    await expect(review.getByText('Estimated maintenance budget', { exact: true })).toHaveCount(0);
    await expect(review.getByText(/2,?150|2,?650/)).toHaveCount(0);
    await expect(review.getByRole('button', { name: /kcal/ })).toHaveCount(0);
    await tracking.click();
    await expect(trackingDescription).toHaveCount(0);
    await distance.fill('0');
    await expect(confirm).toBeDisabled();
    await distance.fill('1.1');
    await expect(confirm).toBeDisabled();
    const decreaseRange = review.getByRole('button', { name: 'Decrease Range on either side (kg) by 0.25' });
    const increaseRange = review.getByRole('button', { name: 'Increase Range on either side (kg) by 0.25' });
    await distance.fill('0.5');
    await expect(decreaseRange).toBeDisabled();
    await distance.fill('3');
    await expect(increaseRange).toBeDisabled();
    await distance.fill('1');
    await increaseRange.click();
    await expect(distance).toHaveValue('1.25');
    await targetField.fill('77');
    await expect(confirm).toBeDisabled();
    await expect(error).toHaveText('Adjust the target or range to include your current weight of 74.8 kg.');
    await expect(targetField).toHaveAttribute('aria-invalid', 'true');
    await expect(distance).toHaveAttribute('aria-invalid', 'true');
    await targetField.fill('76');
    await expect(rangePreview.getByText('74.75 kg', { exact: true })).toBeVisible();
    await expect(rangePreview.getByText('77.25 kg', { exact: true })).toBeVisible();
    await expect(confirm).toBeEnabled();
    await expect(distance).toHaveAttribute('aria-invalid', 'false');
    await lose.click();
    await expect(targetField).toHaveValue('72');
    await maintain.click();
    await expect(targetField).toHaveValue('76');
    await expect(distance).toHaveValue('1.25');
    await targetField.fill('75');
    await confirm.click();
    await expect(page).toHaveURL(/\/progress$/);
    await expect(page.getByTestId('maintenance-guidance')).toContainText('Tracking weight only');
    expect(transitions).toEqual([{
        expected_version: '0'.repeat(64), daily_deficit: 0, tracking: false,
        target_weight_grams: target, lower_weight_grams: 73_750, upper_weight_grams: 76_250
    }]);

    await page.goto('/goal-setup?mode=gain');
    await expect(gain).toBeChecked();
    await expect(tracking).toHaveCount(0);
    await expect(review.getByText('Calorie tracking will resume when you save this goal.')).toBeVisible();
    await targetField.fill('74.8');
    await expect(confirm).toBeDisabled();
    await expect(error).toHaveText('Enter a target above your current weight of 74.8 kg.');
    await expect(targetField).toHaveAttribute('aria-invalid', 'true');
    await targetField.fill('76');
    await review.getByRole('combobox', { name: 'Calorie Surplus', exact: true }).click();
    await page.getByRole('option', { name: '250 kcal/day surplus', exact: true }).click();
    await confirm.click();
    await expect.poll(() => transitions.at(-1)).toEqual({
        expected_version: '0'.repeat(64), daily_deficit: -250, tracking: true, target_weight_grams: 76_000
    });
});

test('a maintenance excursion can be resolved by adjusting the target without turning on calories', async ({ page, ux }, testInfo) => {
    if (testInfo.project.name === 'android-phone-chrome') await page.setViewportSize({ width: 320, height: 568 });
    await ux.install('populated');
    let status: GoalStatus = {
        expected_version: '0'.repeat(64),
        goal: { id: 7, daily_deficit: 0, target_weight_grams: 73_000, completed_on: null },
        tracking: false, weight_unit: 'KG', starting_weight_grams: 75_000,
        trend: { date: '2026-07-21', weight_grams: 75_000, lower_grams: 74_100, upper_grams: 75_900 },
        evidence: 'current', target_kcal: 2400, recovery_range: null,
        budget_options: [{ offset_kcal: 0, target_kcal: 2400 }], pace_options: [],
        maintenance: { range: { target_weight_grams: 73_000, lower_weight_grams: 72_000, upper_weight_grams: 74_500 },
            offset_kcal: 0, return_to_neutral: false, status: 'above_range' }
    };
    const changes: GoalChange[] = [];
    await page.route('**/api/v1/client-config', async route => route.fulfill({ json: {
        api_version: 1, server_version: '1.0.0', capabilities: { maintenance_goals: true }
    } }));
    await page.route('**/api/v1/goals/status', async route => route.fulfill({ json: status }));
    await page.route('**/api/v1/food-days?date=*', async route => route.fulfill({ json: {
        date: new URL(route.request().url()).searchParams.get('date'), status: 'PAUSED', origin: 'PAUSE', source: 'STORED',
        is_complete: false, is_representative: false, updated_at: null, completed_at: null
    } }));
    await page.route('**/api/v1/goals/7/maintenance', async route => {
        const change = route.request().postDataJSON() as GoalChange;
        changes.push(change);
        status = { ...status, expected_version: '1'.repeat(64),
            goal: { ...status.goal!, target_weight_grams: change.target_weight_grams },
            maintenance: { ...status.maintenance!, status: 'within_range', range: {
                target_weight_grams: change.target_weight_grams,
                lower_weight_grams: change.lower_weight_grams!, upper_weight_grams: change.upper_weight_grams!
            } } };
        await route.fulfill({ json: { goal_id: 7 } });
    });
    await page.goto('/today');
    await hideTransientPwaNotices(page);
    await expect(page.getByText('Above range', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review a return-to-target plan' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue monitoring' })).toBeVisible();
    await page.getByRole('button', { name: 'Start calorie tracking' }).click();
    const enable = page.getByRole('dialog', { name: 'Start calorie tracking' });
    await expect(enable.getByText('Estimated maintenance budget', { exact: true })).toBeVisible();
    await expect(enable.getByText('2,400 kcal/day', { exact: true })).toBeVisible();
    await expect(enable.getByRole('button', { name: /kcal/ })).toHaveCount(0);
    await enable.getByRole('button', { name: 'Close start calorie tracking', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Adjust maintenance target' }).click();
    const review = page.getByRole('dialog', { name: 'Adjust maintenance target' });
    await expect(review.getByLabel('Target weight (kg)')).toHaveValue('75.0');
    const rangePreview = review.getByTestId('maintenance-range-preview');
    await expect(rangePreview.getByText('74 kg', { exact: true })).toBeVisible();
    await expect(rangePreview.getByText('76.5 kg', { exact: true })).toBeVisible();
    await expect(review.getByRole('switch', { name: 'Track calories' })).toHaveCount(0);
    await expectNoBlockingAccessibilityViolations(page, testInfo, { kind: 'route', surfaceId: 'maintenance-reset' });
    await applyTwoHundredPercentText(page);
    await review.getByRole('button', { name: 'Use a symmetric range' }).click();
    await review.getByLabel('Range on either side (kg)', { exact: true }).fill('2');
    await expect(rangePreview.getByText('73 kg', { exact: true })).toBeVisible();
    await expect(rangePreview.getByText('77 kg', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Confirm change' }).click();
    await expect(review).toHaveCount(0);
    expect(changes).toEqual([{
        expected_version: '0'.repeat(64), target_weight_grams: 75_000, lower_weight_grams: 73_000, upper_weight_grams: 77_000
    }]);
    await expect(page.getByText('Within range', { exact: true })).toBeVisible();
    await expect(page.getByText('Tracking weight only')).toBeVisible();
    await page.goto('/progress');
    await hideTransientPwaNotices(page);
    await expect(page.getByTestId('maintenance-guidance')).toContainText('Within range');
    await expect(page.getByRole('button', { name: 'Edit maintenance target and range' })).toBeVisible();
    await expect(page.getByLabel('Four-week weight trend and maintenance range')).toBeVisible();
});

test('onboarding previews and saves a symmetric maintenance range', async ({ page, ux }) => {
    await ux.install('populated');
    const { completions } = await installOnboardingAccount(page);
    await page.route('**/api/v1/client-config', route => route.fulfill({ json: {
        api_version: 1, server_version: '1.0.0', capabilities: { maintenance_goals: true }
    } }));
    await page.route('**/api/v1/goals/status', route => route.fulfill({ json: {
        expected_version: '0'.repeat(64), goal: { id: 77, daily_deficit: 0, target_weight_grams: 88_200, completed_on: null },
        tracking: false, weight_unit: 'KG', starting_weight_grams: 88_200, trend: null, evidence: 'insufficient',
        target_kcal: null, recovery_range: null, budget_options: [], pace_options: [],
        maintenance: { range: { target_weight_grams: 88_200, lower_weight_grams: 86_950, upper_weight_grams: 89_450 },
            status: 'insufficient', offset_kcal: 0, return_to_neutral: false }
    } satisfies GoalStatus }));
    await page.goto('/onboarding');
    await advanceOnboardingToPlan(page);
    await page.getByRole('radio', { name: 'Maintain', exact: true }).click();
    const target = page.getByLabel('Target weight (kg)');
    await expect(target).toHaveValue('88.2');
    const distance = page.getByLabel('Range on either side (kg)', { exact: true });
    await expect(distance).toHaveValue('1');
    await distance.fill('1.25');
    const start = page.getByRole('button', { name: 'Start tracking', exact: true });
    await target.fill('92');
    await expect(start).toBeDisabled();
    await expect(page.getByTestId('goal-editor-actions').getByRole('alert'))
        .toHaveText('Adjust the target or range to include your current weight of 88.2 kg.');
    await expect(target).toHaveAttribute('aria-invalid', 'true');
    await expect(distance).toHaveAttribute('aria-invalid', 'true');
    await target.fill('88.2');
    const rangePreview = page.getByTestId('maintenance-range-preview');
    await expect(rangePreview.getByText('86.95 kg', { exact: true })).toBeVisible();
    await expect(rangePreview.getByText('89.45 kg', { exact: true })).toBeVisible();
    await start.click();
    await expect(page).toHaveURL(/\/today$/);
    expect(completions).toEqual([expect.objectContaining({ daily_deficit: 0, target_weight_grams: 88_200,
        maintenance_lower_grams: 86_950, maintenance_upper_grams: 89_450 })]);
});
