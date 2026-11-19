/** @file Composes Today's logging, compact goal guidance, and contextual maintenance actions. */

import { useTrackingFood, useTrackingMetrics } from '../../../src/offline/useTrackingQueries';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { MealPeriod } from '@calibrate/shared';
import { AddFoodSheet } from '../../../src/components/AddFoodSheet';
import { AppButton } from '../../../src/components/AppButton';
import { AppText } from '../../../src/components/AppText';
import { AsyncStateBoundary, useOnlineStatus } from '../../../src/components/AsyncStateBoundary';
import { CalorieBalanceCard } from '../../../src/components/CalorieBalanceCard';
import { DateNavigation } from '../../../src/components/DateNavigation';
import { FixedPage, FixedPageColumn } from '../../../src/components/FixedPage';
import { ExpansionRegion } from '../../../src/components/PageExpansion';
import { DayStatusCard, useFoodDayStatus } from '../../../src/components/FoodTrackingStatus';
import { SkeletonBlock } from '../../../src/components/SkeletonBlock';
import { TodayFoodPreview } from '../../../src/today/TodayFoodPreview';
import { GoalCompletionAction } from '../../../src/today/GoalCompletionAction';
import { PausedDayMessage } from '../../../src/today/PausedDayMessage';
import { TodayWeightCard } from '../../../src/components/TodayWeightCard';
import { WeightEntrySheet } from '../../../src/components/WeightEntrySheet';
import { useAuth } from '../../../src/auth/AuthContext';
import { ASYNC_RESOURCE_STATES } from '../../../src/asyncState/resolveAsyncState';
import { useSharedLogDateNavigation } from '../../../src/context/LogDateContext';
import { useAddFoodRequest } from '../../../src/context/AddFoodRequestContext';
import { usePrefetchPreviousFoodLog } from '../../../src/hooks/usePrefetchPreviousFoodLog';
import { getFoodDayCaloriePresentation, shouldShowCalorieComparison } from '../../../src/food/dayPresentation';
import { getCaloriePlanPresentation } from '../../../src/caloriePlanning/presentation';
import { getActiveTabRoute } from '../../../src/navigation/contextualFab';
import { canonicalPathForRoute } from '../../../src/navigation/routeRegistry';
import { useLogDateRouteParameter } from '../../../src/hooks/useLogDateRouteParameter';
import { getMetricDate } from '../../../src/utils/metrics';
import { usePendingWeightMutation } from '../../../src/offline/usePendingWeightMutation';
import { hasTodayDashboardFailure, resolveTodayDashboardState } from '../../../src/today/dashboardState';
import { useBarcodeSearchHandoff } from '../../../src/barcode/useBarcodeSearchHandoff';
import { spacing, useAppTheme } from '../../../src/theme';
import { GoalGuidance, NextGoalChoices } from '../../../src/progress/GoalGuidance';
import { MaintenanceGoalEditor, type GoalEditorIntent, type GoalEditorOptions } from '../../../src/progress/MaintenanceGoalEditor';
import { useGoalStatus } from '../../../src/progress/useGoalStatus';

const FoodLogContent = React.lazy(() => import('../../../src/food/FoodLogContent'));

/** Composes today's calorie comparison, food summary, day status, and contextual logging actions. */
export default function TodayScreen() {
    const theme = useAppTheme();
    const routeParams = useLocalSearchParams<{ openAddFood?: string; date?: string; meal?: string }>();
    const pathname = usePathname();
    const { api, user } = useAuth();
    const dateNavigation = useSharedLogDateNavigation();
    const setLogDate = dateNavigation.setDate;
    const { request: addFoodRequest, consumeRequest: consumeAddFoodRequest } = useAddFoodRequest();
    const selectedDate = dateNavigation.selectedDate;
    const lifecycle = useGoalStatus(dateNavigation.isToday);
    const goalStatus = dateNavigation.isToday ? lifecycle.data : null;
    const [goalEditor, setGoalEditor] = useState<GoalEditorOptions | null>(null);
    const [nextChoicesOpen, setNextChoicesOpen] = useState(false);
    const [addFoodMeal, setAddFoodMeal] = useState<MealPeriod | null | undefined>(undefined);
    const [isWeightEntryOpen, setIsWeightEntryOpen] = useState(false);
    const [isFoodExpanded, setIsFoodExpanded] = useState(false);
    usePrefetchPreviousFoodLog(selectedDate, dateNavigation.minDate);

    const profileQuery = useQuery({ queryKey: ['mobile-profile'], queryFn: () => api.getUserProfile() });
    const foodQuery = useTrackingFood(selectedDate);
    const foodDayQuery = useFoodDayStatus(selectedDate);
    const canAddFood = foodDayQuery.data?.status === 'OPEN';
    const isPaused = foodDayQuery.data?.status === 'PAUSED';
    const metricsQuery = useTrackingMetrics();
    const isOnline = useOnlineStatus();
    const hasPendingWeightChange = usePendingWeightMutation();

    useEffect(() => {
        if (isPaused) setIsFoodExpanded(false);
    }, [isPaused]);

    // A paused day does not need food or calorie-plan data to explain its state.
    const dashboardQueries = isPaused
        ? [foodDayQuery, metricsQuery] as const
        : [profileQuery, foodQuery, foodDayQuery, metricsQuery] as const;
    const failedDashboardQueries = dashboardQueries.filter((query) => query.isError);
    const dashboardHasFailedResource = hasTodayDashboardFailure(dashboardQueries);
    const dashboardState = resolveTodayDashboardState(dashboardQueries, isOnline);
    const retryFailedDashboardResources = React.useCallback(async () => {
        await Promise.all(failedDashboardQueries.map((query) => query.refetch()));
    }, [failedDashboardQueries]);

    useLogDateRouteParameter(routeParams.date, setLogDate);

    useEffect(() => {
        if (!addFoodRequest || getActiveTabRoute(pathname) !== 'today') return;
        const requestDate = addFoodRequest.date ?? selectedDate;
        if (requestDate !== selectedDate) {
            setLogDate(requestDate);
            return;
        }
        if (!canAddFood) return;
        setAddFoodMeal(addFoodRequest.meal ?? null);
        consumeAddFoodRequest(addFoodRequest.id);
    }, [addFoodRequest, canAddFood, consumeAddFoodRequest, pathname, selectedDate, setLogDate]);

    useBarcodeSearchHandoff({
        params: routeParams,
        selectedDate,
        enabled: canAddFood,
        setDate: setLogDate,
        openSheet: setAddFoodMeal,
        scrubParams: (requestDate) => router.setParams({
            date: requestDate,
            meal: undefined,
            openAddFood: undefined
        })
    });

    const entries = foodQuery.data ?? [];
    const calories = entries.reduce((total, entry) => total + entry.calories, 0);
    const calorieSummary = profileQuery.data?.calorieSummary;
    const planStatus = calorieSummary?.planStatus;
    const planIsAvailable = planStatus === 'available' && !hasPendingWeightChange;
    const currentTarget = planIsAvailable ? calorieSummary?.dailyCalorieTarget ?? null : null;
    const planPresentation = getCaloriePlanPresentation(calorieSummary?.planReasonCode, planStatus);
    function openWeightEntry() {
        setIsWeightEntryOpen(true);
    }
    function editGoal(intent: GoalEditorIntent) {
        if (!goalStatus) return;
        setGoalEditor({ status: goalStatus, intent });
    }

    function handlePlanAction() {
        if (planPresentation.actionKind === 'weight') {
            openWeightEntry();
            return;
        }
        if (planPresentation.actionKind === 'profile') {
            router.push(canonicalPathForRoute('profile-details') as Href);
            return;
        }
        router.push({
            pathname: '/progress',
            params: { openPlanReview: 'true' }
        });
    }
    const selectedDateMetric = (metricsQuery.data ?? []).find((metric) => getMetricDate(metric) === selectedDate) ?? null;
    const isToday = dateNavigation.isToday;
    const dayStatus = foodDayQuery.data;
    const comparison = getFoodDayCaloriePresentation({ day: dayStatus, isToday, currentTarget, hasFoodEntries: entries.length > 0 });
    const target = comparison.target;
    const completedGoal = Boolean(goalStatus?.goal?.completed_on);
    const comparisonLabels = {
        saved: 'Compared with saved target', fallback: 'Compared with current target',
        current: completedGoal ? 'Previous calorie plan' : undefined, unavailable: undefined
    };
    const showCalorieComparison = shouldShowCalorieComparison({
        status: dayStatus?.status,
        isToday,
        hasFoodEntries: entries.length > 0
    });
    let unavailableLabel = 'Day unresolved';
    if (dayStatus?.status === 'INCOMPLETE') unavailableLabel = 'Incomplete day';
    if (!planIsAvailable) unavailableLabel = planStatus === 'requires_review' ? 'Plan needs review' : 'Target unavailable';
    if (hasPendingWeightChange) unavailableLabel = 'Rechecking target';
    if (isPaused) unavailableLabel = 'Tracking paused';
    const contentLoading = dashboardState.kind === 'loading';
    if (contentLoading) unavailableLabel = 'Loading day';
    const foodIsUnavailable = foodQuery.data === undefined;
    if (!contentLoading && foodIsUnavailable) unavailableLabel = 'Day unavailable';
    let balanceSupportingLabel: string | undefined;
    if (contentLoading) balanceSupportingLabel = 'Loading your food log';
    else if (foodIsUnavailable) balanceSupportingLabel = 'Food log unavailable';

    const completionAction = completedGoal && <GoalCompletionAction onChoose={() => setNextChoicesOpen(true)} />;
    const goalGuidance = goalStatus?.maintenance && <FixedPageColumn style={styles.goalGuidance}>
        <GoalGuidance status={goalStatus} onEdit={editGoal} onWeighIn={openWeightEntry}
            pending={hasPendingWeightChange} canReview={isOnline && !lifecycle.isError} compact />
    </FixedPageColumn>;

    return (
        <>
        <FixedPage
            testID="today-fixed-page"
            persistentFooter
            fullWidthBody={dashboardState.kind !== ASYNC_RESOURCE_STATES.ERROR}
            minBodyHeight={TODAY_BODY_MIN_HEIGHT}
            containedBody={dashboardState.kind !== ASYNC_RESOURCE_STATES.ERROR}
            expansion={{
                id: isFoodExpanded && !isPaused ? 'food' : null,
                title: 'Food log',
                backLabel: 'Back to Today',
                onClose: () => setIsFoodExpanded(false),
                onRestore: id => setIsFoodExpanded(id === 'food' && !isPaused),
                focused: getActiveTabRoute(pathname) === 'today',
                renderContent: () => <React.Suspense fallback={<TodayContentLoading />}>
                    <FoodLogContent key={selectedDate} embedded />
                </React.Suspense>
            }}
            header={<DateNavigation
                    navigation={dateNavigation}
                    compact
                    unified
                    style={styles.dateNavigation}
                    pickerFooter={(closePicker) => <DayStatusCard date={selectedDate} isToday={isToday} presentation="controls" onActionComplete={closePicker}
                        onPauseTracking={goalStatus?.maintenance ? () => { closePicker(); editGoal('pause'); } : undefined} />}
                />}
            context={<>
                {isPaused && completedGoal && <View style={styles.goalGuidance}>{completionAction}</View>}
                {!isPaused && <>
                <CalorieBalanceCard
                    totalCalories={calories}
                    targetCalories={!contentLoading && !foodIsUnavailable && showCalorieComparison ? target : null}
                    unavailableLabel={unavailableLabel}
                    supportingLabel={balanceSupportingLabel}
                    comparisonLabel={!contentLoading && !foodIsUnavailable && showCalorieComparison
                        ? comparisonLabels[comparison.source]
                        : undefined}
                    contextAction={completionAction}
                    compact
                    open
                />
                {!contentLoading && !foodIsUnavailable && isToday && dayStatus?.status !== 'COMPLETE' && !isPaused && !hasPendingWeightChange && !planIsAvailable && <View style={styles.planAction}>
                    <AppText variant="muted">{planPresentation.message}</AppText>
                    <AppButton title={planPresentation.actionLabel} variant="ghost"
                        onPress={goalStatus?.maintenance && planPresentation.actionKind !== 'weight' && planPresentation.actionKind !== 'profile'
                            ? () => editGoal('budget') : handlePlanAction} />
                </View>}
                </>}
            </>}
            footer={({ enlargedText }) => isPaused && goalStatus?.maintenance ? <View style={styles.maintenanceDock}>
                <AppButton title="Start calorie tracking" variant="secondary" onPress={() => editGoal('enable')} />
            </View> : dayStatus ? <DayStatusCard date={selectedDate} isToday={isToday} failed={dashboardHasFailedResource} loading={contentLoading} stackActions={enlargedText} presentation="dock" onAddFood={canAddFood ? () => setAddFoodMeal(null) : undefined} /> : <View style={styles.loadingActions}>
                <AppButton title="Add food" disabled style={styles.loadingAction} />
                <AppButton title="Complete day" variant="secondary" disabled style={styles.loadingAction} />
            </View>}
        >
            {({ expanded }) => <AsyncStateBoundary
                contentStyle={[styles.body, expanded && styles.bodyExpanded]}
                state={dashboardState}
                resourceLabel="today's log"
                loading={<TodayContentLoading />}
                empty={<TodayContentLoading />}
                onRetry={isOnline && failedDashboardQueries.length > 0
                    ? retryFailedDashboardResources
                    : undefined}
                retrying={failedDashboardQueries.some((query) => query.isFetching)}
                suppressStaleNotice
            >
                {isPaused ? <PausedDayBody expanded={expanded}>
                    {!goalStatus?.maintenance && <PausedDayMessage isToday={isToday} />}
                    {goalGuidance}
                    <TodayWeightCard metric={selectedDateMetric} weightUnit={user?.weight_unit} isToday={isToday} onPress={openWeightEntry} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.outline }} />
                </PausedDayBody> : <>
                    <ExpansionRegion id="weight" order={1}>
                        {goalGuidance}
                        <TodayWeightCard metric={selectedDateMetric} weightUnit={user?.weight_unit} isToday={isToday} onPress={openWeightEntry} />
                    </ExpansionRegion>
                    <ExpansionRegion id="food" order={2} style={[styles.body, expanded && styles.bodyExpanded]}>
                        <TodayFoodPreview entries={entries} expanded={expanded} onPress={() => setIsFoodExpanded(true)} />
                    </ExpansionRegion>
                </>}
            </AsyncStateBoundary>}
        </FixedPage>
            {nextChoicesOpen && goalStatus && <NextGoalChoices status={goalStatus} onClose={() => setNextChoicesOpen(false)} />}
            {goalEditor && <MaintenanceGoalEditor {...goalEditor} onClose={() => setGoalEditor(null)} />}
            <AddFoodSheet
                visible={addFoodMeal !== undefined && canAddFood}
                date={selectedDate}
                initialMeal={addFoodMeal}
                returnTo="today"
                onClose={() => setAddFoodMeal(undefined)}
            />
            <WeightEntrySheet
                visible={isWeightEntryOpen}
                date={selectedDate}
                onClose={() => setIsWeightEntryOpen(false)}
            />
        </>
    );
}

const TODAY_BODY_MIN_HEIGHT = 184; // Reserves the weight row and a usable food pane before falling back to page scrolling.

function PausedDayBody({ expanded, children }: React.PropsWithChildren<{ expanded: boolean }>) {
    if (expanded) return <View>{children}</View>;
    return <ScrollView style={styles.body} contentContainerStyle={styles.pausedBody}>
        {children}
    </ScrollView>;
}

function TodayContentLoading() {
    return <FixedPageColumn testID="log-content-loading" style={styles.body}>
        <View style={styles.loadingWeight}><SkeletonBlock width="40%" height={24} /><SkeletonBlock width="28%" height={16} /></View>
        <View style={styles.loadingFood}><SkeletonBlock width="32%" height={24} /><SkeletonBlock width="90%" height={24} /><SkeletonBlock width="72%" height={20} /></View>
    </FixedPageColumn>;
}

const styles = StyleSheet.create({
    body: { flex: 1, minHeight: 0, gap: 0 },
    bodyExpanded: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
    pausedBody: { flexGrow: 1 },
    dateNavigation: { paddingTop: spacing.xs, paddingBottom: spacing.sm },
    planAction: { paddingBottom: spacing.md, gap: spacing.sm },
    // Match the vertical inset of Today's logging controls.
    goalGuidance: { paddingVertical: spacing.md },
    maintenanceDock: { paddingVertical: spacing.md },
    loadingActions: { flexDirection: 'row', paddingVertical: spacing.md, gap: spacing.sm },
    loadingAction: { flex: 1 },
    loadingWeight: { minHeight: 72, justifyContent: 'center', gap: spacing.xs },
    loadingFood: { paddingTop: spacing.lg, gap: spacing.md }
});
