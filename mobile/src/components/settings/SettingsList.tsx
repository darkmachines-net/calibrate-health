/** @file Settings List: Groups related settings under a level-two heading without adding card containment. */

import React, { useState } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '../AppText';
import { SectionHeader } from '../SectionHeader';
import { useFocusVisible } from '../useFocusVisible';
import { radius, spacing, useAppTheme } from '../../theme';

type SettingsSectionProps = {
    title: string;
    description?: string;
    children: React.ReactNode;
    style?: ViewStyle;
    testID?: string;
};

type SettingsRowProps = {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    supportingText?: string;
    value?: string;
    danger?: boolean;
    showDivider?: boolean;
    testID?: string;
    onPress: () => void;
};

/** Groups related settings under a level-two heading without adding card containment. */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
    title,
    description,
    children,
    style,
    testID
}) => {
    return (
        <View testID={testID} style={[styles.section, style]}>
            <SectionHeader
                title={title}
                description={description}
                headingLevel={2}
                style={styles.sectionHeading}
            />
            <View>
                {children}
            </View>
        </View>
    );
};

/** Renders one accessible settings action with optional supporting value and danger treatment. */
export const SettingsRow: React.FC<SettingsRowProps> = ({
    icon,
    label,
    supportingText,
    value,
    danger = false,
    showDivider = true,
    testID,
    onPress
}) => {
    const theme = useAppTheme();
    const { colors } = theme;
    const [hovered, setHovered] = useState(false);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();
    const iconColor = danger ? colors.danger : colors.onSurfaceVariant;

    return (
        <Pressable
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={value ? `${label}, ${value}` : label}
            onPress={onPress}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            style={({ pressed }) => [
                styles.row,
                showDivider && { borderBottomColor: colors.outlineVariant, borderBottomWidth: StyleSheet.hairlineWidth },
                hovered && { backgroundColor: colors.surfaceHovered },
                pressed && { backgroundColor: colors.surfacePressed },
                focusVisible && {
                    outlineColor: colors.focusRing,
                    outlineStyle: 'solid',
                    outlineWidth: theme.interaction.focusRingWidth
                }
            ]}
        >
            <View style={styles.iconContainer}>
                <Ionicons name={icon} size={20} color={iconColor} />
            </View>
            <View style={styles.rowText}>
                <AppText variant="body" style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</AppText>
                {supportingText && <AppText variant="caption">{supportingText}</AppText>}
            </View>
            {value && <AppText variant="muted" style={styles.rowValue}>{value}</AppText>}
            <Ionicons name="chevron-forward" size={18} color={danger ? colors.danger : colors.onSurfaceVariant} />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    section: {
        gap: spacing.sm
    },
    sectionHeading: {
        paddingHorizontal: 0
    },
    row: {
        minHeight: 64,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: 0,
        paddingVertical: spacing.sm
    },
    iconContainer: {
        width: 24,
        height: 24,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md
    },
    rowText: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    rowLabel: {
        fontWeight: '600'
    },
    rowValue: {
        maxWidth: '32%',
        flexShrink: 1,
        textAlign: 'right'
    }
});
