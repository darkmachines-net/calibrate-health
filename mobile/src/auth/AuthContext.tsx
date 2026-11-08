/** @file Native password/provider sign-in on the configured backend, session restoration, token rotation and account-scoped cleanup. */

import { hasExplicitLogout, beginExplicitLogout, flushExplicitLogout, finishExplicitLogin, queueNativeRevocation } from './logoutIntent';
import { usePendingLogoutRetry } from './usePendingLogoutRetry';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
    ApiError,
    CalibrateApiClient,
    type MobileAuthResponse,
    type UserClientPayload
} from '@calibrate/api-client';
import type { ClientUpgradeRequirement } from '@calibrate/shared';
import {
    getClientServerCompatibilityMismatch,
    type ClientServerCompatibilityMismatch
} from '@calibrate/shared/releaseCompatibility';
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from '@calibrate/shared/legalVersions';
import * as Application from 'expo-application';
import { useQueryClient } from '@tanstack/react-query';
import { getDefaultServerUrl, testCalibrateServerConnection } from '../config/server';
import { getSessionRestoreErrorMessage, isExpectedDevAutoLoginMiss } from './authErrors';
import { MOBILE_CLIENT_IDENTITY, MOBILE_SERVER_RELEASE_VERSION } from '../config/nativeClient';
import { getNativeDeviceName } from '../platform/nativePlatform';
import {
    clearStoredTokens,
    getOrCreateDeviceId,
    readStoredTokens,
    writeStoredTokens
} from './storage';
import {
    clearAccountDeletionCleanupNotice,
    assertAccountDeletionCleanupAcknowledged,
    readAccountDeletionCleanupNotice,
    writeAccountDeletionCleanupNotice,
    type AccountDeletionCleanupNotice
} from '../account/accountDeletionNotice';
import { DEV_TEST_EMAIL, DEV_TEST_PASSWORD, shouldDevAutoLogin } from './devAutoLogin';
import { requireRegistrationLegalAcceptance, requiresHostedLegalAcceptance, type RegistrationLegalAcceptance } from './accountAccess';
import { clearOnboardingDraft } from '../onboarding/draftStorage';
import { clearOfflineWorkspace, hydrateVerifiedOfflineWorkspace, restoreOfflineWorkspace, saveOfflineWorkspace } from './offlineWorkspace';
import { isRetryableMutationError } from '../offline/retryability';
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import { acquireSocialCredential } from './nativeSocialAuth';

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
    signInWithProvider: (provider: SocialAuthProvider, intent: 'login' | 'register', acceptance?: RegistrationLegalAcceptance) => Promise<boolean>;
    logout: () => Promise<void>;
    clearLocalSession: () => Promise<void>;
    recheckClientCompatibility: () => Promise<boolean>;
    persistAccountDeletionCleanupNotice: (notice: AccountDeletionCleanupNotice) => Promise<void>;
    acknowledgeAccountDeletionCleanupNotice: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Owns native session restoration, token rotation, configured-backend authentication, and account-scoped cache cleanup. */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const queryClient = useQueryClient();
    const [serverUrl] = useState(getDefaultServerUrl);
    const [user, setUser] = useState<UserClientPayload | null>(null);
    const [accessToken, setAccessToken] = useState<string | null>(null);
    const [refreshToken, setRefreshToken] = useState<string | null>(null);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [authError, setAuthError] = useState<string | null>(null);
    const [clientUpgradeRequired, setClientUpgradeRequired] = useState<ClientUpgradeRequirement | null>(null);
    const [clientServerIncompatibility, setClientServerIncompatibility] =
        useState<ClientServerCompatibilityMismatch | null>(null);
    const [accountDeletionCleanupNotice, setAccountDeletionCleanupNotice] =
        useState<AccountDeletionCleanupNotice | null>(null);
    const accessTokenRef = useRef<string | null>(null);
    const refreshTokenRef = useRef<string | null>(null);
    const serverUrlRef = useRef(serverUrl);
    usePendingLogoutRetry(serverUrl, flushExplicitLogout, () => { if (!accountScopeRef.current) setAuthError(null); });
    const [pendingReconnection, setPendingReconnection] = useState(false);
    const localOnlyRef = useRef(false);
    const accountScopeRef = useRef<{ serverUrl: string; userId: number } | null>(null);

    const clearSession = useCallback(async () => {
        const scope = accountScopeRef.current;
        accountScopeRef.current = null;
        localOnlyRef.current = false;
        setPendingReconnection(false);
        const workspaceCleanup = serverUrlRef.current ? clearOfflineWorkspace(scope?.serverUrl ?? serverUrlRef.current) : Promise.resolve();
        const draftCleanup = scope ? clearOnboardingDraft(scope.serverUrl, scope.userId) : Promise.resolve();
        setUser(null);
        setAccessToken(null);
        setRefreshToken(null);
        accessTokenRef.current = null;
        refreshTokenRef.current = null;
        setClientUpgradeRequired(null);
        setClientServerIncompatibility(null);
        queryClient.clear();
        await Promise.all([clearStoredTokens(), draftCleanup, workspaceCleanup]);
    }, [queryClient]);

    const handleClientUpgradeRequired = useCallback((requirement: ClientUpgradeRequirement) => {
        // Keep credentials and offline state intact so an in-place app update can resume the same session.
        setClientUpgradeRequired(requirement);
    }, []);

    const persistAuthPayload = useCallback(async (payload: {
        user: UserClientPayload;
        access_token: string;
        refresh_token: string;
    }) => {
        const previousScope = accountScopeRef.current;
        const nextScope = { serverUrl: serverUrlRef.current, userId: payload.user.id };
        accountScopeRef.current = nextScope;
        if (previousScope && (previousScope.userId !== payload.user.id || previousScope.serverUrl !== serverUrlRef.current)) {
            await clearOnboardingDraft(previousScope.serverUrl, previousScope.userId).catch(() => undefined);
        }
        if (accountScopeRef.current !== nextScope) return false;
        if (previousScope && (previousScope.userId !== payload.user.id || previousScope.serverUrl !== nextScope.serverUrl)) queryClient.clear();
        await hydrateVerifiedOfflineWorkspace(nextScope.serverUrl, payload.user.id, queryClient, () => accountScopeRef.current === nextScope);
        if (accountScopeRef.current !== nextScope) return false;
        localOnlyRef.current = false;
        setPendingReconnection(false);
        setAuthError(null);
        setUser(payload.user);
        setAccessToken(payload.access_token);
        setRefreshToken(payload.refresh_token);
        setClientUpgradeRequired(null);
        setClientServerIncompatibility(null);
        accessTokenRef.current = payload.access_token;
        refreshTokenRef.current = payload.refresh_token;
        await writeStoredTokens({
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token
        });
        if (accountScopeRef.current === nextScope) await saveOfflineWorkspace(nextScope.serverUrl, payload.user, queryClient).catch(() => undefined);
        return accountScopeRef.current === nextScope;
    }, [queryClient]);

    const refreshAccessToken = useCallback(async (): Promise<boolean> => {
        const currentRefreshToken = refreshTokenRef.current;
        const scope = accountScopeRef.current;
        const isCurrent = () => accountScopeRef.current === scope && refreshTokenRef.current === currentRefreshToken;
        if (!currentRefreshToken) return false;

        const refreshClient = new CalibrateApiClient({
            baseUrl: serverUrl,
            clientIdentity: MOBILE_CLIENT_IDENTITY,
            onClientUpgradeRequired: handleClientUpgradeRequired
        });
        try {
            const refreshed = await refreshClient.refreshMobile<MobileAuthResponse>(currentRefreshToken);
            if (!isCurrent()) {
                await queueNativeRevocation(serverUrl, refreshed.refresh_token);
                await flushExplicitLogout(serverUrl).catch(() => undefined);
                throw new Error('Authentication scope changed during refresh.');
            }
            if (accountScopeRef.current && refreshed.user.id !== accountScopeRef.current.userId) return false;
            if (!await persistAuthPayload(refreshed)) {
                await queueNativeRevocation(serverUrl, refreshed.refresh_token);
                await flushExplicitLogout(serverUrl).catch(() => undefined);
                throw new Error('Authentication scope changed during refresh.');
            }
            return true;
        } catch (error) {
            if (!isCurrent()) throw new Error('Authentication scope changed during refresh.', { cause: error });
            if (error instanceof ApiError && error.status === 401) return false;
            if (isRetryableMutationError(error)) {
                localOnlyRef.current = true;
                setPendingReconnection(true);
            }
            throw error;
        }
    }, [handleClientUpgradeRequired, persistAuthPayload, serverUrl]);

    const api = useMemo(
        () =>
            new CalibrateApiClient({
                baseUrl: serverUrl,
                clientIdentity: MOBILE_CLIENT_IDENTITY,
                onClientUpgradeRequired: handleClientUpgradeRequired,
                getAccessToken: () => accessTokenRef.current,
                fetchImpl: (input, init) => {
                    if (localOnlyRef.current) return Promise.reject(new TypeError('Pending reconnection; changes remain on this device.'));
                    return globalThis.fetch(input, init);
                },
                refreshAccessToken,
                onRequestError: (error) => {
                    if (isRetryableMutationError(error)) {
                        if (accountScopeRef.current) localOnlyRef.current = true;
                        setPendingReconnection(true);
                    }
                },
                onUnauthorized: clearSession
            }),
        [clearSession, handleClientUpgradeRequired, refreshAccessToken, serverUrl]
    );

    const getDevTestUserAuthPayload = useCallback(async (
        baseUrl: string,
        nextDeviceId: string
    ): Promise<MobileAuthResponse | null> => {
        const bootstrapClient = new CalibrateApiClient({
            baseUrl,
            clientIdentity: MOBILE_CLIENT_IDENTITY,
            onClientUpgradeRequired: handleClientUpgradeRequired
        });
        try {
            // Trigger the backend's existing dev auto-login/seed path when enabled.
            await bootstrapClient.getMe();
        } catch {
            // If cookie auto-login is disabled, the deterministic password path can still work
            // against an already-seeded local database.
        }

        let payload: MobileAuthResponse;
        try {
            payload = await bootstrapClient.loginMobile({
                email: DEV_TEST_EMAIL,
                password: DEV_TEST_PASSWORD,
                device_id: nextDeviceId,
                device_platform: MOBILE_CLIENT_IDENTITY.platform,
                device_name: getNativeDeviceName()
            });
        } catch (error) {
            if (isExpectedDevAutoLoginMiss(error)) return null;
            throw error;
        }
        return payload;
    }, [handleClientUpgradeRequired]);

    useEffect(() => {
        let isMounted = true;

        async function hydrate() {
            try {
                const [tokens, nextDeviceId, storedCleanupNotice] = await Promise.all([
                    readStoredTokens(serverUrl),
                    getOrCreateDeviceId(),
                    readAccountDeletionCleanupNotice().catch(() => null)
                ]);
                if (!isMounted) return;

                setDeviceId(nextDeviceId);
                if (await hasExplicitLogout(serverUrl)) {
                    await clearSession();
                    await flushExplicitLogout(serverUrl).catch(() => { if (isMounted) setAuthError('Signed out on this device. Server sign-out is pending connection.'); });
                    return;
                }
                // A late rotated token can require revocation without signing out the current account.
                void flushExplicitLogout(serverUrl).catch(() => undefined);
                setAccountDeletionCleanupNotice(storedCleanupNotice);
                if (storedCleanupNotice) {
                    setAccessToken(null);
                    setRefreshToken(null);
                    accessTokenRef.current = null;
                    refreshTokenRef.current = null;
                    await clearStoredTokens().catch(() => undefined);
                    return;
                }
                setAccessToken(tokens.accessToken);
                setRefreshToken(tokens.refreshToken);
                accessTokenRef.current = tokens.accessToken;
                refreshTokenRef.current = tokens.refreshToken;

                const compatibilityClient = new CalibrateApiClient({
                    baseUrl: serverUrl,
                    clientIdentity: MOBILE_CLIENT_IDENTITY,
                    onClientUpgradeRequired: handleClientUpgradeRequired
                });
                const config = await compatibilityClient.getClientConfig({ cache: 'no-store' });
                if (!isMounted) return;
                const compatibilityMismatch = getClientServerCompatibilityMismatch(
                    MOBILE_SERVER_RELEASE_VERSION,
                    config.server_version
                );
                if (compatibilityMismatch) {
                    setClientServerIncompatibility(compatibilityMismatch);
                    return;
                }

                if (tokens.refreshToken) {
                    try {
                        const refreshed = await compatibilityClient.refreshMobile<MobileAuthResponse>(tokens.refreshToken);
                        if (isMounted) {
                            await persistAuthPayload(refreshed);
                        }
                        return;
                    } catch (refreshError) {
                        if (!shouldDevAutoLogin(serverUrl) || !(refreshError instanceof ApiError) || refreshError.status !== 401) {
                            throw refreshError;
                        }
                        await clearStoredTokens();
                    }
                }

                if (shouldDevAutoLogin(serverUrl)) {
                    const devAuthPayload = await getDevTestUserAuthPayload(serverUrl, nextDeviceId);
                    if (isMounted && devAuthPayload) {
                        await persistAuthPayload(devAuthPayload);
                    }
                }
            } catch (error) {
                if (isMounted) {
                    if (isRetryableMutationError(error) && refreshTokenRef.current) {
                        const cached = await restoreOfflineWorkspace(serverUrlRef.current, queryClient).catch(() => null);
                        if (!isMounted) return;
                        if (cached) {
                            accountScopeRef.current = { serverUrl: serverUrlRef.current, userId: cached.id };
                            localOnlyRef.current = true;
                            setPendingReconnection(true);
                            setUser(cached);
                        }
                    }
                    setAuthError(getSessionRestoreErrorMessage(error));
                    // Only a rejected refresh invalidates stored credentials; offline startup should be retryable.
                    if (error instanceof ApiError && error.status === 401) {
                        await clearSession();
                    }
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        void hydrate();

        return () => {
            isMounted = false;
        };
    }, [clearSession, getDevTestUserAuthPayload, handleClientUpgradeRequired, persistAuthPayload, queryClient, serverUrl]);

    const recheckClientCompatibility = useCallback(async (): Promise<boolean> => {
        try {
            const recovery = new CalibrateApiClient({ baseUrl: serverUrlRef.current, clientIdentity: MOBILE_CLIENT_IDENTITY });
            const config = await recovery.getClientConfig({ cache: 'no-store' });
            const compatibilityMismatch = getClientServerCompatibilityMismatch(
                MOBILE_SERVER_RELEASE_VERSION,
                config.server_version
            );
            if (compatibilityMismatch) {
                setClientServerIncompatibility(compatibilityMismatch);
                return false;
            }
            if ((!user || pendingReconnection || localOnlyRef.current) && refreshTokenRef.current) {
                const restored = await refreshAccessToken();
                if (!restored) {
                    await clearSession();
                    return false;
                }
            } else {
                setClientServerIncompatibility(null);
            }
            setClientUpgradeRequired(null);
            return true;
        } catch (error) {
            if (error instanceof ApiError && error.status === 426) return false;
            throw error;
        }
    }, [clearSession, pendingReconnection, refreshAccessToken, user]);

    const confirmCurrentServer = useCallback(async (): Promise<boolean> => {
        const result = await testCalibrateServerConnection(serverUrl, {
            mobileVersion: Application.nativeApplicationVersion,
            clientServerVersion: MOBILE_SERVER_RELEASE_VERSION
        });
        setAuthError(result.ok ? null : result.message);
        return result.ok;
    }, [serverUrl]);

    const updateCurrentUser = useCallback((nextUser: UserClientPayload) => {
        const scope = accountScopeRef.current;
        if (scope?.userId !== nextUser.id) return;
        setUser(nextUser);
        void saveOfflineWorkspace(scope.serverUrl, nextUser, queryClient).catch(() => undefined);
    }, [queryClient]);

    const login = useCallback(
        async (email: string, password: string): Promise<boolean> => {
            assertAccountDeletionCleanupAcknowledged(accountDeletionCleanupNotice);
            const nextDeviceId = deviceId ?? (await getOrCreateDeviceId());
            setDeviceId(nextDeviceId);
            if (!await confirmCurrentServer()) return false;
            await flushExplicitLogout(serverUrl);
            const authClient = new CalibrateApiClient({
                baseUrl: serverUrl,
                clientIdentity: MOBILE_CLIENT_IDENTITY,
                onClientUpgradeRequired: handleClientUpgradeRequired
            });
            const payload = await authClient.loginMobile({
                email,
                password,
                device_id: nextDeviceId,
                device_platform: MOBILE_CLIENT_IDENTITY.platform,
                device_name: getNativeDeviceName()
            });
            await finishExplicitLogin(serverUrlRef.current);

            await persistAuthPayload(payload);
            return true;
        },
        [accountDeletionCleanupNotice, confirmCurrentServer, deviceId, handleClientUpgradeRequired, persistAuthPayload, serverUrl]
    );

    const register = useCallback(
        async (
            email: string,
            password: string,
            acceptance: RegistrationLegalAcceptance
        ): Promise<boolean> => {
            assertAccountDeletionCleanupAcknowledged(accountDeletionCleanupNotice);
            const nextDeviceId = deviceId ?? (await getOrCreateDeviceId());
            setDeviceId(nextDeviceId);
            if (!await confirmCurrentServer()) return false;
            await flushExplicitLogout(serverUrl);
            const legalAcceptance = requiresHostedLegalAcceptance(serverUrl)
                ? requireRegistrationLegalAcceptance(acceptance)
                : null;
            const authClient = new CalibrateApiClient({
                baseUrl: serverUrl,
                clientIdentity: MOBILE_CLIENT_IDENTITY,
                onClientUpgradeRequired: handleClientUpgradeRequired
            });
            const payload = await authClient.registerMobile({
                email,
                password,
                ...(legalAcceptance ? {
                    terms_version: CURRENT_TERMS_VERSION,
                    privacy_version: CURRENT_PRIVACY_VERSION,
                    accept_terms: legalAcceptance.acceptTerms,
                    accept_privacy: legalAcceptance.acceptPrivacy
                } : {}),
                device_id: nextDeviceId,
                device_platform: MOBILE_CLIENT_IDENTITY.platform,
                device_name: getNativeDeviceName()
            });
            await finishExplicitLogin(serverUrlRef.current);

            await persistAuthPayload(payload);
            return true;
        },
        [accountDeletionCleanupNotice, confirmCurrentServer, deviceId, handleClientUpgradeRequired, persistAuthPayload, serverUrl]
    );

    const signInWithProvider = useCallback(async (
        provider: SocialAuthProvider, intent: 'login' | 'register',
        acceptance?: RegistrationLegalAcceptance
    ): Promise<boolean> => {
        assertAccountDeletionCleanupAcknowledged(accountDeletionCleanupNotice);
        if (!await confirmCurrentServer()) return false;
        const legal = intent === 'register' && requiresHostedLegalAcceptance(serverUrl)
            ? requireRegistrationLegalAcceptance(acceptance ?? { acceptTerms: false, acceptPrivacy: false }) : null;
        const authClient = new CalibrateApiClient({
            baseUrl: serverUrl, clientIdentity: MOBILE_CLIENT_IDENTITY,
            onClientUpgradeRequired: handleClientUpgradeRequired
        });
        const available = await authClient.getMobileSocialProviders();
        if (!available.providers.includes(provider)) throw new Error('Provider unavailable on this server.');
        const credential = await acquireSocialCredential(provider);
        if (!credential) return false;
        await flushExplicitLogout(serverUrl);
        const nextDeviceId = deviceId ?? await getOrCreateDeviceId();
        setDeviceId(nextDeviceId);
        const payload = await authClient.authenticateMobileSocial({
            ...credential, intent, device_id: nextDeviceId,
            device_platform: MOBILE_CLIENT_IDENTITY.platform, device_name: getNativeDeviceName(),
            ...(legal ? {
                terms_version: CURRENT_TERMS_VERSION, privacy_version: CURRENT_PRIVACY_VERSION,
                accept_terms: legal.acceptTerms, accept_privacy: legal.acceptPrivacy
            } : {})
        });
        await finishExplicitLogin(serverUrl);
        await persistAuthPayload(payload);
        return true;
    }, [accountDeletionCleanupNotice, confirmCurrentServer, deviceId, handleClientUpgradeRequired, persistAuthPayload, serverUrl]);

    const logout = useCallback(async () => {
        const target = serverUrl;
        let intentPersisted = true;
        await beginExplicitLogout(target, refreshTokenRef.current ?? undefined).catch(() => { intentPersisted = false; });
        try {
            await clearSession();
        } finally {
            // Local cleanup failure must not suppress server session revocation.
            await flushExplicitLogout(target).catch(() => setAuthError(intentPersisted
                ? 'Signed out on this device. Server sign-out is pending connection.'
                : 'Signed out in this app. Device storage is unavailable and server sign-out is pending. Reconnect before closing this app.'));
        }
    }, [clearSession, serverUrl]);

    const persistAccountDeletionCleanupNotice = useCallback(async (notice: AccountDeletionCleanupNotice) => {
        // Update the mounted auth shell first so guidance remains visible even if durable storage is unavailable.
        setAccountDeletionCleanupNotice(notice);
        await writeAccountDeletionCleanupNotice(notice);
    }, []);

    const acknowledgeAccountDeletionCleanupNotice = useCallback(async () => {
        await clearAccountDeletionCleanupNotice();
        setAccountDeletionCleanupNotice(null);
    }, []);

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

    const value = useMemo<AuthContextValue>(
        () => ({
            api,
            user,
            accessToken,
            refreshToken,
            deviceId,
            serverUrl,
            isLoading,
            authError,
            pendingReconnection,
            clientUpgradeRequired,
            clientServerIncompatibility,
            accountDeletionCleanupNotice,
            updateCurrentUser,
            login,
            register,
            signInWithProvider,
            logout,
            clearLocalSession: clearSession,
            recheckClientCompatibility,
            persistAccountDeletionCleanupNotice,
            acknowledgeAccountDeletionCleanupNotice
        }),
        [pendingReconnection, accessToken, accountDeletionCleanupNotice, acknowledgeAccountDeletionCleanupNotice, api, authError, clearSession, clientServerIncompatibility, clientUpgradeRequired, deviceId, isLoading, login, logout, persistAccountDeletionCleanupNotice, recheckClientCompatibility, refreshToken, register, serverUrl, signInWithProvider, updateCurrentUser, user]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/** Reads the current authentication context and throws outside its provider. */
export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
}
