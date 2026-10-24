/** @file Barcode Manual Input: Renders barcode text entry with validation feedback and caller-owned submit and cancel actions. */

import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppButton } from '../components/AppButton';
import { TextField } from '../components/TextField';
import { spacing, useAppTheme } from '../theme';

type BarcodeManualInputProps = {
    value: string;
    error: string | null;
    disabled?: boolean;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel?: () => void;
};

/** Renders barcode text entry with validation feedback and caller-owned submit and cancel actions. */
export function BarcodeManualInput({
    value,
    error,
    disabled = false,
    onChange,
    onSubmit,
    onCancel
}: BarcodeManualInputProps) {
    const theme = useAppTheme();

    return (
        <View style={styles.form}>
            <TextField
                label="EAN or UPC barcode"
                helperText="Enter the 6, 7, 8, 12, or 13 digits printed below the barcode."
                errorText={error ?? undefined}
                value={value}
                editable={!disabled}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                inputMode="numeric"
                returnKeyType="search"
                maxLength={32}
                onChangeText={onChange}
                onSubmitEditing={onSubmit}
            />
            <AppButton
                title="Look up barcode"
                busy={disabled}
                busyLabel="Looking up barcode..."
                leftIcon={<Ionicons name="search-outline" size={18} color={theme.colors.onPrimary} />}
                onPress={onSubmit}
            />
            {onCancel && (
                <AppButton
                    title="Use camera"
                    variant="secondary"
                    disabled={disabled}
                    leftIcon={<Ionicons name="camera-outline" size={18} color={theme.colors.onSurface} />}
                    onPress={onCancel}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({ form: { gap: spacing.md } });
