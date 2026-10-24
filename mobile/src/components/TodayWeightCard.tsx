/** @file Today Weight Card: Compact daily weigh-in summary and entry point for Today. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { MetricEntry } from '@calibrate/api-client';
import type { WeightUnit } from '@calibrate/shared';
import { AppActionRow } from './AppActionRow';
import { AppText } from './AppText';
import { FixedPageColumn } from './FixedPage';
import { formatWeight } from '../utils/format';
import { type AppTheme, useAppTheme } from '../theme';

type TodayWeightCardProps = Omit<React.ComponentProps<typeof AppActionRow>, 'accessibilityLabel' | 'children' | 'onPress' | 'secondaryAction'> & {
    metric: MetricEntry | null;
    weightUnit: WeightUnit | undefined;
    isToday: boolean;
    onPress: () => void;
};

/** Compact daily weigh-in summary and entry point for Today. */
export const TodayWeightCard: React.FC<TodayWeightCardProps> = ({
    metric,
    weightUnit,
    isToday,
    onPress,
    style,
    ...props
}) => {
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const title = isToday ? "Today's weight" : 'Weight';
    const action = metric ? 'Edit' : 'Log';
    const metricLabel = metric ? formatWeight(metric.weight, weightUnit) : 'Weigh in';
    const supportingLabel = metric
        ? (isToday ? 'Logged today' : 'Logged for this day')
        : (isToday ? "Record today's weight" : 'Record weight for this day');

    return (
        <AppActionRow
            {...props}
            testID={props.testID ?? 'today-weight-card'}
            primaryActionTestID="today-weight-card-press-layer"
            accessibilityRole="button"
            accessibilityLabel={`${title}. ${metricLabel}. ${action} weight`}
            accessibilityHint={metric ? 'Opens this weigh-in for editing' : 'Opens the weight entry form'}
            onPress={onPress}
            style={style}
            contentStyle={styles.record}
        >
            <FixedPageColumn style={styles.summaryRow}>
                <View style={styles.iconTile} accessibilityElementsHidden aria-hidden>
                    <Ionicons name="scale-outline" size={22} color={theme.colors.primary} />
                </View>
                <View style={styles.summaryText}>
                    <AppText style={metric ? styles.measurement : styles.emptyLabel}>{metricLabel}</AppText>
                    <AppText style={styles.supportingLabel}>{supportingLabel}</AppText>
                </View>
                <View accessibilityElementsHidden aria-hidden>
                    <Ionicons name={metric ? 'create-outline' : 'add'} size={20} color={theme.colors.primary} />
                </View>
            </FixedPageColumn>
        </AppActionRow>
    );
};

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        record: { paddingVertical: theme.spacing.sm, borderRadius: 0, borderBottomColor: theme.colors.outline, borderBottomWidth: StyleSheet.hairlineWidth },
        iconTile: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
        summaryRow: {
            minHeight: theme.interaction.minimumTouchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md
        },
        summaryText: {
            flex: 1,
            minWidth: 0,
            gap: 0
        },
        measurement: { ...theme.typography.styles.measurement, fontVariant: ['tabular-nums'] },
        emptyLabel: theme.typography.styles.section,
        supportingLabel: { ...theme.typography.styles.label, color: theme.colors.onSurfaceVariant }
    });
}
