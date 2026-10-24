/** @file Reminder Settings Panel: Separates account reminder intent and wall-clock scheduling from device permission and delivery controls. */

import { StyleSheet, View } from 'react-native';
import type { PushStatusPresentation } from '../notifications/workflow';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { SectionHeader } from '../components/SectionHeader';
import { TextField } from '../components/TextField';
import { spacing, useAppTheme } from '../theme';
import { PreferenceSwitch } from './SettingsPrimitives';
import type { ReminderScheduleErrors } from './reminderWallClock';

type ReminderSettingsPanelProps = {
    timezone: string;
    logFoodEnabled: boolean;
    logWeightEnabled: boolean;
    foodTime: string;
    weightTime: string;
    quietStart: string;
    quietEnd: string;
    errors: ReminderScheduleErrors;
    deliveryStatus: PushStatusPresentation;
    isWeb: boolean;
    onLogFoodEnabledChange: (value: boolean) => void;
    onLogWeightEnabledChange: (value: boolean) => void;
    onFoodTimeChange: (value: string) => void;
    onWeightTimeChange: (value: string) => void;
    onQuietStartChange: (value: string) => void;
    onQuietEndChange: (value: string) => void;
    onRequestPermission: () => void;
    onOpenPermissionSettings: () => void;
    onRefreshPermission: () => void;
    onRetryRegistration: () => void;
    onDisableRegistration?: () => void;
};

// Keeps paired time inputs readable before they wrap on compact or enlarged-text layouts.
const TIME_FIELD_MIN_WIDTH = 180;

/** Separates account reminder intent and wall-clock scheduling from device permission and delivery controls. */
export function ReminderSettingsPanel({
    timezone,
    logFoodEnabled,
    logWeightEnabled,
    foodTime,
    weightTime,
    quietStart,
    quietEnd,
    errors,
    deliveryStatus,
    isWeb,
    onLogFoodEnabledChange,
    onLogWeightEnabledChange,
    onFoodTimeChange,
    onWeightTimeChange,
    onQuietStartChange,
    onQuietEndChange,
    onRequestPermission,
    onOpenPermissionSettings,
    onRefreshPermission,
    onRetryRegistration,
    onDisableRegistration
}: ReminderSettingsPanelProps) {
    const { colors } = useAppTheme();
    const sectionStyle = [styles.section, { borderTopColor: colors.outlineVariant }];
    return (
        <>
            <View testID="settings-reminder-intent" style={sectionStyle}>
                <SectionHeader
                    title="Reminders"
                    description="Choose which account reminders Calibrate should create. Delivery permission is managed separately."
                />
                <PreferenceSwitch
                    label="Food reminders"
                    value={logFoodEnabled}
                    onValueChange={onLogFoodEnabledChange}
                />
                <TextField
                    testID="settings-food-reminder-time"
                    label="Food reminder time"
                    value={foodTime}
                    onChangeText={onFoodTimeChange}
                    placeholder="09:00"
                    maxLength={5}
                    autoCapitalize="none"
                    editable={logFoodEnabled}
                    errorText={errors.foodTime}
                    helperText="24-hour local time (HH:mm)."
                />
                <PreferenceSwitch
                    label="Weight reminders"
                    value={logWeightEnabled}
                    onValueChange={onLogWeightEnabledChange}
                />
                <TextField
                    testID="settings-weight-reminder-time"
                    label="Weight reminder time"
                    value={weightTime}
                    onChangeText={onWeightTimeChange}
                    placeholder="09:00"
                    maxLength={5}
                    autoCapitalize="none"
                    editable={logWeightEnabled}
                    errorText={errors.weightTime}
                    helperText="24-hour local time (HH:mm)."
                />
                <View style={styles.heading}>
                    <AppText variant="label">Quiet hours</AppText>
                    <AppText variant="caption">
                        Leave both blank to allow delivery all day. Overnight ranges are supported.
                    </AppText>
                </View>
                <View style={styles.timeRow}>
                    <TextField
                        testID="settings-quiet-hours-start"
                        label="Quiet hours start"
                        value={quietStart}
                        onChangeText={onQuietStartChange}
                        placeholder="22:00"
                        maxLength={5}
                        autoCapitalize="none"
                        errorText={errors.quietStart}
                        containerStyle={styles.timeField}
                    />
                    <TextField
                        testID="settings-quiet-hours-end"
                        label="Quiet hours end"
                        value={quietEnd}
                        onChangeText={onQuietEndChange}
                        placeholder="07:00"
                        maxLength={5}
                        autoCapitalize="none"
                        errorText={errors.quietEnd}
                        containerStyle={styles.timeField}
                    />
                </View>
                <AppText variant="caption">
                    Times stay at the same local wall-clock time in {timezone}, including through daylight-saving changes.
                </AppText>
            </View>

            <View testID="settings-delivery-permission" style={sectionStyle}>
                <SectionHeader
                    title="Delivery permission"
                    description="This browser or device permission controls push delivery; it does not change your reminder choices."
                />
                <AppText
                    accessibilityLiveRegion="polite"
                    accessibilityRole={deliveryStatus.isError ? 'alert' : undefined}
                    variant={deliveryStatus.isError ? 'body' : 'muted'}
                >
                    {deliveryStatus.message}
                </AppText>
                {deliveryStatus.action === 'request' && (
                    <AppButton
                        title="Enable push notifications"
                        variant="secondary"
                        onPress={onRequestPermission}
                    />
                )}
                {deliveryStatus.action === 'settings' && (
                    <View style={styles.timeRow}>
                        {!isWeb && (
                            <AppButton
                                title="Open device settings"
                                variant="secondary"
                                onPress={onOpenPermissionSettings}
                                style={styles.timeField}
                            />
                        )}
                        <AppButton
                            title="Check again"
                            variant="secondary"
                            onPress={onRefreshPermission}
                            style={styles.timeField}
                        />
                    </View>
                )}
                {deliveryStatus.action === 'retry' && (
                    <AppButton
                        title="Retry push registration"
                        variant="secondary"
                        onPress={onRetryRegistration}
                    />
                )}
                {deliveryStatus.action === 'disable' && isWeb && onDisableRegistration && (
                    <AppButton
                        title="Disable push in this browser"
                        variant="secondary"
                        onPress={onDisableRegistration}
                    />
                )}
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    section: {
        gap: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        marginTop: spacing.md,
        paddingTop: spacing.lg
    },
    heading: {
        gap: spacing.xs
    },
    timeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    timeField: {
        flex: 1,
        minWidth: TIME_FIELD_MIN_WIDTH
    }
});
