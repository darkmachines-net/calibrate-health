/** @file Settings Management List Skeleton: Preserve management-list shape while account access data loads. */

import { StyleSheet, View } from 'react-native';
import { SkeletonBlock } from '../components/SkeletonBlock';
import { spacing, useAppTheme } from '../theme';

type SettingsManagementListSkeletonProps = {
    label: string;
};

/** Preserve management-list shape while account access data loads. */
export function SettingsManagementListSkeleton({ label }: SettingsManagementListSkeletonProps) {
    const { colors, interaction } = useAppTheme();
    return (
        <View accessibilityLabel={label} style={styles.list}>
            {[0, 1].map((row) => (
                <View key={row} style={[styles.row, { borderBottomColor: colors.outlineVariant }]}>
                    <View style={styles.copy}>
                        <SkeletonBlock width="58%" height={18} />
                        <SkeletonBlock width="76%" height={14} />
                    </View>
                    <SkeletonBlock width={72} height={interaction.minimumTouchTarget} />
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    list: {
        gap: spacing.md
    },
    row: {
        minHeight: 52,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingVertical: spacing.md
    },
    copy: {
        flex: 1,
        // Match the real session/assistant record's copy column before its action wraps.
        minWidth: 220,
        gap: spacing.sm
    }
});
