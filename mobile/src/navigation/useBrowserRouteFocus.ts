/** @file use Browser Route Focus: Direct entries preserve browser focus so the skip link remains the first Tab target. Client-side route changes move focus to the new route heading. */

import { useEffect, useRef } from 'react';

const ROUTE_FOCUS_TITLE_ID = 'route-focus-title';
const ROUTE_FOCUS_FALLBACK_MS = 5_000;

function focusRouteTitle(): boolean {
    const title = document.getElementById(ROUTE_FOCUS_TITLE_ID);
    if (!title) return false;
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
    return true;
}

/**
 * Direct entries preserve browser focus so the skip link remains the first Tab
 * target. Client-side route changes move focus to the new route heading.
 */
export function useBrowserRouteFocus(pathname: string, title: string) {
    const initialBrowserPathnameRef = useRef(
        typeof window === 'undefined' ? pathname : (window.location?.pathname ?? pathname)
    );
    const hasResolvedInitialPathnameRef = useRef(pathname === initialBrowserPathnameRef.current);
    const previousPathnameRef = useRef(pathname);

    useEffect(() => {
        document.title = title;
        let disposed = false;
        let locationTimer: number | null = null;
        let fallbackTimer: number | null = null;
        let observer: MutationObserver | null = null;

        const cleanup = () => {
            disposed = true;
            observer?.disconnect();
            if (locationTimer !== null) window.clearTimeout(locationTimer);
            if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
        };

        const focusCommittedRoute = () => {
            if (previousPathnameRef.current === pathname) {
                if (pathname === initialBrowserPathnameRef.current) hasResolvedInitialPathnameRef.current = true;
                return;
            }
            previousPathnameRef.current = pathname;

            if (!hasResolvedInitialPathnameRef.current) {
                hasResolvedInitialPathnameRef.current = true;
                return;
            }

            if (focusRouteTitle()) return;

            observer = new MutationObserver(() => {
                if (!focusRouteTitle()) return;
                observer?.disconnect();
                if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
            });
            observer.observe(document.body, { childList: true, subtree: true });
            fallbackTimer = window.setTimeout(() => {
                observer?.disconnect();
                document.querySelector<HTMLElement>('[role="main"]')?.focus({ preventScroll: true });
            }, ROUTE_FOCUS_FALLBACK_MS);
        };

        const browserPathname = typeof window === 'undefined' ? pathname : (window.location?.pathname ?? pathname);
        if (pathname === browserPathname) {
            focusCommittedRoute();
            return cleanup;
        }

        const deadline = Date.now() + 1_000;
        const waitForCommittedLocation = () => {
            if (disposed) return;
            if ((window.location?.pathname ?? pathname) === pathname) {
                focusCommittedRoute();
                return;
            }
            if (Date.now() < deadline) locationTimer = window.setTimeout(waitForCommittedLocation, 16);
        };
        locationTimer = window.setTimeout(waitForCommittedLocation, 0);
        return cleanup;
    }, [pathname, title]);
}
