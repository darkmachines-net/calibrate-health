/** @file preferences: Render the route-owned editor for units, reminders, and interaction feedback. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    HEIGHT_UNITS,
    WEIGHT_UNITS,
    type HeightUnit,
    type WeightUnit
} from '@calibrate/shared';
import { useAuth } from '../../../src/auth/AuthContext';
import { invalidateProfilePlanningQueries } from '../../../src/caloriePlanning/queryInvalidation';
import { AppButton } from '../../../src/components/AppButton';
import { AppSection } from '../../../src/components/AppSection';
import { AppText } from '../../../src/components/AppText';
import { SectionHeader } from '../../../src/components/SectionHeader';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { TabScreen } from '../../../src/components/TabScreen';
import { getSafeActionErrorMessage } from '../../../src/errors/presentation';
import { useConfirmDiscardNavigation } from '../../../src/hooks/useConfirmDiscardNavigation';
import { useNativePushRegistration } from '../../../src/hooks/useNativePushRegistration';
import { getPushStatusPresentation, getPushStatusTarget } from '../../../src/notifications/workflow';
import { ReminderSettingsPanel } from '../../../src/settings/ReminderSettingsPanel';
import {
    getReminderScheduleErrors,
    hasReminderScheduleErrors,
    toReminderSchedulePayload
} from '../../../src/settings/reminderWallClock';
import { PreferenceSwitch } from '../../../src/settings/SettingsPrimitives';
import { spacing, useAppTheme } from '../../../src/theme';
import { HEIGHT_UNIT_OPTIONS, WEIGHT_UNIT_OPTIONS } from '../../../src/utils/profileOptions';

/** Render the route-owned editor for units, reminders, and interaction feedback. */
export default function PreferencesSettingsScreen() {
    const router = useRouter();
    const { api, user, updateCurrentUser } = useAuth();
    const queryClient = useQueryClient();
    const { colors } = useAppTheme();
    const nativePush = useNativePushRegistration();
    const isWeb = Platform.OS === 'web';
    const pushStatus = getPushStatusPresentation(nativePush.state, getPushStatusTarget(Platform.OS));
    const [weightUnit, setWeightUnit] = useState<WeightUnit>(user?.weight_unit ?? WEIGHT_UNITS.KG);
    const [heightUnit, setHeightUnit] = useState<HeightUnit>(user?.height_unit ?? HEIGHT_UNITS.CM);
    const [logFoodReminders, setLogFoodReminders] = useState(user?.reminder_log_food_enabled ?? true);
    const [logWeightReminders, setLogWeightReminders] = useState(user?.reminder_log_weight_enabled ?? true);
    const [logFoodReminderTime, setLogFoodReminderTime] = useState(user?.reminder_log_food_time ?? '09:00');
    const [logWeightReminderTime, setLogWeightReminderTime] = useState(
        user?.reminder_log_weight_time ?? '09:00'
    );
    const [quietHoursStart, setQuietHoursStart] = useState(user?.reminder_quiet_hours_start ?? '');
    const [quietHoursEnd, setQuietHoursEnd] = useState(user?.reminder_quiet_hours_end ?? '');
    const [hapticsEnabled, setHapticsEnabled] = useState(user?.haptics_enabled ?? true);
    const reminderSchedule = {
        foodTime: logFoodReminderTime,
        weightTime: logWeightReminderTime,
        quietStart: quietHoursStart,
        quietEnd: quietHoursEnd
    };
    const reminderScheduleErrors = getReminderScheduleErrors(reminderSchedule);
    const reminderScheduleIsInvalid = hasReminderScheduleErrors(reminderScheduleErrors);
    const preferencesBaselineRef = useRef(user);
    const baseline = preferencesBaselineRef.current;
    const preferencesAreDirty = Boolean(baseline && (
        weightUnit !== baseline.weight_unit
        || heightUnit !== baseline.height_unit
        || logFoodReminders !== baseline.reminder_log_food_enabled
        || logWeightReminders !== baseline.reminder_log_weight_enabled
        || logFoodReminderTime !== (baseline.reminder_log_food_time ?? '09:00')
        || logWeightReminderTime !== (baseline.reminder_log_weight_time ?? '09:00')
        || quietHoursStart !== (baseline.reminder_quiet_hours_start ?? '')
        || quietHoursEnd !== (baseline.reminder_quiet_hours_end ?? '')
        || hapticsEnabled !== baseline.haptics_enabled
    ));
    const resetPreferencesDraft = useCallback(() => {
        if (!user) return;
        preferencesBaselineRef.current = user;
        setWeightUnit(user.weight_unit);
        setHeightUnit(user.height_unit);
        setLogFoodReminders(user.reminder_log_food_enabled);
        setLogWeightReminders(user.reminder_log_weight_enabled);
        setLogFoodReminderTime(user.reminder_log_food_time ?? '09:00');
        setLogWeightReminderTime(user.reminder_log_weight_time ?? '09:00');
        setQuietHoursStart(user.reminder_quiet_hours_start ?? '');
        setQuietHoursEnd(user.reminder_quiet_hours_end ?? '');
        setHapticsEnabled(user.haptics_enabled);
    }, [user]);
    useEffect(() => {
        if (!preferencesAreDirty) resetPreferencesDraft();
    }, [resetPreferencesDraft, preferencesAreDirty]);

    function navigateToSettings() {
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace('/profile');
    }

    const savePreferences = useMutation({
        mutationFn: () =>
            api.updatePreferences({
                weight_unit: weightUnit,
                height_unit: heightUnit,
                reminder_log_food_enabled: logFoodReminders,
                reminder_log_weight_enabled: logWeightReminders,
                ...toReminderSchedulePayload(reminderSchedule),
                haptics_enabled: hapticsEnabled
            })
    });
    const { allowNavigation, requestNavigation } = useConfirmDiscardNavigation(
        preferencesAreDirty,
        savePreferences.isPending,
        resetPreferencesDraft
    );

    async function handleCancel() {
        await requestNavigation(navigateToSettings);
    }

    function handleSave() {
        if (reminderScheduleIsInvalid) return;
        savePreferences.mutate(undefined, {
            onSuccess: async (response) => {
                updateCurrentUser(response.user);
                await invalidateProfilePlanningQueries(queryClient);
                allowNavigation(navigateToSettings);
            }
        });
    }

    return (
        <TabScreen contentWidth="form" testID="settings-preferences-page">
            <View style={styles.content}>
                <SectionHeader
                    title="Tracking preferences"
                    description="Units, reminder intent, delivery permission, quiet hours, and interaction feedback."
                />
                <View style={styles.content}>
                    <AppText variant="label">Weight unit</AppText>
                    <SegmentedControl
                        accessibilityLabel="Weight unit"
                        options={WEIGHT_UNIT_OPTIONS}
                        value={weightUnit}
                        onChange={setWeightUnit}
                    />
                    <AppText variant="label">Height unit</AppText>
                    <SegmentedControl
                        accessibilityLabel="Height unit"
                        options={HEIGHT_UNIT_OPTIONS}
                        value={heightUnit}
                        onChange={setHeightUnit}
                    />
                    <ReminderSettingsPanel
                        timezone={user?.timezone ?? 'UTC'}
                        logFoodEnabled={logFoodReminders}
                        logWeightEnabled={logWeightReminders}
                        foodTime={logFoodReminderTime}
                        weightTime={logWeightReminderTime}
                        quietStart={quietHoursStart}
                        quietEnd={quietHoursEnd}
                        errors={reminderScheduleErrors}
                        deliveryStatus={pushStatus}
                        isWeb={isWeb}
                        onLogFoodEnabledChange={setLogFoodReminders}
                        onLogWeightEnabledChange={setLogWeightReminders}
                        onFoodTimeChange={setLogFoodReminderTime}
                        onWeightTimeChange={setLogWeightReminderTime}
                        onQuietStartChange={setQuietHoursStart}
                        onQuietEndChange={setQuietHoursEnd}
                        onRequestPermission={() => void nativePush.requestPermission()}
                        onOpenPermissionSettings={() => void nativePush.openSettings()}
                        onRefreshPermission={() => void nativePush.refreshPermission()}
                        onRetryRegistration={() => void nativePush.retryRegistration()}
                        onDisableRegistration={nativePush.disableRegistration
                            ? () => void nativePush.disableRegistration?.()
                            : undefined}
                    />
                    <AppSection style={[styles.dividedSection, { borderTopColor: colors.outlineVariant }]}>
                        <SectionHeader title="Interaction" />
                        <PreferenceSwitch
                            label="Haptics"
                            value={hapticsEnabled}
                            onValueChange={setHapticsEnabled}
                        />
                    </AppSection>
                    {savePreferences.error && (
                        <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                            {getSafeActionErrorMessage(
                                savePreferences.error,
                                'Unable to save preferences.'
                            )}
                        </AppText>
                    )}
                    <View style={[styles.actionRow, { borderTopColor: colors.outlineVariant }]}>
                        <AppButton
                            title="Cancel"
                            variant="secondary"
                            disabled={savePreferences.isPending}
                            leftIcon={<Ionicons name="close" size={18} color={colors.onSurface} />}
                            onPress={() => { void handleCancel(); }}
                            style={styles.actionButton}
                        />
                        <AppButton
                            title={savePreferences.isPending ? 'Saving...' : 'Save preferences'}
                            disabled={savePreferences.isPending || reminderScheduleIsInvalid}
                            leftIcon={<Ionicons name="options-outline" size={18} color={colors.onPrimary} />}
                            onPress={handleSave}
                            style={styles.actionButton}
                        />
                    </View>
                </View>
            </View>
        </TabScreen>
    );
}

const styles = StyleSheet.create({
    content: {
        gap: spacing.md
    },
    dividedSection: {
        borderTopWidth: StyleSheet.hairlineWidth,
        marginTop: spacing.md,
        paddingTop: spacing.lg
    },
    actionRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingTop: spacing.lg
    },
    actionButton: {
        flex: 1,
        // Keep the long Save preferences label readable before paired controls wrap.
        minWidth: 180
    }
});
