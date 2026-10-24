import { useTrackingMetrics } from '../../../src/offline/useTrackingQueries';
import { GoalPaceSheet } from '../../../src/progress/GoalPaceSheet';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions, AccessibilityInfo, StyleSheet, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams, usePathname } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CaloriePlanOptionsRequest, GoalEntry } from '@calibrate/api-client';
import { AppButton } from '../../../src/components/AppButton';
import { AppSection } from '../../../src/components/AppSection';
import { AppText } from '../../../src/components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../../../src/components/AsyncStateBoundary';
import { BottomSheetModal } from '../../../src/components/BottomSheetModal';
import { GoalProgressCard } from '../../../src/components/GoalProgressCard';
import { GoalDailyChangeSelect } from '../../../src/components/GoalDailyChangeSelect';
import { WeightValueInput } from '../../../src/components/WeightValueInput';
import { FixedPage } from '../../../src/components/FixedPage';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { getWeightTrendPreviewMinimumHeight } from '../../../src/components/WeightTrendChart';
import { WeightTrendPreviewCard } from '../../../src/components/progress/WeightTrendPreviewCard';
import { PlanCheckSummary } from '../../../src/components/progress/PlanCheckSummary';
import { calibrationStatusQueryKey } from '../../../src/calibration/queryKeys';
import { isNeverEmpty } from '../../../src/asyncState/resolveAsyncState';
import { getCaloriePlanPresentation } from '../../../src/caloriePlanning/presentation';
import { useAuth } from '../../../src/auth/AuthContext';
import { gramsToDisplayWeight } from '../../../src/utils/bodyMeasurements';
import { formatWeightUnit } from '../../../src/utils/format';
import {
    DAILY_GOAL_CHANGE_OPTIONS,
    getGoalModeFromDailyDeficit,
    getSignedDailyDeficit,
    getTargetWeightAfterGoalModeChange,
    GOAL_MODE_OPTIONS,
    type GoalMode
} from '../../../src/utils/goals';
import { getLatestMetric } from '../../../src/utils/metrics';
import { radius, spacing, useAppTheme, type AppTheme } from '../../../src/theme';
import { WEIGHT_INPUT_INCREMENT } from '../../../src/config/inputPrecision';
import { getSafeActionErrorMessage } from '../../../src/errors/presentation';
import { confirmDiscardChanges } from '../../../src/components/confirmDiscardChanges';
import { usePendingWeightMutation } from '../../../src/offline/usePendingWeightMutation';
import {
    getWeightDisplayBounds,
    getWeightPolicyError,
    isWeightWithinPolicy
} from '../../../src/weightEntry/input';

const ProgressExpansionContent = React.lazy(() => import('../../../src/progress/ProgressExpansionContent'));

function formatWeightInput(value: number): string {
    return value.toFixed(1).replace(/\.0$/, '');
}

function getGoalValidationError(
    goalMode: GoalMode,
    startWeight: number,
    targetWeight: number,
    weightUnit: 'KG' | 'LB' | undefined
): string | null {
    if (!Number.isFinite(startWeight) || startWeight <= 0 || !Number.isFinite(targetWeight) || targetWeight <= 0) {
        return 'Enter a valid start and target weight.';
    }
    if (!isWeightWithinPolicy(startWeight, weightUnit) || !isWeightWithinPolicy(targetWeight, weightUnit)) {
        return getWeightPolicyError(weightUnit);
    }

    if (goalMode === 'lose' && targetWeight >= startWeight) {
        return 'For a loss goal, target weight must be below start weight.';
    }

    if (goalMode === 'gain' && targetWeight <= startWeight) {
        return 'For a gain goal, target weight must be above start weight.';
    }

    return null;
}

function getGoalDraftKey(startWeight: string, targetWeight: string, goalMode: GoalMode, dailyChangeAbs: string) {
    return JSON.stringify([startWeight, targetWeight, goalMode, dailyChangeAbs]);
}

export default function ProgressScreen() {
    const pathname = usePathname();
    const [expandedSection, setExpandedSection] = useState<'trend' | 'plan' | null>(null);
    const [trendMinimumHeight, setTrendMinimumHeight] = useState(0);
    const routeParams = useLocalSearchParams<{ openNextGoal?: string; openPlanReview?: string }>();
    const { api, user } = useAuth();
    const theme = useAppTheme();
    const { width: viewportWidth } = useWindowDimensions();
    const { colors: themeColors } = theme;
    const styles = useMemo(() => createStyles(theme), [theme]);
    const queryClient = useQueryClient();
    const goalQuery = useQuery({ queryKey: ['mobile-goal'], queryFn: () => api.getGoals() });
    const profileQuery = useQuery({ queryKey: ['mobile-profile'], queryFn: () => api.getUserProfile() });
    const metricsQuery = useTrackingMetrics();
    const trendSummaryQuery = useQuery({
        queryKey: ['mobile-metrics-trend', 'summary'],
        queryFn: () => api.getTrendMetrics({ range: 'month' })
    });
    const isOnline = useOnlineStatus();
    const hasPendingWeightChange = usePendingWeightMutation();
    const progressQueries = [goalQuery, profileQuery, metricsQuery, trendSummaryQuery] as const;
    const failedProgressQueries = progressQueries.filter((query) => query.isError);
    const allProgressDataResolved = progressQueries.every((query) => query.data !== undefined);
    const failedResourcesHaveUsableCache = failedProgressQueries.every((query) =>
        query.data != null && (!Array.isArray(query.data) || query.data.length > 0)
    );
    const offlineResourcesHaveUsableCache = isOnline || progressQueries.every((query) =>
        query.data != null && (!Array.isArray(query.data) || query.data.length > 0)
    );
    const progressHasUsableData = allProgressDataResolved
        && failedResourcesHaveUsableCache
        && offlineResourcesHaveUsableCache;
    const progressState = useAsyncResourceState({
        data: progressHasUsableData ? true : undefined,
        status: failedProgressQueries.length > 0
            ? 'error'
            : progressQueries.every((query) => query.status === 'success') ? 'success' : 'pending',
        fetchStatus: progressQueries.some((query) => query.fetchStatus === 'paused')
            ? 'paused'
            : progressQueries.some((query) => query.fetchStatus === 'fetching') ? 'fetching' : 'idle',
        error: failedProgressQueries[0]?.error ?? null,
        dataUpdatedAt: progressHasUsableData ? 1 : 0,
        isPlaceholderData: progressQueries.some((query) => query.isPlaceholderData)
    }, () => false);
    const retryFailedProgressResources = async () => {
        await Promise.all(failedProgressQueries.map((query) => query.refetch()));
    };
    const [paceGoal, setPaceGoal] = useState<GoalEntry | null>(null);
    const [isGoalEditorOpen, setIsGoalEditorOpen] = useState(false);
    const [startWeight, setStartWeight] = useState('');
    const [targetWeight, setTargetWeight] = useState('');
    const [goalMode, setGoalMode] = useState<GoalMode>('lose');
    const [dailyChangeAbs, setDailyChangeAbs] = useState('500');
    const [validationError, setValidationError] = useState<string | null>(null);
    const [isDailyChangeSelectorOpen, setIsDailyChangeSelectorOpen] = useState(false);
    const handledNextGoalRouteRef = useRef(false);
    const handledPlanReviewRouteRef = useRef(false);
    const goalDraftBaselineRef = useRef('');
    const targetWeightInputRef = useRef<TextInput>(null);
    const latestMetric = getLatestMetric(metricsQuery.data);
    const latestTrendMetric = getLatestMetric(trendSummaryQuery.data?.metrics);

    const signedDailyDeficit = getSignedDailyDeficit(goalMode, dailyChangeAbs);
    const goalDraftKey = getGoalDraftKey(startWeight, targetWeight, goalMode, dailyChangeAbs);
    const isGoalDraftDirty = isGoalEditorOpen
        && goalDraftBaselineRef.current.length > 0
        && goalDraftKey !== goalDraftBaselineRef.current;
    const hasExplicitDailyChange = goalMode === 'maintain'
        || DAILY_GOAL_CHANGE_OPTIONS.some((value) => String(value) === dailyChangeAbs);
    const goalWeightBounds = getWeightDisplayBounds(user?.weight_unit);
    const caloriePlanDraft = useMemo<CaloriePlanOptionsRequest | null>(() => {
        const profile = profileQuery.data?.profile;
        const parsedStartWeight = Number(startWeight);
        if (
            !profile ||
            !profile.timezone.trim() ||
            !profile.date_of_birth ||
            !profile.sex ||
            !profile.activity_level ||
            profile.height_mm === null ||
            !Number.isFinite(parsedStartWeight)
        ) {
            return null;
        }
        return {
            timezone: profile.timezone,
            date_of_birth: profile.date_of_birth,
            sex: profile.sex,
            activity_level: profile.activity_level,
            height: { unit: 'CM', centimeters: profile.height_mm / 10 },
            weight: { unit: profile.weight_unit, value: parsedStartWeight }
        };
    }, [profileQuery.data?.profile, startWeight]);
    const planOptionsQuery = useQuery({
        queryKey: ['calorie-plan-options', 'goal-editor', caloriePlanDraft],
        queryFn: () => api.getCaloriePlanOptions(caloriePlanDraft!),
        enabled: isGoalEditorOpen && caloriePlanDraft !== null
    });
    const planPreviewState = useAsyncResourceState(planOptionsQuery, isNeverEmpty);
    const selectedPlanOption = hasExplicitDailyChange
        ? planOptionsQuery.data?.planOptions.find((option) => option.dailyDeficit === signedDailyDeficit)
        : undefined;
    const planOptionsAreFresh = isOnline
        && planOptionsQuery.isSuccess
        && !planOptionsQuery.isFetching;
    const goalInputsAreValid = isWeightWithinPolicy(Number(startWeight), user?.weight_unit)
        && isWeightWithinPolicy(Number(targetWeight), user?.weight_unit)
        && hasExplicitDailyChange;
    const serverPlanIsAvailable = !hasPendingWeightChange
        && planOptionsAreFresh
        && planOptionsQuery.data?.eligibility.status === 'eligible'
        && selectedPlanOption?.available === true;
    const canSave = goalInputsAreValid && serverPlanIsAvailable;
    const canAttemptSave = !goalInputsAreValid || serverPlanIsAvailable;
    const saveGoal = useMutation({
        mutationFn: () =>
            api.createGoal({
                start_weight: Number(startWeight),
                target_weight: Number(targetWeight),
                daily_deficit: signedDailyDeficit
            }),
        onSuccess: async () => {
            setValidationError(null);
            setIsGoalEditorOpen(false);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['mobile-goal'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-metrics-trend'] }),
                queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey })
            ]);
        }
    });

    function handleSave() {
        const error = getGoalValidationError(
            goalMode,
            Number(startWeight),
            Number(targetWeight),
            user?.weight_unit
        );
        setValidationError(error);
        if (error) {
            targetWeightInputRef.current?.focus();
            AccessibilityInfo.announceForAccessibility(error);
            return;
        }
        if (hasPendingWeightChange) {
            setValidationError('Wait for the queued weight change to sync before replacing your calorie plan.');
            return;
        }
        if (!planOptionsAreFresh) {
            setValidationError(isOnline
                ? 'Retry the calorie plan check before saving.'
                : 'Reconnect to check the calorie plan before saving.');
            return;
        }
        if (planOptionsQuery.data?.eligibility.status !== 'eligible') {
            setValidationError(getCaloriePlanPresentation(
                planOptionsQuery.data?.eligibility.reasonCode ?? 'SERVER_POLICY_UNAVAILABLE'
            ).message);
            return;
        }
        if (selectedPlanOption?.available !== true) {
            setValidationError('Choose an available daily calorie change.');
            return;
        }
        saveGoal.mutate();
    }

    const getDefaultStartWeight = useCallback((): string => {
        const latestWeight = latestMetric?.weight;
        if (typeof latestWeight === 'number' && Number.isFinite(latestWeight)) {
            return formatWeightInput(latestWeight);
        }

        const trendWeight = latestTrendMetric?.trend_weight;
        if (typeof trendWeight === 'number' && Number.isFinite(trendWeight)) {
            return formatWeightInput(trendWeight);
        }

        if (profileQuery.data?.latest_weight_grams && user?.weight_unit) {
            return gramsToDisplayWeight(profileQuery.data.latest_weight_grams, user.weight_unit);
        }

        return goalQuery.data ? formatWeightInput(goalQuery.data.start_weight) : '';
    }, [goalQuery.data, latestMetric?.weight, latestTrendMetric?.trend_weight, profileQuery.data?.latest_weight_grams, user?.weight_unit]);

    function editCurrentGoal() {
        const currentGoal = goalQuery.data;
        if (currentGoal?.plan_status === 'available' && currentGoal.daily_deficit !== 0) {
            setPaceGoal(currentGoal);
            return;
        }
        openGoalEditor();
    }

    const openGoalEditor = useCallback(() => {
        const currentGoal = goalQuery.data;
        const nextStartWeight = getDefaultStartWeight();
        const nextTargetWeight = currentGoal ? formatWeightInput(currentGoal.target_weight) : '';
        const nextMode = getGoalModeFromDailyDeficit(currentGoal?.daily_deficit);
        const nextDailyChange = String(Math.abs(currentGoal?.daily_deficit ?? 500) || 500);
        setStartWeight(nextStartWeight);
        setTargetWeight(nextTargetWeight);
        setGoalMode(nextMode);
        setDailyChangeAbs(nextDailyChange);
        goalDraftBaselineRef.current = getGoalDraftKey(nextStartWeight, nextTargetWeight, nextMode, nextDailyChange);
        setValidationError(null);
        setIsDailyChangeSelectorOpen(false);
        setIsGoalEditorOpen(true);
    }, [getDefaultStartWeight, goalQuery.data]);

    const openNextGoalEditor = useCallback(() => {
        const latestWeight = getDefaultStartWeight();
        const nextTargetWeight = getTargetWeightAfterGoalModeChange('maintain', latestWeight, '');
        setStartWeight(latestWeight);
        setTargetWeight(nextTargetWeight);
        setGoalMode('maintain');
        setDailyChangeAbs('500');
        goalDraftBaselineRef.current = getGoalDraftKey(latestWeight, nextTargetWeight, 'maintain', '500');
        setValidationError(null);
        setIsDailyChangeSelectorOpen(false);
        setIsGoalEditorOpen(true);
    }, [getDefaultStartWeight]);

    async function requestGoalEditorClose() {
        if (!isGoalDraftDirty || await confirmDiscardChanges()) setIsGoalEditorOpen(false);
    }

    function handleGoalModeChange(nextMode: GoalMode) {
        setGoalMode(nextMode);
        setTargetWeight((currentTarget) =>
            getTargetWeightAfterGoalModeChange(nextMode, startWeight, currentTarget)
        );
        setIsDailyChangeSelectorOpen(false);
    }

    useEffect(() => {
        if (goalMode === 'maintain' || !dailyChangeAbs || !planOptionsQuery.data) return;
        if (selectedPlanOption?.available !== true) {
            setDailyChangeAbs('');
            setIsDailyChangeSelectorOpen(false);
        }
    }, [dailyChangeAbs, goalMode, planOptionsQuery.data, selectedPlanOption?.available]);

    useEffect(() => {
        if (routeParams.openNextGoal !== 'true') {
            handledNextGoalRouteRef.current = false;
            return;
        }
        if (handledNextGoalRouteRef.current || !getDefaultStartWeight()) return;
        handledNextGoalRouteRef.current = true;
        openNextGoalEditor();
    }, [getDefaultStartWeight, openNextGoalEditor, routeParams.openNextGoal]);

    useEffect(() => {
        if (routeParams.openPlanReview !== 'true') {
            handledPlanReviewRouteRef.current = false;
            return;
        }
        if (handledPlanReviewRouteRef.current || !getDefaultStartWeight()) return;
        handledPlanReviewRouteRef.current = true;
        openGoalEditor();
    }, [getDefaultStartWeight, openGoalEditor, routeParams.openPlanReview]);

    return (
        <>
            <FixedPage
                testID="progress-fixed-page"
                scrollWhenShort
                minBodyHeight={Math.max(getWeightTrendPreviewMinimumHeight(viewportWidth), trendMinimumHeight)}
                bodyExpansionId="trend"
                footerExpansionId="plan"
                expansion={{
                    id: expandedSection,
                    title: expandedSection === 'plan' ? 'Plan check' : 'Trend',
                    backLabel: 'Back to Progress',
                    onClose: () => setExpandedSection(null),
                    onRestore: id => { if (id === 'trend' || id === 'plan') setExpandedSection(id); },
                    focused: pathname === '/progress',
                    renderContent: section => <React.Suspense fallback={<View style={styles.snapshotLoading}><SkeletonBlock height={120} /></View>}>
                        <ProgressExpansionContent section={section} />
                    </React.Suspense>
                }}
                context={(
                    <AsyncStateBoundary
                        state={progressState}
                        resourceLabel="goal progress"
                        loading={(
                            <AppSection density="compact" testID="progress-loading" style={styles.snapshotLoading}>
                                <SkeletonBlock width="42%" height={30} />
                                <SkeletonBlock height={72} />
                                <SkeletonBlock height={16} />
                            </AppSection>
                        )}
                        empty={null}
                        onRetry={isOnline && failedProgressQueries.length > 0
                            ? retryFailedProgressResources
                            : undefined}
                        retrying={failedProgressQueries.some((query) => query.isFetching)}
                        suppressStaleNotice
                    >
                        <GoalProgressCard
                            testID="progress-snapshot-card"
                            latestMetric={latestMetric}
                            metrics={metricsQuery.data}
                            goal={goalQuery.data}
                            user={user}
                            onEditGoal={editCurrentGoal}
                            onSetNextGoal={openNextGoalEditor}
                            weightChangePending={hasPendingWeightChange}
                            targetCalories={!hasPendingWeightChange && profileQuery.data?.calorieSummary.planStatus === 'available'
                                ? profileQuery.data.calorieSummary.dailyCalorieTarget
                                : null}
                        />
                    </AsyncStateBoundary>
                )}
                fullWidthFooter
                fullWidthBody
                footer={<PlanCheckSummary
                    onPress={() => setExpandedSection('plan')}
                    planAvailable={profileQuery.data ? profileQuery.data.calorieSummary.planStatus === 'available' : undefined}
                />}
            >
                {({ expanded }) => <WeightTrendPreviewCard
                    expanded={expanded}
                    onMinimumHeightChange={setTrendMinimumHeight}
                    suppressStaleNotice
                    onPress={() => setExpandedSection('trend')}
                    onLogWeight={() => router.push('/weight')}
                />}
            </FixedPage>

            {paceGoal && <GoalPaceSheet
                goal={paceGoal}
                onClose={() => setPaceGoal(null)}
                onStartNewGoal={() => {
                    setPaceGoal(null);
                    openGoalEditor();
                }}
            />}
            <BottomSheetModal
                visible={isGoalEditorOpen}
                accessibilityLabel="Set a new goal"
                title="Set a new goal"
                description={`Weights are entered in ${formatWeightUnit(user?.weight_unit)}.`}
                showCloseButton
                dismissDisabled={saveGoal.isPending}
                isDirty={isGoalDraftDirty}
                confirmDismiss={confirmDiscardChanges}
                onRequestClose={() => setIsGoalEditorOpen(false)}
            >
                <SegmentedControl accessibilityLabel="Goal direction" options={GOAL_MODE_OPTIONS} value={goalMode} onChange={handleGoalModeChange} />
                <View style={styles.goalEditorBody}>
                    <View style={styles.startingContext}>
                        <Ionicons name="scale-outline" size={18} color={themeColors.primary} />
                        <View style={styles.startingText}>
                            <AppText variant="label">Starting from</AppText>
                            <AppText style={styles.startingValue}>
                                {startWeight ? `${startWeight} ${formatWeightUnit(user?.weight_unit)}` : 'Log a current weight first'}
                            </AppText>
                        </View>
                    </View>
                    <WeightValueInput
                        label="Target"
                        value={targetWeight}
                        unit={user?.weight_unit}
                        inputRef={targetWeightInputRef}
                        onChangeText={setTargetWeight}
                        step={WEIGHT_INPUT_INCREMENT}
                        min={goalWeightBounds.minimum}
                        max={goalWeightBounds.maximum}
                        editable={!saveGoal.isPending}
                        helperText="Use one decimal place to set a precise goal."
                    />
                    <View style={styles.dailyChangeSlot}>
                        <AppText variant="label">Daily calorie change</AppText>
                        {goalMode === 'maintain' ? (
                            <View style={styles.maintenanceNote}>
                                <AppText variant="muted">Maintenance goals use a steady calorie target with no daily deficit or surplus.</AppText>
                            </View>
                        ) : (
                            <GoalDailyChangeSelect
                                goalMode={goalMode}
                                value={dailyChangeAbs}
                                isOpen={isDailyChangeSelectorOpen}
                                onToggle={() => setIsDailyChangeSelectorOpen((current) => !current)}
                                onChange={(nextValue) => {
                                    setDailyChangeAbs(nextValue);
                                    setIsDailyChangeSelectorOpen(false);
                                }}
                                planOptions={planOptionsQuery.data?.planOptions}
                            />
                        )}
                    </View>
                    {caloriePlanDraft === null ? (
                        <AppText variant="muted">Complete your profile and log a current weight to check safe calorie plans.</AppText>
                    ) : (
                        <AsyncStateBoundary
                            state={planPreviewState}
                            resourceLabel="calorie plan options"
                            loading={<AppText variant="muted">Checking available calorie plans...</AppText>}
                            empty={<AppText variant="muted">No calorie plan options are available.</AppText>}
                            onRetry={isOnline ? () => planOptionsQuery.refetch() : undefined}
                            retrying={planOptionsQuery.isFetching}
                        >
                            {planOptionsQuery.data && (
                                planOptionsQuery.data.eligibility.status === 'eligible' ? (
                                    <AppText variant="muted">
                                        {selectedPlanOption?.dailyCalorieTarget
                                            ? `Server target: ${selectedPlanOption.dailyCalorieTarget.toLocaleString()} kcal/day. Minimum: ${planOptionsQuery.data.minimumDailyCalorieTarget?.toLocaleString() ?? '-'} kcal/day.`
                                            : 'Choose an available option to see the server-calculated target.'}
                                    </AppText>
                                ) : (
                                    <AppText accessibilityRole="alert" style={styles.error}>
                                        {getCaloriePlanPresentation(
                                            planOptionsQuery.data.eligibility.reasonCode
                                        ).message}
                                    </AppText>
                                )
                            )}
                        </AsyncStateBoundary>
                    )}
                </View>
                {(validationError || saveGoal.error) && (
                    <AppText accessibilityRole="alert" style={styles.error}>
                        {validationError ?? getSafeActionErrorMessage(saveGoal.error, 'Unable to save this goal.')}
                    </AppText>
                )}
                <View style={styles.row}>
                    <AppButton
                        title="Cancel"
                        variant="secondary"
                        leftIcon={<Ionicons name="close" size={18} color={themeColors.onSurface} />}
                        onPress={() => { void requestGoalEditorClose(); }}
                        style={styles.rowField}
                    />
                    <AppButton
                        title={saveGoal.isPending ? 'Saving...' : 'Save goal'}
                        accessibilityHint={canSave ? undefined : 'Checks the goal fields and explains what needs attention.'}
                        disabled={!canAttemptSave || saveGoal.isPending}
                        leftIcon={<Ionicons name="flag-outline" size={18} color={themeColors.onPrimary} />}
                        onPress={handleSave}
                        style={styles.rowField}
                    />
                </View>
            </BottomSheetModal>

        </>
    );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    snapshotLoading: {
        paddingVertical: spacing.md,
        gap: spacing.md
    },
    row: {
        flexDirection: 'row',
        gap: spacing.md
    },
    rowField: {
        flex: 1
    },
    goalEditorBody: {
        minHeight: 254,
        gap: spacing.md
    },
    dailyChangeSlot: {
        minHeight: 98,
        gap: spacing.sm
    },
    maintenanceNote: {
        borderRadius: radius.md,
        backgroundColor: theme.colors.surfaceContainer,
        padding: spacing.md
    },
    startingContext: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderRadius: radius.md,
        backgroundColor: theme.colors.primaryContainer,
        borderColor: theme.colors.outlineVariant,
        borderWidth: StyleSheet.hairlineWidth,
        padding: spacing.md
    },
    startingText: {
        flex: 1,
        minWidth: 0
    },
    startingValue: {
        color: theme.colors.onPrimaryContainer,
        fontWeight: '900'
    },
    error: {
        color: theme.colors.danger
    }
});
