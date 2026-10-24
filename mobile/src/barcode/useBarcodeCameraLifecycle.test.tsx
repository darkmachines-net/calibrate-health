/** @file Regression coverage for use Barcode Camera Lifecycle: useBarcodeCameraLifecycle. */

import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useBarcodeCameraLifecycle } from './useBarcodeCameraLifecycle';

let focusCleanup: (() => void) | undefined;

jest.mock('expo-router', () => {
    const ReactModule = jest.requireActual('react') as typeof import('react');
    return {
        useFocusEffect: (callback: () => (() => void) | undefined) => ReactModule.useEffect(() => {
            const cleanup = callback();
            focusCleanup = cleanup;
            return cleanup;
        }, [callback])
    };
});

describe('useBarcodeCameraLifecycle', () => {
    let appStateListener: ((state: 'active' | 'background' | 'inactive') => void) | null;
    let currentStateDescriptor: PropertyDescriptor | undefined;
    const removeAppStateListener = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        focusCleanup = undefined;
        appStateListener = null;
        currentStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
            appStateListener = listener as typeof appStateListener;
            return { remove: removeAppStateListener } as ReturnType<typeof AppState.addEventListener>;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (currentStateDescriptor) Object.defineProperty(AppState, 'currentState', currentStateDescriptor);
    });

    it('runs only while focused, active, and unobscured, then cleans up its listener', () => {
        const harness = renderHook(({ obscured }: { obscured: boolean }) => useBarcodeCameraLifecycle(obscured), {
            initialProps: { obscured: false }
        });

        expect(harness.result.current).toBe(true);
        act(() => appStateListener?.('background'));
        expect(harness.result.current).toBe(false);
        act(() => appStateListener?.('active'));
        expect(harness.result.current).toBe(true);

        harness.rerender({ obscured: true });
        expect(harness.result.current).toBe(false);
        harness.rerender({ obscured: false });
        expect(harness.result.current).toBe(true);

        act(() => focusCleanup?.());
        expect(harness.result.current).toBe(false);
        harness.unmount();
        expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    });
});
