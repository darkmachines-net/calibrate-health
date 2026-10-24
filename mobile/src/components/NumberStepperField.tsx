/** @file Number Stepper Field: Numeric input with native-sized increment buttons for weights, calories, servings, and recipe yields. */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppIconButton } from './AppIconButton';
import { AppText } from './AppText';
import { TextField } from './TextField';
import { spacing } from '../theme';
import { adjustDecimalInput, normalizeDecimalInput, parseDecimalInput } from '../utils/numericInput';

type NumberStepperFieldProps = {
    label: string;
    value: string;
    onChangeText: (value: string) => void;
    step?: number;
    min?: number;
    max?: number;
    suffix?: string;
    helperText?: string;
    placeholder?: string;
    editable?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
};

/**
 * Numeric input with native-sized increment buttons for weights, calories, servings, and recipe yields.
 */
export const NumberStepperField: React.FC<NumberStepperFieldProps> = ({
    label,
    value,
    onChangeText,
    step = 1,
    min,
    max,
    suffix,
    helperText,
    placeholder,
    editable = true,
    containerStyle
}) => {
    const parsedValue = parseDecimalInput(value);
    const decreaseDisabled = !editable
        || (Number.isFinite(parsedValue) && typeof min === 'number' && parsedValue - step < min);
    const increaseDisabled = !editable
        || (Number.isFinite(parsedValue) && typeof max === 'number' && parsedValue + step > max);

    function adjust(delta: number) {
        onChangeText(adjustDecimalInput({ value, delta, min, max }));
    }

    return (
        <View style={[styles.root, containerStyle]}>
            <View style={styles.labelRow}>
                <AppText variant="label">{label}</AppText>
                {suffix && <AppText variant="caption">{suffix}</AppText>}
            </View>
            <View style={styles.inputRow}>
                <AppIconButton
                    icon="remove"
                    accessibilityLabel={`Decrease ${label} by ${step}`}
                    disabled={decreaseDisabled}
                    onPress={() => adjust(-step)}
                />
                <TextField
                    label={label}
                    hideLabel
                    value={value}
                    onChangeText={(nextValue) => onChangeText(normalizeDecimalInput(nextValue))}
                    placeholder={placeholder}
                    keyboardType="decimal-pad"
                    returnKeyType={'done'}
                    selectTextOnFocus
                    containerStyle={styles.field}
                    style={styles.input}
                    accessibilityLabel={label}
                    editable={editable}
                />
                <AppIconButton
                    icon="add"
                    accessibilityLabel={`Increase ${label} by ${step}`}
                    disabled={increaseDisabled}
                    onPress={() => adjust(step)}
                />
            </View>
            {helperText && <AppText variant="caption">{helperText}</AppText>}
        </View>
    );
};

const styles = StyleSheet.create({
    root: {
        gap: spacing.sm
    },
    labelRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: spacing.md,
        rowGap: spacing.xs
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.sm
    },
    field: {
        flex: 1
    },
    input: {
        textAlign: 'center'
    },
});
