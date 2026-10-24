/** @file Regression coverage for use Browser Notification Stream web: browser notification stream. */

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
    }> = [];
    const reconnectCallbacks = new Map<number, () => void>();
    const invalidate = jest.fn();
    const cancelReconnect = jest.fn((timerId: number) => reconnectCallbacks.delete(timerId));

    const disconnect = connectBrowserNotificationStream({
        serverUrl,
        createSource: (url, options) => {
            const source = {
                url,
                withCredentials: options.withCredentials,
                listener: null as Listener | null,
                close: jest.fn(),
                onerror: null as ((event: Event) => unknown) | null
            };
            sources.push(source);
            return {
                addEventListener: (name, listener) => {
                    expect(name).toBe(NOTIFICATION_REALTIME_EVENT_NAME);
                    source.listener = listener;
                },
                close: source.close,
                get onerror() { return source.onerror; },
                set onerror(value) { source.onerror = value; }
            };
        },
        invalidate,
        scheduleReconnect: (callback, delayMs) => {
            expect(delayMs).toBe(NOTIFICATION_STREAM_RECONNECT_MS);
            const id = reconnectCallbacks.size + 1;
            reconnectCallbacks.set(id, callback);
            return id;
        },
        cancelReconnect
    });

    return { cancelReconnect, disconnect, invalidate, reconnectCallbacks, sources };
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

    it('closes a transiently failed source and reconnects through the scheduler', () => {
        const harness = createHarness();
        harness.sources[0].onerror?.({} as Event);
        expect(harness.sources[0].close).toHaveBeenCalledTimes(1);
        expect(harness.reconnectCallbacks.size).toBe(1);
        harness.reconnectCallbacks.get(1)?.();
        expect(harness.sources).toHaveLength(2);
        harness.disconnect();
        expect(harness.sources[1].close).toHaveBeenCalledTimes(1);
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
