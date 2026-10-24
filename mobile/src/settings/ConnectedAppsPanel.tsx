/** @file Connected Apps Panel: Lists authorized applications and retains revocation confirmation when the server action fails. */

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ConnectedAppSummary } from '@calibrate/api-client';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { BottomSheetModal } from '../components/BottomSheetModal';
import { spacing, useAppTheme } from '../theme';

type ConnectedAppsPanelProps = {
    connections: ConnectedAppSummary[];
    pendingConnectionId?: string;
    errorMessage?: string;
    onRevoke: (connectionId: string) => void | Promise<void>;
};

const SCOPE_LABELS: Record<string, string> = {
    'calibrate:food:read': 'Food logs + calorie plan context',
    'calibrate:weight:read': 'Weight progress + calorie plan context'
};

const CONNECTION_COPY_MIN_WIDTH = 220;

function formatTimestamp(value: string | null): string {
    if (!value) return 'Never used';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Not recorded';
    return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function scopeSummary(scopes: string[]): string {
    return scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(' | ');
}

/** Lists authorized applications and retains revocation confirmation when the server action fails. */
export function ConnectedAppsPanel({
    connections,
    pendingConnectionId,
    errorMessage,
    onRevoke
}: ConnectedAppsPanelProps) {
    const { colors } = useAppTheme();
    const [selected, setSelected] = useState<ConnectedAppSummary | null>(null);

    async function confirmRevoke() {
        if (!selected) return;
        try {
            await onRevoke(selected.id);
            setSelected(null);
        } catch {
            // The owning mutation presents the privacy-safe error while this dialog remains open.
        }
    }

    return (
        <View style={styles.list}>
            {connections.map((connection) => (
                <View
                    key={connection.id}
                    style={[
                        styles.connection,
                        { borderColor: colors.outlineVariant }
                    ]}
                >
                    <View style={styles.connectionCopy}>
                        <AppText style={styles.connectionTitle}>{connection.client_name}</AppText>
                        <AppText variant="caption">{scopeSummary(connection.scopes)}</AppText>
                        <AppText variant="caption">Last used: {formatTimestamp(connection.last_used_at)}</AppText>
                    </View>
                    <AppButton
                        testID={`settings-connected-app-revoke-${connection.id}`}
                        title="Revoke"
                        variant="secondary"
                        textStyle={{ color: colors.danger }}
                        busy={pendingConnectionId === connection.id}
                        busyLabel="Revoking..."
                        disabled={Boolean(pendingConnectionId)}
                        onPress={() => setSelected(connection)}
                        style={styles.revokeButton}
                    />
                </View>
            ))}
            {errorMessage && !selected && (
                <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                    {errorMessage}
                </AppText>
            )}
            <BottomSheetModal
                visible={Boolean(selected)}
                accessibilityLabel="Revoke connected assistant"
                title="Revoke connected assistant?"
                description={selected
                    ? `${selected.client_name} will immediately lose access to this Calibrate account.`
                    : undefined}
                showCloseButton
                dismissDisabled={Boolean(pendingConnectionId)}
                onRequestClose={() => setSelected(null)}
            >
                <View style={styles.confirmationContent}>
                    {errorMessage && (
                        <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                            {errorMessage}
                        </AppText>
                    )}
                    <View style={styles.confirmationActions}>
                        <AppButton
                            title="Cancel"
                            variant="secondary"
                            disabled={Boolean(pendingConnectionId)}
                            onPress={() => setSelected(null)}
                            style={styles.confirmationButton}
                        />
                        <AppButton
                            testID="settings-connected-app-confirm-revoke"
                            title="Revoke"
                            variant="danger"
                            busy={Boolean(pendingConnectionId)}
                            busyLabel="Revoking..."
                            onPress={() => void confirmRevoke()}
                            style={styles.confirmationButton}
                        />
                    </View>
                </View>
            </BottomSheetModal>
        </View>
    );
}

const styles = StyleSheet.create({
    list: {
        gap: spacing.md
    },
    connection: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    connectionCopy: {
        flex: 1,
        minWidth: CONNECTION_COPY_MIN_WIDTH,
        gap: spacing.xs
    },
    connectionTitle: {
        fontWeight: '600'
    },
    revokeButton: {
        flexShrink: 0
    },
    confirmationContent: {
        gap: spacing.md
    },
    confirmationActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    confirmationButton: {
        flex: 1
    }
});
