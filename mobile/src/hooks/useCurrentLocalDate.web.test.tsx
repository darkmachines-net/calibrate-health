/** @file Browser lifecycle tests for date refresh on visibility, focus, and page restoration. */

import { act, cleanupAsync, renderHook } from '@testing-library/react-native';
import { useCurrentLocalDate } from './useCurrentLocalDate';

jest.mock('../platform/appForeground', () => jest.requireActual('../platform/appForeground.web'));

describe('browser local day lifecycle', () => {
    const events = new Map<string, () => void>();
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-07-22T06:59:30Z'));
        const target = {
            addEventListener: (name: string, listener: () => void) => events.set(name, listener),
            removeEventListener: (name: string) => events.delete(name)
        };
        Object.defineProperty(globalThis, 'document', { configurable: true, value: { ...target, visibilityState: 'visible' } });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
    });
    afterEach(async () => {
        await cleanupAsync();
        if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
        else Reflect.deleteProperty(globalThis, 'document');
        if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
        else Reflect.deleteProperty(globalThis, 'window');
        jest.useRealTimers();
    });

    it.each(['visibilitychange', 'focus', 'pageshow'])('refreshes on %s after a suspended tab returns', event => {
        const { result, unmount } = renderHook(() => useCurrentLocalDate('America/Los_Angeles'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        act(() => events.get('visibilitychange')?.());
        expect(jest.getTimerCount()).toBe(0);
        jest.setSystemTime(new Date('2026-07-24T16:00:00Z'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        act(() => events.get(event)?.());
        expect(result.current).toBe('2026-07-24');
        expect(jest.getTimerCount()).toBe(1);
        unmount();
        expect(events.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });
});
