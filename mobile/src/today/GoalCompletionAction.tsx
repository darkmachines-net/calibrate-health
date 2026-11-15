/** @file Compact Today entry point to the next-goal picker after confirmed completion. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppActionRow } from '../components/AppActionRow';
import { AppText } from '../components/AppText';
import { type AppTheme, useAppTheme } from '../theme';

/** Keep the persistent next step accessible alongside Today's logging controls. */
export function GoalCompletionAction({ onChoose }: { onChoose: () => void }) {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    return <AppActionRow
        accessibilityRole="button"
        accessibilityLabel="Goal reached. Choose your next goal"
        primaryActionTestID="today-next-goal-action"
        onPress={onChoose}
        contentStyle={styles.action}
    >
        <View accessibilityElementsHidden aria-hidden>
            <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.primary} />
        </View>
        <View style={styles.copy}>
            <AppText style={styles.title}>Goal reached</AppText>
            <AppText variant="muted">Choose your next goal</AppText>
        </View>
        <View accessibilityElementsHidden aria-hidden>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.onSurfaceVariant} />
        </View>
    </AppActionRow>;
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        action: {
            flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm,
            borderWidth: theme.stroke.control, borderColor: theme.colors.outlineVariant, borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm
        },
        copy: { flex: 1, minWidth: 0 },
        title: { fontWeight: '600' }
    });
}
