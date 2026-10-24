/** @file Browser visibility and restoration adapter with safe server-rendering defaults. */

/** Reports visible browser documents as foreground and returns false during server rendering. */
export function isAppForeground(): boolean {
    return typeof document !== 'undefined' && document.visibilityState !== 'hidden';
}

/** Notifies on visibility, focus, or page restoration; returns cleanup and is inert during server rendering. */
export function subscribeAppForeground(listener: () => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    window.addEventListener('focus', listener);
    window.addEventListener('pageshow', listener);
    return () => {
        document.removeEventListener('visibilitychange', listener);
        window.removeEventListener('focus', listener);
        window.removeEventListener('pageshow', listener);
    };
}
