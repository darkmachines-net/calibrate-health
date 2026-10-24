/** @file use Pending Logout Retry: Signed-out sessions still finish revocation on reconnect/foreground; failures retain durable intent. */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { onlineManager } from '@tanstack/react-query';

/** Signed-out sessions still finish revocation on reconnect/foreground; failures retain durable intent. */
export function usePendingLogoutRetry(server: string, flush: (server: string) => Promise<void>, onFlushed: () => void) {
    const completed = useRef(onFlushed);
    completed.current = onFlushed;
    useEffect(() => {
        if (!server) return;
        const retry = () => { if (onlineManager.isOnline()) void flush(server).then(() => completed.current()).catch(() => undefined); };
        const unsubscribe = onlineManager.subscribe(online => { if (online) retry(); });
        const foreground = AppState.addEventListener('change', state => { if (state === 'active') retry(); });
        return () => { unsubscribe(); foreground.remove(); };
    }, [server, flush]);
}
