/** @file use Native Push Registration: Own the current browser endpoint for the selected cookie session. Permission prompts and endpoint creation remain user initiated; existing endpoints are repaired automatically. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import {
    browserPushEnvironment,
    parseSubscriptionChangedMessage,
    registerBrowserPushSessionCleanup,
    removeBrowserPushSubscription,
    removeLocalBrowserPushSubscription,
    serializeBrowserPushSubscription,
    type BrowserPushEnvironment
} from '../notifications/browserPush.web';
import { NATIVE_PUSH_STATES, type NativePushState } from '../notifications/workflow';

type NativePushRegistrationContextValue = {
    state: NativePushState;
    requestPermission: () => Promise<void>;
    openSettings: () => Promise<void>;
    refreshPermission: () => Promise<void>;
    retryRegistration: () => Promise<void>;
    disableRegistration: () => Promise<void>;
};

const NativePushRegistrationContext = createContext<NativePushRegistrationContextValue | null>(null);

type BrowserPushProviderProps = {
    children: React.ReactNode;
    environment?: BrowserPushEnvironment;
};

/**
 * Own the current browser endpoint for the selected cookie session.
 * Permission prompts and endpoint creation remain user initiated; existing endpoints are repaired automatically.
 */
export function NativePushRegistrationProvider({
    children,
    environment = browserPushEnvironment
}: BrowserPushProviderProps) {
    const { api, isLoading, user } = useAuth();
    const [state, setState] = useState<NativePushState>(NATIVE_PUSH_STATES.CHECKING);
    const activeRun = useRef(0);

    const synchronize = useCallback(async (userInitiated: boolean) => {
        const run = ++activeRun.current;
        if (isLoading) {
            setState(NATIVE_PUSH_STATES.CHECKING);
            return;
        }
        if (!user || !hasFullAccountAccess(user)) {
            setState(NATIVE_PUSH_STATES.SIGNED_OUT);
            try {
                await removeLocalBrowserPushSubscription(environment);
            } catch {
                // A missing/stale worker while signed out is already a safe no-delivery state.
            }
            return;
        }
        if (!environment.isSupported()) {
            setState(NATIVE_PUSH_STATES.UNSUPPORTED);
            return;
        }

        setState(NATIVE_PUSH_STATES.CHECKING);
        let createdSubscription: PushSubscription | null = null;
        try {
            const config = await api.getClientConfig();
            if (run !== activeRun.current) return;
            // Older compatible servers omit this capability; their established public-key endpoint remains the fallback.
            if (config.capabilities.web_push === false) {
                setState(NATIVE_PUSH_STATES.DISABLED);
                return;
            }

            let permission = environment.getPermission();
            if (permission === 'default' && userInitiated) {
                permission = await environment.requestPermission();
            }
            if (run !== activeRun.current) return;
            if (permission === 'denied') {
                setState(NATIVE_PUSH_STATES.BLOCKED);
                return;
            }
            if (permission !== 'granted') {
                setState(NATIVE_PUSH_STATES.PERMISSION_REQUIRED);
                return;
            }

            const registration = await environment.getRegistration();
            if (run !== activeRun.current) return;
            if (!registration) throw new Error('No active service worker is available for browser push.');

            let subscription = await registration.pushManager.getSubscription();
            if (!subscription && !userInitiated) {
                setState(NATIVE_PUSH_STATES.PERMISSION_REQUIRED);
                return;
            }

            setState(NATIVE_PUSH_STATES.REGISTERING);
            if (!subscription) {
                const { publicKey } = await api.getBrowserPushPublicKey();
                if (!publicKey?.trim()) throw new Error('The Calibrate server did not return a VAPID public key.');
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: environment.decodeApplicationServerKey(publicKey)
                });
                createdSubscription = subscription;
            }

            await api.registerBrowserPushSubscription(serializeBrowserPushSubscription(subscription));
            if (run === activeRun.current) setState(NATIVE_PUSH_STATES.REGISTERED);
        } catch {
            if (createdSubscription) {
                try {
                    await createdSubscription.unsubscribe();
                } catch {
                    // The next inspection repairs any local endpoint left behind by a failed save.
                }
            }
            if (run === activeRun.current) setState(NATIVE_PUSH_STATES.ERROR);
        }
    }, [api, environment, isLoading, user]);

    useEffect(() => {
        void synchronize(false);
        return () => {
            activeRun.current += 1;
        };
    }, [synchronize]);

    useEffect(() => {
        if (!user) return undefined;
        return registerBrowserPushSessionCleanup(async () => {
            activeRun.current += 1;
            await removeBrowserPushSubscription(api, environment);
            setState(NATIVE_PUSH_STATES.SIGNED_OUT);
        });
    }, [api, environment, user]);

    useEffect(() => environment.addMessageListener((message) => {
        const change = parseSubscriptionChangedMessage(message);
        if (!change) return;
        void (async () => {
            if (change.oldEndpoint) {
                try {
                    await api.unregisterBrowserPushSubscription(change.oldEndpoint);
                } catch {
                    // The backend also deletes endpoints rejected by its push provider.
                }
            }
            await synchronize(false);
        })();
    }), [api, environment, synchronize]);

    const requestPermission = useCallback(() => synchronize(true), [synchronize]);
    const refreshPermission = useCallback(() => synchronize(false), [synchronize]);
    const retryRegistration = useCallback(() => synchronize(true), [synchronize]);
    const disableRegistration = useCallback(async () => {
        activeRun.current += 1;
        setState(NATIVE_PUSH_STATES.REGISTERING);
        try {
            await removeBrowserPushSubscription(api, environment);
            setState(NATIVE_PUSH_STATES.PERMISSION_REQUIRED);
        } catch {
            setState(NATIVE_PUSH_STATES.ERROR);
        }
    }, [api, environment]);
    // Browsers do not expose a portable site-settings URL. Copy guides users there, then this rechecks state.
    const openSettings = useCallback(() => synchronize(false), [synchronize]);

    const value = useMemo<NativePushRegistrationContextValue>(() => ({
        state,
        requestPermission,
        openSettings,
        refreshPermission,
        retryRegistration,
        disableRegistration
    }), [disableRegistration, openSettings, refreshPermission, requestPermission, retryRegistration, state]);

    return <NativePushRegistrationContext.Provider value={value}>{children}</NativePushRegistrationContext.Provider>;
}

/** Reads the browser push-registration context and throws outside its provider. */
export function useNativePushRegistration(): NativePushRegistrationContextValue {
    const context = useContext(NativePushRegistrationContext);
    if (!context) throw new Error('useNativePushRegistration must be used within NativePushRegistrationProvider.');
    return context;
}
