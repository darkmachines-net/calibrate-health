/** @file Shared foreground clock that keeps timezone-specific dates current without a timer per subscriber. */

import { useCallback, useSyncExternalStore } from 'react';
import { isAppForeground, subscribeAppForeground } from '../platform/appForeground';
import { getTodayDate } from '../utils/dates';

// Minute boundaries include local midnight in current IANA zones and catch clock corrections.
const DATE_CHECK_INTERVAL_MS = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribeForeground: (() => void) | undefined;

function refresh() {
    clearTimeout(timer);
    timer = undefined;
    if (!isAppForeground()) return;
    listeners.forEach(listener => listener());
    timer = setTimeout(refresh, DATE_CHECK_INTERVAL_MS - Date.now() % DATE_CHECK_INTERVAL_MS);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        unsubscribeForeground = subscribeAppForeground(refresh);
        refresh();
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        clearTimeout(timer);
        timer = undefined;
        unsubscribeForeground?.();
        unsubscribeForeground = undefined;
    };
}

/** One foreground clock for all consumers; React only rerenders when their local day changes. */
export function useCurrentLocalDate(timezone?: string | null): string {
    const getSnapshot = useCallback(() => getTodayDate(timezone), [timezone]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
