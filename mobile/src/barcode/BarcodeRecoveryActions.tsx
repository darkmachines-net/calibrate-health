/** @file Barcode Recovery Actions: Shared escape hatches for every camera, connectivity, and lookup failure. */

import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppButton } from '../components/AppButton';
import { spacing, useAppTheme } from '../theme';

type BarcodeRecoveryActionsProps = {
    disabled?: boolean;
    onSearchFoods: () => void;
    onAddManually: () => void;
    onScanLabel?: () => void;
};

/** Shared escape hatches for every camera, connectivity, and lookup failure. */
export function BarcodeRecoveryActions({
    disabled = false,
    onSearchFoods,
    onAddManually,
    onScanLabel
}: BarcodeRecoveryActionsProps) {
    const theme = useAppTheme();

    return (
        <View style={styles.actions}>
            {onScanLabel && <AppButton title="Scan nutrition label" variant="secondary" disabled={disabled} onPress={onScanLabel} />}
            <AppButton
                title="Search foods"
                variant="secondary"
                disabled={disabled}
                leftIcon={<Ionicons name="search-outline" size={18} color={theme.colors.onSurface} />}
                onPress={onSearchFoods}
            />
            <AppButton
                title="Add manually"
                variant="ghost"
                disabled={disabled}
                leftIcon={<Ionicons name="create-outline" size={18} color={theme.colors.onSurface} />}
                onPress={onAddManually}
            />
        </View>
    );
}

const styles = StyleSheet.create({ actions: { gap: spacing.sm } });
