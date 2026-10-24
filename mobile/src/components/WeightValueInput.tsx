/** @file Weight Value Input: Renders unit-aware weight entry and stepping controls that adapt to enlarged text. */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Platform,
    Pressable,
    StyleSheet,
    TextInput,
    useWindowDimensions,
    View,
    type NativeSyntheticEvent,
    type TextInputSubmitEditingEventData
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { WeightUnit } from '@calibrate/shared';
import { AppText } from './AppText';
import { useFocusVisible } from './useFocusVisible';
import { type AppTheme, useAppTheme } from '../theme';
import { formatWeightUnit } from '../utils/format';
import {
    formatWeightInput,
    getSpokenWeightUnit,
    normalizeWeightInputText,
    parseWeightInput
} from '../weightEntry/input';

type WeightValueInputProps = {
    label?: string;
    helperText?: string | null;
    value: string;
    unit: WeightUnit | undefined;
    step: number;
    min: number;
    max?: number;
    editable: boolean;
    inputRef?: React.RefObject<TextInput | null>;
    onChangeText: (value: string) => void;
    onStep?: () => void;
    onSubmitEditing?: (event: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => void;
};

const WEIGHT_VALUE_FONT_SIZE = 52; // Makes the single central measurement the visual anchor of the sheet.
const WEIGHT_VALUE_LINE_HEIGHT = 62;
const WEIGHT_VALUE_HEIGHT = 96;
const WEIGHT_VALUE_UNIT_GUTTER = 64; // Keeps centered text clear of the unit suffix on narrow screens.
const WEIGHT_STEPPER_SIZE = 56;
const WEIGHT_UNIT_STACK_FONT_SCALE = 1.3; // Moves the unit below enlarged input text instead of over the digits.
const DEFAULT_HELPER_TEXT = 'Use one decimal place for a precise, consistent trend.';

/** Renders unit-aware weight entry and stepping controls that adapt to enlarged text. */
export const WeightValueInput: React.FC<WeightValueInputProps> = ({
    label = 'Weight',
    helperText = DEFAULT_HELPER_TEXT,
    value,
    unit,
    step,
    min,
    max,
    editable,
    inputRef,
    onChangeText,
    onStep,
    onSubmitEditing
}) => {
    const theme = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const measurementInputRef = useRef<TextInput | null>(null);
    const [webFontScale, setWebFontScale] = useState(1);
    const effectiveFontScale = Math.max(fontScale, webFontScale);
    const stackUnit = effectiveFontScale >= WEIGHT_UNIT_STACK_FONT_SCALE;
    const valueHeight = Math.max(WEIGHT_VALUE_HEIGHT, Math.ceil(WEIGHT_VALUE_LINE_HEIGHT * effectiveFontScale) + theme.spacing.md);
    const setMeasurementInput = useCallback((node: TextInput | null) => {
        measurementInputRef.current = node;
        if (inputRef) inputRef.current = node;
    }, [inputRef]);
    const readRenderedFontScale = useCallback(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const inputElement = measurementInputRef.current as unknown as HTMLElement | null;
        if (inputElement?.nodeType !== 1) return;
        // Browser text enlargement changes computed size without updating native fontScale.
        const renderedFontSize = Number.parseFloat(window.getComputedStyle(inputElement).fontSize);
        if (Number.isFinite(renderedFontSize) && renderedFontSize > 0) {
            setWebFontScale(renderedFontSize / WEIGHT_VALUE_FONT_SIZE);
        }
    }, []);
    useLayoutEffect(readRenderedFontScale, [readRenderedFontScale]);
    const decreaseFocus = useFocusVisible();
    const increaseFocus = useFocusVisible();
    const spokenUnit = getSpokenWeightUnit(unit);
    const measurementLabel = label.toLowerCase();
    const parsedValue = parseWeightInput(value);

    function adjust(delta: number) {
        const baseline = parsedValue ?? 0;
        const nextValue = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, baseline + delta));
        onChangeText(formatWeightInput(nextValue));
        onStep?.();
    }

    const accessibleValue = parsedValue === null
        ? `No weight entered, ${spokenUnit}`
        : `${formatWeightInput(parsedValue)} ${spokenUnit}`;

    return (
        <View style={styles.root}>
            <AppText variant="label">{label}</AppText>
            <View testID="weight-value-surface" style={styles.valueSurface}>
                <TextInput
                    ref={setMeasurementInput}
                    onLayout={readRenderedFontScale}
                    accessibilityLabel={`${label} in ${spokenUnit}`}
                    accessibilityHint="Enter a weight using one decimal place."
                    autoCorrect={false}
                    editable={editable}
                    inputMode="decimal"
                    keyboardType="decimal-pad"
                    onChangeText={(nextValue) => onChangeText(normalizeWeightInputText(nextValue))}
                    onSubmitEditing={onSubmitEditing}
                    placeholder="0.0"
                    placeholderTextColor={theme.colors.outline}
                    returnKeyType="done"
                    selectTextOnFocus
                    selectionColor={theme.colors.primary}
                    style={[
                        styles.input,
                        { minHeight: valueHeight },
                        stackUnit && styles.inputWithStackedUnit,
                        Platform.OS === 'web' && stackUnit && styles.inputWithExpandedWebText
                    ]}
                    value={value}
                />
                <View testID="weight-unit-slot" pointerEvents="none" style={[styles.unitSlot, stackUnit && styles.unitSlotStacked]}>
                    <AppText accessible={false} style={styles.unit}>{formatWeightUnit(unit)}</AppText>
                </View>
            </View>
            <View style={styles.stepperRow}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Decrease ${measurementLabel} by ${step} ${getSpokenWeightUnit(unit, step !== 1)}`}
                    accessibilityValue={{ text: accessibleValue }}
                    disabled={!editable}
                    onFocus={decreaseFocus.handleFocus}
                    onBlur={decreaseFocus.handleBlur}
                    onPress={() => adjust(-step)}
                    style={({ pressed }) => [
                        styles.stepperButton,
                        decreaseFocus.focusVisible && styles.focusVisible,
                        !editable && styles.disabled,
                        pressed && editable && styles.pressed
                    ]}
                >
                    <Ionicons name="remove" size={24} color={theme.colors.onSurface} />
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Increase ${measurementLabel} by ${step} ${getSpokenWeightUnit(unit, step !== 1)}`}
                    accessibilityValue={{ text: accessibleValue }}
                    disabled={!editable}
                    onFocus={increaseFocus.handleFocus}
                    onBlur={increaseFocus.handleBlur}
                    onPress={() => adjust(step)}
                    style={({ pressed }) => [
                        styles.stepperButton,
                        increaseFocus.focusVisible && styles.focusVisible,
                        !editable && styles.disabled,
                        pressed && editable && styles.pressed
                    ]}
                >
                    <Ionicons name="add" size={24} color={theme.colors.onSurface} />
                </Pressable>
            </View>
            {helperText ? <AppText variant="caption">{helperText}</AppText> : null}
        </View>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    root: {
        gap: theme.spacing.sm
    },
    valueSurface: {
        minHeight: WEIGHT_VALUE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.lg,
        borderColor: theme.colors.outline,
        borderWidth: theme.stroke.control,
        backgroundColor: theme.colors.surface
    },
    input: {
        width: '100%',
        color: theme.colors.onSurface,
        fontSize: WEIGHT_VALUE_FONT_SIZE,
        lineHeight: WEIGHT_VALUE_LINE_HEIGHT,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
        letterSpacing: -0.6,
        paddingHorizontal: WEIGHT_VALUE_UNIT_GUTTER,
        paddingVertical: 0,
        textAlign: 'center',
        textAlignVertical: 'center'
    },
    inputWithStackedUnit: {
        paddingHorizontal: theme.spacing.lg
    },
    inputWithExpandedWebText: {
        paddingHorizontal: theme.spacing.sm
    },
    unitSlot: {
        position: 'absolute',
        top: 0,
        right: theme.spacing.lg,
        bottom: 0,
        justifyContent: 'center'
    },
    unitSlotStacked: {
        position: 'relative',
        right: 0,
        paddingBottom: theme.spacing.md
    },
    unit: {
        color: theme.colors.onSurfaceVariant,
        ...theme.typography.styles.section
    },
    stepperRow: {
        flexDirection: 'row',
        gap: theme.spacing.sm
    },
    stepperButton: {
        minHeight: WEIGHT_STEPPER_SIZE,
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.md,
        borderColor: theme.colors.outlineVariant,
        borderWidth: theme.stroke.control,
        backgroundColor: theme.colors.surfaceContainer
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
        transform: [{ translateY: 1 }]
    },
    focusVisible: {
        outlineWidth: theme.interaction.focusRingWidth,
        outlineStyle: 'solid',
        outlineColor: theme.colors.focusRing
    },
    disabled: {
        opacity: 0.5
    }
});
