/** @file Browser push capability, subscription registration/removal, and authenticated account-switch cleanup. */

import type { BrowserPushSubscriptionPayload, CalibrateApiClient } from '@calibrate/api-client';

const SERVICE_WORKER_READY_TIMEOUT_MS = 5_000;

export const BROWSER_PUSH_MESSAGES = {
    SUBSCRIPTION_CHANGED: 'CALIBRATE_PUSH_SUBSCRIPTION_CHANGED'
} as const;

export type BrowserPushApi = Pick<
    CalibrateApiClient,
    | 'getClientConfig'
    | 'getBrowserPushPublicKey'
    | 'registerBrowserPushSubscription'
    | 'unregisterBrowserPushSubscription'
>;

export type BrowserPushEnvironment = {
    /** Reports whether this browser can provide notification and push registration APIs. */
    isSupported(): boolean;
    /** Returns the browser's current notification permission without prompting. */
    getPermission(): NotificationPermission;
    /** Requests notification permission through the browser's user-facing permission flow. */
    requestPermission(): Promise<NotificationPermission>;
    /** Returns the active service-worker registration or null when none is available. */
    getRegistration(): Promise<ServiceWorkerRegistration | null>;
    /** Decodes the URL-safe public VAPID key into bytes for PushManager. */
    decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer>;
    /** Subscribes to service-worker messages and returns the listener cleanup function. */
    addMessageListener(listener: (message: unknown) => void): () => void;
};

type BrowserPushCleanupHandler = () => Promise<void>;
let sessionCleanupHandler: BrowserPushCleanupHandler | null = null;

/** Let browser auth await endpoint removal before invalidating or switching its cookie session. */
export function registerBrowserPushSessionCleanup(handler: BrowserPushCleanupHandler): () => void {
    sessionCleanupHandler = handler;
    return () => {
        if (sessionCleanupHandler === handler) sessionCleanupHandler = null;
    };
}

/** Attempts to remove the prior session's push endpoint while allowing sign-out to finish on failure. */
export async function cleanupBrowserPushBeforeSessionChange(): Promise<void> {
    try {
        await sessionCleanupHandler?.();
    } catch {
        // Session teardown must continue even if an unreachable old server cannot forget the endpoint.
        console.warn('Could not remove the browser push endpoint from the previous Calibrate session.');
    }
}

function pickBestServiceWorkerRegistration(
    registrations: readonly ServiceWorkerRegistration[]
): ServiceWorkerRegistration | null {
    if (registrations.length === 0) return null;
    return registrations.find((registration) => Boolean(registration.active))
        ?? registrations.find((registration) => Boolean(registration.waiting))
        ?? registrations.find((registration) => Boolean(registration.installing))
        ?? registrations[0];
}

/** Resolve an active registration without allowing browser notification UI to hang forever. */
export async function resolveBrowserServiceWorkerRegistration(
    timeoutMs: number = SERVICE_WORKER_READY_TIMEOUT_MS
): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
        timeoutId = globalThis.setTimeout(() => resolve(null), timeoutMs);
    });
    const ready = navigator.serviceWorker.ready as Promise<ServiceWorkerRegistration>;
    const registration = await Promise.race<ServiceWorkerRegistration | null>([ready, timeout]);
    if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    if (registration) return registration;

    const current = await navigator.serviceWorker.getRegistration();
    if (current) return current;
    return pickBestServiceWorkerRegistration(await navigator.serviceWorker.getRegistrations());
}

/** Convert the URL-safe VAPID wire key into the format required by PushManager. */
export function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = globalThis.atob(base64);
    const buffer = new ArrayBuffer(bytes.length);
    const output = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
        output[index] = bytes.charCodeAt(index);
    }
    return output;
}

/** Reject incomplete browser objects before sending subscription material to a server. */
export function serializeBrowserPushSubscription(
    subscription: PushSubscription
): BrowserPushSubscriptionPayload {
    const serialized = subscription.toJSON();
    const endpoint = serialized.endpoint?.trim();
    const p256dh = serialized.keys?.p256dh?.trim();
    const auth = serialized.keys?.auth?.trim();
    if (!endpoint || !p256dh || !auth) {
        throw new Error('The browser returned an incomplete push subscription.');
    }
    return {
        endpoint,
        expirationTime: serialized.expirationTime ?? null,
        keys: { p256dh, auth }
    };
}

export const browserPushEnvironment: BrowserPushEnvironment = {
    isSupported: () => typeof window !== 'undefined'
        && 'Notification' in window
        && 'PushManager' in window
        && typeof navigator !== 'undefined'
        && 'serviceWorker' in navigator,
    getPermission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getRegistration: () => resolveBrowserServiceWorkerRegistration(),
    decodeApplicationServerKey,
    addMessageListener: (listener) => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
        const handleMessage = (event: MessageEvent) => listener(event.data);
        navigator.serviceWorker.addEventListener('message', handleMessage);
        return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
    }
};

/** Validates subscription-change messages and extracts a normalized previous endpoint when supplied. */
export function parseSubscriptionChangedMessage(message: unknown): { oldEndpoint: string | null } | null {
    if (
        !message
        || typeof message !== 'object'
        || (message as { type?: unknown }).type !== BROWSER_PUSH_MESSAGES.SUBSCRIPTION_CHANGED
    ) return null;
    const oldEndpoint = (message as { oldEndpoint?: unknown }).oldEndpoint;
    return {
        oldEndpoint: typeof oldEndpoint === 'string' && oldEndpoint.trim() ? oldEndpoint.trim() : null
    };
}

/** Delete server ownership first, then always remove the browser endpoint locally. */
export async function removeBrowserPushSubscription(
    api: Pick<BrowserPushApi, 'unregisterBrowserPushSubscription'>,
    environment: Pick<BrowserPushEnvironment, 'getRegistration'>
): Promise<void> {
    const registration = await environment.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;

    try {
        await api.unregisterBrowserPushSubscription(subscription.endpoint);
    } finally {
        await subscription.unsubscribe();
    }
}

/** Signed-out recovery cannot authenticate deletion, but it must stop this browser receiving a prior account's pushes. */
export async function removeLocalBrowserPushSubscription(
    environment: Pick<BrowserPushEnvironment, 'getRegistration'>
): Promise<void> {
    const registration = await environment.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
}
