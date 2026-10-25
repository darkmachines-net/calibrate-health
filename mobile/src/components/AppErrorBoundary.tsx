/** @file App Error Boundary: Restart through the host that actually owns the current runtime. */

import React from 'react';
import * as Crypto from 'expo-crypto';
import {
    DevSettings,
    Appearance,
    Platform,
    Pressable,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    View
} from 'react-native';
import {
    reportClientDiagnostic,
    type ClientDiagnosticSignal
} from '../diagnostics/clientDiagnostics';
import { radius, spacing, themes, typography, type AppTheme } from '../theme';

type AppErrorBoundaryProps = {
    children: React.ReactNode;
    /** Override exists for deterministic tests and alternate native reload hosts. */
    restartApp?: () => void;
    /** Override exists for deterministic tests of the provider-independent emergency shell. */
    reportDiagnostic?: (signal: ClientDiagnosticSignal) => Promise<string | null>;
};

type AppErrorBoundaryState = {
    hasError: boolean;
    requestId: string | null;
    resetVersion: number;
    focusedAction: 'retry' | 'restart' | null;
};

const FALLBACK_MAX_WIDTH = 420; // Keeps recovery copy readable on tablets and unfolded devices.
const BRAND_MARK_SIZE = 52; // Gives the emergency shell a recognizable mark without loading SVG/native modules.
const ROOT_FAILURE_DIAGNOSTIC: ClientDiagnosticSignal = {
    event: 'client_failure',
    operation: 'root_render',
    route: 'app_shell',
    outcome: 'failure',
    duration_bucket: 'not_applicable'
};

/** Restart through the host that actually owns the current runtime. */
export function restartAppRuntime(
    platform = Platform.OS,
    reloadWeb = () => window.location.reload(),
    reloadNative = () => DevSettings.reload()
): void {
    if (platform === 'web') {
        reloadWeb();
        return;
    }
    reloadNative();
}

const defaultRestartApp = (): void => restartAppRuntime();

/**
 * Last-resort native shell for render and lifecycle failures below the app root.
 *
 * The fallback intentionally uses only React Native core primitives so it remains
 * available when navigation, providers, or feature components are what failed.
 */
export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = {
        hasError: false,
        requestId: null,
        resetVersion: 0,
        focusedAction: null
    };

    /** Switches the root boundary to its recovery surface and allocates a diagnostic request identifier. */
    static getDerivedStateFromError(_error: unknown): Partial<AppErrorBoundaryState> {
        return { hasError: true, requestId: Crypto.randomUUID() };
    }

    /** Reports a caught root-render failure once for the current recovery attempt. */
    componentDidCatch(_error: Error, _info: React.ErrorInfo): void {
        void this.reportRootFailure(this.state.resetVersion);
    }

    private reportRootFailure = async (resetVersion: number): Promise<void> => {
        const requestId = this.state.requestId;
        if (!requestId || this.state.resetVersion !== resetVersion) return;
        const reporter = this.props.reportDiagnostic ?? reportClientDiagnostic;
        try {
            await reporter({ ...ROOT_FAILURE_DIAGNOSTIC, request_id: requestId });
        } catch {
            // The local support reference remains useful when diagnostics cannot be delivered.
        }
    };

    private resetAppShell = (): void => {
        this.setState((state) => ({
            hasError: false,
            requestId: null,
            resetVersion: state.resetVersion + 1
        }));
    };

    private restartApp = (): void => {
        (this.props.restartApp ?? defaultRestartApp)();
    };

    /** Renders child content or the themed root-failure recovery surface after a render error. */
    render(): React.ReactNode {
        if (this.state.hasError) {
            const theme = Appearance.getColorScheme() === 'dark' ? themes.dark : themes.light;
            const styles = createStyles(theme);
            return (
                <ScrollView
                    testID="app-error-boundary"
                    style={styles.screen}
                    contentContainerStyle={styles.content}
                    accessible
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    accessibilityLabel="Calibrate encountered an unexpected error"
                >
                    <StatusBar barStyle={theme.dark ? 'light-content' : 'dark-content'} />
                    <View style={styles.card}>
                        <View style={styles.brandRow}>
                            <View
                                style={styles.brandMark}
                                accessibilityRole="image"
                                accessibilityLabel="Calibrate"
                            >
                                <Text style={styles.brandMarkText}>C</Text>
                            </View>
                            <Text style={styles.brandName}>calibrate</Text>
                        </View>

                        <Text accessibilityRole="header" aria-level={1} style={styles.title}>Calibrate hit a snag</Text>
                        <Text style={styles.description}>
                            Your saved data is safe. Try loading the app again, or restart Calibrate if the problem continues.
                        </Text>
                        {this.state.requestId ? (
                            <Text
                                testID="app-error-reference"
                                accessibilityLiveRegion="polite"
                                style={styles.reference}
                            >
                                Support reference: {this.state.requestId}. Include this reference when contacting Calibrate support.
                            </Text>
                        ) : null}
                        {__DEV__ ? (
                            <Text style={styles.developmentError} testID="app-error-detail">
                                Technical details are hidden to protect your privacy.
                            </Text>
                        ) : null}

                        <View style={styles.actions}>
                            <Pressable
                                testID="app-error-retry"
                                accessibilityRole="button"
                                accessibilityLabel="Try loading Calibrate again"
                                onPress={this.resetAppShell}
                                onFocus={() => this.setState({ focusedAction: 'retry' })}
                                onBlur={() => this.setState({ focusedAction: null })}
                                style={({ pressed }) => [styles.button, styles.primaryButton, pressed && styles.pressed, this.state.focusedAction === 'retry' && styles.focused]}
                            >
                                <Text style={styles.primaryButtonLabel}>Try again</Text>
                            </Pressable>
                            <Pressable
                                testID="app-error-restart"
                                accessibilityRole="button"
                                accessibilityLabel="Restart Calibrate"
                                onPress={this.restartApp}
                                onFocus={() => this.setState({ focusedAction: 'restart' })}
                                onBlur={() => this.setState({ focusedAction: null })}
                                style={({ pressed }) => [styles.button, styles.secondaryButton, pressed && styles.pressed, this.state.focusedAction === 'restart' && styles.focused]}
                            >
                                <Text style={styles.secondaryButtonLabel}>Restart app</Text>
                            </Pressable>
                        </View>
                    </View>
                </ScrollView>
            );
        }

        return <React.Fragment key={this.state.resetVersion}>{this.props.children}</React.Fragment>;
    }
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.background
    },
    content: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background,
        padding: spacing.lg
    },
    card: {
        width: '100%',
        maxWidth: FALLBACK_MAX_WIDTH,
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginBottom: spacing.xxl
    },
    brandMark: {
        width: BRAND_MARK_SIZE,
        height: BRAND_MARK_SIZE,
        borderRadius: BRAND_MARK_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primary
    },
    brandMarkText: {
        color: theme.colors.onPrimary,
        fontSize: typography.title,
        fontWeight: '600'
    },
    brandName: {
        color: theme.colors.onSurface,
        fontSize: typography.screenTitle,
        fontWeight: '600'
    },
    title: {
        color: theme.colors.onSurface,
        fontSize: typography.title,
        fontWeight: '600',
        marginBottom: spacing.lg
    },
    description: {
        color: theme.colors.onSurfaceVariant,
        fontSize: typography.body,
        lineHeight: 21
    },
    reference: {
        color: theme.colors.onSurface,
        fontSize: typography.body,
        lineHeight: 21,
        marginTop: spacing.xl
    },
    developmentError: {
        color: theme.colors.onDangerContainer,
        fontSize: typography.caption,
        marginTop: spacing.xl
    },
    actions: {
        gap: spacing.lg,
        marginTop: spacing.xxl
    },
    button: {
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg
    },
    primaryButton: {
        backgroundColor: theme.colors.primary,
    },
    secondaryButton: {
        backgroundColor: theme.colors.surfaceContainer,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.outlineVariant
    },
    primaryButtonLabel: {
        color: theme.colors.onPrimary,
        fontSize: typography.body,
        fontWeight: '600'
    },
    secondaryButtonLabel: {
        color: theme.colors.onSurface,
        fontSize: typography.body,
        fontWeight: '600'
    },
    pressed: {
        opacity: 0.86,
        transform: [{ translateY: 1 }]
    },
    focused: {
        outlineColor: theme.colors.focusRing,
        outlineWidth: theme.interaction.focusRingWidth,
        outlineStyle: 'solid'
    }
});
