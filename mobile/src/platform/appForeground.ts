/** @file Native foreground-state adapter for pausing and resuming shared client subscriptions. */

import { AppState } from 'react-native';

/** Treats unknown startup state as foreground; background and inactive states suspend client work. */
export function isAppForeground(): boolean {
    return AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
}

/** Notifies on native app-state changes and returns an unsubscribe function that removes the listener. */
export function subscribeAppForeground(listener: () => void): () => void {
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
}
