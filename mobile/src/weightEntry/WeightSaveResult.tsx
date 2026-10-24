/** @file Weight Save Result: Presents saved, queued, or deleted weight outcomes with progress recognition and optional trend context. */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { MetricProgressUpdate, TrendMetricsResponse } from '@calibrate/api-client';
import type { WeightUnit } from '@calibrate/shared';
import { AppText } from '../components/AppText';
import { ProgressBar } from '../components/ProgressBar';
import { type AppTheme, useAppTheme } from '../theme';
import { formatWeight } from '../utils/format';
import { describeVisibleWeightTrend } from '../weightTrend/presentation';
import { GoalReachedConfetti } from './GoalReachedConfetti';
import { formatRemainingGoalWeight, getWeightRecognitionPresentation } from './presentation';

type WeightSaveResultProps = {
    action: 'save' | 'delete';
    queued: boolean;
    savedWeight?: number;
    unit: WeightUnit | undefined;
    progressUpdate?: MetricProgressUpdate;
    trend?: TrendMetricsResponse;
    trendLoading: boolean;
    trendError: string | null;
    reduceMotion: boolean;
    headingRef?: React.RefObject<View | null>;
};

/** Presents saved, queued, or deleted weight outcomes with progress recognition and optional trend context. */
export const WeightSaveResult: React.FC<WeightSaveResultProps> = ({
    action,
    queued,
    savedWeight,
    unit,
    progressUpdate,
    trend,
    trendLoading,
    trendError,
    reduceMotion,
    headingRef
}) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const recognition = getWeightRecognitionPresentation(progressUpdate, unit);
    let title = recognition.title;
    let message = recognition.message;
    let icon = recognition.icon;

    if (action === 'delete') {
        title = queued ? 'Deletion saved on this device' : 'Weigh-in deleted';
        message = queued
            ? 'Your trend will update after this change syncs.'
            : 'Your trend and goal progress have been recalculated.';
        icon = 'checkmark-circle';
    } else if (queued) {
        title = 'Saved on this device';
        message = 'Your trend and milestones will update after this weigh-in syncs.';
        icon = 'checkmark-circle';
    }

    const goal = !queued && action === 'save' ? progressUpdate?.goal : null;
    const percent = goal?.current_progress_percent;
    const trendSummary = trend ? describeVisibleWeightTrend(trend.metrics, unit) : null;
    const shouldCelebrate = !queued && action === 'save' && recognition.goalReached;

    return (
        <View style={styles.root}>
            <GoalReachedConfetti active={shouldCelebrate} reduceMotion={reduceMotion} />
            <View
                ref={headingRef}
                accessible
                accessibilityRole="header"
                accessibilityLiveRegion="polite"
                aria-level={2}
                style={styles.hero}
                tabIndex={-1}
            >
                <View style={[styles.iconSurface, shouldCelebrate && styles.celebrationIconSurface]}>
                    <Ionicons
                        name={icon}
                        size={30}
                        color={shouldCelebrate ? theme.colors.onWarningContainer : theme.colors.onSuccessContainer}
                    />
                </View>
                <AppText variant="screenTitle" style={styles.title}>{title}</AppText>
                <AppText variant="muted" style={styles.message}>{message}</AppText>
            </View>

            {action === 'save' && typeof savedWeight === 'number' && (
                <AppText
                    accessibilityLabel={`Saved weight ${formatWeight(savedWeight, unit)}`}
                    style={styles.savedWeight}
                >
                    {formatWeight(savedWeight, unit)}
                </AppText>
            )}

            {!queued && action === 'save' && (
                <View style={styles.summaryStack}>
                    <View style={styles.summaryCard}>
                        <View style={styles.summaryHeading}>
                            <Ionicons name="analytics-outline" size={18} color={theme.colors.primary} />
                            <AppText variant="label">Four-week trend</AppText>
                        </View>
                        {trendLoading ? (
                            <AppText variant="muted">Updating your trend...</AppText>
                        ) : trendError ? (
                            <AppText accessibilityLiveRegion="polite" style={styles.error}>
                                Weight saved. Trend update unavailable: {trendError}
                            </AppText>
                        ) : (
                            <AppText>{trendSummary ?? 'Your trend will appear after another weigh-in.'}</AppText>
                        )}
                    </View>

                    {goal && (
                        <View style={styles.summaryCard}>
                            <View style={styles.goalHeadingRow}>
                                <View style={styles.summaryHeading}>
                                    <Ionicons name="flag-outline" size={18} color={theme.colors.primary} />
                                    <AppText variant="label">Goal progress</AppText>
                                </View>
                                {typeof percent === 'number' && (
                                    <AppText variant="label">{Math.round(percent)}%</AppText>
                                )}
                            </View>
                            {typeof percent === 'number' ? (
                                <ProgressBar
                                    accessibilityLabel="Goal progress"
                                    value={percent / 100}
                                />
                            ) : (
                                <AppText variant="muted">Maintenance goal</AppText>
                            )}
                            <AppText variant="muted">
                                {goal.is_complete
                                    ? 'Target reached'
                                    : `${formatRemainingGoalWeight(goal.remaining_weight_grams, unit)} to goal`}
                            </AppText>
                        </View>
                    )}
                </View>
            )}
        </View>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    root: {
        position: 'relative',
        gap: theme.spacing.lg,
        overflow: 'hidden'
    },
    hero: {
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md
    },
    iconSurface: {
        width: 56,
        height: 56,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.successContainer
    },
    celebrationIconSurface: {
        backgroundColor: theme.colors.warningContainer
    },
    title: {
        textAlign: 'center'
    },
    message: {
        maxWidth: 440,
        textAlign: 'center'
    },
    savedWeight: {
        color: theme.colors.onSurface,
        ...theme.typography.styles.metric,
        fontVariant: ['tabular-nums'],
        textAlign: 'center'
    },
    summaryStack: {
        gap: theme.spacing.sm
    },
    summaryCard: {
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.md,
        borderColor: theme.colors.outlineVariant,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    summaryHeading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm
    },
    goalHeadingRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.md
    },
    error: {
        color: theme.colors.danger
    }
});
