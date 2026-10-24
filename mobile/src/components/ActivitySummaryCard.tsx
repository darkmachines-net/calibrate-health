/** @file Activity Summary Card: Observed device activity. It is intentionally separate from Calibrate's calorie-target estimate. */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ActivityDaysResponse } from '@calibrate/api-client';
import { isActivitySummaryDelayed, isActivitySummaryEmpty } from '../activity/presentation';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { formatCalories, formatNumber } from '../utils/format';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { SkeletonBlock } from './SkeletonBlock';

export type ActivityDay = ActivityDaysResponse['days'][number];

type ActivitySummaryCardProps = {
    day: ActivityDay | null | undefined;
    isToday: boolean;
    isLoading?: boolean;
};

/** Observed device activity. It is intentionally separate from Calibrate's calorie-target estimate. */
export function ActivitySummaryCard({
    day,
    isToday,
    isLoading = false
}: ActivitySummaryCardProps) {
    const theme = useAppTheme();
    const { colors } = theme;
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    const summary = day?.summary;
    const records = day?.records ?? [];
    const isEmpty = isActivitySummaryEmpty(summary) && records.length === 0;
    const delayed = isActivitySummaryDelayed(summary, isToday);

    return (
        <AppSection testID="activity-summary">
            {isLoading ? (
                <View style={styles.skeletonGrid}>
                    {[0, 1, 2].map((index) => <SkeletonBlock key={index} width="30%" height={72} />)}
                </View>
            ) : isEmpty ? (
                <View style={styles.emptyState}>
                    <Ionicons name="walk-outline" size={28} color={colors.muted} />
                    <View style={styles.emptyText}>
                        <AppText style={styles.emptyTitle}>No imported activity for this day</AppText>
                        <AppText variant="muted">
                            {isToday
                                ? 'Health Connect can take a little time to deliver today\'s activity.'
                                : 'No activity was imported for this date.'}
                        </AppText>
                    </View>
                </View>
            ) : (
                <>
                    <View style={styles.metricGrid}>
                        <View style={styles.primaryMetric}>
                            <AppText style={styles.metricValue}>{formatNumber(summary?.steps, 0)}</AppText>
                            <AppText variant="caption">Steps</AppText>
                        </View>
                        <View style={styles.primaryMetric}>
                            <AppText style={styles.metricValue}>{formatCalories(summary?.active_calories_kcal)}</AppText>
                            <AppText variant="caption">Active calories</AppText>
                        </View>
                        <View style={styles.primaryMetric}>
                            <AppText style={styles.metricValue}>{`${formatNumber(summary?.exercise_minutes, 0)} min`}</AppText>
                            <AppText variant="caption">Exercise time</AppText>
                        </View>
                    </View>
                    <View style={styles.totalBurnRow}>
                        <AppText variant="label">Device-estimated total burn</AppText>
                        <AppText style={styles.totalBurnValue}>{formatCalories(summary?.total_calories_kcal)}</AppText>
                    </View>
                    {delayed && (
                        <AppText style={styles.delay}>
                            This summary has not refreshed recently. Your connected apps may still be syncing.
                        </AppText>
                    )}
                </>
            )}
        </AppSection>
    );
}

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        metricGrid: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.sm
        },
        primaryMetric: {
            flexGrow: 1,
            flexBasis: 120,
            gap: spacing.xs,
            paddingVertical: spacing.sm
        },
        metricValue: {
            ...theme.typography.styles.measurement,
            fontVariant: ['tabular-nums']
        },
        totalBurnRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: spacing.sm
        },
        totalBurnValue: {
            fontWeight: '600',
            fontVariant: ['tabular-nums']
        },
        skeletonGrid: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: spacing.sm
        },
        emptyState: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md
        },
        emptyText: {
            flex: 1,
            gap: spacing.xs
        },
        emptyTitle: {
            fontWeight: '600'
        },
        delay: {
            color: theme.colors.warning
        }
    });
}
