/** @file Numeric input with increment buttons for free-form amounts and fields that use a fixed set of values. */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { AppIconButton } from './AppIconButton';
import { AppText } from './AppText';
import { TextField } from './TextField';
import type { ExternalFieldError, FocusableFormControl } from './FormField';
import { spacing } from '../theme';
import { adjustDecimalInput, normalizeDecimalInput, parseDecimalInput } from '../utils/numericInput';

type NumberStepperFieldProps = {
    label: string;
    value: string;
    onChangeText: (value: string) => void;
    step?: number;
    min?: number;
    max?: number;
    stepValues?: readonly number[];
    suffix?: string;
    helperText?: string;
    externalError?: ExternalFieldError;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    placeholder?: string;
    editable?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
};

/**
 * Step by a delta by default. With ascending stepValues, each button selects the next listed value in its direction.
 */
export const NumberStepperField: React.FC<NumberStepperFieldProps> = ({
    label,
    value,
    onChangeText,
    step = 1,
    min,
    max,
    stepValues,
    suffix,
    helperText,
    externalError,
    controlRef,
    placeholder,
    editable = true,
    containerStyle
}) => {
    const parsedValue = parseDecimalInput(value);
    const previousStep = stepValues?.filter((option) => option < parsedValue).at(-1);
    const nextStep = stepValues?.find((option) => !Number.isFinite(parsedValue) || option > parsedValue);
    const decreaseDisabled = !editable || (stepValues ? previousStep === undefined :
        Number.isFinite(parsedValue) && typeof min === 'number' && parsedValue - step < min);
    const increaseDisabled = !editable || (stepValues ? nextStep === undefined :
        Number.isFinite(parsedValue) && typeof max === 'number' && parsedValue + step > max);

    function adjust(delta: number, listedValue: number | undefined) {
        if (stepValues) {
            if (listedValue !== undefined) onChangeText(String(listedValue));
            return;
        }
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
                    onPress={() => adjust(-step, previousStep)}
                />
                <TextField
                    label={label}
                    externalError={externalError}
                    controlRef={controlRef}
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
                    onPress={() => adjust(step, nextStep)}
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
