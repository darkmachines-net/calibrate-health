/** @file Server-scoped logout intent, durable revocation retry, and automatic sign-in suppression. */

type Intent = { signedOut: boolean; pending: boolean; refreshTokens?: string[] };
type Storage = { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void>; remove: (key: string) => Promise<void> };

/**
 * Create a per-server logout journal backed by the supplied storage and optional
 * cross-context lock. Browser revocation uses the cookie session. Native
 * revocation retains the refresh tokens still awaiting acknowledgement.
 */
export function createLogoutIntentStore(storage: Storage, revoke: (server: string, token?: string) => Promise<unknown>, browser: boolean, lock: <T>(key: string, work: () => Promise<T>) => Promise<T> = (_key, work) => work()) {
    const pending = new Map<string, Promise<unknown>>();
    const unsaved = new Map<string, Intent>();
    const unreadable = new Set<string>();
    const key = (server: string) => 'calibrate.logout.' + Array.from(new URL(server).origin).map(c => c.charCodeAt(0).toString(16)).join('');
    function serial<T>(server: string, work: (storageKey: string) => Promise<T>): Promise<T> {
        const storageKey = key(server);
        const result = (pending.get(storageKey) ?? Promise.resolve()).then(() => lock(storageKey, () => work(storageKey)));
        pending.set(storageKey, result.catch(() => undefined));
        return result;
    }
    const read = async (k: string): Promise<Intent | null> => unsaved.get(k) ?? JSON.parse(await storage.get(k) ?? 'null') as Intent | null;
    const save = async (k: string, intent: Intent) => {
        // Keep an in-process recovery path even when persistent storage rejects the write.
        unsaved.set(k, intent);
        if (unreadable.has(k)) throw new Error('Sign-out storage could not be read; existing durable intent is preserved.');
        if (intent.signedOut || intent.pending) await storage.set(k, JSON.stringify(intent));
        else await storage.remove(k);
        unsaved.delete(k);
    };
    return {
        /** Check whether explicit sign-out still suppresses automatic sign-in for this server. */
        hasExplicitLogout: (server: string) => serial(server, async k => Boolean((await read(k))?.signedOut)),
        /** Record sign-out and any pending cookie-session or refresh-token revocation. */
        beginExplicitLogout: (server: string, token?: string) => serial(server, async k => {
            const previous = await read(k).catch(() => { unreadable.add(k); return null; });
            const tokens = browser ? [] : [...new Set([...(previous?.refreshTokens ?? []), ...(token ? [token] : [])])];
            await save(k, { signedOut: true, pending: browser || tokens.length > 0, ...(tokens.length ? { refreshTokens: tokens } : {}) });
        }),
        /** A rotated token arriving after logout must be revoked without signing out a replacement account. */
        enqueueRevocation: (server: string, token: string) => serial(server, async k => {
            if (browser) throw new Error('Browser invalidation does not accept refresh tokens.');
            const previous = await read(k);
            await save(k, { signedOut: previous?.signedOut ?? false, pending: true, refreshTokens: [...new Set([...(previous?.refreshTokens ?? []), token])] });
        }),
        /** Revoke outstanding credentials in order, preserving sign-out and retaining pending work on failure. */
        flushExplicitLogout: (server: string) => serial(server, async k => {
            const intent = await read(k);
            if (!intent?.pending) return;
            if (browser) {
                await revoke(server);
                await save(k, { signedOut: intent.signedOut, pending: false }).catch(() => undefined);
            } else {
                const remaining = [...(intent.refreshTokens ?? [])];
                while (remaining.length) {
                    await revoke(server, remaining[0]);
                    remaining.shift();
                    await save(k, { signedOut: intent.signedOut, pending: remaining.length > 0, ...(remaining.length ? { refreshTokens: remaining } : {}) }).catch(() => undefined);
                }
            }
        }),
        /** Clear sign-out suppression after a new login while retaining any pending revocation. */
        finishExplicitLogin: (server: string) => serial(server, async k => {
            const intent = await read(k);
            if (intent?.pending) await save(k, { ...intent, signedOut: false });
            else await save(k, { signedOut: false, pending: false });
        })
    };
}
