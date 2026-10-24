/** @file Accessible selectable combobox and listbox primitives with shared option and keyboard behavior. */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {

    Pressable,
    ScrollView,
    StyleSheet,
    TextInput,
    View,
    type StyleProp,
    type ViewStyle
} from 'react-native';
import { type AppTheme, useAppTheme } from '../theme';
import { AppText } from './AppText';
import { BottomSheetModal } from './BottomSheetModal';
import { FormField, type FocusableFormControl } from './FormField';
import { useFocusVisible } from './useFocusVisible';

export type ComboboxOption<T extends string> = {
    value: T;
    label: string;
    description?: string;
    disabled?: boolean;
    disabledReason?: string;
};

export type ListboxProps<T extends string> = {
    label: string;
    options: ReadonlyArray<ComboboxOption<T>>;
    value?: T;
    activeValue?: T;
    onActiveChange?: (value: T) => void;
    onSelect: (value: T) => void;
    onDismiss: () => void;
    initialTypeahead?: string;
    focusInitialOption?: boolean;
    testID?: string;
};

export type ComboboxProps<T extends string> = {
    label: string;
    options: ReadonlyArray<ComboboxOption<T>>;
    value?: T;
    onChange: (value: T) => void;
    placeholder?: string;
    helperText?: string;
    errorText?: string;
    required?: boolean;
    hideLabel?: boolean;
    closeOnSelect?: boolean;
    disabled?: boolean;
    focusError?: boolean;
    searchable?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    containerStyle?: StyleProp<ViewStyle>;
    testID?: string;
};

type KeyboardLikeEvent = {
    key?: string;
    nativeEvent?: { key?: string };
    preventDefault?: () => void;
};

type FocusableOption = {
    focus?: () => void;
};

const TYPEAHEAD_RESET_MS = 650;

function getKey(event: KeyboardLikeEvent) {
    return event.key ?? event.nativeEvent?.key ?? '';
}

function findTypeaheadIndex<T extends string>(
    options: ReadonlyArray<ComboboxOption<T>>,
    search: string,
    startIndex: number
) {
    const normalized = search.toLocaleLowerCase();
    for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (startIndex + offset) % options.length;
        const option = options[index];
        if (!option.disabled && option.label.toLocaleLowerCase().startsWith(normalized)) return index;
    }
    return -1;
}

/** Standalone listbox used by Combobox and custom selection triggers. */
export function Listbox<T extends string>({
    label,
    options,
    value,
    activeValue,
    onActiveChange,
    onSelect,
    onDismiss,
    initialTypeahead = '',
    focusInitialOption = true,
    testID = 'listbox'
}: ListboxProps<T>) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const optionRefs = useRef<Array<FocusableOption | null>>([]);
    const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const typeahead = useRef(initialTypeahead.toLocaleLowerCase());
    const enabledIndexes = useMemo(
        () => options
            .map((option, index) => (!option.disabled ? index : -1))
            .filter((index) => index >= 0),
        [options]
    );
    const requestedActiveIndex = options.findIndex((option) => option.value === activeValue);
    const selectedIndex = options.findIndex((option) => option.value === value);
    let initialIndex = requestedActiveIndex;
    if (!enabledIndexes.includes(initialIndex)) initialIndex = selectedIndex;
    if (!enabledIndexes.includes(initialIndex)) initialIndex = enabledIndexes[0] ?? -1;
    if (initialTypeahead) {
        const typeaheadIndex = findTypeaheadIndex(options, initialTypeahead, initialIndex - 1);
        if (typeaheadIndex >= 0) initialIndex = typeaheadIndex;
    }
    const [activeIndex, setActiveIndex] = useState(initialIndex);

    useEffect(() => {
        if (!focusInitialOption) return undefined;
        const focusTimer = setTimeout(() => optionRefs.current[initialIndex]?.focus?.(), 0);
        return () => clearTimeout(focusTimer);
    }, [focusInitialOption, initialIndex]);

    useEffect(() => {
        if (enabledIndexes.includes(activeIndex) || activeIndex === initialIndex) return;
        setActiveIndex(initialIndex);
        const nextActiveOption = options[initialIndex];
        if (nextActiveOption && !nextActiveOption.disabled) {
            onActiveChange?.(nextActiveOption.value);
        }
    }, [activeIndex, enabledIndexes, initialIndex, onActiveChange, options]);

    useEffect(() => () => {
        if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
    }, []);

    function activate(index: number) {
        const option = options[index];
        if (!option || option.disabled) return;
        setActiveIndex(index);
        onActiveChange?.(option.value);
        optionRefs.current[index]?.focus?.();
    }

    function handleKeyDown(event: KeyboardLikeEvent, index: number) {
        if (enabledIndexes.length === 0) return;
        const key = getKey(event);
        const currentPosition = Math.max(0, enabledIndexes.indexOf(index));
        let nextIndex: number | undefined;
        if (key === 'Home') nextIndex = enabledIndexes[0];
        if (key === 'End') nextIndex = enabledIndexes[enabledIndexes.length - 1];
        if (key === 'ArrowDown' || key === 'ArrowRight') {
            nextIndex = enabledIndexes[(currentPosition + 1) % enabledIndexes.length];
        }
        if (key === 'ArrowUp' || key === 'ArrowLeft') {
            nextIndex = enabledIndexes[(currentPosition - 1 + enabledIndexes.length) % enabledIndexes.length];
        }
        if (nextIndex !== undefined) {
            event.preventDefault?.();
            activate(nextIndex);
            return;
        }
        if (key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            const option = options[index];
            if (option && !option.disabled) onSelect(option.value);
            return;
        }
        if (key === 'Escape') {
            event.preventDefault?.();
            onDismiss();
            return;
        }
        if (key.length !== 1 || event.key === undefined && event.nativeEvent?.key === undefined) return;
        typeahead.current += key.toLocaleLowerCase();
        if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
        typeaheadTimer.current = setTimeout(() => { typeahead.current = ''; }, TYPEAHEAD_RESET_MS);
        const matchIndex = findTypeaheadIndex(options, typeahead.current, index);
        if (matchIndex >= 0) {
            event.preventDefault?.();
            activate(matchIndex);
        }
    }

    return (
        <ScrollView
            nativeID={testID}
            accessibilityLabel={label}
            accessibilityRole="menu"
            role={'listbox' as never}
            keyboardShouldPersistTaps="handled"
            style={styles.listbox}
            testID={testID}
        >
            {options.map((option, index) => {
                const selected = option.value === value;
                const active = index === activeIndex;
                const inactive = option.disabled === true;
                return (
                    <Pressable
                        key={option.value}
                        ref={(nextRef) => { optionRefs.current[index] = nextRef as FocusableOption | null; }}
                        accessibilityRole="menuitem"
                        role="option"
                        accessibilityLabel={option.label}
                        accessibilityHint={option.disabledReason ?? option.description}
                        accessibilityState={{ selected, disabled: inactive }}
                        disabled={inactive}
                        onFocus={() => {
                            setActiveIndex(index);
                            onActiveChange?.(option.value);
                        }}
                        onPress={() => onSelect(option.value)}
                        tabIndex={active ? 0 : -1}
                        {...({ onKeyDown: (event: KeyboardLikeEvent) => handleKeyDown(event, index) } as object)}
                        style={({ pressed }) => [
                            styles.option,
                            selected && styles.optionSelected,
                            active && styles.optionActive,
                            pressed && !inactive && styles.optionPressed
                        ]}
                    >
                        <View style={styles.optionCopy}>
                            <AppText style={[styles.optionTitle, selected && styles.optionTitleSelected, inactive && styles.optionTitleDisabled]}>
                                {option.label}
                            </AppText>
                            {option.description && (
                                <AppText variant="caption" style={selected && styles.optionDescriptionSelected}>
                                    {option.description}
                                </AppText>
                            )}
                            {option.disabledReason && (
                                <AppText variant="caption" style={styles.optionDisabledReason}>
                                    {option.disabledReason}
                                </AppText>
                            )}
                        </View>
                        {selected && <Ionicons name="checkmark" size={20} color={theme.colors.selection} />}
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}

/** Accessible single-value selection with an optional searchable native modal. */
export function Combobox<T extends string>({
    label,
    options,
    value,
    onChange,
    placeholder = 'Choose an option',
    helperText,
    errorText,
    required = false,
    hideLabel = false,
    closeOnSelect = true,
    disabled = false,
    focusError = false,
    searchable = false,
    open,
    onOpenChange,
    containerStyle,
    testID = 'combobox'
}: ComboboxProps<T>) {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const [internalOpen, setInternalOpen] = useState(false);
    const [hasOpened, setHasOpened] = useState(open === true);
    const [query, setQuery] = useState('');
    const [initialTypeahead, setInitialTypeahead] = useState('');
    const triggerRef = useRef<FocusableFormControl | null>(null);
    const searchRef = useRef<TextInput | null>(null);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const isOpen = open ?? internalOpen;
    const selectedOption = options.find((option) => option.value === value);
    const filteredOptions = searchable && query
        ? options.filter((option) => (
            option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
            || option.description?.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ))
        : options;

    useEffect(() => {
        if (isOpen) setHasOpened(true);
    }, [isOpen]);

    function setOpen(nextOpen: boolean) {
        if (nextOpen) setHasOpened(true);
        if (open === undefined) setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
        if (!nextOpen) {
            setQuery('');
            setInitialTypeahead('');
        }
    }

    function handleTriggerKeyDown(event: KeyboardLikeEvent) {
        const key = getKey(event);
        if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
            event.preventDefault?.();
            setOpen(true);
            return;
        }
        if (key.length === 1) {
            event.preventDefault?.();
            setInitialTypeahead(key);
            if (searchable) setQuery(key);
            setOpen(true);
        }
    }

    function select(nextValue: T) {
        onChange(nextValue);
        if (closeOnSelect) setOpen(false);
    }

    return (
        <FormField
            label={label}
            helperText={helperText}
            errorText={errorText}
            required={required}
            disabled={disabled}
            hideLabel={hideLabel}
            focusError={focusError}
            controlRef={triggerRef}
            containerStyle={containerStyle}
            testID={`${testID}-field`}
        >
            {(controlProps) => (
                <>
                    <Pressable
                        ref={triggerRef as never}
                        {...controlProps}
                        aria-controls={`${testID}-listbox`}
                        aria-expanded={isOpen}
                        aria-haspopup="listbox"
                        accessibilityRole="combobox"
                        accessibilityState={{ ...controlProps.accessibilityState, expanded: isOpen }}
                        accessibilityValue={{ text: selectedOption?.label ?? placeholder }}
                        disabled={disabled}
                        onBlur={handleBlur}
                        onFocus={handleFocus}
                        onPress={() => setOpen(!isOpen)}
                        role="combobox"
                        {...({ onKeyDown: handleTriggerKeyDown } as object)}
                        style={({ pressed }) => [
                            styles.trigger,
                            focusVisible && styles.triggerFocused,
                            pressed && !disabled && styles.triggerPressed,
                            disabled && styles.triggerDisabled
                        ]}
                        testID={testID}
                    >
                        <View style={styles.triggerCopy}>
                            <AppText style={styles.triggerValue}>{selectedOption?.label ?? placeholder}</AppText>
                            {selectedOption?.description && (
                                <AppText variant="caption">{selectedOption.description}</AppText>
                            )}
                        </View>
                        <Ionicons
                            name={isOpen ? 'chevron-up' : 'chevron-down'}
                            size={20}
                            color={theme.colors.onSurfaceVariant}
                        />
                    </Pressable>
                    {hasOpened && (
                        <BottomSheetModal
                            visible={isOpen}
                            onRequestClose={() => setOpen(false)}
                            title={label}
                            accessibilityLabel={`${label} options`}
                            showCloseButton
                            scrollable={false}
                            maxHeight="72%"
                            initialFocusRef={searchable ? searchRef : undefined}
                            returnFocusRef={triggerRef}
                        >
                            <View style={styles.dialogContent} testID={`${testID}-dialog`}>
                                {searchable && (
                                    <TextInput
                                        ref={searchRef}
                                        accessibilityLabel={`Search ${label}`}
                                        accessibilityRole="search"
                                        autoFocus
                                        value={query}
                                        onChangeText={setQuery}
                                        placeholder="Search options"
                                        placeholderTextColor={theme.colors.onSurfaceVariant}
                                        selectionColor={theme.colors.primary}
                                        style={styles.searchInput}
                                    />
                                )}
                                {filteredOptions.length > 0 ? (
                                    <Listbox
                                        label={`${label} options`}
                                        options={filteredOptions}
                                        value={value}
                                        onSelect={select}
                                        onDismiss={() => setOpen(false)}
                                        initialTypeahead={initialTypeahead}
                                        focusInitialOption={!searchable}
                                        testID={`${testID}-listbox`}
                                    />
                                ) : (
                                    <AppText accessibilityRole="alert" style={styles.noResults}>
                                        No matching options.
                                    </AppText>
                                )}
                            </View>
                        </BottomSheetModal>
                    )}
                </>
            )}
        </FormField>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        trigger: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceContainerLow,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm
        },
        triggerFocused: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        triggerPressed: {
            backgroundColor: theme.colors.surfacePressed,
            opacity: theme.interaction.pressedOpacity
        },
        triggerDisabled: {
            opacity: theme.interaction.disabledOpacity
        },
        triggerCopy: {
            flex: 1,
            minWidth: 0,
            gap: theme.spacing.xs
        },
        triggerValue: {
            ...theme.typography.styles.body,
            fontWeight: '600'
        },
        dialogContent: {
            flex: 1,
            minHeight: 0,
            gap: theme.spacing.md
        },
        searchInput: {
            minHeight: theme.interaction.minimumTouchTarget,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceContainerLow,
            color: theme.colors.onSurface,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            ...theme.typography.styles.body
        },
        listbox: {
            flex: 1,
            borderColor: theme.colors.outline,
            borderWidth: theme.stroke.control,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface
        },
        option: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
            borderBottomColor: theme.colors.outlineVariant,
            borderBottomWidth: StyleSheet.hairlineWidth,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm
        },
        optionSelected: {
            backgroundColor: theme.colors.selectionContainer
        },
        optionActive: {
            outlineColor: theme.colors.focusRing,
            outlineStyle: 'solid',
            outlineWidth: theme.interaction.focusRingWidth
        },
        optionPressed: {
            backgroundColor: theme.colors.surfacePressed,
            opacity: theme.interaction.pressedOpacity
        },
        optionCopy: {
            flex: 1,
            minWidth: 0,
            gap: theme.spacing.xs
        },
        optionTitle: {
            ...theme.typography.styles.body,
            fontWeight: '600'
        },
        optionTitleSelected: {
            color: theme.colors.onSelectionContainer
        },
        optionTitleDisabled: {
            color: theme.colors.onSurfaceVariant
        },
        optionDescriptionSelected: {
            color: theme.colors.onSelectionContainer
        },
        optionDisabledReason: {
            color: theme.colors.danger
        },
        noResults: {
            color: theme.colors.onSurfaceVariant,
            paddingVertical: theme.spacing.lg,
            textAlign: 'center'
        }
    });
}
