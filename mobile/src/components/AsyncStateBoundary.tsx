/** @file Stable loading, empty, stale, offline, and error presentation with accessible retry behavior. */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { onlineManager } from '@tanstack/react-query';
import {
    ASYNC_RESOURCE_STATES,
    resolveAsyncResourceState,
    type AsyncQuerySnapshot,
    type AsyncResourceState
} from '../asyncState/resolveAsyncState';
import { getErrorPresentation } from '../errors/presentation';
import { type AppTheme, useAppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppNotice } from './AppNotice';
import { AppText } from './AppText';

type AsyncStateBoundaryProps = {
    state: AsyncResourceState;
    resourceLabel: string;
    loading: React.ReactNode;
    empty: React.ReactNode;
    children: React.ReactNode;
    onRetry?: () => unknown | Promise<unknown>;
    retrying?: boolean;
    suppressStaleNotice?: boolean;
    contentStyle?: StyleProp<ViewStyle>;
};

type AsyncRetryLiveStatusProps = {
    retrying: boolean;
    resourceLabel: string;
};

/** Announces active retries through a polite live region without adding visible layout. */
export function AsyncRetryLiveStatus({ retrying, resourceLabel }: AsyncRetryLiveStatusProps) {
    return (
        <AppText accessibilityLiveRegion="polite" style={hiddenStyles.liveStatus}>
            {retrying ? `Retrying ${resourceLabel}` : ''}
        </AppText>
    );
}

/** Subscribes to React Query connectivity through a React-safe external store. */
export function useOnlineStatus(): boolean {
    return React.useSyncExternalStore(
        (listener) => onlineManager?.subscribe?.(listener) ?? (() => undefined),
        () => onlineManager?.isOnline?.() ?? true,
        () => onlineManager?.isOnline?.() ?? true
    );
}

/** Combines query state, connectivity, and the caller's empty predicate into one presentation state. */
export function useAsyncResourceState<T>(
    query: AsyncQuerySnapshot<T>,
    isEmpty: (data: T) => boolean
): AsyncResourceState {
    const isOnline = useOnlineStatus();
    return resolveAsyncResourceState(query, { isEmpty, isOnline });
}

/** Keeps cached content visible where possible and supplies consistent loading, empty, failure, and retry states. */
export function AsyncStateBoundary({
    state,
    resourceLabel,
    loading,
    empty,
    children,
    onRetry,
    retrying = false,
    suppressStaleNotice = false,
    contentStyle
}: AsyncStateBoundaryProps) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const [localRetrying, setLocalRetrying] = React.useState(false);
    const isRetrying = retrying || localRetrying;

    const retry = React.useCallback(async () => {
        if (!onRetry || isRetrying) return;
        setLocalRetrying(true);
        try {
            await onRetry();
        } finally {
            setLocalRetrying(false);
        }
    }, [isRetrying, onRetry]);

    if (state.kind === ASYNC_RESOURCE_STATES.LOADING) {
        return (
            <>
                {loading}
                <AsyncRetryLiveStatus retrying={isRetrying} resourceLabel={resourceLabel} />
            </>
        );
    }
    if (state.kind === ASYNC_RESOURCE_STATES.EMPTY) return <>{empty}</>;

    if (state.kind === ASYNC_RESOURCE_STATES.ERROR) {
        const isOffline = state.terminalReason === 'offline';
        const presentation = isOffline
            ? {
                title: "You're offline",
                message: `Connect to the internet to load ${resourceLabel}.`,
                requestId: null
            }
            : getErrorPresentation(state.error, resourceLabel);
        return (
            <AppNotice
                tone={isOffline ? 'warning' : 'danger'}
                testID="async-state-error"
                style={[styles.errorCard, isOffline && styles.offlineCard]}
            >
                <View
                    accessible
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    testID="async-state-error-copy"
                    style={styles.errorCopy}
                >
                    <AppText variant="subtitle">{presentation.title}</AppText>
                    <AppText variant="muted">{presentation.message}</AppText>
                    {presentation.requestId && (
                        <AppText variant="caption">Reference: {presentation.requestId}</AppText>
                    )}
                </View>
                {!isOffline && onRetry && (
                    <AppButton
                        title={isRetrying ? 'Retrying...' : 'Retry'}
                        variant="secondary"
                        disabled={isRetrying}
                        accessibilityState={{ busy: isRetrying }}
                        onPress={() => void retry()}
                    />
                )}
                <AsyncRetryLiveStatus retrying={!isOffline && isRetrying} resourceLabel={resourceLabel} />
            </AppNotice>
        );
    }

    const showStaleNotice = state.kind === ASYNC_RESOURCE_STATES.STALE && !suppressStaleNotice;
    const showDegradedNotice = state.kind === ASYNC_RESOURCE_STATES.DEGRADED;
    return (
        <View style={[styles.content, contentStyle]}>
            {(showStaleNotice || showDegradedNotice) && (
                <View
                    accessibilityRole={showDegradedNotice ? 'alert' : undefined}
                    accessibilityLiveRegion="polite"
                    testID={`async-state-${state.kind}`}
                    style={[styles.notice, showDegradedNotice ? styles.degradedNotice : styles.staleNotice]}
                >
                    <View style={styles.noticeCopy}>
                        <AppText variant="label">
                            {showStaleNotice ? 'Offline - showing saved information' : `Couldn't refresh ${resourceLabel}`}
                        </AppText>
                        <AppText variant="caption">
                            {showStaleNotice
                                ? 'Changes may not appear until the connection returns.'
                                : 'The information below may be out of date.'}
                        </AppText>
                    </View>
                    {showDegradedNotice && onRetry && (
                        <AppButton
                            title={isRetrying ? 'Retrying...' : 'Retry'}
                            variant="ghost"
                            disabled={isRetrying}
                            accessibilityState={{ busy: isRetrying }}
                            onPress={() => void retry()}
                        />
                    )}
                </View>
            )}
            <AsyncRetryLiveStatus retrying={showDegradedNotice && isRetrying} resourceLabel={resourceLabel} />
            {children}
        </View>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        content: {
            gap: theme.spacing.sm,
            width: '100%'
        },
        errorCard: {
            borderColor: theme.colors.danger
        },
        offlineCard: {
            backgroundColor: theme.colors.warningContainer,
            borderColor: theme.colors.warning
        },
        errorCopy: {
            gap: theme.spacing.sm
        },
        notice: {
            alignItems: 'center',
            borderLeftWidth: theme.interaction.focusRingWidth,
            flexDirection: 'row',
            gap: theme.spacing.sm,
            justifyContent: 'space-between',
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            width: '100%'
        },
        staleNotice: {
            backgroundColor: theme.colors.warningContainer,
            borderColor: theme.colors.warning
        },
        degradedNotice: {
            backgroundColor: theme.colors.dangerContainer,
            borderColor: theme.colors.danger
        },
        noticeCopy: {
            flex: 1,
            minWidth: 0
        }
    });
}

const hiddenStyles = StyleSheet.create({
    liveStatus: {
        position: 'absolute',
        height: 0,
        overflow: 'hidden'
    }
});