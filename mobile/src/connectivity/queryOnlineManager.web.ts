/** @file query Online Manager: Keep web Query state aligned with browser online/offline events. */

import React from 'react';
import { onlineManager } from '@tanstack/react-query';

type BrowserConnectivitySource = {
    isOnline(): boolean;
    subscribe(listener: () => void): () => void;
};

const browserConnectivity: BrowserConnectivitySource = {
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
    subscribe: (listener) => {
        if (typeof window === 'undefined') return () => undefined;
        window.addEventListener('online', listener);
        window.addEventListener('offline', listener);
        return () => {
            window.removeEventListener('online', listener);
            window.removeEventListener('offline', listener);
        };
    }
};

/** Keep web Query state aligned with browser online/offline events. */
export function configureQueryOnlineManager(
    source: BrowserConnectivitySource = browserConnectivity
): () => void {
    let unsubscribe: () => void = () => undefined;
    let subscribed = false;
    const stop = () => {
        if (!subscribed) return;
        subscribed = false;
        unsubscribe();
    };

    onlineManager.setEventListener((setOnline) => {
        const updateOnline = () => setOnline(source.isOnline());
        updateOnline();
        unsubscribe = source.subscribe(updateOnline);
        subscribed = true;
        return stop;
    });

    return () => {
        stop();
        onlineManager.setEventListener(() => () => undefined);
    };
}

/** Installs browser connectivity listeners for React Query and cleans them up on unmount. */
export function useQueryOnlineManager(): void {
    React.useEffect(() => configureQueryOnlineManager(), []);
}