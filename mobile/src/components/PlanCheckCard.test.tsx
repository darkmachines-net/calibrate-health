/** @file Plan-check regressions for descriptive windows, stale weight recovery, report history and syncing. */

import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanCheckCard, PlanCheckCardView } from './PlanCheckCard';
import { planCheckFixture } from '../../test/fixtures/planCheck';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { getTodayDate } from '../utils/dates';

const mockPush = jest.fn();
let mockPending = false;
const mockApi = { getPlanCheck: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ api: mockApi, user: { timezone: 'UTC' } }) }));
jest.mock('../offline/usePendingCalibrationEvidenceMutation', () => ({ usePendingCalibrationEvidenceMutation: () => mockPending }));
afterEach(async () => { await cleanup(); mockPending = false; jest.clearAllMocks(); });

test('shows every available duration and partial food coverage without target actions', async () => {
    const screen = await render(<PlanCheckCardView status={planCheckFixture()} />);
    for (const days of [7, 14, 28]) expect(screen.getByText(`Last ${days} days`)).toBeTruthy();
    expect(screen.getByText('Food logged on 5 of 7 days | 4 marked complete')).toBeTruthy();
    expect(screen.getAllByText('0.35 kg loss / week')).toHaveLength(3);
    expect(screen.queryByText(/Review suggested/)).toBeNull();
    expect(screen.getByText('Your recorded weight moved gradually downward this week.')).toBeTruthy();
});

test('stale weigh-in hides weight values and offers a working log action while retaining intake coverage', async () => {
    const status = { ...planCheckFixture(), needsWeighIn: true };
    const onLogWeight = jest.fn();
    const screen = await render(<PlanCheckCardView status={status} onLogWeight={onLogWeight} />);
    expect(screen.queryByText('0.35 kg loss / week')).toBeNull();
    expect(screen.getByText(/today or yesterday/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Log weight' }));
    expect(onLogWeight).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Food logged on 5 of 7 days | 4 marked complete')).toBeTruthy();
});

test('fewer than seven days has no trend and disabled reports do not advertise a schedule', async () => {
    const status = { ...planCheckFixture(), trackingDays: 6, windows: [], weeklyReports: [], weeklyReportsEnabled: false };
    const screen = await render(<PlanCheckCardView status={status} />);
    expect(screen.getByText(/after 7 days of tracking/)).toBeTruthy();
    expect(screen.queryByText('Last 7 days')).toBeNull();
    expect(screen.queryByText('Weekly report')).toBeNull();
});

test('renders pounds and allows reopening an earlier stored report', async () => {
    const status = planCheckFixture();
    status.weightUnit = 'LB';
    status.weeklyReports.push({ ...status.weeklyReports[0], reportDate: '2026-11-01', summary: 'Previous report.' });
    const screen = await render(<PlanCheckCardView status={status} />);
    expect(screen.getAllByText('0.77 lb loss / week')).toHaveLength(3);
    await fireEvent.press(screen.getByRole('button', { name: 'Report history' }));
    const previous = screen.getAllByRole('button').at(-1)!;
    await fireEvent.press(previous);
    expect(screen.getByText('Previous report.')).toBeTruthy();
});

test('pending offline evidence hides stale summaries until sync', async () => {
    mockPending = true;
    mockApi.getPlanCheck.mockResolvedValue(planCheckFixture());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const screen = await render(<QueryClientProvider client={client}><PlanCheckCard /></QueryClientProvider>);
    expect(screen.getByText(/entries are syncing/)).toBeTruthy();
    expect(screen.queryByText('Last 7 days')).toBeNull();
    await cleanup();
    client.clear();
});

test('a failed refresh labels saved trends while reconnect retries are still running', async () => {
    mockApi.getPlanCheck.mockRejectedValueOnce(new Error('Refresh unavailable'))
        .mockImplementation(() => new Promise(() => undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0, gcTime: 0 } } });
    client.setQueryData([...calibrationStatusQueryKey, getTodayDate('UTC')], planCheckFixture());
    try {
        const screen = await render(<QueryClientProvider client={client}><PlanCheckCard /></QueryClientProvider>);
        expect(await screen.findByText("Couldn't refresh plan check")).toBeTruthy();
        expect(screen.getByText('Last 7 days')).toBeTruthy();
        expect(client.isFetching()).toBe(1);
    } finally {
        await cleanup();
        client.clear();
    }
});
