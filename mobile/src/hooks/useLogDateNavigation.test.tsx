/** @file Guards selected log dates across local midnight, explicit navigation, and route intents. */

import { act, cleanupAsync, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useLogDateNavigation } from './useLogDateNavigation';
import { useLogDateRouteParameter } from './useLogDateRouteParameter';

const mockUser = { timezone: 'America/Los_Angeles', created_at: '2026-01-01T12:00:00Z' };
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser, api: {} }) }));
jest.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: { tracking_start_date: '2026-01-01' } }) }));

describe('live local-day navigation', () => {
    let onAppState: (state: AppStateStatus) => void;
    let originalState: PropertyDescriptor | undefined;
    const remove = jest.fn();
    function setAppState(state: AppStateStatus) {
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
        onAppState(state);
    }

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-22T06:59:30Z'));
        mockUser.timezone = 'America/Los_Angeles';
        originalState = Object.getOwnPropertyDescriptor(AppState, 'currentState');
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
        remove.mockClear();
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
            onAppState = listener;
            return { remove };
        });
    });
    afterEach(async () => {
        await cleanupAsync();
        jest.restoreAllMocks();
        if (originalState) Object.defineProperty(AppState, 'currentState', originalState);
        jest.useRealTimers();
    });

    it('unlocks the new day at midnight while preserving the selected date', () => {
        const { result } = renderHook(() => useLogDateNavigation());
        expect(result.current).toMatchObject({ selectedDate: '2026-07-21', today: '2026-07-21', isToday: true, canGoForward: false });
        act(() => jest.advanceTimersByTime(30_000));
        expect(result.current).toMatchObject({ selectedDate: '2026-07-21', today: '2026-07-22', maxDate: '2026-07-22', isToday: false, canGoForward: true });
        act(() => result.current.goToNextDate());
        expect(result.current).toMatchObject({ selectedDate: '2026-07-22', isToday: true, canGoForward: false });
        act(() => result.current.setDate('2026-07-23'));
        expect(result.current.selectedDate).toBe('2026-07-22');
    });

    it.each([1, 4])('refreshes immediately after %i suspended days without firing timers', days => {
        const { result } = renderHook(() => useLogDateNavigation('2026-07-19'));
        act(() => setAppState('background'));
        expect(jest.getTimerCount()).toBe(0);
        jest.setSystemTime(new Date(`2026-07-${21 + days}T16:00:00Z`));
        act(() => setAppState('active'));
        expect(result.current.selectedDate).toBe('2026-07-19');
        expect(result.current.maxDate).toBe(`2026-07-${21 + days}`);
        act(() => result.current.goToToday());
        expect(result.current.isToday).toBe(true);
        expect(result.current.selectedDate).toBe(`2026-07-${21 + days}`);
    });

    it.each([
        ['2026-03-09T06:59:30Z', '2026-03-08', '2026-03-09'],
        ['2026-11-02T07:59:30Z', '2026-11-01', '2026-11-02'],
        ['2027-01-01T07:59:30Z', '2026-12-31', '2027-01-01']
    ])('rolls over DST and year boundaries from %s', (instant, before, after) => {
        jest.setSystemTime(new Date(instant));
        const { result } = renderHook(() => useLogDateNavigation());
        expect(result.current.today).toBe(before);
        act(() => jest.advanceTimersByTime(30_000));
        expect(result.current).toMatchObject({ selectedDate: before, today: after, canGoForward: true });
    });

    it('uses the profile timezone and reacts to changes and backward clock corrections', () => {
        const { result, rerender } = renderHook(() => useLogDateNavigation('2026-07-19'));
        expect(result.current.today).toBe('2026-07-21');
        mockUser.timezone = 'Asia/Kathmandu';
        rerender({});
        expect(result.current.today).toBe('2026-07-22');
        jest.setSystemTime(new Date('2026-07-20T01:00:00Z'));
        act(() => jest.advanceTimersByTime(60_000));
        expect(result.current).toMatchObject({ today: '2026-07-20', selectedDate: '2026-07-19' });
    });

    it('shares one timer and listener, avoids same-day renders, and cleans up', () => {
        jest.setSystemTime(new Date('2026-07-21T19:00:00Z'));
        const render = jest.fn();
        const first = renderHook(() => { render(); return useLogDateNavigation(); });
        const second = renderHook(() => useLogDateNavigation());
        expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
        const before = render.mock.calls.length;
        act(() => jest.advanceTimersByTime(120_000));
        expect(render).toHaveBeenCalledTimes(before);
        first.unmount();
        expect(remove).not.toHaveBeenCalled();
        second.unmount();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not reapply an old route date when bounds or selection change', () => {
        const { result, rerender } = renderHook(({ date }: { date: string | undefined }) => {
            const navigation = useLogDateNavigation();
            useLogDateRouteParameter(date, navigation.setDate);
            return navigation;
        }, { initialProps: { date: '2026-07-20' as string | undefined } });
        expect(result.current.selectedDate).toBe('2026-07-20');
        act(() => result.current.goToNextDate());
        act(() => jest.advanceTimersByTime(30_000));
        expect(result.current.selectedDate).toBe('2026-07-21');
        act(() => result.current.goToNextDate());
        expect(result.current.selectedDate).toBe('2026-07-22');
        rerender({ date: undefined });
        rerender({ date: '2026-07-20' });
        expect(result.current.selectedDate).toBe('2026-07-20');
    });
});
