/** @file Route titles and presentation helpers with consistent unknown-route behavior. */

import { getRouteByPath } from './routeRegistry';

export const NOT_FOUND_DOCUMENT_TITLE = 'Page not found - Calibrate';

/** Resolves a route's document title with a consistent not-found fallback. */
export function getRouteDocumentTitle(pathname: string): string {
    return getRouteByPath(pathname)?.definition.documentTitle ?? NOT_FOUND_DOCUMENT_TITLE;
}

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
