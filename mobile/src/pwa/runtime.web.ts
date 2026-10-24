/** @file React-safe external store for browser connectivity, service-worker updates, and explicit lifecycle disposal. */

import * as React from 'react';

export const PWA_NETWORK_STATES = {
    ONLINE: 'online',
    OFFLINE: 'offline',
    BACK_ONLINE: 'back_online'
} as const;

export const PWA_UPDATE_STATES = {
    IDLE: 'idle',
    READY: 'ready',
    APPLYING: 'applying',
    ERROR: 'error'
} as const;

export type PwaNetworkState = typeof PWA_NETWORK_STATES[keyof typeof PWA_NETWORK_STATES];
export type PwaUpdateState = typeof PWA_UPDATE_STATES[keyof typeof PWA_UPDATE_STATES];

export type PwaSnapshot = Readonly<{
    network: PwaNetworkState;
    update: PwaUpdateState;
    updateError: string | null;
}>;

type StoreListener = () => void;

export type PwaWorker = {
    state?: string;
    /** Sends a structured message to the selected service worker. */
    postMessage(message: unknown): void;
    /** Subscribes to the requested service-worker lifecycle event. */
    addEventListener?(type: 'statechange' | 'error', listener: StoreListener): void;
    /** Removes the matching service-worker lifecycle listener. */
    removeEventListener?(type: 'statechange' | 'error', listener: StoreListener): void;
};

export type PwaRegistration = {
    waiting: PwaWorker | null;
    installing: PwaWorker | null;
    /** Requests a browser check for a newer service-worker script. */
    update(): Promise<void>;
    /** Subscribes to the requested service-worker lifecycle event. */
    addEventListener(type: 'updatefound', listener: StoreListener): void;
    /** Removes the matching service-worker lifecycle listener. */
    removeEventListener(type: 'updatefound', listener: StoreListener): void;
};

export type PwaServiceWorkerContainer = {
    controller: PwaWorker | null;
    /** Registers a service worker at the supplied script URL and scope. */
    register(scriptUrl: string, options: { scope: string }): Promise<PwaRegistration>;
    /** Subscribes to the requested service-worker lifecycle event. */
    addEventListener(type: 'controllerchange', listener: StoreListener): void;
    /** Removes the matching service-worker lifecycle listener. */
    removeEventListener(type: 'controllerchange', listener: StoreListener): void;
};

export type PwaEnvironment = {
    production: boolean;
    /** Reads current browser connectivity without changing runtime state. */
    isOnline(): boolean;
    /** Subscribes to a browser connectivity event and returns its cleanup function. */
    addWindowListener(type: 'online' | 'offline', listener: StoreListener): () => void;
    /** Returns the service-worker API when supported, otherwise null. */
    getServiceWorker(): PwaServiceWorkerContainer | null;
    /** Schedules a runtime callback after the requested delay in milliseconds. */
    setTimer(listener: StoreListener, delayMs: number): unknown;
    /** Cancels a previously scheduled runtime callback. */
    clearTimer(timer: unknown): void;
    /** Reloads the document after the user accepts an available application update. */
    reload(): void;
};

export type PwaRuntime = {
    /** Subscribes to PWA state changes and returns the unsubscribe function. */
    subscribe(listener: StoreListener): () => void;
    /** Returns the current stable PWA snapshot for React external-store consumers. */
    getSnapshot(): PwaSnapshot;
    /** Returns the deterministic server-render snapshot used during hydration. */
    getServerSnapshot(): PwaSnapshot;
    /** Activates the waiting update after the user requests it. */
    applyUpdate(): void;
    /** Retries update discovery after a failed service-worker update. */
    retryUpdate(): Promise<void>;
    /** Releases listeners and timers owned by the PWA runtime. */
    dispose(): void;
};

// Keep the recovery confirmation visible long enough to be read without lingering in the app shell.
export const BACK_ONLINE_NOTICE_MS = 5_000;
// Surface a recoverable failure if an installed worker never takes control after refresh is requested.
export const UPDATE_APPLY_TIMEOUT_MS = 12_000;
export const PWA_SERVICE_WORKER_URL = '/sw.js';
export const PWA_SERVICE_WORKER_SCOPE = '/';

const SERVER_SNAPSHOT: PwaSnapshot = Object.freeze({
    network: PWA_NETWORK_STATES.ONLINE,
    update: PWA_UPDATE_STATES.IDLE,
    updateError: null
});

const UPDATE_FAILURE_MESSAGE = 'The app update could not be installed. Check your connection and try again.';

function createBrowserEnvironment(): PwaEnvironment {
    return {
        production: process.env.NODE_ENV === 'production',
        isOnline: () => typeof navigator === 'undefined' || navigator.onLine,
        addWindowListener: (type, listener) => {
            if (typeof window === 'undefined') return () => undefined;
            window.addEventListener(type, listener);
            return () => window.removeEventListener(type, listener);
        },
        getServiceWorker: () => {
            if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
            return navigator.serviceWorker as unknown as PwaServiceWorkerContainer;
        },
        setTimer: (listener, delayMs) => globalThis.setTimeout(listener, delayMs),
        clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
        reload: () => window.location.reload()
    };
}

/** Creates an externally subscribable PWA lifecycle store with injected browser APIs and explicit disposal. */
export function createPwaRuntime(environment: PwaEnvironment): PwaRuntime {
    const listeners = new Set<StoreListener>();
    const workerListeners = new Map<PwaWorker, { stateChange: StoreListener; error: StoreListener }>();
    let snapshot: PwaSnapshot = {
        ...SERVER_SNAPSHOT,
        network: environment.isOnline() ? PWA_NETWORK_STATES.ONLINE : PWA_NETWORK_STATES.OFFLINE
    };
    let started = false;
    let disposed = false;
    let registration: PwaRegistration | null = null;
    let serviceWorker: PwaServiceWorkerContainer | null = null;
    let readyUpdateWorker: PwaWorker | null = null;
    let removeOnlineListener: (() => void) | null = null;
    let removeOfflineListener: (() => void) | null = null;
    let backOnlineTimer: unknown = null;
    let updateApplyTimer: unknown = null;
    let reloadOnControllerChange = false;
    let didReloadForControllerChange = false;
    let removeRegistrationListener: (() => void) | null = null;

    function publish(patch: Partial<PwaSnapshot>) {
        const next = { ...snapshot, ...patch };
        if (
            next.network === snapshot.network
            && next.update === snapshot.update
            && next.updateError === snapshot.updateError
        ) return;
        snapshot = next;
        listeners.forEach((listener) => listener());
    }

    function clearBackOnlineTimer() {
        if (backOnlineTimer === null) return;
        environment.clearTimer(backOnlineTimer);
        backOnlineTimer = null;
    }

    function clearUpdateApplyTimer() {
        if (updateApplyTimer === null) return;
        environment.clearTimer(updateApplyTimer);
        updateApplyTimer = null;
    }

    function reportUpdateFailure() {
        clearUpdateApplyTimer();
        reloadOnControllerChange = false;
        readyUpdateWorker = null;
        publish({ update: PWA_UPDATE_STATES.ERROR, updateError: UPDATE_FAILURE_MESSAGE });
    }

    function reloadForAppliedUpdate() {
        if (!reloadOnControllerChange || didReloadForControllerChange) return;
        didReloadForControllerChange = true;
        reloadOnControllerChange = false;
        readyUpdateWorker = null;
        clearUpdateApplyTimer();
        environment.reload();
    }

    function handleOffline() {
        clearBackOnlineTimer();
        publish({ network: PWA_NETWORK_STATES.OFFLINE });
    }

    function handleOnline() {
        if (snapshot.network !== PWA_NETWORK_STATES.OFFLINE) {
            publish({ network: PWA_NETWORK_STATES.ONLINE });
            return;
        }
        publish({ network: PWA_NETWORK_STATES.BACK_ONLINE });
        clearBackOnlineTimer();
        backOnlineTimer = environment.setTimer(() => {
            backOnlineTimer = null;
            publish({ network: PWA_NETWORK_STATES.ONLINE });
        }, BACK_ONLINE_NOTICE_MS);
    }

    function observeWorker(worker: PwaWorker | null) {
        if (!worker || workerListeners.has(worker)) return;
        const stateChange = () => {
            if (worker.state === 'installed' && (serviceWorker?.controller || registration?.waiting)) {
                // `registration.waiting` can lag the install state event. Keep the worker that
                // actually reached `installed` so an immediate Refresh click cannot lose it.
                readyUpdateWorker = registration?.waiting ?? worker;
                publish({ update: PWA_UPDATE_STATES.READY, updateError: null });
            } else if (worker.state === 'activated') {
                reloadForAppliedUpdate();
            } else if (worker.state === 'redundant') {
                reportUpdateFailure();
            }
        };
        const error = () => reportUpdateFailure();
        worker.addEventListener?.('statechange', stateChange);
        worker.addEventListener?.('error', error);
        workerListeners.set(worker, { stateChange, error });
        stateChange();
    }

    function observeRegistration(nextRegistration: PwaRegistration) {
        removeRegistrationListener?.();
        registration = nextRegistration;
        const updateFound = () => observeWorker(nextRegistration.installing);
        nextRegistration.addEventListener('updatefound', updateFound);
        removeRegistrationListener = () => nextRegistration.removeEventListener('updatefound', updateFound);
        observeWorker(nextRegistration.installing);
        if (nextRegistration.waiting) {
            readyUpdateWorker = nextRegistration.waiting;
            observeWorker(nextRegistration.waiting);
            publish({ update: PWA_UPDATE_STATES.READY, updateError: null });
        }
    }

    async function registerServiceWorker() {
        if (!environment.production || !serviceWorker) return;
        try {
            const nextRegistration = await serviceWorker.register(PWA_SERVICE_WORKER_URL, {
                scope: PWA_SERVICE_WORKER_SCOPE
            });
            if (disposed) return;
            observeRegistration(nextRegistration);
        } catch {
            if (!disposed) reportUpdateFailure();
        }
    }

    function handleControllerChange() {
        reloadForAppliedUpdate();
    }

    function start() {
        if (started || disposed) return;
        started = true;
        publish({
            network: environment.isOnline() ? PWA_NETWORK_STATES.ONLINE : PWA_NETWORK_STATES.OFFLINE
        });
        removeOnlineListener = environment.addWindowListener('online', handleOnline);
        removeOfflineListener = environment.addWindowListener('offline', handleOffline);
        serviceWorker = environment.getServiceWorker();
        if (environment.production && serviceWorker) {
            serviceWorker.addEventListener('controllerchange', handleControllerChange);
            void registerServiceWorker();
        }
    }

    async function retryUpdate() {
        start();
        publish({ update: PWA_UPDATE_STATES.IDLE, updateError: null });
        if (!environment.production || !serviceWorker) return;
        try {
            if (!registration) {
                await registerServiceWorker();
                return;
            }
            await registration.update();
            if (registration.waiting) {
                readyUpdateWorker = registration.waiting;
                observeWorker(registration.waiting);
                publish({ update: PWA_UPDATE_STATES.READY, updateError: null });
            }
        } catch {
            reportUpdateFailure();
        }
    }

    function applyUpdate() {
        start();
        const waitingWorker = registration?.waiting ?? readyUpdateWorker;
        if (!waitingWorker) {
            reportUpdateFailure();
            return;
        }
        publish({ update: PWA_UPDATE_STATES.APPLYING, updateError: null });
        reloadOnControllerChange = true;
        clearUpdateApplyTimer();
        updateApplyTimer = environment.setTimer(reportUpdateFailure, UPDATE_APPLY_TIMEOUT_MS);
        try {
            waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        } catch {
            reportUpdateFailure();
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearBackOnlineTimer();
        clearUpdateApplyTimer();
        removeOnlineListener?.();
        removeOfflineListener?.();
        removeRegistrationListener?.();
        if (serviceWorker) serviceWorker.removeEventListener('controllerchange', handleControllerChange);
        workerListeners.forEach(({ stateChange, error }, worker) => {
            worker.removeEventListener?.('statechange', stateChange);
            worker.removeEventListener?.('error', error);
        });
        workerListeners.clear();
        listeners.clear();
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            start();
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        getServerSnapshot: () => SERVER_SNAPSHOT,
        applyUpdate,
        retryUpdate,
        dispose
    };
}

export const browserPwaRuntime = createPwaRuntime(createBrowserEnvironment());

/** Subscribes React to stable PWA snapshots and exposes user-requested update actions. */
export function usePwaStatus(runtime: PwaRuntime = browserPwaRuntime) {
    const snapshot = React.useSyncExternalStore(
        runtime.subscribe,
        runtime.getSnapshot,
        runtime.getServerSnapshot
    );
    return {
        ...snapshot,
        applyUpdate: runtime.applyUpdate,
        retryUpdate: runtime.retryUpdate
    };
}
