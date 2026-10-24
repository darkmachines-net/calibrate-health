/** @file Date Picker Field: Pressable native date field used where typed date strings are error-prone on mobile. */

import React, { useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, StyleSheet, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from './AppText';
import { FormField } from './FormField';
import { AppButton } from './AppButton';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { dateOnlyToLocalDate, formatDateOnlyForDisplay, localDateToDateOnly } from '../utils/dates';
import type { DatePickerFieldProps } from './DatePickerField.types';

/**
 * Pressable native date field used where typed date strings are error-prone on mobile.
 */
export const DatePickerField: React.FC<DatePickerFieldProps> = ({
    label,
    value,
    onChangeDate,
    placeholder = 'Choose date',
    helperText,
    errorText,
    controlRef,
    minimumDate,
    maximumDate,
    fallbackDate,
    style,
    ...props
}) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [isFocused, setIsFocused] = useState(false);
    const [pickerDate, setPickerDate] = useState<Date | null>(null);
    const fieldRef = useRef<React.ComponentRef<typeof View> | null>(null);

    useImperativeHandle(controlRef, () => ({
        focus: () => {
            const element = fieldRef.current;
            element?.focus();
            if (Platform.OS === 'web' || !element) return;
            const handle = findNodeHandle(element);
            if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
        }
    }), []);

    function openPicker() {
        const initialDate = value || fallbackDate || maximumDate || localDateToDateOnly(new Date());
        setPickerDate(dateOnlyToLocalDate(initialDate));
    }

    function handleDatePicked(event: DateTimePickerEvent, date?: Date) {
        if (Platform.OS === 'android') {
            setPickerDate(null);
            if (event.type === 'set' && date) {
                onChangeDate(localDateToDateOnly(date));
            }
            return;
        }

        if (event.type === 'set' && date) {
            setPickerDate(date);
        }
    }

    function confirmPicker() {
        if (!pickerDate) return;
        onChangeDate(localDateToDateOnly(pickerDate));
        setPickerDate(null);
    }

    return (
        <View {...props} style={[styles.group, style]}>
            <FormField label={label} helperText={helperText} errorText={errorText} controlRef={controlRef}>
            {(field) => (
            <Pressable
                {...field}
                ref={fieldRef}
                accessibilityRole="button"
                accessibilityLabel={`Choose ${label}`}
                accessibilityLabelledBy={undefined}
                aria-labelledby={undefined}
                accessibilityValue={{ text: value ? formatDateOnlyForDisplay(value) : 'Not set' }}
                onPress={openPicker}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                style={({ pressed }) => [styles.field, pressed && styles.pressed, isFocused && styles.fieldFocused, errorText && styles.fieldError]}
            >
                <AppText
                    variant="body"
                    style={[styles.value, !value && styles.placeholder]}
                >
                    {value ? formatDateOnlyForDisplay(value) : placeholder}
                </AppText>
                <Ionicons name="calendar-outline" size={18} color={theme.colors.onSurfaceVariant} />
            </Pressable>
            )}
            </FormField>
            {pickerDate && (
                <View style={styles.pickerContainer}>
                    <DateTimePicker
                        value={pickerDate}
                        mode="date"
                        display={Platform.OS === 'android' ? 'calendar' : 'inline'}
                        minimumDate={minimumDate ? dateOnlyToLocalDate(minimumDate) : undefined}
                        maximumDate={maximumDate ? dateOnlyToLocalDate(maximumDate) : undefined}
                        onChange={handleDatePicked}
                    />
                    {Platform.OS === 'ios' && (
                        <View style={styles.pickerActions}>
                            <AppButton title="Cancel" variant="ghost" onPress={() => setPickerDate(null)} style={styles.pickerAction} />
                            <AppButton title="Done" onPress={confirmPicker} style={styles.pickerAction} />
                        </View>
                    )}
                </View>
            )}
        </View>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    group: {
        gap: spacing.sm
    },
    field: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        borderRadius: radius.md,
        borderWidth: theme.stroke.control,
        borderColor: theme.colors.outline,
        backgroundColor: theme.colors.surfaceContainerLow,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm
    },
    value: { flex: 1, ...theme.typography.styles.input },
    fieldFocused: { borderColor: theme.colors.focusRing, borderWidth: theme.interaction.focusRingWidth, backgroundColor: theme.colors.surface },
    fieldError: { borderColor: theme.colors.danger },
    placeholder: {
        color: theme.colors.onSurfaceVariant
    },
    pickerContainer: {
        alignItems: 'stretch'
    },
    pickerActions: {
        flexDirection: 'row',
        gap: spacing.sm
    },
    pickerAction: {
        flex: 1
    },
    pressed: {
        backgroundColor: theme.colors.surface
    }
});
