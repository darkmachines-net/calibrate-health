/** @file one Time Token: Capture before the route tree mounts so fragments never reach child effects or diagnostics. */

import { Platform } from 'react-native';

type BrowserLocation = Pick<Location, 'hash' | 'pathname' | 'search'>;
type BrowserHistory = Pick<History, 'replaceState' | 'state'>;

let pendingBrowserToken: { pathname: string; token: string } | null = null;

type TokenWindow = Window & {
    __calibrateOneTimeToken?: { pathname: string; token: string };
};

function firstParam(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0]?.trim() || null;
    return value?.trim() || null;
}

function tokenFromRoutedFragment(value: string | string[] | undefined): string | null {
    const fragment = firstParam(value)?.replace(/^#/, '');
    if (!fragment) return null;
    return new URLSearchParams(fragment).get('token')?.trim() || null;
}

function readBrowserToken(browser: { location: BrowserLocation; history: BrowserHistory }): string | null {
    const hashParams = new URLSearchParams(browser.location.hash.replace(/^#/, ''));
    const queryParams = new URLSearchParams(browser.location.search);
    const token = hashParams.get('token')?.trim() || queryParams.get('token')?.trim() || null;
    if (!hashParams.has('token') && !queryParams.has('token')) return token;

    queryParams.delete('token');
    const remainingQuery = queryParams.toString();
    browser.history.replaceState(
        browser.history.state,
        '',
        `${browser.location.pathname}${remainingQuery ? `?${remainingQuery}` : ''}`
    );
    return token;
}

/** Capture before the route tree mounts so fragments never reach child effects or diagnostics. */
export function scrubBrowserOneTimeTokenFromUrl(_pathname: string): void {
    if (typeof window === 'undefined') return;
    const browserPathname = window.location.pathname;
    if (browserPathname !== '/reset-password' && browserPathname !== '/verify-email') return;
    const token = readBrowserToken({ location: window.location, history: window.history });
    if (token) pendingBrowserToken = { pathname: browserPathname, token };
}

/**
 * Consume a purpose-bound token once. Browser fragments are scrubbed before
 * child effects, network calls, or diagnostics can observe them.
 */
export function consumeOneTimeToken(
    routedToken: string | string[] | undefined,
    browser: { location: BrowserLocation; history: BrowserHistory } | null =
        Platform.OS === 'web'
            && typeof window !== 'undefined'
            && Boolean(window.location)
            && Boolean(window.history)
            ? { location: window.location, history: window.history }
            : null,
    routedFragment?: string | string[]
): string | null {
    const nativeFragmentToken = tokenFromRoutedFragment(routedFragment);
    if (!browser) return nativeFragmentToken ?? firstParam(routedToken);

    const token = readBrowserToken(browser);
    const tokenWindow = typeof window === 'undefined' ? null : window as TokenWindow;
    const bootstrapped = tokenWindow?.__calibrateOneTimeToken?.pathname === browser.location.pathname
        ? tokenWindow.__calibrateOneTimeToken.token
        : null;
    if (bootstrapped && tokenWindow) delete tokenWindow.__calibrateOneTimeToken;
    const captured = pendingBrowserToken?.pathname === browser.location.pathname
        ? pendingBrowserToken.token
        : null;
    if (captured) pendingBrowserToken = null;
    return token ?? bootstrapped ?? captured ?? nativeFragmentToken ?? firstParam(routedToken);
}