/** @file Text Field: Text input compatibility wrapper backed by the shared accessible field contract. */

import React, { useRef, useState } from 'react';
import { StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { FormField, type FocusableFormControl } from './FormField';

type TextFieldProps = TextInputProps & {
    label: string;
    helperText?: string;
    errorText?: string;
    required?: boolean;
    hideLabel?: boolean;
    focusError?: boolean;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    containerStyle?: StyleProp<ViewStyle>;
    trailingAccessory?: React.ReactNode;
};

/** Text input compatibility wrapper backed by the shared accessible field contract. */
export const TextField: React.FC<TextFieldProps> = ({
    label,
    helperText,
    errorText,
    required = false,
    hideLabel = false,
    focusError = false,
    controlRef,
    containerStyle,
    trailingAccessory,
    style,
    onBlur,
    onFocus,
    accessibilityLabel,
    placeholderTextColor,
    selectionColor,
    ...props
}) => {
    const [isFocused, setIsFocused] = useState(false);
    const internalRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);

    return (
        <FormField
            label={label}
            helperText={helperText}
            errorText={errorText}
            required={required}
            disabled={props.editable === false}
            hideLabel={hideLabel}
            focusError={focusError}
            controlRef={controlRef ?? internalRef}
            containerStyle={containerStyle}
        >
            {(controlProps) => {
                const input = <TextInput
                    {...controlProps}
                    {...props}
                    ref={(nextRef) => {
                        internalRef.current = nextRef;
                        if (controlRef) controlRef.current = nextRef;
                    }}
                    accessibilityLabel={accessibilityLabel ?? controlProps.accessibilityLabel}
                    accessibilityLabelledBy={accessibilityLabel ? undefined : controlProps.accessibilityLabelledBy}
                    aria-labelledby={accessibilityLabel ? undefined : controlProps['aria-labelledby']}
                    accessibilityHint={props.accessibilityHint ?? controlProps.accessibilityHint}
                    accessibilityState={{ ...controlProps.accessibilityState, ...props.accessibilityState }}
                    onBlur={(event) => {
                        setIsFocused(false);
                        onBlur?.(event);
                    }}
                    onFocus={(event) => {
                        setIsFocused(true);
                        onFocus?.(event);
                    }}
                    placeholderTextColor={placeholderTextColor ?? theme.colors.onSurfaceVariant}
                    selectionColor={selectionColor ?? theme.colors.primary}
                    style={[styles.input, Boolean(trailingAccessory) && styles.inputWithAccessory, isFocused && styles.inputFocused, errorText && styles.inputError, style]}
                />;
                if (!trailingAccessory) return input;
                return <View style={styles.inputRow}>{input}{trailingAccessory}</View>;
            }}
        </FormField>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        inputRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
        inputWithAccessory: { flex: 1, minWidth: 0 },
        input: {
            minHeight: theme.interaction.minimumTouchTarget,
            borderRadius: theme.radius.md,
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.outline,
            backgroundColor: theme.colors.surfaceContainerLow,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            color: theme.colors.onSurface,
            ...theme.typography.styles.input
        },
        inputFocused: {
            borderColor: theme.colors.focusRing,
            borderWidth: theme.interaction.focusRingWidth,
            backgroundColor: theme.colors.surface
        },
        inputError: {
            borderColor: theme.colors.danger
        }
    });
}
