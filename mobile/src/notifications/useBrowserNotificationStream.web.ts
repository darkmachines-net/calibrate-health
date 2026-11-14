/** @file Keeps the foreground browser notification cache synchronized over one reconnecting stream. */

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
    NOTIFICATION_REALTIME_EVENT_NAME,
    isNotificationRealtimePayload
} from '../../../shared/notificationRealtime';
import { isAppForeground, subscribeAppForeground } from '../platform/appForeground.web';
import { invalidateNotificationQueries } from './query';

export { MOBILE_NOTIFICATION_QUERY_KEY } from './query';

// Reconnect after transient server or network failures without creating a tight request loop.
export const NOTIFICATION_STREAM_RECONNECT_MS = 5_000;

type StreamEvent = { data: string };
type StreamSource = {
    addEventListener(name: string, listener: (event: StreamEvent) => void): void;
    close(): void;
    onerror: ((event: Event) => unknown) | null;
    onopen: ((event: Event) => unknown) | null;
};

type NotificationStreamDependencies = {
    serverUrl: string;
    createSource(url: string, options: { withCredentials: true }): StreamSource;
    invalidate(): void;
    scheduleReconnect(callback: () => void, delayMs: number): number;
    cancelReconnect(timerId: number): void;
    isForeground(): boolean;
    subscribeForeground(listener: () => void): () => void;
};

/** Builds the versioned server-sent notification stream URL for the selected server. */
export function getNotificationStreamUrl(serverUrl: string): string {
    return new URL('/api/v1/notifications/stream', serverUrl).toString();
}

/** Own one credentialed stream while visible, refetch after each open, and return idempotent cleanup. */
export function connectBrowserNotificationStream(dependencies: NotificationStreamDependencies): () => void {
    let active = true;
    let source: StreamSource | null = null;
    let reconnectTimer: number | null = null;
    const streamUrl = getNotificationStreamUrl(dependencies.serverUrl);

    function cancelPendingReconnect() {
        if (reconnectTimer === null) return;
        dependencies.cancelReconnect(reconnectTimer);
        reconnectTimer = null;
    }

    function closeSource() {
        const previous = source;
        source = null;
        previous?.close();
    }

    function connect() {
        if (!active || source || !dependencies.isForeground()) return;
        const current = dependencies.createSource(streamUrl, { withCredentials: true });
        source = current;
        // The server has no event replay. Refresh once the new subscription can observe further writes.
        current.onopen = () => { if (source === current) dependencies.invalidate(); };
        current.addEventListener(NOTIFICATION_REALTIME_EVENT_NAME, (event) => {
            if (source !== current) return;
            try {
                if (isNotificationRealtimePayload(JSON.parse(event.data))) dependencies.invalidate();
            } catch {
                // The normal notification query remains the recovery path for malformed stream data.
            }
        });
        current.onerror = () => {
            if (source !== current) return;
            closeSource();
            reconnectTimer = dependencies.scheduleReconnect(() => {
                reconnectTimer = null;
                connect();
            }, NOTIFICATION_STREAM_RECONNECT_MS);
        };
    }

    connect();
    const unsubscribeForeground = dependencies.subscribeForeground(() => {
        if (!active) return;
        if (!dependencies.isForeground()) {
            cancelPendingReconnect();
            closeSource();
        } else if (source || reconnectTimer !== null) {
            dependencies.invalidate();
        } else {
            connect();
        }
    });
    return () => {
        if (!active) return;
        active = false;
        unsubscribeForeground();
        cancelPendingReconnect();
        closeSource();
    };
}

/** Own the foreground notification source for the selected server and full-access account. */
export function useBrowserNotificationStream({
    accountId,
    serverUrl,
    queryClient
}: {
    accountId: number | undefined;
    serverUrl: string;
    queryClient: QueryClient;
}) {
    useEffect(() => {
        if (accountId === undefined || !serverUrl || typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
            return;
        }
        return connectBrowserNotificationStream({
            serverUrl,
            createSource: (url, options) => new window.EventSource(url, options),
            invalidate: () => void invalidateNotificationQueries(queryClient),
            scheduleReconnect: (callback, delayMs) => window.setTimeout(callback, delayMs),
            cancelReconnect: (timerId) => window.clearTimeout(timerId),
            isForeground: isAppForeground,
            subscribeForeground: subscribeAppForeground
        });
    }, [accountId, queryClient, serverUrl]);
}
