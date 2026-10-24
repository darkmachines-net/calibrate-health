/** @file Plan Check Card: Loads calibration status and coordinates recommendation mutations while guarding pending evidence changes. */

import React, { useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type ViewProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type CalibrationStatusResponse } from '@calibrate/api-client';
import type {
    CalibrationAssessmentBlocker,
    CalibrationInterval,
    CalibrationPaceStatus
} from '@calibrate/shared/calibration';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from './AsyncStateBoundary';
import { BottomSheetModal } from './BottomSheetModal';
import { CardHeader } from './CardHeader';
import { paceTitle, paceIcon, waitingTitle } from '../calibration/planCheckPresentation';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { useAuth } from '../auth/AuthContext';
import { getErrorPresentation, getSafeActionErrorMessage } from '../errors/presentation';
import { usePendingCalibrationEvidenceMutation } from '../offline/usePendingCalibrationEvidenceMutation';
import { addDaysToDateOnly, formatDateOnlyForDisplay } from '../utils/dates';
import { useCurrentLocalDate } from '../hooks/useCurrentLocalDate';
import { spacing, typeScale, type AppTheme, useAppTheme } from '../theme';

const COMPACT_LAYOUT_BREAKPOINT = 640; // Stacks the decision and target rows before text begins to compete.
const METRIC_MIN_WIDTH = 112; // Keeps paired measurements readable on a 320px phone and lets enlarged text wrap.
const POUNDS_PER_KILOGRAM = 2.2046226218;

type PlanCheckCardProps = ViewProps & { suppressStaleNotice?: boolean; hideTitle?: boolean };
type PlanCheckCardViewProps = ViewProps & {
    hideTitle?: boolean;
    status?: CalibrationStatusResponse;
    isLoading?: boolean;
    error?: Error | null;
    timezone?: string | null;
    todayDate?: string;
    onRetry?: () => void;
    onApplyRecommendation?: (recommendationId: number) => Promise<void>;
    onCancelScheduledChange?: (recommendationId: number) => Promise<void>;
};

const PlanCheckHeading: React.FC<{ metadata?: string; hideTitle?: boolean }> = ({ metadata, hideTitle }) => (
    <View style={styles.heading}>
        {!hideTitle && <CardHeader title="Plan check" density="compact" />}
        {metadata && <AppText variant="muted">{metadata}</AppText>}
    </View>
);

/** Loads calibration status and coordinates recommendation mutations while guarding pending evidence changes. */
export const PlanCheckCard: React.FC<PlanCheckCardProps> = ({
    suppressStaleNotice,
    hideTitle,
    ...props
}) => {
    const { api, user } = useAuth();
    const queryClient = useQueryClient();
    const statusQuery = useQuery({
        queryKey: calibrationStatusQueryKey,
        queryFn: () => api.getCalibrationStatus()
    });
    const isOnline = useOnlineStatus();
    const hasPendingEvidence = usePendingCalibrationEvidenceMutation();
    const statusState = useAsyncResourceState(statusQuery, () => false);

    if (hasPendingEvidence) {
        return (
            <AppSection {...props} density="compact">
                <PlanCheckHeading hideTitle={hideTitle} metadata="Updating..." />
                <AppText variant="muted">
                    Your latest food and weight entries are syncing before this check updates.
                </AppText>
            </AppSection>
        );
    }

    async function applyRecommendation(recommendationId: number) {
        const change = await api.applyCalibrationRecommendation(recommendationId, Crypto.randomUUID());
        queryClient.setQueryData<CalibrationStatusResponse>(calibrationStatusQueryKey, (current) => current ? ({
            ...current,
            recommendation: null,
            scheduledChange: change
        }) : current);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        void Promise.all([
            queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey }),
            queryClient.invalidateQueries({ queryKey: ['mobile-profile'] })
        ]).catch(() => undefined);
    }

    async function cancelScheduledChange(recommendationId: number) {
        const nextStatus = await api.cancelCalibrationRecommendation(recommendationId, Crypto.randomUUID());
        queryClient.setQueryData<CalibrationStatusResponse>(calibrationStatusQueryKey, nextStatus);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        void queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }).catch(() => undefined);
    }

    return (
        <AsyncStateBoundary
            state={statusState}
            resourceLabel="plan check"
            loading={<PlanCheckCardView hideTitle={hideTitle} {...props} isLoading timezone={user?.timezone} />}
            empty={<PlanCheckCardView hideTitle={hideTitle} {...props} isLoading timezone={user?.timezone} />}
            onRetry={isOnline ? () => statusQuery.refetch() : undefined}
            retrying={statusQuery.isFetching}
            suppressStaleNotice={suppressStaleNotice}
        >
            <PlanCheckCardView hideTitle={hideTitle}
                {...props}
                status={statusQuery.data}
                timezone={user?.timezone}
                onRetry={isOnline ? () => { void statusQuery.refetch(); } : undefined}
                onApplyRecommendation={applyRecommendation}
                onCancelScheduledChange={cancelScheduledChange}
            />
        </AsyncStateBoundary>
    );
};

function convertedWeightRate(valueKg: number, unit: 'KG' | 'LB'): number {
    return unit === 'LB' ? valueKg * POUNDS_PER_KILOGRAM : valueKg;
}

function weightUnitLabel(unit: 'KG' | 'LB'): string {
    return unit === 'LB' ? 'lb' : 'kg';
}

function formatWeightRate(valueKg: number, unit: 'KG' | 'LB'): string {
    const value = convertedWeightRate(valueKg, unit);
    const suffix = weightUnitLabel(unit);
    if (Math.abs(value) < 0.005) return 'About steady';
    return Math.abs(value).toFixed(2) + ' ' + suffix + '/week ' + (value < 0 ? 'loss' : 'gain');
}

function formatWeightRateRange(interval: CalibrationInterval, unit: 'KG' | 'LB'): string {
    const low = convertedWeightRate(interval.low, unit);
    const high = convertedWeightRate(interval.high, unit);
    const suffix = weightUnitLabel(unit);
    if (high < -0.005) {
        return Math.abs(high).toFixed(2) + '-' + Math.abs(low).toFixed(2) + ' ' + suffix + '/week loss';
    }
    if (low > 0.005) {
        return low.toFixed(2) + '-' + high.toFixed(2) + ' ' + suffix + '/week gain';
    }
    return Math.abs(Math.min(0, low)).toFixed(2) + ' ' + suffix + ' loss to ' +
        Math.max(0, high).toFixed(2) + ' ' + suffix + ' gain per week';
}

const WeightRateMetric: React.FC<{ label: string; valueKg: number; unit: 'KG' | 'LB' }> = ({ label, valueKg, unit }) => {
    const value = convertedWeightRate(valueKg, unit);
    const isSteady = Math.abs(value) < 0.005;
    return (
        <View style={styles.metric} accessible accessibilityLabel={label + ': ' + formatWeightRate(valueKg, unit)}>
            <AppText variant="muted">{label}</AppText>
            <AppText style={styles.metricValue}>{isSteady ? 'About steady' : Math.abs(value).toFixed(2)}</AppText>
            {!isSteady && <AppText variant="muted">{weightUnitLabel(unit) + '/week ' + (value < 0 ? 'loss' : 'gain')}</AppText>}
        </View>
    );
};

function blockerLabel(blocker: CalibrationAssessmentBlocker | null): string {
    switch (blocker) {
        case 'tracking_paused':
            return 'food tracking to resume';
        case 'plan_unavailable':
            return 'an available calorie plan';
        case 'current_weigh_in':
            return 'a current weigh-in';
        case 'weight_history':
            return 'more weight history';
        case 'food_history':
            return 'more complete food logs';
        case 'food_uncertainty':
            return 'a more consistent food history';
        case 'weight_uncertainty':
            return 'a more stable weight trend';
        case 'trend_unavailable':
            return 'a continuous weight trend';
        default:
            return 'more consistent weight history';
    }
}

function waitingDescription(blocker: CalibrationAssessmentBlocker | null): string {
    switch (blocker) {
        case 'tracking_paused':
            return 'Resume food tracking when you are ready. This check will restart with your new history.';
        case 'plan_unavailable':
            return 'This check will return after your calorie plan is available again.';
        case 'trend_unavailable':
            return 'We cannot assess your weight trend right now. Check that your weight entries are correct and continue logging consistently.';
        case 'weight_uncertainty':
            return 'Day-to-day weight changes are still too large to assess your pace reliably. Keep logging meals and weight.';
        default:
            return 'Keep logging meals and weight consistently. Once your trend is reliable, we will tell you whether it matches your goal and whether a target change may help.';
    }
}

function comparisonSummary(
    interval: CalibrationInterval,
    goalRateKgPerWeek: number,
    unit: 'KG' | 'LB',
    status: CalibrationPaceStatus,
    startDate: string,
    endDate: string
): string {
    return 'Your underlying weight trend from ' + formatDateOnlyForDisplay(startDate) + ' through ' +
        formatDateOnlyForDisplay(endDate) + ' is about ' + formatWeightRate(interval.midpoint, unit) +
        ', with a likely range of ' + formatWeightRateRange(interval, unit) + '. Your goal is ' +
        formatWeightRate(goalRateKgPerWeek, unit) + '. ' + paceTitle(status) +
        '. This describes the period shown and is not a forecast.';
}

const PaceComparison: React.FC<{
    interval: CalibrationInterval;
    goalRateKgPerWeek: number;
    status: CalibrationPaceStatus;
    unit: 'KG' | 'LB';
    startDate: string;
    endDate: string;
}> = ({ interval, goalRateKgPerWeek, status, unit, startDate, endDate }) => {
    const theme = useAppTheme();
    const rawSpan = Math.max(0.01, Math.max(interval.high, goalRateKgPerWeek) -
        Math.min(interval.low, goalRateKgPerWeek));
    const padding = Math.max(0.05, rawSpan * 0.4);
    const domainLow = Math.min(interval.low, goalRateKgPerWeek) - padding;
    const domainHigh = Math.max(interval.high, goalRateKgPerWeek) + padding;
    const position = (value: number) => ((value - domainLow) / (domainHigh - domainLow)) * 100;
    const beforeRange = position(interval.low);
    const rangeWidth = Math.max(2, position(interval.high) - beforeRange);
    const afterRange = Math.max(0, 100 - beforeRange - rangeWidth);
    const goalPosition = position(goalRateKgPerWeek);
    const rangeColor = status === 'aligned' ? theme.colors.success : theme.colors.warning;

    return (
        <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={comparisonSummary(
                interval,
                goalRateKgPerWeek,
                unit,
                status,
                startDate,
                endDate
            )}
            style={styles.comparison}
            testID="plan-check-pace-comparison"
        >
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <View style={styles.trackShell}>
                    <View style={[styles.track, { backgroundColor: theme.colors.outlineVariant }]} />
                    <View style={styles.rangeRow}>
                        <View style={{ flex: beforeRange }} />
                        <View style={[
                            styles.rangeBand,
                            { flex: rangeWidth, backgroundColor: rangeColor }
                        ]} />
                        <View style={{ flex: afterRange }} />
                    </View>
                    <View style={styles.goalRow}>
                        <View style={{ flex: goalPosition }} />
                        <View style={[styles.goalMarker, { backgroundColor: theme.colors.onSurface }]} />
                        <View style={{ flex: Math.max(0, 100 - goalPosition) }} />
                    </View>
                </View>
                <View style={styles.chartLabels}>
                    <View style={styles.chartLabelItem}>
                        <View style={[styles.rangeKey, { backgroundColor: rangeColor }]} />
                        <AppText variant="muted">Recent weight trend</AppText>
                    </View>
                    <View style={styles.chartLabelItem}>
                        <View style={[styles.goalKey, { backgroundColor: theme.colors.onSurface }]} />
                        <AppText variant="muted">Your goal</AppText>
                    </View>
                </View>
            </View>
        </View>
    );
};

/** Presents plan-check evidence and requires review before applying an available recommendation. */
export const PlanCheckCardView: React.FC<PlanCheckCardViewProps> = ({
    status,
    hideTitle,
    isLoading = false,
    error = null,
    timezone,
    todayDate,
    onRetry,
    onApplyRecommendation,
    onCancelScheduledChange,
    style,
    ...props
}) => {
    const theme = useAppTheme();
    const themedStyles = React.useMemo(() => createStyles(theme), [theme]);
    const { width, fontScale } = useWindowDimensions();
    const stackLayout = width < COMPACT_LAYOUT_BREAKPOINT || fontScale >= 1.3;
    const stackMetrics = fontScale >= 1.3;
    const [reviewedRecommendationKey, setReviewedRecommendationKey] = useState<string | null>(null);
    const [isApplying, setIsApplying] = useState(false);
    const [applyError, setApplyError] = useState<Error | null>(null);
    const [isCancelling, setIsCancelling] = useState(false);
    const [cancelError, setCancelError] = useState<Error | null>(null);
    const currentLocalDate = useCurrentLocalDate(timezone);
    const evaluation = status?.evaluation;
    const assessment = evaluation?.assessment;
    const recommendation = evaluation?.recommendation;
    const actionableRecommendation = status?.recommendation && recommendation ? recommendation : null;
    // Never silently swap the target while the user is reviewing an earlier recommendation.
    const recommendationKey = actionableRecommendation && status?.recommendation
        ? JSON.stringify([status.recommendation.id, status.recommendation.inputFingerprint, actionableRecommendation])
        : null;
    const isReviewOpen = reviewedRecommendationKey !== null && reviewedRecommendationKey === recommendationKey;
    const scheduledChange = status?.scheduledChange;
    const scheduledChangeIsOnHold = scheduledChange?.dailyCalorieBudgetKcal === null;

    useEffect(() => {
        setCancelError(null);
    }, [scheduledChange?.recommendationId, scheduledChange?.effectiveLocalDate]);

    useEffect(() => {
        if (reviewedRecommendationKey === null || reviewedRecommendationKey === recommendationKey) return;
        setApplyError(null);
        setReviewedRecommendationKey(null);
    }, [recommendationKey, reviewedRecommendationKey]);

    async function applyRecommendation() {
        const recommendationId = status?.recommendation?.id;
        if (!recommendationId || !onApplyRecommendation) {
            setApplyError(new Error('This recommendation is no longer available.'));
            return;
        }
        setIsApplying(true);
        setApplyError(null);
        try {
            await onApplyRecommendation(recommendationId);
            setReviewedRecommendationKey(null);
        } catch (nextError) {
            setApplyError(nextError instanceof Error ? nextError : new Error('Unable to apply this recommendation.'));
            if (nextError instanceof ApiError && nextError.status === 409) onRetry?.();
        } finally {
            setIsApplying(false);
        }
    }

    async function cancelScheduledChange() {
        const recommendationId = status?.scheduledChange?.recommendationId;
        if (!recommendationId || !onCancelScheduledChange) {
            setCancelError(new Error('This scheduled update is no longer available.'));
            return;
        }
        setIsCancelling(true);
        setCancelError(null);
        try {
            await onCancelScheduledChange(recommendationId);
        } catch (nextError) {
            setCancelError(nextError instanceof Error ? nextError : new Error('Unable to undo this scheduled update.'));
            if (nextError instanceof ApiError && nextError.status === 409) onRetry?.();
        } finally {
            setIsCancelling(false);
        }
    }

    if (error && !status) {
        const presentation = getErrorPresentation(error, 'plan check');
        return (
            <AppSection {...props} density="compact" style={style}>
                <PlanCheckHeading hideTitle={hideTitle} metadata="Unable to update" />
                <AppText accessibilityRole="alert" style={themedStyles.error}>{presentation.message}</AppText>
                {presentation.requestId && <AppText variant="caption">Reference: {presentation.requestId}</AppText>}
                {onRetry && <AppButton title="Retry" variant="secondary" onPress={onRetry} />}
            </AppSection>
        );
    }

    if (isLoading || !evaluation) {
        return (
            <AppSection {...props} density="compact" style={style} accessibilityLabel="Loading plan check">
                <PlanCheckHeading hideTitle={hideTitle} metadata="Checking your latest completed day..." />
            </AppSection>
        );
    }

    if (!assessment) {
        return (
            <AppSection {...props} density="compact" style={style}>
                <PlanCheckHeading hideTitle={hideTitle} />
                <AppText variant="muted">This check is not available from your connected server yet.</AppText>
            </AppSection>
        );
    }

    const assessmentWindow = assessment.window;
    const trend = assessment.recentWeightTrendKgPerWeek;
    const paceStatus = assessment.paceStatus;
    const metadata = assessmentWindow
        ? 'Based on ' + assessmentWindow.spanDays + ' days through ' +
            formatDateOnlyForDisplay(assessmentWindow.endDate)
        : 'Updated through ' + formatDateOnlyForDisplay(evaluation.asOfDate);
    const effectiveLocalDate = status?.recommendation?.effectiveLocalDate ?? null;
    const tomorrow = addDaysToDateOnly(todayDate ?? currentLocalDate, 1);
    let effectiveDateLabel = 'on the next local day';
    if (effectiveLocalDate === tomorrow) effectiveDateLabel = 'tomorrow';
    else if (effectiveLocalDate) effectiveDateLabel = 'on ' + formatDateOnlyForDisplay(effectiveLocalDate);

    let decisionMessage = 'No calorie-target change suggested right now.';
    if (assessment.targetDecision === 'waiting') {
        decisionMessage = assessment.targetDecisionBlocker === 'food_history'
            ? 'Keep logging meals before considering a calorie-target change.'
            : 'Keep logging consistently before considering a calorie-target change.';
    } else if (assessment.targetDecision === 'safety_limited') {
        decisionMessage = 'A lower calorie target is not recommended.';
    } else if (assessment.targetDecision === 'policy_unavailable') {
        decisionMessage = 'Automatic calorie-target adjustments are not available for this goal.';
    } else if (assessment.targetDecision === 'change_available') {
        decisionMessage = 'Refresh this check before reviewing a calorie-target adjustment.';
    } else if (assessment.state === 'off_track') {
        decisionMessage = 'Keep your current calorie target for now.';
    }

    const showAdjustment = Boolean(
        assessment.state === 'off_track' &&
        assessment.targetDecision === 'change_available' &&
        actionableRecommendation &&
        !scheduledChange
    );
    const applyTitle = actionableRecommendation
        ? 'Apply ' + actionableRecommendation.recommendedTargetKcal.toLocaleString() + ' kcal'
        : 'Apply suggested target';

    return (
        <>
            <AppSection {...props} density="compact" style={style} testID="plan-check-section">
                <View style={styles.cardBody}>
                    <PlanCheckHeading hideTitle={hideTitle} metadata={metadata} />

                    {scheduledChange && (
                        <View style={[
                            themedStyles.scheduledBanner,
                            scheduledChangeIsOnHold && themedStyles.scheduledBannerWarning
                        ]}>
                            <Ionicons
                                name={scheduledChangeIsOnHold ? 'alert-circle-outline' : 'checkmark-circle-outline'}
                                size={20}
                                color={scheduledChangeIsOnHold ? theme.colors.warning : theme.colors.success}
                            />
                            <View style={styles.scheduledCopy}>
                                <AppText variant="label">
                                    {scheduledChangeIsOnHold ? 'Saved update on hold' : 'Calorie target update scheduled'}
                                </AppText>
                                <AppText variant="caption">
                                    {scheduledChange.dailyCalorieBudgetKcal === null
                                        ? 'No updated target starts until the calorie plan is replaced.'
                                        : scheduledChange.dailyCalorieBudgetKcal.toLocaleString() +
                                            ' kcal/day starts ' +
                                            formatDateOnlyForDisplay(scheduledChange.effectiveLocalDate) + '.'}
                                </AppText>
                            </View>
                            {scheduledChange.recommendationId !== null && (
                                <AppButton
                                    title={isCancelling ? 'Undoing...' : 'Undo'}
                                    accessibilityLabel="Undo scheduled calorie target update"
                                    variant="secondary"
                                    disabled={isCancelling}
                                    accessibilityState={{ busy: isCancelling }}
                                    onPress={() => void cancelScheduledChange()}
                                />
                            )}
                        </View>
                    )}
                    {cancelError && (
                        <AppText accessibilityRole="alert" style={themedStyles.error}>
                            {getSafeActionErrorMessage(cancelError, 'Unable to undo this scheduled update.')}
                        </AppText>
                    )}

                    {assessment.state === 'waiting' ? (
                        <View style={themedStyles.waitingPanel} testID="plan-check-waiting">
                            <View style={styles.statusHeading}>
                                <Ionicons name="time-outline" size={24} color={theme.colors.onSurfaceVariant} />
                                <AppText style={[styles.statusCopy, styles.assessmentTitle]}>{waitingTitle(assessment.blocker)}</AppText>
                            </View>
                            <AppText variant="muted">{waitingDescription(assessment.blocker)}</AppText>
                            <View style={styles.waitingFor}>
                                <AppText variant="caption">Waiting for</AppText>
                                <AppText variant="label">{blockerLabel(assessment.blocker)}</AppText>
                            </View>
                        </View>
                    ) : assessmentWindow && trend && paceStatus ? (
                        <View style={styles.resultBody} testID={'plan-check-' + assessment.state}>
                            <View style={styles.evidenceGroup}>
                                <View style={styles.statusHeading}>
                                    <Ionicons
                                        name={paceIcon(paceStatus)}
                                        size={20}
                                        color={paceStatus === 'aligned' ? theme.colors.success : theme.colors.warning}
                                    />
                                    <View style={styles.statusCopy}>
                                        <AppText style={styles.assessmentTitle}>{paceTitle(paceStatus)}</AppText>
                                        <AppText variant="muted">
                                            This describes the period shown, not a forecast.
                                        </AppText>
                                    </View>
                                </View>

                                <View style={styles.comparisonGroup}>
                                    <View testID="plan-check-metrics" style={[styles.metrics, stackMetrics && styles.metricsStacked]}>
                                        <WeightRateMetric label="Recent weight trend" valueKg={trend.midpoint} unit={evaluation.weightUnit} />
                                        <WeightRateMetric label="Your goal" valueKg={assessment.goalRateKgPerWeek} unit={evaluation.weightUnit} />
                                    </View>
                                    <PaceComparison
                                        interval={trend}
                                        goalRateKgPerWeek={assessment.goalRateKgPerWeek}
                                        status={paceStatus}
                                        unit={evaluation.weightUnit}
                                        startDate={assessmentWindow.startDate}
                                        endDate={assessmentWindow.endDate}
                                    />
                                    <AppText variant="muted">
                                        Likely range: {formatWeightRateRange(trend, evaluation.weightUnit)}
                                    </AppText>
                                </View>
                            </View>

                            {!showAdjustment && !scheduledChange && (
                                <View style={themedStyles.decisionRow}>
                                    <Ionicons
                                        name={assessment.targetDecision === 'safety_limited'
                                            ? 'shield-checkmark-outline'
                                            : 'checkmark-circle-outline'}
                                        size={18}
                                        color={theme.colors.onSurfaceVariant}
                                    />
                                    <AppText variant="label" style={styles.decisionText}>
                                        {decisionMessage}
                                    </AppText>
                                </View>
                            )}

                            {showAdjustment && actionableRecommendation && (
                                <View style={styles.adjustmentGroup} testID="plan-check-adjustment">
                                    <AppText style={styles.assessmentTitle}>
                                        A calorie-target adjustment may help
                                    </AppText>
                                    <View style={[styles.metrics, stackMetrics && styles.metricsStacked]}>
                                        <View style={styles.metric}>
                                            <AppText variant="muted">Current target</AppText>
                                            <AppText style={styles.targetValue}>{actionableRecommendation.currentTargetKcal.toLocaleString()}</AppText>
                                            <AppText variant="muted">kcal/day</AppText>
                                        </View>
                                        <View style={styles.metric}>
                                            <AppText variant="muted">Suggested target</AppText>
                                            <AppText style={[styles.targetValue, { color: theme.colors.primary }]}>{actionableRecommendation.recommendedTargetKcal.toLocaleString()}</AppText>
                                            <AppText variant="muted">kcal/day</AppText>
                                        </View>
                                    </View>
                                    <AppButton
                                        title="Review adjustment"
                                        accessibilityLabel={'Review suggested ' +
                                            actionableRecommendation.recommendedTargetKcal.toLocaleString() +
                                            ' calorie daily target'}
                                        style={styles.reviewAction}
                                        onPress={() => {
                                            setApplyError(null);
                                            setReviewedRecommendationKey(recommendationKey);
                                        }}
                                    />
                                </View>
                            )}
                        </View>
                    ) : null}
                </View>
            </AppSection>

            <BottomSheetModal
                visible={isReviewOpen}
                accessibilityLabel="Review calorie target adjustment"
                title="Review calorie target"
                description={assessmentWindow
                    ? 'Based on your recent weight trend and completed food logs from ' +
                        formatDateOnlyForDisplay(assessmentWindow.startDate) + ' through ' +
                        formatDateOnlyForDisplay(assessmentWindow.endDate) + '.'
                    : undefined}
                showCloseButton
                showHandle={false}
                onRequestClose={() => {
                    setApplyError(null);
                    setReviewedRecommendationKey(null);
                }}
            >
                <View style={styles.sheetContent}>
                    {actionableRecommendation && trend && (
                        <>
                            <View style={themedStyles.reviewMetrics}>
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Recent weight trend</AppText>
                                    <AppText variant="label">
                                        {formatWeightRate(trend.midpoint, evaluation.weightUnit)}
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Likely range</AppText>
                                    <AppText variant="label">
                                        {formatWeightRateRange(trend, evaluation.weightUnit)}
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Your goal</AppText>
                                    <AppText variant="label">
                                        {formatWeightRate(assessment.goalRateKgPerWeek, evaluation.weightUnit)}
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Current calorie target</AppText>
                                    <AppText variant="label">
                                        {actionableRecommendation.currentTargetKcal.toLocaleString()} kcal/day
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Suggested calorie target</AppText>
                                    <AppText variant="label">
                                        {actionableRecommendation.recommendedTargetKcal.toLocaleString()} kcal/day
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Conservative change</AppText>
                                    <AppText variant="label">
                                        {Math.abs(actionableRecommendation.adjustmentStepKcal).toLocaleString() +
                                            ' kcal/day ' +
                                            (actionableRecommendation.adjustmentStepKcal < 0 ? 'lower' : 'higher')}
                                    </AppText>
                                </View>
                                <View style={themedStyles.divider} />
                                <View style={styles.reviewRow}>
                                    <AppText variant="muted">Safety limit</AppText>
                                    <AppText variant="label">
                                        {assessment.minimumDailyCalorieTargetKcal.toLocaleString()} kcal/day minimum
                                    </AppText>
                                </View>
                            </View>
                            <View style={styles.safetyRow}>
                                <Ionicons name="shield-checkmark-outline" size={18} color={theme.colors.primary} />
                                <AppText variant="caption" style={styles.safetyText}>
                                    This is a bounded first step. Your weight goal and goal rate stay the same.
                                    If applied, the new target starts {effectiveDateLabel}.
                                </AppText>
                            </View>
                            {applyError && (
                                <AppText accessibilityRole="alert" style={themedStyles.error}>
                                    {getSafeActionErrorMessage(applyError, 'Unable to apply this recommendation.')}
                                </AppText>
                            )}
                            <View style={[styles.actions, stackLayout && styles.actionsStacked]}>
                                <AppButton
                                    title={isApplying ? 'Applying...' : applyTitle}
                                    disabled={isApplying}
                                    accessibilityState={{ busy: isApplying }}
                                    leftIcon={<Ionicons name="checkmark" size={18} color={theme.colors.onPrimary} />}
                                    onPress={() => void applyRecommendation()}
                                    style={styles.action}
                                />
                                <AppButton
                                    title="Close"
                                    variant="secondary"
                                    disabled={isApplying}
                                    onPress={() => {
                                        setApplyError(null);
                                        setReviewedRecommendationKey(null);
                                    }}
                                    style={styles.action}
                                />
                            </View>
                        </>
                    )}
                </View>
            </BottomSheetModal>
        </>
    );
};

const styles = StyleSheet.create({
    cardBody: { gap: spacing.lg },
    heading: { gap: spacing.xs },
    scheduledCopy: { flex: 1, minWidth: 180, gap: spacing.xs },
    statusHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    assessmentTitle: { ...typeScale.body, fontWeight: '600' },
    waitingFor: { gap: spacing.xs },
    // Group the assessment with its evidence; only the next step gets a larger gap.
    resultBody: { gap: spacing.xl },
    evidenceGroup: { gap: spacing.lg },
    comparisonGroup: { gap: spacing.sm },
    adjustmentGroup: { gap: spacing.md },
    statusCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    metricsStacked: { flexDirection: 'column' },
    metric: { flexGrow: 1, flexBasis: 0, gap: spacing.xs, minWidth: METRIC_MIN_WIDTH },
    metricValue: { ...typeScale.measurement, fontVariant: ['tabular-nums'] },
    targetValue: { ...typeScale.section, fontVariant: ['tabular-nums'] },
    comparison: { gap: spacing.xs },
    trackShell: { height: 34, justifyContent: 'center' },
    track: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2 },
    rangeRow: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center'
    },
    rangeBand: { height: 12, borderRadius: 6 },
    goalRow: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'row',
        alignItems: 'center'
    },
    goalMarker: { width: 2, height: 24, borderRadius: 1 },
    chartLabels: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    chartLabelItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    rangeKey: { width: 20, height: 6, borderRadius: 3 },
    goalKey: { width: 2, height: 14, borderRadius: 1 },
    decisionText: { flex: 1 },
    reviewAction: { width: '100%' },
    sheetContent: { alignSelf: 'center', width: '100%', maxWidth: 760, gap: spacing.md },
    reviewRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md
    },
    safetyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    safetyText: { flex: 1 },
    actions: { flexDirection: 'row', gap: spacing.md },
    actionsStacked: { flexDirection: 'column' },
    action: { flex: 1 }
});

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        waitingPanel: {
            gap: spacing.md,
        },
        decisionRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
        },
        scheduledBanner: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacing.md,
            borderLeftWidth: theme.interaction.focusRingWidth,
            borderLeftColor: theme.colors.success,
            borderRadius: theme.radius.md,
            padding: spacing.md,
            backgroundColor: theme.colors.successContainer
        },
        scheduledBannerWarning: { backgroundColor: theme.colors.warningContainer },
        reviewMetrics: {
            gap: spacing.sm,
        },
        divider: {
            height: StyleSheet.hairlineWidth,
            backgroundColor: theme.colors.outlineVariant
        },
        error: { color: theme.colors.danger }
    });
}
