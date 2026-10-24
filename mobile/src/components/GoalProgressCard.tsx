/** @file Goal Progress Card: Compact native snapshot that keeps current weight and goal projection together. */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { GoalEntry, MetricEntry, UserClientPayload } from '@calibrate/api-client';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { CardHeader } from './CardHeader';
import { ProgressBar } from './ProgressBar';
import { radius, spacing, useAppTheme, type AppTheme } from '../theme';
import { formatDateOnlyForDisplay } from '../utils/dates';
import {
    computeGoalProgress,
    formatDailyGoalChange,
    getGoalModeFromDailyDeficit,
    getGoalReachedDate
} from '../utils/goals';
import { formatWeight } from '../utils/format';
import { useFocusVisible } from './useFocusVisible';

type GoalProgressCardProps = ViewProps & {
    title?: string;
    goal: GoalEntry | null | undefined;
    latestMetric: MetricEntry | null | undefined;
    metrics?: ReadonlyArray<MetricEntry>;
    user: UserClientPayload | null;
    targetCalories?: number | null;
    weightChangePending?: boolean;
    onEditGoal?: () => void;
    onSetNextGoal?: () => void;
};

function formatMetricDate(value: string | null | undefined): string {
    if (!value) return 'No weigh-in yet';
    const [datePart] = value.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (Number.isNaN(parsed.getTime())) return datePart;
    return `Updated ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed)}`;
}

function describeGoalPlan(goal: GoalEntry): string {
    if (goal.plan_status !== 'available') {
        return goal.plan_status === 'requires_review'
            ? 'Stored goal preserved. Calorie target unavailable until you review this plan.'
            : 'Stored goal preserved. Calorie target unavailable until the server verifies this plan.';
    }
    const mode = getGoalModeFromDailyDeficit(goal.daily_deficit);
    const dailyChange = `${Math.abs(goal.daily_deficit).toLocaleString()} kcal`;
    switch (mode) {
        case 'gain':
            return `Gaining weight with a ${dailyChange}/day surplus.`;
        case 'maintain':
            return 'Maintaining weight with a steady calorie target.';
        default:
            return `Losing weight with a ${dailyChange}/day deficit.`;
    }
}

/** Compact native snapshot that keeps current weight and goal projection together. */
export const GoalProgressCard: React.FC<GoalProgressCardProps> = ({
    title = 'Snapshot',
    goal,
    latestMetric,
    metrics,
    user,
    targetCalories,
    weightChangePending = false,
    onEditGoal,
    onSetNextGoal,
    style,
    ...props
}) => {
    const theme = useAppTheme();
    const { width, fontScale } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme, width), [theme, width]);

    if (!goal) {
        return (
            <AppSection {...props} density="compact" style={[styles.summary, style]}>
                <CardHeader
                    title={title}
                    density="comfortable"
                    headingTestID="snapshot-heading-line"
                    action={onEditGoal && <GoalActionButton label="Set goal" onPress={onEditGoal} theme={theme} />}
                />
                <View style={[styles.metricsRow, fontScale >= 1.6 && styles.metricsStacked]}>
                    <View style={styles.metricBlock}>
                        <AppText variant="muted" style={styles.supporting}>Current weight</AppText>
                        <AppText variant="screenTitle" style={styles.currentWeight} accessibilityHint={formatMetricDate(latestMetric?.date)}>
                            {formatWeight(latestMetric?.weight, user?.weight_unit)}
                        </AppText>
                    </View>
                    <View testID="goal-projection" style={styles.projectionBlock}>
                        <AppText variant="muted" style={styles.supporting} accessibilityLabel="Goal date at selected pace">Goal date</AppText>
                        <AppText variant="screenTitle" style={styles.projectionValue}>Not configured</AppText>
                    </View>
                </View>
                <AppText variant="muted" style={styles.supporting}>Set a goal to add progress and projection details.</AppText>
            </AppSection>
        );
    }

    const currentWeight = latestMetric?.weight ?? null;
    const goalMode = getGoalModeFromDailyDeficit(goal.daily_deficit);
    const isMaintenance = goalMode === 'maintain';
    const planIsAvailable = goal.plan_status === 'available' && !weightChangePending;
    const reachedDate = getGoalReachedDate({
        goal,
        metrics: metrics ?? (latestMetric ? [latestMetric] : []),
        timezone: user?.timezone
    });
    const serverProjection = goal.projection;
    const hasReachedGoal = planIsAvailable && serverProjection?.status === 'reached';
    const progress = isMaintenance || hasReachedGoal
        ? null
        : computeGoalProgress({
            startWeight: goal.start_weight,
            targetWeight: goal.target_weight,
            currentWeight
        });
    const projection = planIsAvailable && serverProjection?.status === 'projected' && serverProjection.projected_end_date
        ? formatDateOnlyForDisplay(serverProjection.projected_end_date)
        : 'Unavailable';

    let goalAction: React.ReactNode = null;
    if (weightChangePending) {
        goalAction = null;
    } else if (hasReachedGoal && onSetNextGoal) {
        goalAction = <GoalActionButton label="Set next goal" onPress={onSetNextGoal} theme={theme} />;
    } else if (onEditGoal) {
        goalAction = (
            <GoalActionButton
                label={goal.plan_status === 'requires_review' ? 'Review calorie plan' : 'Edit goal'}
                onPress={onEditGoal}
                theme={theme}
            />
        );
    }

    let goalStatus: React.ReactNode;
    if (isMaintenance && planIsAvailable) {
        goalStatus = (
            <View style={styles.statusBlock}>
                <AppText variant="muted" style={styles.supporting}>Goal status</AppText>
                <AppText variant="screenTitle" style={styles.statusValue}>Ongoing</AppText>
            </View>
        );
    } else if (hasReachedGoal) {
        goalStatus = (
            <View style={styles.reachedBlock}>
                <AppText variant="muted" style={styles.supporting}>Goal status</AppText>
                <AppText variant="screenTitle" style={styles.reachedValue}>Reached</AppText>
            </View>
        );
    } else {
        goalStatus = (
            <View testID="goal-projection" style={styles.projectionBlock}>
                <AppText variant="muted" style={styles.supporting} accessibilityLabel="Goal date at selected pace">Goal date</AppText>
                <AppText variant="screenTitle" style={styles.projectionValue}>{projection}</AppText>
            </View>
        );
    }

    let progressDetails: React.ReactNode;
    if (isMaintenance && planIsAvailable) {
        progressDetails = (
            <AppText variant="muted" style={styles.supporting}>
                Maintenance is ongoing, with no completion percentage or projected end date.
            </AppText>
        );
    } else if (isMaintenance) {
        progressDetails = (
            <AppText variant="muted" style={styles.supporting}>
                This stored maintenance goal is preserved, but its calorie target is unavailable pending review.
            </AppText>
        );
    } else if (hasReachedGoal) {
        progressDetails = (
            <>
                <ProgressBar accessibilityLabel="Goal progress" style={styles.goalTrack} value={1} tone="primary" />
                <View style={styles.goalEndpoints}>
                    <AppText variant="muted" style={[styles.supporting, styles.endpoint]}>Start {formatWeight(goal.start_weight, user?.weight_unit)}</AppText>
                    <AppText variant="muted" style={[styles.supporting, styles.progressSummary]}>100% reached</AppText>
                    <AppText variant="muted" style={[styles.supporting, styles.endpoint, styles.goalEndpoint]}>Goal {formatWeight(goal.target_weight, user?.weight_unit)}</AppText>
                </View>
                <AppText variant="muted" style={styles.supporting}>
                    {reachedDate ? `Goal reached on ${formatDateOnlyForDisplay(reachedDate)}.` : 'Goal reached.'}
                </AppText>
                <View style={styles.planWarning}>
                    <Ionicons name="information-circle-outline" size={18} color={theme.colors.onWarningContainer} />
                    <AppText style={styles.planWarningText}>
                        Your {formatDailyGoalChange(goal.daily_deficit)} plan remains active until you set another goal.
                    </AppText>
                </View>
            </>
        );
    } else {
        progressDetails = (
            <>
                <ProgressBar accessibilityLabel="Goal progress" style={styles.goalTrack} value={(progress?.percent ?? 0) / 100} tone="primary" />
                <View style={styles.goalEndpoints}>
                    <AppText variant="muted" style={[styles.supporting, styles.endpoint]}>Start {formatWeight(goal.start_weight, user?.weight_unit)}</AppText>
                    {progress && (
                        <AppText variant="muted" style={[styles.supporting, styles.progressSummary]}>
                            {Math.round(progress.percent)}% complete
                        </AppText>
                    )}
                    <AppText variant="muted" style={[styles.supporting, styles.endpoint, styles.goalEndpoint]}>Goal {formatWeight(goal.target_weight, user?.weight_unit)}</AppText>
                </View>
                {!progress && <AppText variant="muted" style={styles.supporting}>Log weight on Today to calculate progress.</AppText>}
            </>
        );
    }

    return (
        <AppSection {...props} density="compact" style={[styles.summary, style]}>
            <CardHeader
                title={title}
                density="comfortable"
                headingTestID="snapshot-heading-line"
                action={goalAction}
            />
            <View style={[styles.metricsRow, fontScale >= 1.6 && styles.metricsStacked]}>
                <View style={styles.metricBlock}>
                    <AppText variant="muted" style={styles.supporting}>Current weight</AppText>
                    <AppText variant="screenTitle" style={styles.currentWeight} accessibilityHint={formatMetricDate(latestMetric?.date)}>
                        {formatWeight(currentWeight, user?.weight_unit)}
                    </AppText>
                </View>
                {goalStatus}
            </View>
            {!planIsAvailable && <AppText variant="muted" style={styles.supporting}>
                {weightChangePending
                    ? 'Weight change syncing. Calorie target and projection will return after the server rechecks this plan.'
                    : describeGoalPlan(goal)}
            </AppText>}
            {progressDetails}
            {!weightChangePending && typeof targetCalories === 'number' && (
                <AppText variant="muted" style={styles.supporting}>Current target: {Math.round(targetCalories).toLocaleString()} kcal/day</AppText>
            )}
        </AppSection>
    );
};

const GoalActionButton: React.FC<{ label: string; onPress: () => void; theme: AppTheme }> = ({ label, onPress, theme }) => {
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { focusVisible, handleFocus, handleBlur } = useFocusVisible();

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={onPress}
            onFocus={handleFocus}
            onBlur={handleBlur}
            style={({ pressed }) => [styles.actionButton, pressed && styles.pressed, focusVisible && styles.focusVisible]}
        >
            <AppText variant="label" numberOfLines={1} adjustsFontSizeToFit style={styles.actionText}>{label}</AppText>
        </Pressable>
    );
};

// A short date stays subordinate to the current measurement on narrow phones.
const COMPACT_SNAPSHOT_BREAKPOINT = 340;
const COMPACT_PROJECTION_SIZE = 18;

const createStyles = (theme: AppTheme, width = COMPACT_SNAPSHOT_BREAKPOINT) => StyleSheet.create({
    supporting: {
        ...theme.typography.styles.label,
        fontWeight: '400'
    },
    summary: {
        paddingBottom: spacing.md,
        gap: spacing.xs
    },
    actionButton: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        borderRadius: radius.md,
        paddingHorizontal: spacing.sm
    },
    actionText: {
        color: theme.colors.primary,
        fontWeight: '600',
        flexShrink: 1
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed
    },
    focusVisible: {
        outlineWidth: theme.interaction.focusRingWidth,
        outlineStyle: 'solid',
        outlineColor: theme.colors.focusRing
    },
    metricsRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm
    },
    metricBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'flex-start',
        gap: spacing.xs,
        paddingBottom: spacing.sm
    },
    currentWeight: {
        color: theme.colors.onSurface,
        ...theme.typography.styles.page,
        fontVariant: ['tabular-nums']
    },
    goalEndpoints: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    goalTrack: { height: 5 },
    metricsStacked: { flexDirection: 'column' },
    endpoint: {
        ...theme.typography.styles.caption,
        flex: 1,
        minWidth: 0
    },
    goalEndpoint: {
        textAlign: 'right'
    },
    projectionBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'flex-start',
        gap: spacing.xs,
        paddingBottom: spacing.sm
    },
    projectionValue: {
        color: theme.colors.onSurface,
        ...theme.typography.styles.section,
        fontSize: width < COMPACT_SNAPSHOT_BREAKPOINT ? COMPACT_PROJECTION_SIZE : theme.typography.styles.section.fontSize,
        fontVariant: ['tabular-nums']
    },
    statusBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'flex-start',
        gap: spacing.xs,
        paddingBottom: spacing.sm
    },
    statusValue: {
        color: theme.colors.onSurface,
        ...theme.typography.styles.measurement
    },
    reachedBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'flex-start',
        gap: spacing.xs,
        paddingBottom: spacing.sm
    },
    reachedValue: {
        color: theme.colors.success,
        ...theme.typography.styles.measurement
    },
    planWarning: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
        borderRadius: radius.md,
        backgroundColor: theme.colors.warningContainer,
        padding: spacing.md
    },
    planWarningText: {
        ...theme.typography.styles.label,
        fontWeight: '400',
        flex: 1,
        color: theme.colors.onWarningContainer
    },
    progressSummary: {
        ...theme.typography.styles.caption,
        flexShrink: 1,
        minWidth: 0,
        fontWeight: '600',
        textAlign: 'center'
    }
});
