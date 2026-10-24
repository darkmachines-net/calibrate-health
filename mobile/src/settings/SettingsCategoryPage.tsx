/** @file Settings categories with platform navigation, offline summaries, and canonical software-license access. */

import { StyleSheet, View } from 'react-native';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsList';
import { MOBILE_CLIENT_IDENTITY } from '../config/nativeClient';
import { spacing, useAppTheme } from '../theme';
import type {
    ProductLink,
    SettingsCategoryId,
    SettingsPageId,
    SettingsSheetId
} from './SettingsHome';

type SettingsCategoryPageProps = {
    category: SettingsCategoryId;
    sessionCount?: number;
    connectedAppCount?: number;
    isOutboxReady: boolean;
    failedMutationCount: number;
    pendingMutationCount: number;
    isWeb: boolean;
    showAndroidIntegrations: boolean;
    onOpenPage: (page: SettingsPageId) => void;
    onOpenSheet: (sheet: SettingsSheetId) => void;
    onOpenProductLink: (link: ProductLink) => void;
    onDeleteAccount: () => void;
    onLogout: () => void;
};

/** Renders one settings category with platform-appropriate navigation and offline-state summaries. */
export function SettingsCategoryPage({
    category,
    sessionCount,
    connectedAppCount,
    isOutboxReady,
    failedMutationCount,
    pendingMutationCount,
    isWeb,
    showAndroidIntegrations,
    onOpenPage,
    onOpenSheet,
    onOpenProductLink,
    onDeleteAccount,
    onLogout
}: SettingsCategoryPageProps) {
    const { colors } = useAppTheme();
    const offlineSummary = failedMutationCount > 0
        ? `${failedMutationCount} failed`
        : `${pendingMutationCount} pending`;

    if (category === 'profile') {
        return (
            <View testID="settings-category-profile" style={styles.category}>
                <SettingsSection
                    testID="settings-section-profile"
                    title="Profile & preferences"
                    description="Your personal details and how Calibrate behaves for you."
                >
                    <SettingsRow
                        icon="image-outline"
                        label="Profile photo"
                        supportingText="Your avatar across Calibrate"
                        onPress={() => onOpenSheet('profile-photo')}
                    />
                    <SettingsRow
                        icon="person-outline"
                        label="Profile details"
                        supportingText="Body details, activity level, and time zone"
                        onPress={() => onOpenPage('profile-details')}
                    />
                    <SettingsRow
                        testID="settings-open-preferences"
                        icon="options-outline"
                        label="Preferences"
                        supportingText="Units, reminders, quiet hours, permissions, and haptics"
                        showDivider={false}
                        onPress={() => onOpenPage('preferences')}
                    />
                </SettingsSection>
            </View>
        );
    }

    if (category === 'security') {
        return (
            <View testID="settings-category-security" style={styles.category}>
                <SettingsSection
                    testID="settings-section-security"
                    title="Security & access"
                    description="Protect this account and manage where it is signed in."
                >
                    <SettingsRow
                        icon="key-outline"
                        label="Password"
                        supportingText="Change your password with current-password confirmation"
                        onPress={() => onOpenSheet('password')}
                    />
                    <SettingsRow
                        testID="settings-open-sessions"
                        icon="phone-portrait-outline"
                        label="Signed-in devices"
                        supportingText="Review and revoke browser, phone, and watch sessions"
                        value={sessionCount === undefined ? undefined : String(sessionCount)}
                        onPress={() => onOpenPage('devices')}
                    />
                    <SettingsRow
                        icon="log-out-outline"
                        label="Log out"
                        showDivider={false}
                        onPress={onLogout}
                    />
                </SettingsSection>
            </View>
        );
    }

    if (category === 'connections') {
        return (
            <View testID="settings-category-connections" style={styles.category}>
                <SettingsSection
                    testID="settings-section-connections"
                    title="Connections"
                    description="Imported activity, companion devices, and assistants."
                >
                    <SettingsRow
                        icon="walk-outline"
                        label="Activity"
                        supportingText="Steps, active calories, and exercise history"
                        onPress={() => onOpenPage('activity')}
                    />
                    {showAndroidIntegrations ? (
                        <>
                            <SettingsRow
                                icon="fitness-outline"
                                label="Health Connect"
                                supportingText="Read activity and weight from Android"
                                onPress={() => onOpenPage('health-connect')}
                            />
                            <SettingsRow
                                icon="watch-outline"
                                label="Galaxy Watch"
                                supportingText="Pair, sync, and manage the Wear OS companion"
                                onPress={() => onOpenPage('watch')}
                            />
                        </>
                    ) : null}
                    <SettingsRow
                        testID="settings-open-connected-apps"
                        icon="link-outline"
                        label="Connected assistants"
                        supportingText="Review and revoke read-only Calibrate access"
                        value={connectedAppCount === undefined ? undefined : String(connectedAppCount)}
                        showDivider={false}
                        onPress={() => onOpenPage('connected-apps')}
                    />
                </SettingsSection>
            </View>
        );
    }

    if (category === 'data') {
        return (
            <View testID="settings-category-data" style={styles.category}>
                <SettingsSection
                    testID="settings-section-data"
                    title="Data & privacy"
                    description="Manage saved content, sync state, portability, and account deletion."
                >
                    <SettingsRow
                        icon="restaurant-outline"
                        label="Saved foods"
                        supportingText="Foods and recipes you can quickly log"
                        onPress={() => onOpenPage('my-foods')}
                    />
                    <SettingsRow
                        icon="cloud-upload-outline"
                        label="Import from Lose It"
                        supportingText="Bring in a ZIP export"
                        onPress={() => onOpenSheet('import')}
                    />
                    <SettingsRow
                        icon="sync-outline"
                        label="Offline changes"
                        supportingText={isOutboxReady
                            ? 'Review work waiting to sync'
                            : 'Browser changes require an active connection'}
                        value={isOutboxReady ? offlineSummary : 'Online only'}
                        onPress={() => onOpenSheet('offline')}
                    />
                    <SettingsRow
                        testID="settings-export"
                        icon="share-outline"
                        label="Export account data"
                        supportingText="Download a portable JSON copy"
                        onPress={() => onOpenSheet('export')}
                    />
                    <SettingsRow
                        testID="settings-delete-account"
                        icon="trash-outline"
                        label="Delete account"
                        supportingText="Permanently delete this account after reauthentication"
                        danger
                        showDivider={false}
                        onPress={onDeleteAccount}
                    />
                </SettingsSection>
            </View>
        );
    }

    return (
        <View testID="settings-category-help" style={styles.category}>
            <SettingsSection
                testID="settings-section-help"
                title="Help & legal"
                description="Get support and review documents about your rights and the software."
            >
                <SettingsRow
                    icon="help-circle-outline"
                    label="Support and feedback"
                    supportingText="Get help or tell us what could be better"
                    onPress={() => onOpenProductLink('support')}
                />
                <SettingsRow
                    icon="shield-checkmark-outline"
                    label="Privacy policy"
                    onPress={() => onOpenProductLink('privacy')}
                />
                <SettingsRow
                    icon="document-text-outline"
                    label="Terms of service"
                    onPress={() => onOpenProductLink('terms')}
                />
                <SettingsRow
                    icon="code-slash-outline"
                    label="Software license"
                    showDivider={false}
                    onPress={() => onOpenProductLink('licenses')}
                />
            </SettingsSection>

            <SettingsSection
                testID="settings-section-app"
                title="App"
                description="Product information, diagnostics, connections, and software updates."
                style={{
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.outlineVariant,
                    paddingTop: spacing.lg
                }}
            >
                <SettingsRow
                    icon="information-circle-outline"
                    label="About Calibrate"
                    supportingText="Purpose, trust, and product links"
                    value={isWeb ? undefined : `v${MOBILE_CLIENT_IDENTITY.version}`}
                    onPress={() => onOpenPage('about')}
                />
                <SettingsRow
                    testID="settings-advanced"
                    icon="options-outline"
                    label="Advanced settings"
                    supportingText="Connection, diagnostics, and software updates"
                    showDivider={false}
                    onPress={() => onOpenPage('advanced')}
                />
            </SettingsSection>
        </View>
    );
}

const styles = StyleSheet.create({
    category: {
        gap: spacing.xxl
    }
});
