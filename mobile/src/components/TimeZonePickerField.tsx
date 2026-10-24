/** @file Time Zone Picker Field: Offers known and device timezones with manual IANA entry when the desired zone is absent. */

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { Combobox } from './Combobox';
import { TextField } from './TextField';
import { detectDeviceTimeZone, formatTimeZoneLabel, getTimeZoneOptions, isValidIanaTimeZone } from '../utils/timezones';
import { type AppTheme, useAppTheme } from '../theme';

type TimeZonePickerFieldProps = {
    value: string;
    onChange: (value: string) => void;
};

/** Offers known and device timezones with manual IANA entry when the desired zone is absent. */
export const TimeZonePickerField: React.FC<TimeZonePickerFieldProps> = ({ value, onChange }) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const deviceTimeZone = useMemo(() => detectDeviceTimeZone(), []);
    const options = useMemo(() => getTimeZoneOptions(value, deviceTimeZone), [deviceTimeZone, value]);
    const [isManualOpen, setIsManualOpen] = useState(false);
    const [manualDraft, setManualDraft] = useState(value);
    const normalizedDraft = manualDraft.trim();
    const isManualValid = isValidIanaTimeZone(normalizedDraft);
    const usesDeviceTimeZone = Boolean(deviceTimeZone && value === deviceTimeZone);

    useEffect(() => {
        if (!isManualOpen) setManualDraft(value);
    }, [isManualOpen, value]);

    function selectTimeZone(nextValue: string) {
        setIsManualOpen(false);
        onChange(nextValue);
    }

    let deviceStatus = 'Select a time zone below or enter an IANA identifier manually.';
    if (usesDeviceTimeZone) {
        deviceStatus = 'Using the time zone configured on this device.';
    } else if (deviceTimeZone) {
        deviceStatus = `Detected from device settings: ${deviceTimeZone}`;
    }

    return (
        <View style={styles.root}>
            <View style={styles.devicePanel}>
                <View style={styles.deviceStatus}>
                    <View style={styles.deviceIcon}>
                        <Ionicons
                            name={usesDeviceTimeZone ? 'checkmark-circle' : 'phone-portrait-outline'}
                            size={22}
                            color={usesDeviceTimeZone ? theme.colors.success : theme.colors.primary}
                        />
                    </View>
                    <View style={styles.deviceCopy}>
                        <AppText style={styles.deviceTitle}>
                            {deviceTimeZone ? formatTimeZoneLabel(deviceTimeZone) : 'Device time zone unavailable'}
                        </AppText>
                        <AppText variant="caption">{deviceStatus}</AppText>
                    </View>
                </View>
                {deviceTimeZone && (
                    <AppButton
                        title={usesDeviceTimeZone ? 'Using device time zone' : 'Use device time zone'}
                        variant="secondary"
                        disabled={usesDeviceTimeZone}
                        leftIcon={<Ionicons name="locate-outline" size={18} color={theme.colors.onSurface} />}
                        onPress={() => selectTimeZone(deviceTimeZone)}
                    />
                )}
            </View>

            <Combobox
                label="Time zone"
                value={value}
                options={options}
                onChange={selectTimeZone}
                helperText="Search common time zones or enter an IANA identifier below."
                searchable
            />

            <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isManualOpen }}
                onPress={() => setIsManualOpen((current) => !current)}
                style={({ pressed }) => [styles.advancedAction, pressed && styles.pressed]}
            >
                <Ionicons name="options-outline" size={20} color={theme.colors.onSurfaceVariant} />
                <AppText style={styles.advancedText}>Enter IANA time zone manually</AppText>
                <Ionicons name={isManualOpen ? 'chevron-up' : 'chevron-down'} size={18} color={theme.colors.onSurfaceVariant} />
            </Pressable>

            {isManualOpen && (
                <View style={styles.manualEditor}>
                    <TextField
                        label="IANA time zone"
                        value={manualDraft}
                        onChangeText={setManualDraft}
                        autoCapitalize="none"
                        autoCorrect={false}
                        helperText="Example: America/Los_Angeles"
                    />
                    {normalizedDraft.length > 0 && !isManualValid && (
                        <AppText accessibilityRole="alert" style={styles.error}>Enter a valid IANA time zone.</AppText>
                    )}
                    <AppButton
                        title="Apply manual time zone"
                        variant="secondary"
                        disabled={!isManualValid}
                        onPress={() => selectTimeZone(normalizedDraft)}
                    />
                </View>
            )}
        </View>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: {
            gap: theme.spacing.sm
        },
        devicePanel: {
            gap: theme.spacing.md,
            borderRadius: theme.radius.lg,
            borderColor: theme.colors.outlineVariant,
            borderWidth: StyleSheet.hairlineWidth,
            backgroundColor: theme.colors.primaryContainer,
            padding: theme.spacing.md
        },
        deviceStatus: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md
        },
        deviceIcon: {
            width: theme.interaction.minimumTouchTarget,
            height: theme.interaction.minimumTouchTarget,
            flexShrink: 0,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surface
        },
        deviceCopy: {
            flex: 1,
            minWidth: 0,
            gap: theme.spacing.xs
        },
        deviceTitle: {
            color: theme.colors.onPrimaryContainer,
            fontWeight: '700'
        },
        advancedAction: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.sm,
            overflow: 'hidden'
        },
        advancedText: {
            flex: 1,
            color: theme.colors.onSurfaceVariant,
            fontWeight: '600'
        },
        manualEditor: {
            gap: theme.spacing.md,
            borderLeftColor: theme.colors.outlineVariant,
            borderLeftWidth: 2,
            paddingLeft: theme.spacing.md
        },
        error: {
            color: theme.colors.danger
        },
        pressed: {
            backgroundColor: theme.colors.surfacePressed
        }
    });
}
