import { findFailedMetric } from '../offline/failedMutationRecovery';
import { FailedMutationRecovery } from '../offline/FailedChangeRecoveryPanel';
import { useTrackingMetrics } from '../offline/useTrackingQueries';
import { localTarget } from '../offline/trackingProjection';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    Keyboard,
    Platform,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    View
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
    MetricEntry,
    MetricProgressUpdate,
    MetricSaveResponse
} from '@calibrate/api-client';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { AsyncRetryLiveStatus, useOnlineStatus } from './AsyncStateBoundary';
import { BottomSheetModal } from './BottomSheetModal';
import { SectionHeader } from './SectionHeader';
import { WeightSaveResult } from '../weightEntry/WeightSaveResult';
import { WeightValueInput } from './WeightValueInput';
import {
    formatWeightInput,
    getWeightDisplayBounds,
    getWeightPolicyError,
    isWeightOutlier,
    isWeightWithinPolicy,
    parseWeightInput
} from '../weightEntry/input';
import { useAuth } from '../auth/AuthContext';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { useOfflineOutbox } from '../offline/provider';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { useReducedMotionPreference } from '../hooks/useReducedMotionPreference';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { formatWeight, formatWeightUnit } from '../utils/format';
import { triggerHapticFeedback } from '../utils/haptics';
import { getMetricDate } from '../utils/metrics';
import { spacing, useAppTheme } from '../theme';
import { WEIGHT_INPUT_INCREMENT } from '../config/inputPrecision';
import { getErrorPresentation, getSafeActionErrorMessage } from '../errors/presentation';
import { confirmDiscardChanges } from './confirmDiscardChanges';

type WeightEntrySheetProps = {
    visible: boolean;
    date: string;
    onClose: () => void;
    onSaved?: () => void;
};

type SheetPhase =
    | 'loading'
    | 'editing'
    | 'outlier-confirm'
    | 'saving'
    | 'synced-result'
    | 'queued-result'
    | 'delete-confirm';

type ResultState = {
    action: 'save' | 'delete';
    queued: boolean;
    savedWeight?: number;
    progressUpdate?: MetricProgressUpdate;
};

function findMetricOnOrBeforeDate(metrics: MetricEntry[], targetDate: string): MetricEntry | null {
    const sorted = metrics.slice().sort((a, b) => getMetricDate(b).localeCompare(getMetricDate(a)));
    return sorted.find((metric) => getMetricDate(metric) <= targetDate) ?? null;
}

/** Focused two-stage weigh-in sheet shared by Today and deep-linked weight routes. */
export const WeightEntrySheet: React.FC<WeightEntrySheetProps> = ({ visible, date, onClose, onSaved }) => {
    const theme = useAppTheme();
    const { fontScale } = useWindowDimensions();
    const footerRowStyle = [styles.footerRow, fontScale >= 1.3 && styles.footerRowStacked];
    const { colors } = theme;
    const { api, user } = useAuth();
    const { enqueue, withOutbox, mutations = [] } = useOfflineOutbox();
    const failedWeight = findFailedMetric(mutations, date);
    const queryClient = useQueryClient();
    const reduceMotion = useReducedMotionPreference();
    const isOnline = useOnlineStatus();
    const resultHeadingRef = useRef<View>(null);
    const [phase, setPhase] = useState<SheetPhase>('loading');
    const [pendingAction, setPendingAction] = useState<'save' | 'delete'>('save');
    const [weight, setWeight] = useState('');
    const [validationError, setValidationError] = useState<string | null>(null);
    const [result, setResult] = useState<ResultState | null>(null);
    const weightUnit = formatWeightUnit(user?.weight_unit);

    const metricsQuery = useTrackingMetrics(visible);
    const trendQuery = useQuery({
        queryKey: ['mobile-metrics-trend', 'month'],
        queryFn: () => api.getTrendMetrics({ range: 'month' }),
        enabled: visible && phase === 'synced-result' && result?.action === 'save'
    });

    const existingMetric = useMemo(() => {
        return (metricsQuery.data ?? []).find((metric) => getMetricDate(metric) === date) ?? null;
    }, [date, metricsQuery.data]);

    const prefillMetric = useMemo(() => {
        if (existingMetric) return existingMetric;
        return findMetricOnOrBeforeDate(metricsQuery.data ?? [], date);
    }, [date, existingMetric, metricsQuery.data]);

    const refreshWeightQueries = useCallback(() => {
        void Promise.allSettled([
            queryClient.invalidateQueries({ queryKey: ['mobile-metrics'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-metrics-trend'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-goal'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-in-app-notifications'] }),
            queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey })
        ]);
    }, [queryClient]);

    const addWeight = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: () => {
            if (failedWeight) throw new Error('Resolve the failed weight change before saving a correction.');
            const parsedWeight = parseWeightInput(weight);
            if (parsedWeight === null) throw new Error('Enter a valid weight greater than zero.');
            if (!isWeightWithinPolicy(parsedWeight, user?.weight_unit)) {
                throw new Error(getWeightPolicyError(user?.weight_unit));
            }
            const payload = { weight: parsedWeight, date };
            return executeOrQueueMutation<MetricSaveResponse>({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.ADD_METRIC,
                payload,
                execute: (operationId) => api.addMetric(payload, operationId),
                enqueue
            });
        },
        onSuccess: (mutationResult) => {
            const queued = mutationResult.disposition === 'queued';
            const response = queued ? undefined : mutationResult.value;
            const savedWeight = response?.weight ?? parseWeightInput(weight) ?? undefined;
            Keyboard.dismiss();
            setResult({
                action: 'save',
                queued,
                savedWeight,
                progressUpdate: response?.progress_update
            });
            setPhase(queued ? 'queued-result' : 'synced-result');
            triggerHapticFeedback(user?.haptics_enabled, 'success');
            refreshWeightQueries();
            onSaved?.();
        },
        onError: () => setPhase('editing')
    });

    const deleteWeight = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: () => {
            if (failedWeight) throw new Error('Resolve the failed weight change before deleting this weigh-in.');
            if (!existingMetric) throw new Error('No weight entry exists for this day.');
            const payload = { ...localTarget(existingMetric), date };
            return executeOrQueueMutation({
                withOutbox,
                forceQueue: mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.DELETE_METRIC,
                payload,
                execute: (operationId) => api.deleteMetric(existingMetric.id, operationId),
                enqueue
            });
        },
        onSuccess: (mutationResult) => {
            const queued = mutationResult.disposition === 'queued';
            Keyboard.dismiss();
            setWeight('');
            setResult({ action: 'delete', queued });
            setPhase(queued ? 'queued-result' : 'synced-result');
            triggerHapticFeedback(user?.haptics_enabled, 'warning');
            refreshWeightQueries();
            onSaved?.();
        },
        onError: () => setPhase('delete-confirm')
    });

    const { reset: resetAddWeight } = addWeight;
    const { reset: resetDeleteWeight } = deleteWeight;
    useEffect(() => {
        if (!visible) return;
        setPhase('loading');
        setPendingAction('save');
        setValidationError(null);
        setResult(null);
        resetAddWeight();
        resetDeleteWeight();
    }, [date, resetAddWeight, resetDeleteWeight, visible]);

    useEffect(() => {
        const hasUsableMetrics = Boolean(metricsQuery.data && metricsQuery.data.length > 0);
        if (!visible || phase !== 'loading' || metricsQuery.isLoading) return;
        if ((!isOnline || metricsQuery.isError) && !hasUsableMetrics) return;
        setWeight(prefillMetric ? formatWeightInput(prefillMetric.weight) : '');
        setPhase('editing');
    }, [isOnline, metricsQuery.data, metricsQuery.isError, metricsQuery.isLoading, phase, prefillMetric, visible]);

    useEffect(() => {
        if (phase !== 'synced-result' && phase !== 'queued-result') return;
        const announcement = result?.action === 'delete'
            ? (result.queued ? 'Deletion saved on this device.' : 'Weigh-in deleted.')
            : (result?.queued ? 'Weight saved on this device.' : 'Weight saved. Progress updated.');
        const timer = setTimeout(() => {
            try {
                if (Platform.OS !== 'web') {
                    const node = findNodeHandle(resultHeadingRef.current);
                    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
                }
                AccessibilityInfo.announceForAccessibility(announcement);
            } catch {
                // Accessibility APIs are best-effort on partial web implementations.
            }
        }, reduceMotion ? 0 : 120);
        return () => clearTimeout(timer);
    }, [phase, reduceMotion, result?.action, result?.queued]);

    const parsedWeight = parseWeightInput(weight);
    const weightBounds = getWeightDisplayBounds(user?.weight_unit);
    const weightRangeError = parsedWeight !== null && !isWeightWithinPolicy(parsedWeight, user?.weight_unit)
        ? getWeightPolicyError(user?.weight_unit)
        : null;
    const didReachGoal = result?.action === 'save' && result.progressUpdate?.recognitions.some(
        (recognition) => recognition.type === 'goal_reached'
    ) === true;
    const isUnchanged = Boolean(
        existingMetric
        && parsedWeight !== null
        && Math.abs(parsedWeight - existingMetric.weight) < WEIGHT_INPUT_INCREMENT / 2
    );
    const canSave = !failedWeight && parsedWeight !== null && weightRangeError === null && !isUnchanged;
    const isBusy = phase === 'saving' || addWeight.isPending || deleteWeight.isPending;
    const initialWeight = prefillMetric ? formatWeightInput(prefillMetric.weight) : '';
    const hasUnsavedWeight = phase === 'editing' && weight !== initialWeight;
    const loadError = metricsQuery.error
        ? getErrorPresentation(metricsQuery.error, 'weigh-ins').message
        : !isOnline && metricsQuery.data ? 'Offline - using saved weigh-ins.' : null;
    const saveError = addWeight.error
        ? getSafeActionErrorMessage(addWeight.error, 'Unable to save this weigh-in.')
        : null;
    const deleteError = deleteWeight.error
        ? getSafeActionErrorMessage(deleteWeight.error, 'Unable to delete this weigh-in.')
        : null;
    const metricsUnavailable = (!isOnline || metricsQuery.isError)
        && !(metricsQuery.data && metricsQuery.data.length > 0);

    function mutateWeight() {
        setPendingAction('save');
        setValidationError(null);
        addWeight.reset();
        setPhase('saving');
        addWeight.mutate();
    }

    function handleSaveAttempt() {
        Keyboard.dismiss();
        if (parsedWeight === null) {
            setValidationError(`Enter a valid weight in ${weightUnit}.`);
            return;
        }
        if (weightRangeError) {
            setValidationError(weightRangeError);
            return;
        }
        if (isUnchanged) return;
        if (isWeightOutlier({
            value: parsedWeight,
            previousValue: prefillMetric?.weight ?? null,
            unit: user?.weight_unit
        })) {
            setPhase('outlier-confirm');
            return;
        }
        mutateWeight();
    }

    function handleDelete() {
        setPendingAction('delete');
        deleteWeight.reset();
        setPhase('saving');
        deleteWeight.mutate();
    }

    function handleClose() {
        if (isBusy) return;
        onClose();
    }

    function handleEditResult() {
        setValidationError(null);
        addWeight.reset();
        if (typeof result?.savedWeight === 'number') setWeight(formatWeightInput(result.savedWeight));
        setPhase('editing');
    }

    function handleViewProgress() {
        onClose();
        router.replace('/progress');
    }

    function handleSetNextGoal() {
        onClose();
        router.replace({ pathname: '/progress', params: { openNextGoal: 'true' } });
    }

    const closeButton = !isBusy && (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close weight entry"
            onPress={handleClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
        >
            <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>
    );

    let content: React.ReactNode;
    if (phase === 'loading' && metricsUnavailable) {
        const presentation = getErrorPresentation(metricsQuery.error, 'weigh-ins');
        content = (
            <>
                <SheetHeader title="Log weight" description={`${formatDateOnlyForDisplay(date)} | ${weightUnit}`} action={closeButton} />
                <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                    {isOnline ? presentation.message : 'Connect to load your weigh-ins, then try again.'}
                </AppText>
                {presentation.requestId && <AppText variant="caption">Reference: {presentation.requestId}</AppText>}
                {isOnline && (
                    <AppButton
                        title={metricsQuery.isFetching ? 'Retrying...' : 'Retry weigh-ins'}
                        variant="secondary"
                        disabled={metricsQuery.isFetching}
                        accessibilityState={{ busy: metricsQuery.isFetching }}
                        onPress={() => void metricsQuery.refetch()}
                    />
                )}
                <AsyncRetryLiveStatus retrying={metricsQuery.isFetching} resourceLabel="weigh-ins" />
            </>
        );
    } else if (phase === 'loading') {
        content = (
            <>
                <SheetHeader title="Log weight" description={`${formatDateOnlyForDisplay(date)} | ${weightUnit}`} action={closeButton} />
                <View style={styles.loadingValue} />
                <AppText variant="muted">Loading your latest weigh-in...</AppText>
            </>
        );
    } else if (phase === 'outlier-confirm') {
        content = (
            <>
                <SheetHeader title="Check this weight" description={formatDateOnlyForDisplay(date)} action={closeButton} />
                <View style={styles.confirmationCard}>
                    <Ionicons name="alert-circle-outline" size={28} color={colors.warning} />
                    <AppText variant="subtitle">Is {formatWeight(parsedWeight, user?.weight_unit)} correct?</AppText>
                    <AppText variant="muted" style={styles.centeredText}>
                        This is a larger change from {prefillMetric
                            ? formatWeight(prefillMetric.weight, user?.weight_unit)
                            : 'your previous weigh-in'}. Check the number and unit before saving.
                    </AppText>
                </View>
            </>
        );
    } else if (phase === 'delete-confirm') {
        content = (
            <>
                <SheetHeader title="Delete this weigh-in?" description={formatDateOnlyForDisplay(date)} action={closeButton} />
                <View style={styles.confirmationCard}>
                    <Ionicons name="trash-outline" size={28} color={colors.danger} />
                    <AppText variant="subtitle">{formatWeight(existingMetric?.weight, user?.weight_unit)}</AppText>
                    <AppText variant="muted" style={styles.centeredText}>
                        Your trend and goal progress will update. This cannot be undone.
                    </AppText>
                </View>
                {deleteError && <LiveError message={deleteError} color={colors.danger} />}
            </>
        );
    } else if (phase === 'saving') {
        content = (
            <>
                <SheetHeader
                    title={pendingAction === 'delete' ? 'Deleting weigh-in...' : 'Saving weigh-in...'}
                    description={formatDateOnlyForDisplay(date)}
                />
                <View style={styles.savingState} accessibilityLiveRegion="polite">
                    <Ionicons name="sync-outline" size={30} color={colors.primary} />
                    <AppText variant="muted">
                        {pendingAction === 'save' ? 'Updating your trend and goal progress...' : 'Recalculating your progress...'}
                    </AppText>
                </View>
            </>
        );
    } else if ((phase === 'synced-result' || phase === 'queued-result') && result) {
        content = (
            <>
                <View style={styles.resultCloseRow}>{closeButton}</View>
                <WeightSaveResult
                    action={result.action}
                    queued={result.queued}
                    savedWeight={result.savedWeight}
                    unit={user?.weight_unit}
                    progressUpdate={result.progressUpdate}
                    trend={trendQuery.data}
                    trendLoading={trendQuery.isLoading || trendQuery.isFetching}
                    trendError={trendQuery.error
                        ? getErrorPresentation(trendQuery.error, 'weight trend').message
                        : null}
                    reduceMotion={reduceMotion}
                    headingRef={resultHeadingRef}
                />
                {!result.queued && result.action === 'save' && (
                    <AppButton title="Edit weight" variant="ghost" onPress={handleEditResult} />
                )}
            </>
        );
    } else {
        content = (
            <>
                <SheetHeader title="Log weight" description={`${formatDateOnlyForDisplay(date)} | ${weightUnit}`} action={closeButton} />
                {existingMetric && (
                    <AppText variant="muted">Editing the weigh-in already saved for this day.</AppText>
                )}
                {!existingMetric && prefillMetric && (
                    <AppText variant="muted">
                        Using your last weigh-in from {formatDateOnlyForDisplay(getMetricDate(prefillMetric))}.
                    </AppText>
                )}
                <WeightValueInput
                    value={weight}
                    unit={user?.weight_unit}
                    step={WEIGHT_INPUT_INCREMENT}
                    min={weightBounds.minimum}
                    max={weightBounds.maximum}
                    editable={!isBusy}
                    onChangeText={(nextWeight) => {
                        setWeight(nextWeight);
                        setValidationError(null);
                    }}
                    onStep={() => triggerHapticFeedback(user?.haptics_enabled, 'selection')}
                    onSubmitEditing={handleSaveAttempt}
                />
                {(validationError || weightRangeError || loadError || saveError || deleteError) && (
                    <LiveError
                        message={validationError ?? weightRangeError ?? loadError ?? saveError ?? deleteError ?? 'Unable to save weight.'}
                        color={colors.danger}
                    />
                )}
                {existingMetric && (
                    <AppButton
                        title="Delete weigh-in"
                        variant="ghost"
                        disabled={isBusy || Boolean(failedWeight)}
                        leftIcon={<Ionicons name="trash-outline" size={18} color={colors.danger} />}
                        onPress={() => setPhase('delete-confirm')}
                    />
                )}
            </>
        );
    }

    let footer: React.ReactNode = null;
    if (phase === 'editing') {
        footer = (
            <View style={footerRowStyle}>
                <AppButton title="Cancel" variant="secondary" onPress={handleClose} style={styles.footerButton} />
                <AppButton
                    title={existingMetric ? 'Save weight' : 'Log weight'}
                    accessibilityHint={isUnchanged ? 'Change the saved value before saving again' : undefined}
                    disabled={!canSave || isBusy}
                    leftIcon={<Ionicons name="scale-outline" size={18} color={colors.onPrimary} />}
                    onPress={handleSaveAttempt}
                    style={styles.footerButton}
                />
            </View>
        );
    } else if (phase === 'outlier-confirm') {
        footer = (
            <View style={footerRowStyle}>
                <AppButton title="Go back" variant="secondary" onPress={() => setPhase('editing')} style={styles.footerButton} />
                <AppButton title={`Save ${formatWeight(parsedWeight, user?.weight_unit)}`} disabled={Boolean(failedWeight)} onPress={mutateWeight} style={styles.footerButton} />
            </View>
        );
    } else if (phase === 'delete-confirm') {
        footer = (
            <View style={footerRowStyle}>
                <AppButton title="Keep weigh-in" variant="secondary" onPress={() => setPhase('editing')} style={styles.footerButton} />
                <AppButton title="Delete" variant="danger" disabled={Boolean(failedWeight)} onPress={handleDelete} style={styles.footerButton} />
            </View>
        );
    } else if (phase === 'saving') {
        footer = <AppButton title={pendingAction === 'delete' ? 'Deleting...' : 'Saving...'} disabled />;
    } else if ((phase === 'synced-result' || phase === 'queued-result') && result) {
        footer = result.queued ? (
            <AppButton title="Done" onPress={handleClose} />
        ) : didReachGoal ? (
            <View style={footerRowStyle}>
                <AppButton title="Done" variant="secondary" onPress={handleClose} style={styles.footerButton} />
                <AppButton title="Set next goal" onPress={handleSetNextGoal} style={styles.footerButton} />
            </View>
        ) : (
            <View style={footerRowStyle}>
                <AppButton title="View progress" variant="secondary" onPress={handleViewProgress} style={styles.footerButton} />
                <AppButton title="Done" onPress={handleClose} style={styles.footerButton} />
            </View>
        );
    }

    return (
        <BottomSheetModal
            visible={visible}
            accessibilityLabel={phase === 'synced-result' || phase === 'queued-result' ? 'Weight progress update' : 'Weight entry'}
            contentKey={phase}
            dismissDisabled={isBusy}
            isDirty={hasUnsavedWeight}
            confirmDismiss={confirmDiscardChanges}
            footer={footer}
            onRequestClose={handleClose}
        >
            {failedWeight && <FailedMutationRecovery key={failedWeight.id} mutation={failedWeight} onRecovered={() => { refreshWeightQueries(); setPhase('loading'); }} />}
            {content}
        </BottomSheetModal>
    );
};

const SheetHeader: React.FC<{
    title: string;
    description?: string;
    action?: React.ReactNode;
}> = ({ title, description, action }) => (
    <View style={styles.headerRow}>
        <SectionHeader title={title} description={description} style={styles.headerText} />
        {action}
    </View>
);

const LiveError: React.FC<{ message: string; color: string }> = ({ message, color }) => (
    <AppText accessibilityLiveRegion="assertive" role="alert" style={{ color }}>
        {message}
    </AppText>
);

const styles = StyleSheet.create({
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md
    },
    headerText: {
        flex: 1,
        minWidth: 0
    },
    closeButton: {
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 24
    },
    closeButtonPressed: {
        opacity: 0.6
    },
    loadingValue: {
        minHeight: 96,
        borderRadius: 16,
        backgroundColor: 'rgba(127, 127, 127, 0.14)'
    },
    confirmationCard: {
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md
    },
    centeredText: {
        textAlign: 'center'
    },
    savingState: {
        minHeight: 128,
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md
    },
    resultCloseRow: {
        minHeight: 48,
        alignItems: 'flex-end'
    },
    footerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm
    },
    footerRowStacked: { flexDirection: 'column' },
    footerButton: {
        flex: 1,
        minWidth: Platform.OS === 'web' ? 'auto' : 0,
        paddingHorizontal: spacing.sm
    }
});
