/** @file App Choice Group: Descriptive, exclusive choices with one tab stop and native radio announcements. */

import React, { useId, useImperativeHandle, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, StyleSheet, View } from 'react-native';
import { AppText } from './AppText';
import { FormField, type FocusableFormControl } from './FormField';
import { useFocusVisible } from './useFocusVisible';
import { type AppTheme, useAppTheme } from '../theme';

export type AppChoiceOption<T extends string> = {
    value: T;
    label: string;
    description: string;
    disabled?: boolean;
    disabledReason?: string;
};

export type AppChoiceGroupProps<T extends string> = {
    label: string;
    options: ReadonlyArray<AppChoiceOption<T>>;
    value: T | null;
    onChange: (value: T) => void;
    errorText?: string;
    focusError?: boolean;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    testID?: string;
};

type KeyboardLikeEvent = {
    key?: string;
    nativeEvent?: { key?: string };
    preventDefault?: () => void;
};

// A compact radio marker leaves room for explanatory text at large font sizes.
const CHOICE_MARKER_SIZE = 20;
const CHOICE_MARKER_DOT_SIZE = 10;

function ChoiceOption<T extends string>({
    option, selected, tabIndex, setRef, onPress, onKeyDown
}: {
    option: AppChoiceOption<T>;
    selected: boolean;
    tabIndex: 0 | -1;
    setRef: (value: FocusableFormControl | null) => void;
    onPress: () => void;
    onKeyDown: (event: KeyboardLikeEvent) => void;
}) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const descriptionId = 'choice-description-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const description = [option.description, option.disabledReason].filter(Boolean).join(' ');

    return (
        <Pressable
            ref={setRef as never}
            accessibilityRole="radio"
            role="radio"
            accessibilityLabel={option.label}
            accessibilityHint={description}
            accessibilityState={{ checked: selected, disabled: Boolean(option.disabled) }}
            aria-checked={selected}
            aria-describedby={descriptionId}
            disabled={option.disabled}
            tabIndex={tabIndex}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onPress={onPress}
            {...({ onKeyDown } as object)}
            style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && !option.disabled && styles.optionPressed,
                focusVisible && styles.optionFocused
            ]}
        >
            <View accessible={false} style={[styles.marker, selected && styles.markerSelected]}>
                {selected && <View style={styles.markerDot} />}
            </View>
            <View style={styles.copy}>
                <AppText variant="label" style={option.disabled && styles.disabledLabel}>{option.label}</AppText>
                <View nativeID={descriptionId} style={styles.description}>
                    <AppText variant="caption">{option.description}</AppText>
                    {option.disabledReason && <AppText variant="caption" style={styles.disabledReason}>{option.disabledReason}</AppText>}
                </View>
            </View>
        </Pressable>
    );
}

/** Descriptive, exclusive choices with one tab stop and native radio announcements. */
export function AppChoiceGroup<T extends string>({
    label, options, value, onChange, errorText, focusError, controlRef, testID
}: AppChoiceGroupProps<T>) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const optionRefs = useRef<Array<FocusableFormControl | null>>([]);
    const internalControlRef = useRef<FocusableFormControl | null>(null);
    const enabledIndexes = options.flatMap((option, index) => option.disabled ? [] : [index]);
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    const tabStopIndex = selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? -1);
    const fieldControlRef = controlRef ?? internalControlRef;

    useImperativeHandle(fieldControlRef, () => ({
        focus: () => focusOption(tabStopIndex)
    }), [tabStopIndex]);

    function focusOption(index: number) {
        const element = optionRefs.current[index];
        element?.focus();
        if (Platform.OS === 'web' || !element) return;
        const handle = findNodeHandle(element as View);
        if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }

    function handleKeyDown(event: KeyboardLikeEvent, index: number) {
        if (enabledIndexes.length === 0) return;
        const key = event.key ?? event.nativeEvent?.key ?? '';
        const enabledIndex = enabledIndexes.indexOf(index);
        let nextIndex: number | undefined;
        if (key === 'Home') nextIndex = enabledIndexes[0];
        if (key === 'End') nextIndex = enabledIndexes[enabledIndexes.length - 1];
        if (key === 'ArrowDown' || key === 'ArrowRight') {
            nextIndex = enabledIndexes[(enabledIndex + 1) % enabledIndexes.length];
        }
        if (key === 'ArrowUp' || key === 'ArrowLeft') {
            nextIndex = enabledIndexes[(enabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
        }
        if (nextIndex === undefined) return;
        event.preventDefault?.();
        onChange(options[nextIndex].value);
        focusOption(nextIndex);
    }

    return (
        <FormField label={label} errorText={errorText} focusError={focusError} controlRef={fieldControlRef} testID={testID}>
            {(controlProps) => (
                <View
                    {...controlProps}
                    accessibilityRole="radiogroup"
                    role="radiogroup"
                    aria-orientation="vertical"
                    style={styles.group}
                >
                    {options.map((option, index) => (
                        <ChoiceOption
                            key={option.value}
                            option={option}
                            selected={option.value === value}
                            tabIndex={index === tabStopIndex ? 0 : -1}
                            setRef={(nextRef) => { optionRefs.current[index] = nextRef; }}
                            onPress={() => onChange(option.value)}
                            onKeyDown={(event) => handleKeyDown(event, index)}
                        />
                    ))}
                </View>
            )}
        </FormField>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        group: { gap: theme.spacing.sm },
        option: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
            padding: theme.spacing.md,
            borderRadius: theme.radius.md,
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.outlineVariant,
            backgroundColor: theme.colors.surfaceContainerLow
        },
        optionSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.selectionContainer },
        optionPressed: { backgroundColor: theme.colors.surfacePressed },
        optionFocused: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        marker: {
            width: CHOICE_MARKER_SIZE,
            height: CHOICE_MARKER_SIZE,
            borderRadius: theme.radius.pill,
            borderWidth: theme.stroke.control,
            borderColor: theme.colors.outline,
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: theme.spacing.xs
        },
        markerSelected: { borderColor: theme.colors.primary },
        markerDot: {
            width: CHOICE_MARKER_DOT_SIZE,
            height: CHOICE_MARKER_DOT_SIZE,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.primary
        },
        copy: { flex: 1, minWidth: 0, gap: theme.spacing.xs },
        description: { gap: theme.spacing.xs },
        disabledLabel: { color: theme.colors.onSurfaceVariant },
        disabledReason: { color: theme.colors.onSurfaceVariant, fontWeight: '600' }
    });
}
