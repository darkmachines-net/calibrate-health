/** @file Regression coverage for Activity Summary Card: ActivitySummaryCard. */

import { render } from '@testing-library/react-native';
import type { ActivityDaySummary } from '@calibrate/api-client';
import { ActivitySummaryCard, type ActivityDay } from './ActivitySummaryCard';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const summary: ActivityDaySummary = {
    id: 1,
    local_date: '2026-08-08',
    steps: 8450,
    active_calories_kcal: 430,
    total_calories_kcal: 2380,
    exercise_minutes: 36,
    observed_at: '2026-08-08T10:00:00.000Z',
    created_at: '2026-08-08T10:00:00.000Z',
    updated_at: '2026-08-08T10:00:00.000Z'
};

const day: ActivityDay = {
    local_date: '2026-08-08',
    summary,
    records: []
};

describe('ActivitySummaryCard', () => {
    it('leads with observed activity and labels device burn without implying a target adjustment', async () => {
        const screen = await render(<ActivitySummaryCard day={day} isToday={false} />);

        expect(screen.getByText('Steps')).toBeTruthy();
        expect(screen.getByText('Active calories')).toBeTruthy();
        expect(screen.getByText('Exercise time')).toBeTruthy();
        expect(screen.getByText('Device-estimated total burn')).toBeTruthy();
        expect(screen.getByText('2,380 kcal')).toBeTruthy();
        expect(screen.queryByText('Activity')).toBeNull();
        expect(screen.queryByText(/TDEE/i)).toBeNull();
        expect(screen.queryByText(/calorie target/i)).toBeNull();
    });

    it('uses a concise empty state and keeps delayed sync wording factual', async () => {
        const emptyScreen = await render(<ActivitySummaryCard day={undefined} isToday />);
        expect(emptyScreen.getByText('No imported activity for this day')).toBeTruthy();
        expect(emptyScreen.getByText(/take a little time to deliver today/)).toBeTruthy();

        const delayedScreen = await render(<ActivitySummaryCard day={day} isToday />);
        expect(delayedScreen.getByText(/has not refreshed recently/)).toBeTruthy();
        expect(delayedScreen.getByText(/connected apps may still be syncing/)).toBeTruthy();
    });
});
