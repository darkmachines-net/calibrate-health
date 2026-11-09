/** @file Compact plan-check coverage for navigation, freshness, empty history and offline states. */

import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { PlanCheckSummaryView } from './PlanCheckSummary';
import { planCheckFixture } from '../../../test/fixtures/planCheck';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ api: {}, user: { timezone: 'UTC' } }) }));
jest.mock('../../offline/usePendingCalibrationEvidenceMutation', () => ({ usePendingCalibrationEvidenceMutation: () => false }));
afterEach(cleanup);

test('one accessible expansion target advertises durations and available reports', async () => {
    const onPress = jest.fn();
    const screen = await render(<PlanCheckSummaryView status={planCheckFixture()} onPress={onPress} />);
    expect(screen.getByText('Last 7, 14, 28 days')).toBeTruthy();
    expect(screen.getByText('Your weekly report and recent trends are ready.')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
});

test.each([
    [{ pendingEvidence: true }, 'Your latest food and weight entries are syncing.'],
    [{ isLoading: true }, 'Loading your progress summary...'],
    [{ error: true }, 'Open details to retry your progress summary.'],
    [{ offline: true }, 'Reconnect to load your progress summary.']
])('retains navigation during pending and unavailable states', async (props, copy) => {
    const screen = await render(<PlanCheckSummaryView {...props} onPress={jest.fn()} />);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByRole('button')).toBeEnabled();
});

test('requests a recent weigh-in and identifies failed refreshes', async () => {
    const screen = await render(<PlanCheckSummaryView status={{ ...planCheckFixture(), needsWeighIn: true }} error onPress={jest.fn()} />);
    expect(screen.getByText('Log your weight today to restore weight trends.')).toBeTruthy();
    expect(screen.getByText('Could not refresh | Showing saved check')).toBeTruthy();
});
