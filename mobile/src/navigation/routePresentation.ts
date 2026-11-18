/** @file Back navigation labels and browser history detection for the app shell. */

import { getRouteByPath } from './routeRegistry';

/** Returns an appropriate back label only for routes that declare a parent. */
export function getRouteBackLabel(pathname: string, canGoBack: boolean): string | null {
    const match = getRouteByPath(pathname);
    if (!match?.definition.parent) return null;
    if (canGoBack) return 'Go back';
    return match.definition.backLabel ?? 'Go back';
}

/** Detects whether browser navigation added history since the shell mounted. */
export function hasBrowserHistorySinceMount(initialLength: number, currentLength: number): boolean {
    return currentLength > initialLength;
}
