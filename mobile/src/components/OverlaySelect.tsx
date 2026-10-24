/** @file Overlay Select: Legacy controlled-select adapter. Existing callers keep ownership of closing after selection while receiving the shared accessible combobox. */

import type { StyleProp, ViewStyle } from 'react-native';
import { Combobox, type ComboboxOption } from './Combobox';

export type OverlaySelectOption<T extends string> = ComboboxOption<T>;

type OverlaySelectProps<T extends string> = {
    accessibilityLabel: string;
    value: T;
    options: Array<OverlaySelectOption<T>>;
    isOpen: boolean;
    onToggle: () => void;
    onChange: (value: T) => void;
    placeholder?: string;
    style?: StyleProp<ViewStyle>;
};

/**
 * Legacy controlled-select adapter. Existing callers keep ownership of
 * closing after selection while receiving the shared accessible combobox.
 */
export function OverlaySelect<T extends string>({
    accessibilityLabel,
    value,
    options,
    isOpen,
    onToggle,
    onChange,
    placeholder,
    style
}: OverlaySelectProps<T>) {
    return (
        <Combobox
            label={accessibilityLabel}
            value={value}
            options={options}
            open={isOpen}
            onOpenChange={(nextOpen) => {
                if (nextOpen !== isOpen) onToggle();
            }}
            onChange={onChange}
            placeholder={placeholder}
            hideLabel
            closeOnSelect={false}
            containerStyle={style}
        />
    );
}
