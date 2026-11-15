/** @file Tests browser notification resynchronization, stream reconnection, and visibility cleanup. */

import { NOTIFICATION_REALTIME_EVENT_NAME, NOTIFICATION_REALTIME_REASONS } from '../../../shared/notificationRealtime';
import {
    connectBrowserNotificationStream,
    getNotificationStreamUrl,
    NOTIFICATION_STREAM_RECONNECT_MS
} from './useBrowserNotificationStream.web';

type Listener = (event: { data: string }) => void;

function createHarness(serverUrl = 'http://localhost:3000') {
    const sources: Array<{
        url: string;
        withCredentials: boolean;
        listener: Listener | null;
        close: jest.Mock;
        onerror: ((event: Event) => unknown) | null;
        onopen: ((event: Event) => unknown) | null;
    }> = [];
    const reconnectCallbacks = new Map<number, () => void>();
    const invalidate = jest.fn();
    const cancelReconnect = jest.fn((timerId: number) => reconnectCallbacks.delete(timerId));
    let foreground = true;
    let onForegroundChange: (() => void) | undefined;

    const disconnect = connectBrowserNotificationStream({
        serverUrl,
        createSource: (url, options) => {
            const source = {
                url,
                withCredentials: options.withCredentials,
                listener: null as Listener | null,
                close: jest.fn(),
                onerror: null as ((event: Event) => unknown) | null,
                onopen: null as ((event: Event) => unknown) | null
            };
            sources.push(source);
            return {
                addEventListener: (name, listener) => {
                    expect(name).toBe(NOTIFICATION_REALTIME_EVENT_NAME);
                    source.listener = listener;
                },
                close: source.close,
                get onerror() { return source.onerror; },
                set onerror(value) { source.onerror = value; },
                get onopen() { return source.onopen; },
                set onopen(value) { source.onopen = value; }
            };
        },
        invalidate,
        scheduleReconnect: (callback, delayMs) => {
            expect(delayMs).toBe(NOTIFICATION_STREAM_RECONNECT_MS);
            const id = reconnectCallbacks.size + 1;
            reconnectCallbacks.set(id, callback);
            return id;
        },
        cancelReconnect,
        isForeground: () => foreground,
        subscribeForeground: (listener) => {
            onForegroundChange = listener;
            return () => { onForegroundChange = undefined; };
        }
    });

    return {
        cancelReconnect, disconnect, invalidate, reconnectCallbacks, sources,
        /** Report visibility changes or focus while already visible. */
        changeForeground(visible: boolean) {
            foreground = visible;
            onForegroundChange?.();
        }
    };
}

describe('browser notification stream', () => {
    it('uses the selected server with credentialed EventSource requests and invalidates only valid events', () => {
        const harness = createHarness('https://calibrate.example:8443');
        expect(harness.sources[0]).toMatchObject({
            url: 'https://calibrate.example:8443/api/v1/notifications/stream',
            withCredentials: true
        });

        const listener = harness.sources[0].listener!;
        listener({ data: JSON.stringify({
            reason: NOTIFICATION_REALTIME_REASONS.CREATED,
            updated_at: '2026-07-18T00:00:00.000Z'
        }) });
        listener({ data: '{malformed' });
        listener({ data: JSON.stringify({ reason: 'unknown', updated_at: '2026-07-18T00:00:00.000Z' }) });
        expect(harness.invalidate).toHaveBeenCalledTimes(1);
        harness.disconnect();
    });

    it('resynchronizes after each reconnect and ignores stale source callbacks', () => {
        const harness = createHarness();
        const event = {} as Event;
        let serverUnreadCount = 0;
        let cachedUnreadCount = -1;
        harness.invalidate.mockImplementation(() => { cachedUnreadCount = serverUnreadCount; });
        harness.sources[0].onopen?.(event);
        expect(cachedUnreadCount).toBe(0);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const previous = harness.sources[attempt];
            previous.onerror?.(event);
            expect(previous.close).toHaveBeenCalledTimes(1);
            expect(harness.reconnectCallbacks.size).toBe(1);
            serverUnreadCount += 1; // A notification is created with no open connection to deliver an event.
            expect(cachedUnreadCount).toBe(attempt);
            const reconnect = harness.reconnectCallbacks.get(1);
            harness.reconnectCallbacks.delete(1);
            reconnect?.();
            expect(harness.sources).toHaveLength(attempt + 2);
            previous.onopen?.(event);
            previous.onerror?.(event);
            expect(harness.reconnectCallbacks.size).toBe(0);
            expect(cachedUnreadCount).toBe(attempt);
            harness.sources[attempt + 1].onopen?.(event);
            expect(cachedUnreadCount).toBe(attempt + 1);
        }
        harness.disconnect();
        expect(harness.sources[3].close).toHaveBeenCalledTimes(1);
    });

    it('pauses while hidden, resynchronizes on return and refreshes on focus', () => {
        const harness = createHarness();
        harness.sources[0].onerror?.({} as Event);
        harness.changeForeground(false);
        expect(harness.reconnectCallbacks.size).toBe(0);
        harness.changeForeground(true);
        expect(harness.sources).toHaveLength(2);
        harness.sources[1].onopen?.({} as Event);
        expect(harness.invalidate).toHaveBeenCalledTimes(1);
        harness.changeForeground(true);
        expect(harness.invalidate).toHaveBeenCalledTimes(2);
        expect(harness.sources).toHaveLength(2);
        harness.changeForeground(false);
        expect(harness.sources[1].close).toHaveBeenCalledTimes(1);
        harness.disconnect();
        harness.changeForeground(true);
        expect(harness.sources).toHaveLength(2);
    });

    it('cancels pending reconnect and stays closed after logout or server-switch teardown', () => {
        const harness = createHarness();
        harness.sources[0].onerror?.({} as Event);
        const reconnect = harness.reconnectCallbacks.get(1)!;

        harness.disconnect();
        reconnect();
        harness.disconnect();

        expect(harness.cancelReconnect).toHaveBeenCalledWith(1);
        expect(harness.sources).toHaveLength(1);
        expect(getNotificationStreamUrl('http://127.0.0.1:3000')).toBe(
            'http://127.0.0.1:3000/api/v1/notifications/stream'
        );
    });
});
