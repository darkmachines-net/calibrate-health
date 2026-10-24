/** @file Browser Expo root: shared providers, responsive shell, route metadata, PWA lifecycle, and error recovery. */

import 'react-native-gesture-handler';
// Record browser history before any lazily loaded editor can register a discard guard.
import '../src/hooks/useBrowserDiscardNavigation.web';
import React from 'react';
import { Slot, usePathname } from 'expo-router';
import Head from 'expo-router/head';
import { StyleSheet, View } from 'react-native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { hasFullAccountAccess } from '../src/auth/accountAccess';
import { NativePushRegistrationProvider } from '../src/hooks/useNativePushRegistration';
import { useOfflineReplayExecutor } from '../src/offline/useOfflineReplayExecutor';
import { OfflineOutboxProvider } from '../src/offline/provider';
import { OfflineWorkspaceStatus } from '../src/offline/OfflineWorkspaceStatus';
import { invalidateQueriesAfterOfflineReplay } from '../src/offline/replayInvalidation';
import { useAppTheme } from '../src/theme';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary';
import { HealthConnectProvider } from '../src/healthConnect/provider';
import { PwaStatusBanner } from '../src/pwa/PwaStatusBanner.web';
import { useBrowserNotificationStream } from '../src/notifications/useBrowserNotificationStream.web';
import { useVisualViewportHeight } from '../src/hooks/useVisualViewportHeight';
import { useQueryOnlineManager } from '../src/connectivity/queryOnlineManager.web';
import { resolveRouteMetadata } from '../src/navigation/routeMetadata';
import { useBrowserRouteFocus } from '../src/navigation/useBrowserRouteFocus';
import { scrubBrowserOneTimeTokenFromUrl } from '../src/auth/oneTimeToken';
import { ClientDiagnosticsRuntime } from '../src/diagnostics/ClientDiagnosticsRuntime';
import { ClientWebVitalsRuntime } from '../src/diagnostics/ClientWebVitalsRuntime.web';

const queryClient = new QueryClient();

const BrowserRoutePresentation: React.FC = () => {
    const pathname = usePathname();
    const { user } = useAuth();
    scrubBrowserOneTimeTokenFromUrl(pathname);
    const metadata = resolveRouteMetadata(pathname, { authenticated: Boolean(user) });
    useBrowserRouteFocus(pathname, metadata.title);

    return (
        <Head>
            <title>{metadata.title}</title>
            <meta name="description" content={metadata.description} />
            <meta name="robots" content={metadata.robots} />
            {metadata.canonicalPath ? <link rel="canonical" href={metadata.canonicalPath} /> : null}
        </Head>
    );
};

const WebSkipLink: React.FC = () => {
    const theme = useAppTheme();
    const [isFocused, setIsFocused] = React.useState(false);
    const style: React.CSSProperties = {
        position: 'fixed',
        top: 8,
        left: 8,
        zIndex: 10000,
        minHeight: 48,
        padding: '10px 16px',
        border: `2px solid ${theme.colors.onPrimary}`,
        borderRadius: theme.radius.md,
        background: theme.colors.primary,
        color: theme.colors.onPrimary,
        font: '600 16px/24px system-ui, sans-serif',
        cursor: 'pointer',
        transform: isFocused ? 'translateY(0)' : 'translateY(calc(-100% - 16px))',
        transition: 'transform 120ms ease',
        boxShadow: isFocused ? `0 0 0 3px ${theme.colors.primaryContainer}` : 'none'
    };

    function focusMainContent() {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="main"]'));
        const activeMain = candidates.find((candidate) => candidate.getClientRects().length > 0);
        activeMain?.focus({ preventScroll: true });
        activeMain?.scrollIntoView({ block: 'start' });
    }

    return (
        <button
            type="button"
            style={style}
            onBlur={() => setIsFocused(false)}
            onClick={focusMainContent}
            onFocus={() => setIsFocused(true)}
        >
            Skip to main content
        </button>
    );
};

/** Web keeps native-only notification, Health Connect, and Wear runtime hooks out of startup. */
const BrowserRuntime: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { serverUrl, user } = useAuth();
    const queryClient = useQueryClient();
    const executeMutation = useOfflineReplayExecutor();
    const onReplayCompleted = React.useCallback(
        (result: Parameters<typeof invalidateQueriesAfterOfflineReplay>[1]) =>
            invalidateQueriesAfterOfflineReplay(queryClient, result),
        [queryClient]
    );
    useBrowserNotificationStream({ enabled: Boolean(user && hasFullAccountAccess(user)), serverUrl, queryClient });
    return (
        <OfflineOutboxProvider executeMutation={executeMutation} onReplayCompleted={onReplayCompleted}>
            <HealthConnectProvider>{children}</HealthConnectProvider>
        </OfflineOutboxProvider>
    );
};

/** Network status belongs to the whole web shell; update prompts wait until the user is signed in. */
const BrowserPwaStatus: React.FC = () => {
    const { user } = useAuth();
    return <PwaStatusBanner showUpdateNotices={Boolean(user)} hasCompactNavigation={Boolean(user)} />;
};

const WebRootRuntime: React.FC = () => {
    const theme = useAppTheme();
    useQueryOnlineManager();
    const visualViewportHeight = useVisualViewportHeight();

    React.useEffect(() => {
        const previousRootBackground = document.documentElement.style.backgroundColor;
        const previousBodyBackground = document.body.style.backgroundColor;
        const previousColorScheme = document.documentElement.style.colorScheme;
        const previousBodyMargin = document.body.style.margin;
        const previousBodyOverflow = document.body.style.overflowX;

        document.documentElement.style.backgroundColor = theme.colors.background;
        document.documentElement.style.colorScheme = theme.mode;
        document.body.style.backgroundColor = theme.colors.background;
        document.body.style.margin = '0';
        document.body.style.overflowX = 'hidden';

        return () => {
            document.documentElement.style.backgroundColor = previousRootBackground;
            document.documentElement.style.colorScheme = previousColorScheme;
            document.body.style.backgroundColor = previousBodyBackground;
            document.body.style.margin = previousBodyMargin;
            document.body.style.overflowX = previousBodyOverflow;
        };
    }, [theme]);

    return (
        <>
            <WebSkipLink />
            <SafeAreaProvider>
                <QueryClientProvider client={queryClient}>
                    <AuthProvider>
                        <ClientDiagnosticsRuntime />
                        <ClientWebVitalsRuntime />
                        <BrowserPwaStatus />
                        <NativePushRegistrationProvider>
                            <BrowserRuntime>
                                <StatusBar style={theme.dark ? 'light' : 'dark'} />
                                <BrowserRoutePresentation />
                                <View
                                    style={[
                                        styles.viewport,
                                        visualViewportHeight !== undefined && styles.visualViewport,
                                        { height: visualViewportHeight }
                                    ]}
                                >
                                    <OfflineWorkspaceStatus />
                                    <Slot />
                                </View>
                            </BrowserRuntime>
                        </NativePushRegistrationProvider>
                    </AuthProvider>
                </QueryClientProvider>
            </SafeAreaProvider>
        </>
    );
};

/** Mounts browser providers and shell runtime inside the root render-error boundary. */
export default function RootLayout() {
    return (
        <AppErrorBoundary>
            <WebRootRuntime />
        </AppErrorBoundary>
    );
}

const styles = StyleSheet.create({
    viewport: {
        flex: 1,
        minHeight: 0
    },
    visualViewport: {
        // Preserve the measured viewport height instead of collapsing it to a zero flex basis.
        flexGrow: 0,
        flexShrink: 0,
        flexBasis: 'auto',
        width: '100%'
    }
});
