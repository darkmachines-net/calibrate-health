/** @file Auth Context: Browser auth uses the serving backend and its HttpOnly cookie session. */

import { hasExplicitLogout, beginExplicitLogout, flushExplicitLogout, finishExplicitLogin } from './logoutIntent.web';
import { usePendingLogoutRetry } from './usePendingLogoutRetry';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, CalibrateApiClient, type UserClientPayload } from '@calibrate/api-client';
import { useQueryClient } from '@tanstack/react-query';
import type { ClientUpgradeRequirement } from '@calibrate/shared';
import type { ClientServerCompatibilityMismatch } from '@calibrate/shared/releaseCompatibility';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '@calibrate/shared/legalVersions';
import { getDefaultServerUrl, testCalibrateServerConnection } from '../config/server';
import { getSessionRestoreErrorMessage } from './authErrors';
import type { AccountDeletionCleanupNotice } from '../account/accountDeletionNotice';
import { cleanupBrowserPushBeforeSessionChange } from '../notifications/browserPush.web';
import { restoreBrowserDevelopmentSession } from './devAutoLogin';
import { clearBrowserUserScopedCaches } from '../pwa/cacheIsolation.web';
import { requireRegistrationLegalAcceptance, requiresHostedLegalAcceptance, type RegistrationLegalAcceptance } from './accountAccess';
import { clearOnboardingDraft } from '../onboarding/draftStorage';
import { clearOfflineWorkspace, hydrateVerifiedOfflineWorkspace, restoreOfflineWorkspace, saveOfflineWorkspace } from './offlineWorkspace';
import { isRetryableMutationError } from '../offline/retryability';

type AuthContextValue = {
    api: CalibrateApiClient;
    user: UserClientPayload | null;
    accessToken: string | null;
    refreshToken: string | null;
    deviceId: string | null;
    serverUrl: string;
    isLoading: boolean;
    authError: string | null;
    pendingReconnection: boolean;
    clientUpgradeRequired: ClientUpgradeRequirement | null;
    clientServerIncompatibility: ClientServerCompatibilityMismatch | null;
    accountDeletionCleanupNotice: AccountDeletionCleanupNotice | null;
    updateCurrentUser: (user: UserClientPayload) => void;
    login: (email: string, password: string) => Promise<boolean>;
    register: (email: string, password: string, acceptance: RegistrationLegalAcceptance) => Promise<boolean>;
    logout: () => Promise<void>;
    clearLocalSession: () => Promise<void>;
    recheckClientCompatibility: () => Promise<boolean>;
    persistAccountDeletionCleanupNotice: (notice: AccountDeletionCleanupNotice) => Promise<void>;
    acknowledgeAccountDeletionCleanupNotice: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Owns serving-backend cookie authentication and account-scoped offline cleanup. */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const queryClient = useQueryClient();
    const [serverUrl] = useState(getDefaultServerUrl);
    usePendingLogoutRetry(serverUrl, flushExplicitLogout, () => { if (!accountScopeRef.current) setAuthError(null); });
    const [user, setUser] = useState<UserClientPayload | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [authError, setAuthError] = useState<string | null>(null);
    const [pendingReconnection, setPendingReconnection] = useState(false);
    const localOnlyRef = useRef(false);
    const accountScopeRef = useRef<{ serverUrl: string; userId: number } | null>(null);

    const acceptUser = useCallback(async (nextUser: UserClientPayload) => {
        const previousScope = accountScopeRef.current;
        const nextScope = { serverUrl, userId: nextUser.id };
        accountScopeRef.current = nextScope;
        if (previousScope && previousScope.userId !== nextUser.id) {
            await clearOnboardingDraft(previousScope.serverUrl, previousScope.userId).catch(() => undefined);
        }
        if (accountScopeRef.current !== nextScope) return;
        if (previousScope && previousScope.userId !== nextUser.id) queryClient.clear();
        await hydrateVerifiedOfflineWorkspace(serverUrl, nextUser.id, queryClient, () => accountScopeRef.current === nextScope);
        if (accountScopeRef.current !== nextScope) return;
        localOnlyRef.current = false;
        setPendingReconnection(false);
        setAuthError(null);
        setUser(nextUser);
        await saveOfflineWorkspace(serverUrl, nextUser, queryClient).catch(() => undefined);
    }, [queryClient, serverUrl]);

    const clearSession = useCallback(async () => {
        const scope = accountScopeRef.current;
        accountScopeRef.current = null;
        localOnlyRef.current = false;
        setPendingReconnection(false);
        const workspaceCleanup = clearOfflineWorkspace(scope?.serverUrl ?? serverUrl);
        const draftCleanup = scope ? clearOnboardingDraft(scope.serverUrl, scope.userId) : Promise.resolve();
        setUser(null);
        setAuthError(null);
        queryClient.clear();
        await Promise.all([clearBrowserUserScopedCaches(), draftCleanup, workspaceCleanup]);
    }, [queryClient, serverUrl]);

    const clearSessionWithBrowserCleanup = useCallback(async () => {
        await cleanupBrowserPushBeforeSessionChange();
        await clearSession();
    }, [clearSession]);

    const api = useMemo(() => new CalibrateApiClient({
        baseUrl: serverUrl,
        requestCredentials: 'include',
        fetchImpl: (input, init) => {
            if (localOnlyRef.current) return Promise.reject(new TypeError('Pending reconnection; changes remain on this device.'));
            return globalThis.fetch(input, init);
        },
        onRequestError: (error) => {
            if (isRetryableMutationError(error)) {
                if (accountScopeRef.current) localOnlyRef.current = true;
                setPendingReconnection(true);
            }
        },
        onUnauthorized: clearSession
    }), [clearSession, serverUrl]);

    useEffect(() => {
        let active = true;
        let mayRestoreWorkspace = false;
        setIsLoading(true);
        void (async () => {
            if (await hasExplicitLogout(serverUrl)) {
                await clearSession();
                await flushExplicitLogout(serverUrl).catch(() => { if (active) setAuthError('Signed out on this device. Server sign-out is pending connection.'); });
                return null;
            }
            mayRestoreWorkspace = true;
            return restoreBrowserDevelopmentSession(api, serverUrl);
        })().then(async (payload) => {
            if (active && payload) await acceptUser(payload.user);
        }).catch(async (error: unknown) => {
            if (!active || (error instanceof ApiError && error.status === 401)) return;
            if (mayRestoreWorkspace && isRetryableMutationError(error)) {
                const cached = await restoreOfflineWorkspace(serverUrl, queryClient).catch(() => null);
                if (!active) return;
                if (cached) {
                    accountScopeRef.current = { serverUrl, userId: cached.id };
                    localOnlyRef.current = true;
                    setPendingReconnection(true);
                    setUser(cached);
                }
            }
            setAuthError(getSessionRestoreErrorMessage(error));
        }).finally(() => {
            if (active) setIsLoading(false);
        });
        return () => { active = false; };
    }, [acceptUser, api, clearSession, queryClient, serverUrl]);

    const confirmCurrentServer = useCallback(async (): Promise<boolean> => {
        const result = await testCalibrateServerConnection(serverUrl);
        setAuthError(result.ok ? null : result.message);
        return result.ok;
    }, [serverUrl]);

    const updateCurrentUser = useCallback((nextUser: UserClientPayload) => {
        const scope = accountScopeRef.current;
        if (scope?.userId !== nextUser.id) return;
        setUser(nextUser);
        void saveOfflineWorkspace(scope.serverUrl, nextUser, queryClient).catch(() => undefined);
    }, [queryClient]);

    const login = useCallback(async (email: string, password: string) => {
        await flushExplicitLogout(serverUrl);
        if (!await confirmCurrentServer()) return false;
        const payload = await new CalibrateApiClient({
            baseUrl: serverUrl,
            requestCredentials: 'include'
        }).loginBrowser({ email, password });
        await finishExplicitLogin(serverUrl);
        queryClient.clear();
        await clearBrowserUserScopedCaches();
        await acceptUser(payload.user);
        return true;
    }, [acceptUser, confirmCurrentServer, queryClient, serverUrl]);

    const register = useCallback(async (
        email: string,
        password: string,
        acceptance: RegistrationLegalAcceptance
    ) => {
        await flushExplicitLogout(serverUrl);
        if (!await confirmCurrentServer()) return false;
        const legalAcceptance = requiresHostedLegalAcceptance(serverUrl)
            ? requireRegistrationLegalAcceptance(acceptance)
            : null;
        const payload = await new CalibrateApiClient({
            baseUrl: serverUrl,
            requestCredentials: 'include'
        }).registerBrowser({
            email,
            password,
            ...(legalAcceptance ? {
                terms_version: CURRENT_TERMS_VERSION,
                privacy_version: CURRENT_PRIVACY_VERSION,
                accept_terms: legalAcceptance.acceptTerms,
                accept_privacy: legalAcceptance.acceptPrivacy
            } : {})
        });
        await finishExplicitLogin(serverUrl);
        queryClient.clear();
        await clearBrowserUserScopedCaches();
        await acceptUser(payload.user);
        return true;
    }, [acceptUser, confirmCurrentServer, queryClient, serverUrl]);

    const logout = useCallback(async () => {
        let intentPersisted = true;
        await beginExplicitLogout(serverUrl).catch(() => { intentPersisted = false; });
        await cleanupBrowserPushBeforeSessionChange().catch(() => undefined);
        try {
            await clearSession();
        } finally {
            // Local cleanup failure must not suppress server session revocation.
            await flushExplicitLogout(serverUrl).catch(() => setAuthError(intentPersisted
                ? 'Signed out on this device. Server sign-out is pending connection.'
                : 'Signed out in this app. Device storage is unavailable and server sign-out is pending. Reconnect before closing this app.'));
        }
    }, [clearSession, serverUrl]);

    const recheckClientCompatibility = useCallback(async () => {
        const scope = accountScopeRef.current;
        if (await hasExplicitLogout(serverUrl)) { await flushExplicitLogout(serverUrl); return false; }
        const recovery = new CalibrateApiClient({ baseUrl: serverUrl, requestCredentials: 'include' });
        try {
            const payload = await recovery.getMe();
            if (accountScopeRef.current !== scope) return false;
            if (accountScopeRef.current && payload.user.id !== accountScopeRef.current.userId) {
                await clearSession();
                return false;
            }
            await acceptUser(payload.user);
        } catch (error) {
            if (accountScopeRef.current !== scope) return false;
            if (error instanceof ApiError && error.status === 401) await clearSession();
            throw error;
        }
        return true;
    }, [acceptUser, clearSession, serverUrl]);

    useEffect(() => {
        if (!user || !serverUrl) return;
        return queryClient.getQueryCache().subscribe((event) => {
            if (event.type !== 'updated' || event.action.type !== 'success') return;
            const scope = accountScopeRef.current;
            if (scope?.userId === user.id && scope.serverUrl === serverUrl) {
                void saveOfflineWorkspace(serverUrl, user, queryClient).catch(() => undefined);
            }
        });
    }, [queryClient, serverUrl, user]);

    const value = useMemo<AuthContextValue>(() => ({
        api,
        user,
        accessToken: null,
        refreshToken: null,
        deviceId: null,
        serverUrl,
        isLoading,
        authError,
        pendingReconnection,
        clientUpgradeRequired: null,
        clientServerIncompatibility: null,
        accountDeletionCleanupNotice: null,
        updateCurrentUser,
        login,
        register,
        logout,
        clearLocalSession: clearSessionWithBrowserCleanup,
        recheckClientCompatibility,
        persistAccountDeletionCleanupNotice: async () => undefined,
        acknowledgeAccountDeletionCleanupNotice: async () => undefined
    }), [updateCurrentUser, api, pendingReconnection, authError, clearSessionWithBrowserCleanup, isLoading, login, logout, recheckClientCompatibility, register, serverUrl, user]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/** Reads browser authentication state and throws outside its provider. */
export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth must be used within AuthProvider');
    return context;
}
