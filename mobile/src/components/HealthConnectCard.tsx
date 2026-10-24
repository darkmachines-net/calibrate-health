/** @file Health Connect Card: Read-only Health Connect consent and device-access controls. */

import { useMemo } from 'react';
import { Alert, StyleSheet, Switch, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { formatHealthConnectFreshness } from '../healthConnect/presentation';
import { useHealthConnect } from '../healthConnect/provider';
import { useHealthConnectPresentation } from '../healthConnect/useHealthConnectPresentation';
import { HEALTH_CONNECT_FEATURES, type HealthConnectFeature } from '../healthConnect/types';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppNotice } from './AppNotice';
import { AppText } from './AppText';
import { HealthConnectConnectionAction } from './HealthConnectConnectionAction';
import { SectionHeader } from './SectionHeader';

const FEATURE_PRESENTATION: Array<{
    feature: HealthConnectFeature;
    label: string;
    description: string;
}> = [
    { feature: HEALTH_CONNECT_FEATURES.STEPS, label: 'Steps', description: 'Daily step totals.' },
    { feature: HEALTH_CONNECT_FEATURES.ACTIVE_CALORIES, label: 'Active calories', description: 'Energy burned through activity.' },
    {
        feature: HEALTH_CONNECT_FEATURES.TOTAL_CALORIES,
        label: 'Device-estimated total burn',
        description: 'Observed active and resting burn. This is not Calibrate TDEE.'
    },
    { feature: HEALTH_CONNECT_FEATURES.EXERCISE, label: 'Exercise', description: 'Workout type, title, and duration.' },
    {
        feature: HEALTH_CONNECT_FEATURES.WEIGHT,
        label: 'Weight',
        description: 'Optional scale readings, preserved with their source.'
    }
];

function formatPermissionCheck(value: string | null): string {
    if (!value) return 'Not checked yet';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Unknown';
    return parsed.toLocaleString();
}

/** Read-only Health Connect consent and device-access controls. */
export function HealthConnectCard() {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const healthConnect = useHealthConnect();
    const presentation = useHealthConnectPresentation({
        hasImportedActivity: healthConnect.lastSuccessfulSyncAt !== null
    });
    const availability = healthConnect.connection?.availability;
    const granted = new Set(healthConnect.connection?.grantedFeatures ?? []);
    const enabledFeatures = FEATURE_PRESENTATION.filter(({ feature }) => healthConnect.selection[feature]);
    const missingFeatures = presentation.missingFeatures;
    const isAvailable = availability === 'available';

    function confirmDisconnect() {
        Alert.alert(
            'Disconnect Health Connect?',
            'Calibrate will revoke Health Connect permissions and stop future imports. Activity and weight already sent to your Calibrate server remain until account deletion or server cleanup.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Disconnect', style: 'destructive', onPress: () => void healthConnect.disconnect() }
            ]
        );
    }

    return (
        <AppSection>
            <SectionHeader
                title="Health Connect"
                description="Read activity from Samsung Health and other connected apps on this phone."
            />
            <AppNotice style={styles.rationale}>
                <Ionicons name="shield-checkmark-outline" size={22} color={theme.colors.primary} />
                <AppText style={styles.rationaleText}>
                    Read only: Calibrate never writes health records, and imported activity will not automatically change your calorie target.
                </AppText>
            </AppNotice>
            <AppText
                accessibilityLiveRegion="polite"
                accessibilityRole={presentation.tone === 'danger' ? 'alert' : undefined}
                style={[
                    presentation.tone === 'danger' && styles.error,
                    presentation.tone === 'caution' && styles.notice
                ]}
            >
                {presentation.message}
            </AppText>

            {healthConnect.connected && (
                <View style={styles.syncStatus}>
                    <AppText variant="caption">
                        Activity freshness: {formatHealthConnectFreshness(healthConnect.lastSuccessfulSyncAt)}
                    </AppText>
                    <AppButton
                        title="Sync activity now"
                        busy={healthConnect.isSyncing}
                        busyLabel="Syncing..."
                        variant="ghost"
                        disabled={
                            healthConnect.isBusy
                            || healthConnect.isSyncing
                            || healthConnect.paused
                            || missingFeatures.length > 0
                        }
                        onPress={() => void healthConnect.sync()}
                        style={styles.compactButton}
                    />
                </View>
            )}

            {availability === 'provider_update_required' && (
                <HealthConnectConnectionAction variant="secondary" />
            )}

            {isAvailable && (
                <>
                    <SectionHeader title="Data Calibrate may read" />
                    <View style={styles.featureList}>
                        {FEATURE_PRESENTATION.map(({ feature, label, description }) => {
                            const enabled = healthConnect.selection[feature];
                            const grantedAccess = granted.has(feature);
                            const isWeight = feature === HEALTH_CONNECT_FEATURES.WEIGHT;
                            return (
                                <View key={feature} style={styles.featureRow}>
                                    <View style={styles.featureText}>
                                        <View style={styles.featureTitleRow}>
                                            <AppText style={styles.featureTitle}>{label}</AppText>
                                            {healthConnect.connected && enabled && (
                                                <AppText variant="caption" style={grantedAccess ? styles.granted : styles.needsAccess}>
                                                    {grantedAccess ? 'Allowed' : 'Needs access'}
                                                </AppText>
                                            )}
                                        </View>
                                        <AppText variant="caption">
                                            {description}
                                            {isWeight
                                                ? ' Off by default; imported readings never overwrite a manual weigh-in.'
                                                : ''}
                                        </AppText>
                                    </View>
                                    <Switch
                                        style={styles.featureSwitch}
                                        accessibilityLabel={'Read ' + label.toLowerCase() + ' from Health Connect'}
                                        accessibilityHint={isWeight ? 'Weight import requires separate, explicit permission.' : undefined}
                                        value={enabled}
                                        disabled={healthConnect.isBusy}
                                        onValueChange={(next) => void healthConnect.setFeatureEnabled(feature, next)}
                                        trackColor={{ false: theme.colors.controlTrack, true: theme.colors.primaryContainer }}
                                        thumbColor={enabled ? theme.colors.primary : theme.colors.surface}
                                    />
                                </View>
                            );
                        })}
                    </View>
                    <AppText variant="muted">
                        Turning off a data type, pausing, or disconnecting stops future imports. Data already synced to your Calibrate server remains in history and exports until account deletion or server cleanup.
                    </AppText>

                    {!healthConnect.connected ? (
                        enabledFeatures.length > 0 && <HealthConnectConnectionAction />
                    ) : (
                        <>
                            <View style={styles.actionRow}>
                                <AppButton
                                    title={healthConnect.paused ? 'Resume sync' : 'Pause sync'}
                                    variant="secondary"
                                    disabled={healthConnect.isBusy}
                                    onPress={() => void healthConnect.setPaused(!healthConnect.paused)}
                                    style={styles.actionButton}
                                />
                                <HealthConnectConnectionAction
                                    variant="secondary"
                                    style={styles.actionButton}
                                />
                            </View>
                            <AppButton
                                title="Disconnect"
                                variant="ghost"
                                disabled={healthConnect.isBusy}
                                onPress={confirmDisconnect}
                            />
                        </>
                    )}
                </>
            )}

            <View style={styles.footer}>
                <AppText variant="caption" style={styles.footerCopy}>
                    Last permission check: {formatPermissionCheck(healthConnect.lastRefreshedAt)}
                </AppText>
                {isAvailable && (
                    <AppButton
                        title={healthConnect.isBusy ? 'Checking...' : 'Check again'}
                        variant="ghost"
                        disabled={healthConnect.isBusy}
                        onPress={() => void healthConnect.refresh()}
                        style={styles.compactButton}
                    />
                )}
            </View>
            {healthConnect.restartMessage && (
                <AppText accessibilityLiveRegion="polite" style={styles.notice}>{healthConnect.restartMessage}</AppText>
            )}
            <AppButton
                title="View activity history"
                variant="secondary"
                leftIcon={<Ionicons name="bar-chart-outline" size={18} color={theme.colors.onSurface} />}
                onPress={() => router.push('/activity')}
            />
            <AppButton
                title="How Calibrate uses health data"
                variant="ghost"
                onPress={() => router.push('/health-connect-privacy')}
            />
        </AppSection>
    );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    rationale: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
        backgroundColor: theme.colors.summaryContainer,
        borderLeftColor: theme.colors.primary
    },
    rationaleText: {
        flex: 1
    },
    featureList: {
        gap: spacing.sm
    },
    syncStatus: {
        gap: spacing.sm
    },
    featureRow: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth
    },
    featureText: {
        flex: 1,
        gap: spacing.xs
    },
    featureSwitch: {
        minWidth: theme.interaction.minimumTouchTarget,
        minHeight: theme.interaction.minimumTouchTarget
    },
    featureTitleRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    featureTitle: {
        flexShrink: 1,
        fontWeight: '600'
    },
    granted: {
        color: theme.colors.success
    },
    needsAccess: {
        color: theme.colors.warning
    },
    actionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    actionButton: {
        flex: 1,
        // Permission actions need enough room for their full labels at phone widths.
        minWidth: 180
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.outlineVariant,
        paddingTop: spacing.md
    },
    footerCopy: {
        flex: 1,
        minWidth: 180
    },
    compactButton: {
        minHeight: theme.interaction.minimumTouchTarget,
        paddingVertical: spacing.sm
    },
    error: {
        color: theme.colors.danger
    },
    notice: {
        color: theme.colors.warning
    }
});
