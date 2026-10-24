/** @file Date Navigation: In-content local-day navigation for log-focused screens. */

import React, { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusVisible } from './useFocusVisible';
import { AppText } from './AppText';
import type { DateNavigationProps } from './DateNavigation.types';
import { HistoricalDatePicker } from '../food/HistoricalDatePicker';
import {
    DateNavigationIconButton,
    useDateNavigationPresentation
} from './DateNavigation.shared';

/**
 * In-content local-day navigation for log-focused screens.
 *
 * The date pill opens the native calendar, so the row stays compact on phones
 * and avoids the separate calendar button that made the Log tab feel crowded.
 */
export const DateNavigation: React.FC<DateNavigationProps> = ({
    navigation,
    compact = false,
    unified = false,
    pickerFooter,
    style,
    ...props
}) => {
    const [pickerOpen, setPickerOpen] = useState(false);
    const { theme, styles } = useDateNavigationPresentation();
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const { fontScale } = useWindowDimensions();
    const hideCalendarIcon = compact && fontScale >= 1.6;

    function openPicker() {
        setPickerOpen(true);
    }

    return (
        <View {...props} style={[styles.container, style]}>
            <View accessibilityRole="toolbar" accessibilityLabel="Food log date" style={[styles.root, compact && styles.rootCompact, unified && styles.rootUnified]}>
                <DateNavigationIconButton
                    label="Previous day"
                    unified={unified}
                    icon="chevron-back"
                    disabled={!navigation.canGoBack}
                    onPress={navigation.goToPreviousDate}
                />
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Choose date"
                    onFocus={handleFocus}
                    onBlur={handleBlur}
                    onPress={openPicker}
                    style={({ pressed }) => [
                        styles.datePill,
                        unified && styles.unifiedControl,
                        focusVisible && styles.focusVisible,
                        compact && styles.datePillCompact,
                        pressed && styles.pressed
                    ]}
                >
                    <AppText variant="subtitle" style={styles.dateText}>
                        {navigation.isToday ? 'Today' : navigation.selectedDateLabel}
                    </AppText>
                    {!hideCalendarIcon && (
                        <Ionicons name="calendar-outline" size={20} color={theme.colors.primary} />
                    )}
                </Pressable>
                <DateNavigationIconButton
                    label="Next day"
                    unified={unified}
                    icon="chevron-forward"
                    disabled={!navigation.canGoForward}
                    onPress={navigation.goToNextDate}
                />
            </View>

            <HistoricalDatePicker
                visible={pickerOpen}
                selectedDate={navigation.selectedDate}
                minDate={navigation.minDate}
                maxDate={navigation.maxDate}
                onSelectDate={navigation.setDate}
                onRequestClose={() => setPickerOpen(false)}
                footer={pickerFooter?.(() => setPickerOpen(false))}
            />
        </View>
    );
};
