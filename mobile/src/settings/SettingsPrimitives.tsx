/** @file Settings Primitives: Renders a keyboard-accessible preference switch with explicit checked and disabled states. */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText } from '../components/AppText';
import { BottomSheetModal, type BottomSheetModalProps } from '../components/BottomSheetModal';
import { useFocusVisible } from '../components/useFocusVisible';
import { spacing, useAppTheme } from '../theme';

type PreferenceSwitchProps = {
    label: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled?: boolean;
};

/** Renders a keyboard-accessible preference switch with explicit checked and disabled states. */
export const PreferenceSwitch: React.FC<PreferenceSwitchProps> = ({
    label,
    value,
    onValueChange,
    disabled = false
}) => {
    const { colors, interaction } = useAppTheme();
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();

    return (
        <Pressable
            aria-checked={value}
            accessibilityLabel={label}
            accessibilityRole="switch"
            accessibilityState={{ checked: value, disabled }}
            disabled={disabled}
            onPress={() => onValueChange(!value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            style={({ pressed }) => [
                styles.switchRow,
                pressed && styles.pressedRow,
                focusVisible && {
                    outlineWidth: interaction.focusRingWidth,
                    outlineStyle: 'solid',
                    outlineColor: colors.focusRing
                }
            ]}
        >
            <AppText variant="body" style={styles.switchLabel}>{label}</AppText>
            <View
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                style={[
                    styles.switchTrack,
                    { backgroundColor: value ? colors.primaryContainer : colors.outlineVariant },
                    value && styles.switchTrackSelected
                ]}
            >
                <View
                    style={[
                        styles.switchThumb,
                        { backgroundColor: value ? colors.primary : colors.outline }
                    ]}
                />
            </View>
        </Pressable>
    );
};

/** Presents a compact label/value pair using shared settings typography. */
export const SummaryRow: React.FC<{ label: string; value: string }> = ({
    label,
    value
}) => (
    <View style={styles.summaryRow}>
        <AppText variant="caption">{label}</AppText>
        <AppText variant="body" style={styles.summaryValue}>{value}</AppText>
    </View>
);

type SettingsDetailSheetProps = {
    visible: boolean;
    maxHeight?: BottomSheetModalProps['maxHeight'];
    title: string;
    description?: string;
    size?: BottomSheetModalProps['size'];
    dismissDisabled?: boolean;
    isDirty?: boolean;
    confirmDismiss?: BottomSheetModalProps['confirmDismiss'];
    onClose: () => void;
    children: React.ReactNode;
};

/** Wraps settings detail content in the shared adaptive dialog with dirty-state dismissal protection. */
export const SettingsDetailSheet: React.FC<SettingsDetailSheetProps> = ({
    visible,
    maxHeight,
    title,
    description,
    size,
    dismissDisabled,
    isDirty,
    confirmDismiss,
    onClose,
    children
}) => (
    <BottomSheetModal
        visible={visible}
        accessibilityLabel={title}
        maxHeight={maxHeight}
        title={title}
        description={description}
        size={size}
        showCloseButton
        dismissDisabled={dismissDisabled}
        isDirty={isDirty}
        confirmDismiss={confirmDismiss}
        onRequestClose={onClose}
    >
        <View style={styles.sheetContent}>{children}</View>
    </BottomSheetModal>
);

const styles = StyleSheet.create({
    sheetContent: {
        gap: spacing.md
    },
    switchRow: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md
    },
    switchTrack: {
        width: 44,
        height: 24,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 12,
        padding: 2
    },
    switchTrackSelected: {
        justifyContent: 'flex-end'
    },
    switchThumb: {
        width: 20,
        height: 20,
        borderRadius: 10
    },
    switchLabel: {
        flex: 1,
        fontWeight: '600'
    },
    pressedRow: {
        opacity: 0.78
    },
    summaryRow: {
        minHeight: 30,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md
    },
    summaryValue: {
        flexShrink: 1,
        textAlign: 'right',
        fontWeight: '600'
    }
});
