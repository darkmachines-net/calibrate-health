/** @file Native Expo root: global providers, session restoration, connectivity, diagnostics, and error recovery. */

import 'react-native-gesture-handler';
import React from 'react';
import { Slot } from 'expo-router';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { hasFullAccountAccess } from '../src/auth/accountAccess';
import { NativePushRegistrationProvider } from '../src/hooks/useNativePushRegistration';
import { useNotificationTapRouting } from '../src/notifications/useNotificationTapRouting';
import { invalidateNotificationQueries } from '../src/notifications/query';
import { useOfflineReplayExecutor } from '../src/offline/useOfflineReplayExecutor';
import { OfflineOutboxProvider } from '../src/offline/provider';
import { OfflineWorkspaceStatus } from '../src/offline/OfflineWorkspaceStatus';
import { invalidateQueriesAfterOfflineReplay } from '../src/offline/replayInvalidation';
import { useAppTheme } from '../src/theme';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary';
import { ClientUpgradeRequiredScreen } from '../src/components/ClientUpgradeRequiredScreen';
import { ClientServerIncompatibleScreen } from '../src/components/ClientServerIncompatibleScreen';
import { HealthConnectProvider } from '../src/healthConnect/provider';
import { useWearHandoffRouting } from '../src/wear/useWearHandoffRouting';
import { useWearSyncInvalidation } from '../src/wear/useWearSyncInvalidation';
import { useQueryOnlineManager } from '../src/connectivity/queryOnlineManager.native';
import { ClientDiagnosticsRuntime } from '../src/diagnostics/ClientDiagnosticsRuntime';
import { supportsAndroidIntegrations } from '../src/platform/nativePlatform';

const queryClient = new QueryClient();

const NativeRuntimeHooks: React.FC = () => {
    const { user, serverUrl } = useAuth();
    const runtimeQueryClient = useQueryClient();
    const hasFullAccess = hasFullAccountAccess(user);
    const androidIntegrationsEnabled = supportsAndroidIntegrations();
    const reconcileNotifications = React.useCallback(() => {
        void invalidateNotificationQueries(runtimeQueryClient);
    }, [runtimeQueryClient]);
    useNotificationTapRouting(Boolean(user && hasFullAccess), reconcileNotifications);
    useWearHandoffRouting({
        enabled: Boolean(androidIntegrationsEnabled && user && hasFullAccess && serverUrl),
        serverOrigin: serverUrl,
        userId: user?.id ?? null
    });
    useWearSyncInvalidation(androidIntegrationsEnabled);
    return null;
};

const ClientCompatibilityGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const {
        clientUpgradeRequired,
        clientServerIncompatibility,
        serverUrl,
        recheckClientCompatibility,
        clearLocalSession
    } = useAuth();
    if (clientUpgradeRequired) {
        return (
            <ClientUpgradeRequiredScreen
                requirement={clientUpgradeRequired}
                serverUrl={serverUrl}
                onRecheck={recheckClientCompatibility}
                onChooseServer={clearLocalSession}
            />
        );
    }
    if (clientServerIncompatibility) {
        return (
            <ClientServerIncompatibleScreen
                mismatch={clientServerIncompatibility}
                serverUrl={serverUrl}
                onRecheck={recheckClientCompatibility}
                onChooseServer={clearLocalSession}
            />
        );
    }
    return <>{children}</>;
};

const AuthenticatedRuntime: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const runtimeQueryClient = useQueryClient();
    const executeMutation = useOfflineReplayExecutor();
    const onReplayCompleted = React.useCallback(
        (result: Parameters<typeof invalidateQueriesAfterOfflineReplay>[1]) =>
            invalidateQueriesAfterOfflineReplay(runtimeQueryClient, result),
        [runtimeQueryClient]
    );
    return (
        <OfflineOutboxProvider executeMutation={executeMutation} onReplayCompleted={onReplayCompleted}>
            <HealthConnectProvider><OfflineWorkspaceStatus />{children}</HealthConnectProvider>
        </OfflineOutboxProvider>
    );
};

const NativeRootRuntime: React.FC = () => {
    const theme = useAppTheme();
    useQueryOnlineManager();

    return (
        <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <AuthProvider>
                        <ClientDiagnosticsRuntime />
                        <ClientCompatibilityGate>
                            <NativePushRegistrationProvider>
                                <AuthenticatedRuntime>
                                    <NativeRuntimeHooks />
                                    <StatusBar style={theme.dark ? 'light' : 'dark'} />
                                    <Slot />
                                </AuthenticatedRuntime>
                            </NativePushRegistrationProvider>
                        </ClientCompatibilityGate>
                    </AuthProvider>
                </QueryClientProvider>
        </SafeAreaProvider>
    );
};

/** Mounts native providers and application runtime inside the root render-error boundary. */
export default function RootLayout() {
    return (
        <AppErrorBoundary>
            <NativeRootRuntime />
        </AppErrorBoundary>
    );
}
