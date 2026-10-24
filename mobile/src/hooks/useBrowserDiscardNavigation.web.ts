/** @file use Browser Discard Navigation: Registers the focused page's browser discard guard and removes it when focus or dirty state changes. */

import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

type RequestNavigation = (navigate: () => void) => Promise<void>;
const HISTORY_POSITION = '__calibrateHistoryPosition';

let position = 0;
let requestNavigation: RequestNavigation | undefined;
let restoring: { origin: number; destination: number; request: RequestNavigation } | undefined;

function readPosition(state: unknown): number | undefined {
    if (!state || typeof state !== 'object') return undefined;
    const value = (state as Record<string, unknown>)[HISTORY_POSITION];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function withPosition(state: unknown, nextPosition: number) {
    return { ...(state && typeof state === 'object' ? state : {}), [HISTORY_POSITION]: nextPosition };
}

// Track entries before Router starts writing history. Keep its state/IDs intact.
// Browser traversal resets nested Router state without emitting beforeRemove.
if (typeof window !== 'undefined') {
    const pushState = window.history.pushState.bind(window.history);
    const replaceState = window.history.replaceState.bind(window.history);
    position = readPosition(window.history.state) ?? 0;
    replaceState(withPosition(window.history.state, position), '');

    window.history.pushState = (state, unused, url) => {
        const nextPosition = position + 1;
        pushState(withPosition(state, nextPosition), unused, url);
        position = nextPosition;
    };
    window.history.replaceState = (state, unused, url) => {
        replaceState(withPosition(state, position), unused, url);
    };

    window.addEventListener('popstate', (event) => {
        const destination = readPosition(event.state);
        if (destination === undefined) return;

        if (restoring) {
            event.stopImmediatePropagation();
            if (destination !== restoring.origin) {
                window.history.go(restoring.origin - destination);
                return;
            }
            const pending = restoring;
            restoring = undefined;
            position = pending.origin;
            void pending.request(() => window.history.go(pending.destination - pending.origin));
            return;
        }

        const origin = position;
        position = destination;
        if (!requestNavigation || destination === origin) return;

        // Restore the real entry before asking, so cancellation preserves Forward
        // history, the current URL, and the mounted draft without inserting entries.
        event.stopImmediatePropagation();
        restoring = { origin, destination, request: requestNavigation };
        window.history.go(origin - destination);
    }, true);
}

/** Registers the focused page's browser discard guard and removes it when focus or dirty state changes. */
export function useBrowserDiscardNavigation(
    shouldPreventRemoval: boolean,
    request: RequestNavigation
): void {
    useFocusEffect(useCallback(() => {
        if (!shouldPreventRemoval) return;
        requestNavigation = request;
        return () => {
            if (requestNavigation === request) requestNavigation = undefined;
        };
    }, [request, shouldPreventRemoval]));
}
