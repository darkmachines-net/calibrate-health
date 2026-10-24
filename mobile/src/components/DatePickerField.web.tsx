/** @file Date Picker Field: Uses the browser's accessible, locale-aware date control on web. */

import React from 'react';
import { View } from 'react-native';
import { FormField } from './FormField';
import { useAppTheme } from '../theme';
import type { DatePickerFieldProps } from './DatePickerField.types';

/** Uses the browser's accessible, locale-aware date control on web. */
export const DatePickerField: React.FC<DatePickerFieldProps> = ({
    label, value, onChangeDate, helperText, errorText, controlRef,
    minimumDate, maximumDate, fallbackDate: _fallbackDate, placeholder: _placeholder,
    style, ...props
}) => {
    const { colors, dark, interaction, radius, spacing, stroke, typography } = useAppTheme();
    const [isFocused, setIsFocused] = React.useState(false);
    let borderColor: string = colors.outline;
    if (isFocused) borderColor = colors.focusRing;
    if (errorText) borderColor = colors.danger;
    const handleChange = (event: React.FormEvent<HTMLInputElement>) => onChangeDate(event.currentTarget.value);
    return (
        <View {...props} style={style}>
            <FormField label={label} helperText={helperText} errorText={errorText} controlRef={controlRef}>
                {(field) => (
                    <input
                        ref={(element) => { if (controlRef) controlRef.current = element; }}
                        id={field.nativeID}
                        aria-label={label}
                        aria-describedby={field['aria-describedby']}
                        aria-invalid={field['aria-invalid']}
                        max={maximumDate} min={minimumDate}
                        onBlur={() => setIsFocused(false)} onFocus={() => setIsFocused(true)}
                        onChange={handleChange} onInput={handleChange}
                        style={{
                            minHeight: interaction.minimumTouchTarget, width: '100%', boxSizing: 'border-box',
                            borderStyle: 'solid', borderWidth: isFocused ? interaction.focusRingWidth : stroke.control,
                            borderColor,
                            borderRadius: radius.md, backgroundColor: isFocused ? colors.surface : colors.surfaceContainerLow,
                            color: colors.onSurface, colorScheme: dark ? 'dark' : 'light',
                            fontFamily: typography.styles.input.fontFamily,
                            fontSize: typography.styles.input.fontSize, fontWeight: typography.styles.input.fontWeight,
                            letterSpacing: typography.styles.input.letterSpacing,
                            lineHeight: `${typography.styles.input.lineHeight}px`,
                            outline: 'none', padding: `${spacing.sm}px ${spacing.md}px`
                        }}
                        type="date" value={value}
                    />
                )}
            </FormField>
        </View>
    );
};
