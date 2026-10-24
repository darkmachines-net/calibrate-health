/** @file Shared date-picker field props used by matching browser and native implementations. */

import type React from 'react';
import type { ViewProps } from 'react-native';
import type { FocusableFormControl } from './FormField';

export type DatePickerFieldProps = ViewProps & {
    label: string;
    value: string;
    onChangeDate: (value: string) => void;
    placeholder?: string;
    helperText?: string;
    errorText?: string;
    controlRef?: React.RefObject<FocusableFormControl | null>;
    minimumDate?: string;
    maximumDate?: string;
    fallbackDate?: string;
};
