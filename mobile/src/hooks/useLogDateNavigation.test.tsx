/** @file Local-day navigation coverage for midnight, timezones, clock corrections, and foreground lifecycle. */

import { act, cleanup, renderHook } from '@testing-library/react-native';
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
        // Keep React's async-render microtasks real so timer counts measure only the local-day clock.
        jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
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
        await cleanup();
        jest.restoreAllMocks();
        if (originalState) Object.defineProperty(AppState, 'currentState', originalState);
        jest.useRealTimers();
    });

    it('unlocks the new day at midnight while preserving the selected date', async () => {
        const { result } = await renderHook(() => useLogDateNavigation());
        expect(result.current).toMatchObject({ selectedDate: '2026-07-21', today: '2026-07-21', isToday: true, canGoForward: false });
        await act(() => jest.advanceTimersByTime(30_000));
        expect(result.current).toMatchObject({ selectedDate: '2026-07-21', today: '2026-07-22', maxDate: '2026-07-22', isToday: false, canGoForward: true });
        await act(() => result.current.goToNextDate());
        expect(result.current).toMatchObject({ selectedDate: '2026-07-22', isToday: true, canGoForward: false });
        await act(() => result.current.setDate('2026-07-23'));
        expect(result.current.selectedDate).toBe('2026-07-22');
    });

    it.each([1, 4])('refreshes immediately after %i suspended days without firing timers', async days => {
        const { result } = await renderHook(() => useLogDateNavigation('2026-07-19'));
        await act(() => setAppState('background'));
        expect(jest.getTimerCount()).toBe(0);
        jest.setSystemTime(new Date(`2026-07-${21 + days}T16:00:00Z`));
        await act(() => setAppState('active'));
        expect(result.current.selectedDate).toBe('2026-07-19');
        expect(result.current.maxDate).toBe(`2026-07-${21 + days}`);
        await act(() => result.current.goToToday());
        expect(result.current.isToday).toBe(true);
        expect(result.current.selectedDate).toBe(`2026-07-${21 + days}`);
    });

    it.each([
        ['2026-03-09T06:59:30Z', '2026-03-08', '2026-03-09'],
        ['2026-11-02T07:59:30Z', '2026-11-01', '2026-11-02'],
        ['2027-01-01T07:59:30Z', '2026-12-31', '2027-01-01']
    ])('rolls over DST and year boundaries from %s', async (instant, before, after) => {
        jest.setSystemTime(new Date(instant));
        const { result } = await renderHook(() => useLogDateNavigation());
        expect(result.current.today).toBe(before);
        await act(() => jest.advanceTimersByTime(30_000));
        expect(result.current).toMatchObject({ selectedDate: before, today: after, canGoForward: true });
    });

    it('uses the profile timezone and reacts to changes and backward clock corrections', async () => {
        const { result, rerender } = await renderHook(() => useLogDateNavigation('2026-07-19'));
        expect(result.current.today).toBe('2026-07-21');
        mockUser.timezone = 'Asia/Kathmandu';
        await rerender({});
        expect(result.current.today).toBe('2026-07-22');
        jest.setSystemTime(new Date('2026-07-20T01:00:00Z'));
        await act(() => jest.advanceTimersByTime(60_000));
        expect(result.current).toMatchObject({ today: '2026-07-20', selectedDate: '2026-07-19' });
    });

    it('shares one timer and listener, avoids same-day renders, and cleans up', async () => {
        jest.setSystemTime(new Date('2026-07-21T19:00:00Z'));
        const render = jest.fn();
        const first = await renderHook(() => { render(); return useLogDateNavigation(); });
        const second = await renderHook(() => useLogDateNavigation());
        expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);
        const before = render.mock.calls.length;
        await act(() => jest.advanceTimersByTime(120_000));
        expect(render).toHaveBeenCalledTimes(before);
        await first.unmount();
        expect(remove).not.toHaveBeenCalled();
        await second.unmount();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not reapply an old route date when bounds or selection change', async () => {
        const { result, rerender } = await renderHook(({ date }: { date: string | undefined }) => {
            const navigation = useLogDateNavigation();
            useLogDateRouteParameter(date, navigation.setDate);
            return navigation;
        }, { initialProps: { date: '2026-07-20' as string | undefined } });
        expect(result.current.selectedDate).toBe('2026-07-20');
        await act(() => result.current.goToNextDate());
        await act(() => jest.advanceTimersByTime(30_000));
        expect(result.current.selectedDate).toBe('2026-07-21');
        await act(() => result.current.goToNextDate());
        expect(result.current.selectedDate).toBe('2026-07-22');
        await rerender({ date: undefined });
        await rerender({ date: '2026-07-20' });
        expect(result.current.selectedDate).toBe('2026-07-20');
    });
});
