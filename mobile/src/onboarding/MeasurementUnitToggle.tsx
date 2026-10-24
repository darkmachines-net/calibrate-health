/** @file Measurement Unit Toggle: Renders a unit-switch action and optionally restores keyboard focus after height fields change. */

import { useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppButton } from '../components/AppButton';
import { spacing, useAppTheme } from '../theme';

// A small swap icon signals that the unit can change without competing with the input.
const UNIT_SWITCH_ICON_SIZE = 16;

type MeasurementUnitToggleProps = {
    measurement: 'Weight' | 'Height';
    unit: string;
    nextUnit: string;
    onPress: () => void;
    disabled?: boolean;
    focusOnMount?: boolean;
};

/** Renders a unit-switch action and optionally restores keyboard focus after height fields change. */
export function MeasurementUnitToggle({ measurement, unit, nextUnit, onPress, disabled, focusOnMount = false }: MeasurementUnitToggleProps) {
    const { colors } = useAppTheme();
    const buttonRef = useRef<React.ComponentRef<typeof View>>(null);
    useEffect(() => {
        if (!focusOnMount) return;
        // Height switches replace one field with two; retain focus on their unit control.
        const frame = requestAnimationFrame(() => {
            buttonRef.current?.focus();
            if (Platform.OS === 'web') return;
            const handle = findNodeHandle(buttonRef.current);
            if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
        });
        return () => cancelAnimationFrame(frame);
    }, [focusOnMount]);
    return <AppButton buttonRef={buttonRef} title={unit} variant="ghost" onPress={onPress} disabled={disabled}
        accessibilityLabel={`${measurement} unit: ${unit}. Switch to ${nextUnit}`}
        rightIcon={<Ionicons name="swap-horizontal" size={UNIT_SWITCH_ICON_SIZE} color={colors.onSurfaceVariant} accessible={false} />}
        style={styles.toggle} textStyle={{ color: colors.onSurfaceVariant }} />;
}

const styles = StyleSheet.create({
    toggle: { paddingHorizontal: spacing.sm, flexShrink: 0 }
});
