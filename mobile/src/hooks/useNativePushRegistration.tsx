/** @file use Native Push Registration: Configure foreground behavior consistently before registering or listening for native pushes. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import { NATIVE_PUSH_PROVIDERS } from '@calibrate/shared';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import {
    getNotificationPermissionState,
    isNativePushEnvironmentSupported,
    NATIVE_PUSH_STATES,
    type NativePushState
} from '../notifications/workflow';
import { EXPO_PROJECT_ID_ENV, resolveExpoProjectId } from '../notifications/expoProject';
import { getNativePushPlatform } from '../platform/nativePlatform';

type NativePushRegistrationContextValue = {
    state: NativePushState;
    requestPermission: () => Promise<void>;
    openSettings: () => Promise<void>;
    refreshPermission: () => Promise<void>;
    retryRegistration: () => Promise<void>;
    disableRegistration?: () => Promise<void>;
};

const NativePushRegistrationContext = createContext<NativePushRegistrationContextValue | null>(null);

/** Configure foreground behavior consistently before registering or listening for native pushes. */
async function loadNotificationsModule() {
    const Notifications = await import('expo-notifications');
    Notifications.setNotificationHandler({
        handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: true
        })
    });
    return Notifications;
}

/**
 * Own native notification permission and registration state for the signed-in native install.
 * Permission prompts remain user initiated; already-granted devices register automatically.
 */
export function NativePushRegistrationProvider({ children }: { children: React.ReactNode }) {
    const { api, user } = useAuth();
    const [state, setState] = useState<NativePushState>(NATIVE_PUSH_STATES.CHECKING);
    const activeRun = useRef(0);

    const synchronize = useCallback(async (requestPermission: boolean) => {
        const run = ++activeRun.current;
        if (!user || !hasFullAccountAccess(user)) {
            setState(NATIVE_PUSH_STATES.SIGNED_OUT);
            return;
        }
        if (!isNativePushEnvironmentSupported(Constants.appOwnership, Platform.OS)) {
            setState(NATIVE_PUSH_STATES.UNSUPPORTED);
            return;
        }

        setState(NATIVE_PUSH_STATES.CHECKING);
        try {
            const config = await api.getClientConfig();
            if (run !== activeRun.current) return;
            if (!config.capabilities.native_push) {
                setState(NATIVE_PUSH_STATES.DISABLED);
                return;
            }
            const Notifications = await loadNotificationsModule();
            const permission = requestPermission
                ? await Notifications.requestPermissionsAsync()
                : await Notifications.getPermissionsAsync();
            if (run !== activeRun.current) return;

            const permissionState = getNotificationPermissionState(permission);
            if (permissionState !== NATIVE_PUSH_STATES.REGISTERING) {
                setState(permissionState);
                return;
            }

            setState(NATIVE_PUSH_STATES.REGISTERING);
            const projectId = resolveExpoProjectId(Constants);
            if (!projectId) {
                throw new Error(`Missing Expo project ID. Set ${EXPO_PROJECT_ID_ENV} for local builds or use an EAS build.`);
            }
            const token = await Notifications.getExpoPushTokenAsync({ projectId });
            if (run !== activeRun.current) return;
            if (!token.data) throw new Error('Expo did not return a push token.');

            await api.registerNativePushSubscription({
                token: token.data,
                platform: getNativePushPlatform(Platform.OS),
                provider: NATIVE_PUSH_PROVIDERS.EXPO
            });
            if (run === activeRun.current) setState(NATIVE_PUSH_STATES.REGISTERED);
        } catch {
            if (run === activeRun.current) setState(NATIVE_PUSH_STATES.ERROR);
        }
    }, [api, user]);

    useEffect(() => {
        void synchronize(false);
        return () => {
            activeRun.current += 1;
        };
    }, [synchronize]);

    useEffect(() => {
        if (!user || state !== NATIVE_PUSH_STATES.REGISTERED) return undefined;

        let disposed = false;
        let removeListener: (() => void) | undefined;
        void loadNotificationsModule().then((Notifications) => {
            if (disposed) return;
            const subscription = Notifications.addPushTokenListener(() => {
                void synchronize(false);
            });
            removeListener = () => subscription.remove();
        }).catch(() => {
            if (!disposed) setState(NATIVE_PUSH_STATES.ERROR);
        });

        return () => {
            disposed = true;
            removeListener?.();
        };
    }, [state, synchronize, user]);

    const requestPermission = useCallback(() => synchronize(true), [synchronize]);
    const refreshPermission = useCallback(() => synchronize(false), [synchronize]);
    const retryRegistration = useCallback(() => synchronize(false), [synchronize]);
    const openSettings = useCallback(async () => {
        try {
            await Linking.openSettings();
        } catch {
            setState(NATIVE_PUSH_STATES.ERROR);
        }
    }, []);

    const value = useMemo<NativePushRegistrationContextValue>(() => ({
        state,
        requestPermission,
        openSettings,
        refreshPermission,
        retryRegistration
    }), [openSettings, refreshPermission, requestPermission, retryRegistration, state]);

    return React.createElement(NativePushRegistrationContext.Provider, { value }, children);
}

/** Reads native push registration state and throws outside its provider. */
export function useNativePushRegistration(): NativePushRegistrationContextValue {
    const context = useContext(NativePushRegistrationContext);
    if (!context) {
        throw new Error('useNativePushRegistration must be used within NativePushRegistrationProvider.');
    }
    return context;
}
