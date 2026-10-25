/** @file Regression coverage for Goal Progress Card: GoalProgressCard. */

import { fireEvent, render, within } from '@testing-library/react-native';
import type { GoalEntry } from '@calibrate/api-client';
import { GoalProgressCard } from './GoalProgressCard';
import { themes } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const GOAL: GoalEntry = {
    id: 1,
    start_weight: 182,
    target_weight: 165,
    target_date: null,
    daily_deficit: 500,
    created_at: '2026-07-01T00:00:00.000Z',
    plan_status: 'available',
    plan_reason_code: null,
    projection: {
        status: 'projected',
        projected_end_date: '2026-10-20',
        reason_code: null
    }
};

describe('GoalProgressCard', () => {
    it('combines the latest snapshot and goal projection in one section', async () => {
        const onEditGoal = jest.fn();
        const screen = await render(
            <GoalProgressCard
                goal={GOAL}
                latestMetric={{ id: 1, date: '2026-07-20', weight: 172 }}
                user={null}
                onEditGoal={onEditGoal}
            />
        );

        await fireEvent.press(screen.getByLabelText('Edit goal'));

        expect(screen.getByText('Snapshot')).toBeTruthy();
        expect(screen.getByText('172 kg').props.accessibilityHint).toBe('Updated Jul 20');
        expect(screen.getByText('Current weight')).toHaveStyle({
            fontSize: 14,
            lineHeight: 20,
            fontWeight: '400'
        });
        expect(screen.getByTestId('snapshot-heading-line')).toHaveStyle({
            flexDirection: 'row',
            alignItems: 'baseline',
            flexWrap: 'wrap'
        });
        expect(screen.getByLabelText('Goal date at selected pace')).toBeTruthy();
        const projection = screen.getByTestId('goal-projection');
        expect(within(projection).getByText(/, 2026$/)).toHaveStyle({
            color: themes.light.colors.onSurface,
            fontSize: 20,
            lineHeight: 26
        });
        expect(screen.getByText('172 kg')).toHaveStyle({ fontSize: 28, lineHeight: 34 });
        expect(screen.getByLabelText('Edit goal')).toHaveStyle({ minHeight: 48 });
        expect(screen.getByText('59% complete')).toHaveStyle({
            fontSize: 12,
            fontWeight: '600',
            flexShrink: 1
        });
        expect(onEditGoal).toHaveBeenCalledTimes(1);
    });

    it('keeps the goal action separately focusable from the snapshot content', async () => {
        const screen = await render(
            <GoalProgressCard
                goal={GOAL}
                latestMetric={{ id: 1, date: '2026-07-20', weight: 172 }}
                user={null}
                onEditGoal={jest.fn()}
            />
        );

        const action = screen.getByLabelText('Edit goal');
        expect(within(action).queryByText('Snapshot')).toBeNull();
        await fireEvent(action, 'focus', { nativeEvent: {} });
        expect(action).toHaveStyle({
            outlineWidth: themes.light.interaction.focusRingWidth,
            outlineColor: themes.light.colors.focusRing
        });
        await fireEvent(action, 'blur', { nativeEvent: {} });
        expect(action).not.toHaveStyle({ outlineWidth: themes.light.interaction.focusRingWidth });
    });

    it('keeps gain progress in the compact snapshot', async () => {
        const screen = await render(
            <GoalProgressCard
                goal={{ ...GOAL, daily_deficit: -250, target_weight: 190 }}
                latestMetric={{ id: 1, date: '2026-07-20', weight: 184 }}
                user={null}
            />
        );

        expect(screen.getByText('25% complete')).toBeTruthy();
    });

    it('keeps a reached goal durable after a later fluctuation and offers the next-goal flow', async () => {
        const onSetNextGoal = jest.fn();
        const screen = await render(
            <GoalProgressCard
                goal={{
                    ...GOAL,
                    projection: { status: 'reached', projected_end_date: null, reason_code: null }
                }}
                latestMetric={{ id: 3, date: '2026-07-24', weight: 166 }}
                metrics={[
                    { id: 3, date: '2026-07-24', weight: 166 },
                    { id: 2, date: '2026-07-22', weight: 164.8 },
                    { id: 1, date: '2026-07-10', weight: 174 }
                ]}
                user={null}
                onSetNextGoal={onSetNextGoal}
            />
        );

        expect(screen.getByText('Reached')).toBeTruthy();
        expect(screen.getByText('Goal reached on Jul 22, 2026.')).toBeTruthy();
        expect(screen.getByText(
            'Your 500 kcal/day deficit plan remains active until you set another goal.'
        )).toBeTruthy();
        expect(screen.queryByText('Goal date at selected pace')).toBeNull();

        await fireEvent.press(screen.getByLabelText('Set next goal'));
        expect(onSetNextGoal).toHaveBeenCalledTimes(1);
    });

    it('presents maintenance as ongoing without completion or projection semantics', async () => {
        const maintenanceGoal: GoalEntry = {
            ...GOAL,
            target_weight: 170,
            daily_deficit: 0,
            projection: { status: 'maintenance', projected_end_date: null, reason_code: null }
        };
        const screen = await render(
            <GoalProgressCard
                goal={maintenanceGoal}
                latestMetric={{ id: 2, date: '2026-07-24', weight: 170 }}
                metrics={[{ id: 2, date: '2026-07-24', weight: 170 }]}
                user={null}
            />
        );

        expect(screen.getByText('Ongoing')).toBeTruthy();
        expect(screen.getByText(
            'Maintenance is ongoing, with no completion percentage or projected end date.'
        )).toBeTruthy();
        expect(screen.queryByText(/% complete/)).toBeNull();
        expect(screen.queryByText('Goal date at selected pace')).toBeNull();
    });

    it('preserves progress but suppresses unsafe projection and target details', async () => {
        const onEditGoal = jest.fn();
        const screen = await render(
            <GoalProgressCard
                goal={{
                    ...GOAL,
                    plan_status: 'requires_review',
                    plan_reason_code: 'TARGET_BELOW_MINIMUM',
                    projection: {
                        status: 'unavailable',
                        projected_end_date: null,
                        reason_code: 'TARGET_BELOW_MINIMUM'
                    }
                }}
                latestMetric={{ id: 1, date: '2026-07-20', weight: 172 }}
                user={null}
                targetCalories={null}
                onEditGoal={onEditGoal}
            />
        );

        expect(screen.getByText('59% complete')).toBeTruthy();
        expect(screen.getByText('Unavailable')).toBeTruthy();
        expect(screen.queryByText(/Current target:/)).toBeNull();
        await fireEvent.press(screen.getByLabelText('Review calorie plan'));
        expect(onEditGoal).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['requires_review', 'Stored goal preserved. Calorie target unavailable until you review this plan.'],
        [undefined, 'Stored goal preserved. Calorie target unavailable until the server verifies this plan.']
    ] as const)('does not describe %s maintenance as active', async (planStatus, planCopy) => {
        const screen = await render(
            <GoalProgressCard
                goal={{
                    ...GOAL,
                    daily_deficit: 0,
                    target_weight: 170,
                    plan_status: planStatus,
                    projection: {
                        status: 'unavailable',
                        projected_end_date: null,
                        reason_code: 'SERVER_POLICY_UNAVAILABLE'
                    }
                }}
                latestMetric={{ id: 2, date: '2026-07-24', weight: 170 }}
                user={null}
            />
        );

        expect(screen.getByText('Unavailable')).toBeTruthy();
        expect(screen.getByText(planCopy)).toBeTruthy();
        expect(screen.getByText(
            'This stored maintenance goal is preserved, but its calorie target is unavailable pending review.'
        )).toBeTruthy();
        expect(screen.queryByText('Ongoing')).toBeNull();
        expect(screen.queryByText('Maintaining weight with a steady calorie target.')).toBeNull();
    });

    it('suppresses cached target and projection while a weight change is syncing', async () => {
        const screen = await render(
            <GoalProgressCard
                goal={GOAL}
                latestMetric={{ id: 2, date: '2026-07-20', weight: 170 }}
                user={null}
                targetCalories={2_000}
                weightChangePending
                onSetNextGoal={jest.fn()}
            />
        );

        expect(screen.getByText('Weight change syncing. Calorie target and projection will return after the server rechecks this plan.')).toBeTruthy();
        expect(screen.getByText('Unavailable')).toBeTruthy();
        expect(screen.queryByText('Current target: 2,000 kcal/day')).toBeNull();
        expect(screen.queryByLabelText('Set next goal')).toBeNull();
    });
});
