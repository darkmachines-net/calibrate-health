/** @file Form Field: Gives every form control one label, description, and error relationship on web while preserving useful VoiceOver and TalkBack announcements. */

import React, { useEffect, useId, useMemo, useRef } from 'react';
import {
    AccessibilityInfo,
    StyleSheet,
    View,
    type AccessibilityState,
    type StyleProp,
    type ViewStyle
} from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from './AppText';

export type FocusableFormControl = {
    focus: () => void;
};

type FormControlAccessibilityProps = {
    nativeID: string;
    accessibilityLabel: string;
    accessibilityHint?: string;
    accessibilityState: AccessibilityState;
    accessibilityLabelledBy?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    'aria-invalid': boolean;
    'aria-required': boolean;
};

export type FormFieldProps = {
    label: string;
    children: (controlProps: FormControlAccessibilityProps) => React.ReactNode;
    helperText?: string;
    errorText?: string;
    required?: boolean;
    disabled?: boolean;
    hideLabel?: boolean;
    focusError?: boolean;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    containerStyle?: StyleProp<ViewStyle>;
    testID?: string;
};

function toNativeId(value: string) {
    return `form-field-${value.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * Gives every form control one label, description, and error relationship on
 * web while preserving useful VoiceOver and TalkBack announcements.
 */
export function FormField({
    label,
    children,
    helperText,
    errorText,
    required = false,
    disabled = false,
    hideLabel = false,
    focusError = false,
    controlRef,
    containerStyle,
    testID
}: FormFieldProps) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const reactId = useId();
    const baseId = toNativeId(reactId);
    const labelId = `${baseId}-label`;
    const controlId = `${baseId}-control`;
    const helperId = helperText ? `${baseId}-helper` : undefined;
    const errorId = errorText ? `${baseId}-error` : undefined;
    const describedBy = [errorId, helperId].filter(Boolean).join(' ') || undefined;
    const lastAnnouncedError = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (!errorText) {
            lastAnnouncedError.current = undefined;
            return;
        }
        if (!focusError || lastAnnouncedError.current === errorText) return;
        lastAnnouncedError.current = errorText;
        controlRef?.current?.focus();
        AccessibilityInfo.announceForAccessibility(errorText);
    }, [controlRef, errorText, focusError]);

    const accessibilityHint = [errorText, helperText].filter(Boolean).join(' ') || undefined;
    const controlProps: FormControlAccessibilityProps = {
        nativeID: controlId,
        accessibilityLabel: label,
        accessibilityHint,
        accessibilityState: { disabled },
        accessibilityLabelledBy: hideLabel ? undefined : labelId,
        'aria-labelledby': hideLabel ? undefined : labelId,
        'aria-describedby': describedBy,
        'aria-invalid': Boolean(errorText),
        'aria-required': required
    };

    return (
        <View style={[styles.root, containerStyle]} testID={testID}>
            {!hideLabel && (
                <AppText nativeID={labelId} variant="label">
                    {label}{required ? ' (required)' : ''}
                </AppText>
            )}
            {children(controlProps)}
            {errorText && (
                <AppText
                    nativeID={errorId}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    style={styles.error}
                    variant="caption"
                >
                    {errorText}
                </AppText>
            )}
            {helperText && (
                <AppText nativeID={helperId} style={styles.helper} variant="caption">
                    {helperText}
                </AppText>
            )}
        </View>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        root: {
            gap: theme.spacing.sm
        },
        helper: {
            color: theme.colors.onSurfaceVariant
        },
        error: {
            color: theme.colors.danger
        }
    });
}
