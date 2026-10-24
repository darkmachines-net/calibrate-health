import React from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, StyleSheet, useWindowDimensions, View, type ViewProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from './AppText';
import type { FocusableFormControl } from './FormField';
import { useFocusVisible } from './useFocusVisible';
import { type AppTheme, useAppTheme } from '../theme';

type SegmentedOption<T extends string> = {
    value: T;
    label: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
};

type SegmentedControlProps<T extends string> = Omit<ViewProps, 'accessibilityLabel'> & {
    accessibilityLabel: string;
    options: ReadonlyArray<SegmentedOption<T>>;
    value: T | null;
    disabled?: boolean;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    onChange: (value: T) => void;
};

type KeyboardLikeEvent = {
    key?: string;
    nativeEvent?: { key?: string };
    preventDefault?: () => void;
};

type FocusableOption = {
    focus?: () => void;
};

function getKey(event: KeyboardLikeEvent) {
    return event.key ?? event.nativeEvent?.key ?? '';
}

function SegmentedOptionButton<T extends string>({
    option,
    selected,
    disabled,
    stacked,
    tabIndex,
    onPress,
    onKeyDown,
    setRef
}: {
    option: SegmentedOption<T>;
    selected: boolean;
    disabled: boolean;
    stacked: boolean;
    tabIndex: 0 | -1;
    onPress: () => void;
    onKeyDown: (event: KeyboardLikeEvent) => void;
    setRef: (value: FocusableOption | null) => void;
}) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();

    return (
        <Pressable
            ref={setRef as never}
            aria-checked={selected}
            accessibilityLabel={option.label}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onBlur={handleBlur}
            onFocus={handleFocus}
            onPress={onPress}
            role="radio"
            tabIndex={tabIndex}
            {...({ onKeyDown } as object)}
            style={({ pressed }) => [
                styles.segment,
                option.icon && styles.segmentWithIcon,
                stacked && styles.segmentStacked,
                selected && styles.segmentSelected,
                pressed && !selected && styles.segmentPressed,
                focusVisible && styles.segmentFocused
            ]}
        >
            {option.icon && <Ionicons name={option.icon} size={theme.typography.styles.label.lineHeight}
                color={selected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
                accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden />}
            <AppText
                style={selected ? styles.labelSelected : styles.label}
            >
                {option.label}
            </AppText>
        </Pressable>
    );
}

/**
 * Named exclusive selector with native touch behavior and web roving focus.
 */
export function SegmentedControl<T extends string>({
    accessibilityLabel,
    options,
    value,
    disabled = false,
    onChange,
    controlRef,
    style,
    ...props
}: SegmentedControlProps<T>) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const { width, fontScale } = useWindowDimensions();
    const optionRefs = React.useRef<Array<FocusableOption | null>>([]);
    const compactMultipleChoices = options.length >= 3 && width < 360;
    const enlargedLabels = fontScale >= 1.5 && (options.length >= 3 || options.some((option) => option.icon));
    const stacked = compactMultipleChoices || enlargedLabels;
    const selectedIndex = options.findIndex((option) => option.value === value);
    const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const focusOption = React.useCallback((index: number) => {
        if (disabled) return;
        const element = optionRefs.current[index];
        element?.focus?.();
        if (Platform.OS === 'web' || !element) return;
        const handle = findNodeHandle(element as View);
        if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }, [disabled]);

    React.useEffect(() => {
        if (!controlRef) return;
        controlRef.current = { focus: () => focusOption(tabStopIndex) };
        return () => { controlRef.current = null; };
    }, [controlRef, focusOption, tabStopIndex]);

    function selectAndFocus(index: number) {
        const option = options[index];
        if (!option) return;
        onChange(option.value);
        focusOption(index);
    }

    function handleKeyDown(event: KeyboardLikeEvent, index: number) {
        if (disabled || options.length === 0) return;
        const key = getKey(event);
        let nextIndex: number | undefined;
        if (key === 'Home') nextIndex = 0;
        if (key === 'End') nextIndex = options.length - 1;
        if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = (index + 1) % options.length;
        if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
        if (nextIndex === undefined) return;
        event.preventDefault?.();
        selectAndFocus(nextIndex);
    }

    return (
        <View
            {...props}
            accessibilityLabel={accessibilityLabel}
            accessibilityRole="radiogroup"
            accessibilityState={{ ...props.accessibilityState, disabled }}
            aria-disabled={disabled}
            aria-label={accessibilityLabel}
            aria-orientation={stacked ? 'vertical' : 'horizontal'}
            role="radiogroup"
            style={[styles.root, stacked && styles.rootStacked, style]}
        >
            {options.map((option, index) => (
                <SegmentedOptionButton
                    key={option.value}
                    option={option}
                    selected={option.value === value}
                    disabled={disabled}
                    stacked={stacked}
                    tabIndex={!disabled && index === tabStopIndex ? 0 : -1}
                    onPress={() => onChange(option.value)}
                    onKeyDown={(event) => handleKeyDown(event, index)}
                    setRef={(nextRef) => { optionRefs.current[index] = nextRef; }}
                />
            ))}
        </View>
    );
}

function createStyles(theme: AppTheme) {
    const labelBase = {
        ...theme.typography.styles.label,
        textAlign: 'center',
        flexShrink: 1
    } as const;

    return StyleSheet.create({
        root: {
            flexDirection: 'row',
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceContainer,
            borderColor: theme.colors.outlineVariant,
            borderWidth: theme.stroke.control,
            padding: theme.spacing.xs,
            gap: theme.spacing.xs
        },
        rootStacked: {
            flexDirection: 'column'
        },
        segment: {
            flex: 1,
            minHeight: theme.interaction.minimumTouchTarget,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.surfaceContainer,
            borderColor: 'transparent',
            borderWidth: theme.stroke.control,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.xs
        },
        segmentWithIcon: {
            flexDirection: 'row',
            gap: theme.spacing.sm
        },
        segmentStacked: {
            flex: 0,
            width: '100%'
        },
        segmentSelected: {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.outlineVariant,
            borderWidth: theme.stroke.control
        },
        segmentPressed: {
            backgroundColor: theme.colors.surfacePressed
        },
        segmentFocused: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        label: {
            ...labelBase,
            color: theme.colors.onSurfaceVariant
        },
        labelSelected: {
            ...labelBase,
            color: theme.colors.onPrimaryContainer
        }
    });
}
