/** @file Account settings composition and resource states with accessible navigation and recovery. */

import { Image, StyleSheet, View } from 'react-native';
import { HEIGHT_UNITS, WEIGHT_UNITS, type HeightUnit, type WeightUnit } from '@calibrate/shared';
import { AppText } from '../components/AppText';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsList';
import { MOBILE_CLIENT_IDENTITY } from '../config/nativeClient';
import { spacing, useAppTheme } from '../theme';
import { ASYNC_RESOURCE_STATES, type AsyncResourceState } from '../asyncState/resolveAsyncState';
import type { RouteId } from '../navigation/routeRegistry';

const SETTINGS_CATEGORY_IDS = [
    'profile',
    'security',
    'connections',
    'data',
    'help'
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

// Durable, multi-section settings are routes; sheets stay limited to short contextual tasks.
const SETTINGS_PAGE_IDS = [
    'profile-details',
    'preferences',
    'activity',
    'health-connect',
    'watch',
    'connected-apps',
    'devices',
    'my-foods',
    'about',
    'advanced'
] as const satisfies readonly RouteId[];

export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];

export type SettingsSheetId =
    | 'import'
    | 'profile-photo'
    | 'password'
    | 'offline'
    | 'export';

export type ProductLink = 'support' | 'privacy' | 'terms' | 'licenses';

type SettingsHomeProps = {
    email?: string | null;
    profileImageUrl?: string | null;
    goalSummary: string;
    weightUnit: WeightUnit;
    heightUnit: HeightUnit;
    sessionCount?: number;
    connectedAppCount?: number;
    isOutboxReady: boolean;
    failedMutationCount: number;
    pendingMutationCount: number;
    isWeb: boolean;
    onOpenCategory: (category: SettingsCategoryId) => void;
};

type SettingsAccountSummaryProps = {
    email?: string | null;
    profileImageUrl?: string | null;
    goalSummary: string;
};

function getAvatarLabel(email?: string | null): string {
    return email?.trim().charAt(0).toUpperCase() || 'C';
}

/** Shows meaningful settings resource failures while suppressing browser stale-cache notices. */
export function shouldShowSettingsResourceStatus(state: AsyncResourceState, isWeb: boolean): boolean {
    if (isWeb && state.kind === ASYNC_RESOURCE_STATES.STALE) return false;
    return state.kind !== ASYNC_RESOURCE_STATES.CONTENT && state.kind !== ASYNC_RESOURCE_STATES.EMPTY;
}

function SettingsAccountSummary({
    email,
    profileImageUrl,
    goalSummary
}: SettingsAccountSummaryProps) {
    const { colors } = useAppTheme();

    return (
        <View testID="settings-account-summary" style={styles.accountSummary}>
            <View style={[styles.summaryAvatar, { backgroundColor: colors.primaryContainer }]}>
                {profileImageUrl ? (
                    <Image source={{ uri: profileImageUrl }} style={styles.avatarImage} />
                ) : (
                    <AppText variant="subtitle" style={{ color: colors.onPrimaryContainer }}>
                        {getAvatarLabel(email)}
                    </AppText>
                )}
            </View>
            <View style={styles.summaryText}>
                <AppText
                    accessibilityRole="header"
                    aria-level={3}
                    ellipsizeMode="middle"
                    numberOfLines={1}
                    style={styles.summaryEmail}
                >
                    {email ?? 'Calibrate account'}
                </AppText>
                <AppText variant="caption" numberOfLines={2}>{goalSummary}</AppText>
            </View>
        </View>
    );
}

/** Renders the settings overview with profile, units, security, connections, and offline summaries. */
export function SettingsHome({
    email,
    profileImageUrl,
    goalSummary,
    weightUnit,
    heightUnit,
    sessionCount,
    connectedAppCount,
    isOutboxReady,
    failedMutationCount,
    pendingMutationCount,
    isWeb,
    onOpenCategory
}: SettingsHomeProps) {
    const { colors } = useAppTheme();
    const unitSummary = `${weightUnit === WEIGHT_UNITS.LB ? 'lb' : 'kg'} | ${heightUnit === HEIGHT_UNITS.FT_IN ? 'ft/in' : 'cm'
    }`;
    const securitySummary = sessionCount === undefined
        ? undefined
        : `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`;
    const connectionSummary = connectedAppCount === undefined || connectedAppCount === 0
        ? undefined
        : `${connectedAppCount} ${connectedAppCount === 1 ? 'assistant' : 'assistants'}`;
    let dataSummary: string | undefined;
    if (!isOutboxReady) {
        dataSummary = 'Online only';
    } else if (failedMutationCount > 0) {
        dataSummary = `${failedMutationCount} failed`;
    } else if (pendingMutationCount > 0) {
        dataSummary = `${pendingMutationCount} pending`;
    }

    return (
        <View testID="settings-home" style={styles.home}>
            <SettingsSection
                testID="settings-section-account"
                title="Your account"
                description="The account and goal currently active on this device."
            >
                <SettingsAccountSummary
                    email={email}
                    profileImageUrl={profileImageUrl}
                    goalSummary={goalSummary}
                />
            </SettingsSection>

            <SettingsSection
                testID="settings-section-categories"
                title="Browse settings"
                description="Choose an area to see related controls."
                style={{
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.outlineVariant,
                    paddingTop: spacing.lg
                }}
            >
                <SettingsRow
                    testID="settings-open-profile"
                    icon="person-outline"
                    label="Profile & preferences"
                    supportingText="Personal details, photo, units, reminders, and haptics"
                    value={unitSummary}
                    onPress={() => onOpenCategory('profile')}
                />
                <SettingsRow
                    testID="settings-open-security"
                    icon="shield-checkmark-outline"
                    label="Security & access"
                    supportingText="Password, signed-in devices, and sign-out"
                    value={securitySummary}
                    onPress={() => onOpenCategory('security')}
                />
                <SettingsRow
                    testID="settings-open-connections"
                    icon="link-outline"
                    label="Connections"
                    supportingText="Activity, health data, companion devices, and assistants"
                    value={connectionSummary}
                    onPress={() => onOpenCategory('connections')}
                />
                <SettingsRow
                    testID="settings-open-data"
                    icon="folder-open-outline"
                    label="Data & privacy"
                    supportingText="Saved foods, imports, offline changes, export, and deletion"
                    value={dataSummary}
                    onPress={() => onOpenCategory('data')}
                />
                <SettingsRow
                    testID="settings-open-help"
                    icon="help-circle-outline"
                    label="Help & app"
                    supportingText="Support, legal documents, product information, and advanced controls"
                    value={isWeb ? undefined : `v${MOBILE_CLIENT_IDENTITY.version}`}
                    showDivider={false}
                    onPress={() => onOpenCategory('help')}
                />
            </SettingsSection>
        </View>
    );
}

const styles = StyleSheet.create({
    home: {
        gap: spacing.md
    },
    accountSummary: {
        minHeight: 78,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: 0,
        paddingVertical: spacing.md
    },
    summaryAvatar: {
        width: 54,
        height: 54,
        borderRadius: 27,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden'
    },
    summaryText: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    summaryEmail: {
        fontWeight: '600'
    },
    avatarImage: {
        width: '100%',
        height: '100%'
    }
});
