/** @file Regression coverage for Paused Day Message: shows the saved date alongside an explicit manual resume explanation. */

jest.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
jest.mock('../offline/provider', () => ({ useOfflineOutbox: () => ({ mutations: [] }) }));
import { render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PausedDayMessage } from './PausedDayMessage';

const mockGetPause = jest.fn();
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, timezone: 'Pacific/Honolulu' }, api: { getFoodTrackingPause: mockGetPause } }) }));
jest.mock('../utils/dates', () => ({ ...jest.requireActual('../utils/dates'), getTodayDate: () => '2026-07-21' }));

const pause = { active: true, starts_on: '2026-07-20', expected_resume_on: '2026-08-02', resumed_on: null };
async function mount(isToday = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return await render(<QueryClientProvider client={client}><PausedDayMessage isToday={isToday} /></QueryClientProvider>);
}

it('shows the saved date alongside an explicit manual resume explanation', async () => {
    mockGetPause.mockResolvedValue({ pause });
    const screen = await mount();
    expect(await screen.findByText('Expected to resume Aug 2, 2026')).toBeTruthy();
    expect(screen.getByText(/Resume whenever you are ready/)).toBeTruthy();
});

it('does not present the current expectation on a historical paused day', async () => {
    mockGetPause.mockClear();
    const screen = await mount(false);
    expect(screen.getByText('Tracking was paused')).toBeTruthy();
    expect(screen.queryByText(/Expected to resume/)).toBeNull();
    expect(mockGetPause).not.toHaveBeenCalled();
});

it('distinguishes loading, unavailable and invalid metadata from a confirmed open-ended pause', async () => {
    mockGetPause.mockImplementation(() => new Promise(() => {}));
    const loading = await mount();
    expect(loading.getByText('Loading pause plan...')).toBeTruthy();
    expect(loading.queryByText('Until you resume')).toBeNull(); await loading.unmount();
    mockGetPause.mockRejectedValue(new Error('Unavailable'));
    const failed = await mount();
    expect(await failed.findByText('Pause plan unavailable.')).toBeTruthy();
    expect(failed.queryByText('Until you resume')).toBeNull(); await failed.unmount();
    mockGetPause.mockResolvedValue({ pause: { ...pause, expected_resume_on: 'bad-date' } });
    const invalid = await mount();
    expect(await invalid.findByText('Pause plan unavailable.')).toBeTruthy(); await invalid.unmount();
    mockGetPause.mockResolvedValue({ pause: { ...pause, expected_resume_on: null } });
    const open = await mount();
    await waitFor(() => expect(open.getByText('Until you resume')).toBeTruthy());
});
