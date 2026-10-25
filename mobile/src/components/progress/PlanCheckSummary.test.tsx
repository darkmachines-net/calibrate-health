/** @file Regression coverage for Plan Check Summary: PlanCheckSummary. */

import { fireEvent, render, within } from '@testing-library/react-native';
import type { CalibrationStatusResponse } from '@calibrate/api-client';
import { PlanCheckSummaryView } from './PlanCheckSummary';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ api: {} }) }));
jest.mock('../../offline/usePendingCalibrationEvidenceMutation', () => ({ usePendingCalibrationEvidenceMutation: () => false }));

function status(): CalibrationStatusResponse {
    return {
        generatedAt: '2026-09-13T12:00:00Z', inputFingerprint: 'summary', planStatus: 'available', planReasonCode: null,
        recommendation: null, scheduledChange: null,
        evaluation: {
            modelVersion: 4, asOfDate: '2026-09-13', weightUnit: 'KG', status: 'insight',
            headline: '', summary: '', nextStep: '', historyProgress: null, selectedWindowDays: 28,
            dataQuality: { observationDays: 28, completeDays: 28, confidentDays: 28, suspiciousDays: 0, incompleteDays: 0, missingDays: 0, weightPoints: 14, weightSpanDays: 28 },
            missingCriteria: [], assumptions: [],
            estimates: { averageIntakeKcal: null, observedWeeklyWeightChangeKg: null, targetAdjustmentKcal: null, configuredWeeklyWeightChangeKg: -0.46 },
            recommendation: null, activityContext: null,
            assessment: {
                version: 1, state: 'off_track', paceStatus: 'slower',
                window: { startDate: '2026-08-16', endDate: '2026-09-13', spanDays: 28, confidenceLevel: 0.95 },
                recentWeightTrendKgPerWeek: { low: -0.23, midpoint: -0.15, high: -0.07 }, goalRateKgPerWeek: -0.46,
                blocker: null, targetDecision: 'no_change_recommended', targetDecisionBlocker: null,
                minimumDailyCalorieTargetKcal: 1200
            }
        }
    };
}

describe('PlanCheckSummary', () => {
    it('offers one full-width target for the heading, period, and diagnosis', async () => {
        const onPress = jest.fn();
        const screen = await render(<PlanCheckSummaryView status={status()} onPress={onPress} />);
        const target = screen.getByLabelText('Open plan check details. Your recent weight trend is slower than your goal');
        expect(screen.getByText('28 days through Sep 13')).toBeTruthy();
        expect(screen.getAllByRole('button')).toHaveLength(1);
        expect(within(target).getByText('Plan check')).toBeTruthy();
        expect(within(target).getByText('28 days through Sep 13')).toBeTruthy();
        await fireEvent.press(target);
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ pendingEvidence: true }, 'Your latest food and weight entries are syncing.'],
        [{ planAvailable: false }, 'Review your calorie plan to restart this check.'],
        [{ isLoading: true }, 'Building your plan check...'],
        [{ error: true }, 'Open details to retry your plan check.'],
        [{ offline: true }, 'Reconnect to load your plan check.']
    ])('keeps a navigable slot when the check cannot show a diagnosis (%s)', async (props, copy) => {
        const screen = await render(<PlanCheckSummaryView {...props} onPress={jest.fn()} />);
        expect(screen.getByText(copy)).toBeTruthy();
        expect(screen.getByTestId('plan-check-summary')).toBeTruthy();
        expect(screen.getByRole('button')).toBeEnabled();
    });

    it('points scheduled updates to the details that retain review and undo', async () => {
        const current = status();
        current.scheduledChange = { recommendationId: 7, effectiveLocalDate: '2026-09-14', dailyCalorieBudgetKcal: 1900 } as NonNullable<CalibrationStatusResponse['scheduledChange']>;
        const screen = await render(<PlanCheckSummaryView status={current} onPress={jest.fn()} />);
        expect(screen.getByText('A calorie target update is scheduled. Open details to review or undo it.')).toBeTruthy();
    });

    it('labels a saved diagnosis when a later refresh fails', async () => {
        const screen = await render(<PlanCheckSummaryView status={status()} error onPress={jest.fn()} />);
        expect(screen.getByText('Could not refresh | Showing saved check')).toBeTruthy();
        expect(screen.getByText('Your recent weight trend is slower than your goal')).toBeTruthy();
        expect(screen.getByRole('button')).toBeEnabled();
    });
});
