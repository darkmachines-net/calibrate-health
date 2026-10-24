/** @file use Barcode Camera Lifecycle: Stops camera capture whenever another surface covers the preview or the route leaves the foreground. */

import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';

/** Stops camera capture whenever another surface covers the preview or the route leaves the foreground. */
export function useBarcodeCameraLifecycle(obscured: boolean): boolean {
    const [isFocused, setIsFocused] = useState(false);
    const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

    useFocusEffect(useCallback(() => {
        setIsFocused(true);
        return () => setIsFocused(false);
    }, []));

    useEffect(() => {
        const subscription = AppState.addEventListener('change', setAppState);
        return () => subscription.remove();
    }, []);

    return isFocused && appState === 'active' && !obscured;
}
