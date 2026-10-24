/** @file Authenticated browser notification stream lifecycle and bounded cache invalidation. */

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
    NOTIFICATION_REALTIME_EVENT_NAME,
    isNotificationRealtimePayload
} from '../../../shared/notificationRealtime';
import { MOBILE_NOTIFICATION_QUERY_KEY } from './query';

export { MOBILE_NOTIFICATION_QUERY_KEY } from './query';

// Reconnect after transient server or network failures without creating a tight request loop.
export const NOTIFICATION_STREAM_RECONNECT_MS = 5_000;

type StreamEvent = { data: string };
type StreamSource = {
    addEventListener(name: string, listener: (event: StreamEvent) => void): void;
    close(): void;
    onerror: ((event: Event) => unknown) | null;
};

type NotificationStreamDependencies = {
    serverUrl: string;
    createSource(url: string, options: { withCredentials: true }): StreamSource;
    invalidate(): void;
    scheduleReconnect(callback: () => void, delayMs: number): number;
    cancelReconnect(timerId: number): void;
};

/** Builds the versioned server-sent notification stream URL for the selected server. */
export function getNotificationStreamUrl(serverUrl: string): string {
    return new URL('/api/v1/notifications/stream', serverUrl).toString();
}

/** Own one credentialed, reconnecting browser stream and return an idempotent teardown. */
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

    function connect() {
        cancelPendingReconnect();
        if (!active) return;
        source = dependencies.createSource(streamUrl, { withCredentials: true });
        source.addEventListener(NOTIFICATION_REALTIME_EVENT_NAME, (event) => {
            try {
                if (isNotificationRealtimePayload(JSON.parse(event.data))) dependencies.invalidate();
            } catch {
                // The normal notification query remains the recovery path for malformed stream data.
            }
        });
        source.onerror = () => {
            source?.close();
            source = null;
            if (!active) return;
            reconnectTimer = dependencies.scheduleReconnect(connect, NOTIFICATION_STREAM_RECONNECT_MS);
        };
    }

    connect();
    return () => {
        if (!active) return;
        active = false;
        cancelPendingReconnect();
        source?.close();
        source = null;
    };
}

/** Keep the selected authenticated browser session subscribed to notification changes. */
export function useBrowserNotificationStream({
    enabled,
    serverUrl,
    queryClient
}: {
    enabled: boolean;
    serverUrl: string;
    queryClient: QueryClient;
}) {
    useEffect(() => {
        if (!enabled || !serverUrl || typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
            return;
        }
        return connectBrowserNotificationStream({
            serverUrl,
            createSource: (url, options) => new window.EventSource(url, options),
            invalidate: () => void queryClient.invalidateQueries({ queryKey: [...MOBILE_NOTIFICATION_QUERY_KEY] }),
            scheduleReconnect: (callback, delayMs) => window.setTimeout(callback, delayMs),
            cancelReconnect: (timerId) => window.clearTimeout(timerId)
        });
    }, [enabled, queryClient, serverUrl]);
}
