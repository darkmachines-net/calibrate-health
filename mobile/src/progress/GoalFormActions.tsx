/** @file Shared confirmation controls and anchored validation message for goal forms. */

import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { spacing, useAppTheme } from '../theme';

/** Place the current error directly above confirmation and stack navigation controls at larger text sizes. */
export function GoalFormActions({ error, errorId, secondaryAction, ...confirm }: ComponentProps<typeof AppButton> & {
    error?: string | null;
    errorId: string;
    secondaryAction?: ReactNode;
}) {
    const { colors } = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const horizontal = Boolean(secondaryAction) && fontScale < 1.5;
    return <View style={styles.actions} testID="goal-editor-actions">
        {error && <AppText nativeID={errorId} accessibilityRole="alert" accessibilityLiveRegion="polite"
            variant="caption" style={{ color: colors.danger }}>{error}</AppText>}
        <View style={[styles.actions, horizontal && styles.row]}>
            {secondaryAction}
            <AppButton {...confirm} style={horizontal && styles.primary} />
        </View>
    </View>;
}

const styles = StyleSheet.create({
    actions: { gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center' },
    primary: { flex: 1 }
});
