import { OfflineMutationConflict } from '../offline/mutationConflict';
import { copyFoodWhenSynchronized } from './copyFoodWhenSynchronized';
import { findFailedFood } from '../offline/failedCreation';
import { localTarget } from '../offline/trackingProjection';
import { useTrackingFood } from '../offline/useTrackingQueries';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams, usePathname } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FoodLogCopyPayload, FoodLogEntry, FoodLogUpdatePayload } from '@calibrate/api-client';
import type { MealPeriod } from '@calibrate/shared';
import { AddFoodSheet } from '../components/AddFoodSheet';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../components/AsyncStateBoundary';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { BottomSheetModal } from '../components/BottomSheetModal';
import {
    CopyFoodSheet,
    type FoodCopySelection,
    type FoodCopySource
} from '../components/CopyFoodSheet';
import { FoodLogTimelineCard } from '../components/FoodLogTimelineCard';
import { useFoodDayStatus } from '../components/FoodTrackingStatus';
import { NumberStepperField } from '../components/NumberStepperField';
import { OverlaySelect } from '../components/OverlaySelect';
import { TabScreen } from '../components/TabScreen';
import { SaveMealAsRecipeSheet } from '../components/SaveMealAsRecipeSheet';
import { SkeletonBlock } from '../components/SkeletonBlock';
import { TextField } from '../components/TextField';
import { useAuth } from '../auth/AuthContext';
import { useAddFoodRequest } from '../context/AddFoodRequestContext';
import { useSharedLogDateNavigation } from '../context/LogDateContext';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { usePrefetchPreviousFoodLog } from '../hooks/usePrefetchPreviousFoodLog';
import { useLogDateRouteParameter } from '../hooks/useLogDateRouteParameter';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { getFoodLogEditableAmount } from '../food/foodLogAmount';
import { useFoodDeleteRecovery } from '../food/useFoodDeleteRecovery';
import { getActiveTabRoute } from '../navigation/contextualFab';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { useOfflineOutbox } from '../offline/provider';
import { triggerHapticFeedback } from '../utils/haptics';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { MEAL_SELECT_OPTIONS } from '../utils/meals';
import { spacing, type AppTheme, useAppTheme } from '../theme';
import { getFoodQuantityStep, MINIMUM_FOOD_QUANTITY } from '../food/quantityInput';
import { parseDecimalInput } from '../utils/numericInput';
import { useBarcodeSearchHandoff } from '../barcode/useBarcodeSearchHandoff';
import { reportClientOperationFailure } from '../diagnostics/operationDiagnostics';

export default function FoodLogContent({ embedded = false }: { embedded?: boolean }) {
    const routeParams = useLocalSearchParams<{ date?: string; meal?: string; openAddFood?: string }>();
    const pathname = usePathname();
    const { api, user } = useAuth();
    const outbox = useOfflineOutbox();
    const { enqueue } = outbox;
    const queryClient = useQueryClient();
    const dateNavigation = useSharedLogDateNavigation();
    const { setDate } = dateNavigation;
    const { request: addFoodRequest, consumeRequest: consumeAddFoodRequest } = useAddFoodRequest();
    const selectedDate = dateNavigation.selectedDate;
    const [addFoodMeal, setAddFoodMeal] = useState<MealPeriod | null | undefined>(undefined);
    const [editEntry, setEditEntry] = useState<FoodLogEntry | null>(null);
    const [editName, setEditName] = useState('');
    const [editCalories, setEditCalories] = useState('');
    const [editMeal, setEditMeal] = useState<MealPeriod>('BREAKFAST');
    const [editAmount, setEditAmount] = useState('');
    const [editAmountDirty, setEditAmountDirty] = useState(false);
    const [editCaloriesOverridden, setEditCaloriesOverridden] = useState(false);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const failedFood = editEntry ? findFailedFood(outbox.mutations, { ...localTarget(editEntry), date: selectedDate }) : undefined;
    const failedCreation = failedFood?.operation === 'food.create';
    const discardLabels = failedCreation
        ? { initial: 'Discard failed entry', confirm: 'Confirm discard failed entry' }
        : { initial: 'Discard queued changes', confirm: 'Confirm discard queued changes' };
    const discardButtonLabel = confirmDiscard ? discardLabels.confirm : discardLabels.initial;
    const discardFailed = useMutation({
        networkMode: 'always',
        mutationFn: async () => {
            if (!failedFood) throw new Error('The failed entry changed.');
            await outbox.discardFailedFood(failedFood.id);
        },
        onSuccess: async () => { setEditEntry(null); await invalidateLogQueries(); }
    });
    const retryFailedFood = useMutation({
        networkMode: 'always',
        mutationFn: async () => { if (failedFood) await outbox.retryFailed(failedFood.id); },
        onSuccess: () => { setConfirmDiscard(false); }
    });
    const [editError, setEditError] = useState<string | null>(null);
    const [isEditMealSelectorOpen, setIsEditMealSelectorOpen] = useState(false);
    const [recipeDraftMeal, setRecipeDraftMeal] = useState<MealPeriod | null>(null);
    const [recipeDraftEntries, setRecipeDraftEntries] = useState<FoodLogEntry[]>([]);
    const [recipeSavedMessage, setRecipeSavedMessage] = useState<string | null>(null);
    const [copySource, setCopySource] = useState<FoodCopySource | null>(null);
    const [copySuccessMessage, setCopySuccessMessage] = useState<string | null>(null);
    const copyOperationRef = useRef<{ key: string; operationId: string } | null>(null);
    const theme = useAppTheme();
    const styles = React.useMemo(() => createStyles(theme), [theme]);
    usePrefetchPreviousFoodLog(selectedDate, dateNavigation.minDate);

    const foodQuery = useTrackingFood(selectedDate);
    const foodDayQuery = useFoodDayStatus(selectedDate);
    const isOnline = useOnlineStatus();
    const foodState = useAsyncResourceState(foodQuery, (entries) => entries.length === 0);
    const foodDayState = useAsyncResourceState(foodDayQuery, () => false);
    const canEditFood = foodDayQuery.data?.status === 'OPEN';
    const editAmountConfig = editEntry ? getFoodLogEditableAmount(editEntry) : null;
    const editAmountStep = editAmountConfig ? getFoodQuantityStep(editAmountConfig.unitLabel) : 1;

    useLogDateRouteParameter(embedded ? undefined : routeParams.date, dateNavigation.setDate);

    useBarcodeSearchHandoff({
        params: routeParams,
        selectedDate,
        enabled: canEditFood && !embedded,
        setDate: dateNavigation.setDate,
        openSheet: setAddFoodMeal,
        scrubParams: (requestDate) => router.setParams({
            date: requestDate,
            meal: undefined,
            openAddFood: undefined
        })
    });

    useEffect(() => {
        if (embedded || !addFoodRequest || getActiveTabRoute(pathname) !== 'food-log') return;
        const requestDate = addFoodRequest.date ?? selectedDate;
        if (requestDate !== selectedDate) {
            setDate(requestDate);
            return;
        }
        if (!canEditFood) return;
        setAddFoodMeal(addFoodRequest.meal ?? null);
        consumeAddFoodRequest(addFoodRequest.id);
    }, [embedded, addFoodRequest, canEditFood, consumeAddFoodRequest, setDate, pathname, selectedDate]);

    async function invalidateLogQueries(additionalDates: string[] = []) {
        const dates = Array.from(new Set([selectedDate, ...additionalDates]));
        await Promise.all([
            ...dates.flatMap((date) => [
                queryClient.invalidateQueries({ queryKey: ['mobile-food', date] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-food-day', date] })
            ]),
            queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey }),
            queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-recent-foods'] })
        ]);
    }

    const deleteRecovery = useFoodDeleteRecovery({
        entries: foodQuery.data,
        date: selectedDate,
        deleteFoodLog: (id, operationId) => api.deleteFoodLog(id, operationId),
        outbox,
        onCommitted: async () => {
            triggerHapticFeedback(user?.haptics_enabled, 'selection');
            await invalidateLogQueries();
        }
    });

    const copyFood = useMutation({
        mutationFn: async (selection: FoodCopySelection) => {
            if (!copySource || copySource.kind !== selection.kind) {
                throw new Error('Choose a meal or day to copy.');
            }
            const operationKey = JSON.stringify({ sourceDate: selectedDate, source: copySource, selection });
            if (copyOperationRef.current?.key !== operationKey) {
                copyOperationRef.current = { key: operationKey, operationId: Crypto.randomUUID() };
            }
            const payload: FoodLogCopyPayload = {
                operation_id: copyOperationRef.current.operationId,
                source_date: selectedDate,
                target_date: selection.targetDate
            };
            if (copySource.kind === 'meal') {
                if (selection.kind !== 'meal') throw new Error('Choose a meal to copy.');
                payload.meal_mappings = [{
                    source_meal_period: copySource.meal,
                    target_meal_period: selection.targetMeal
                }];
            }
            await deleteRecovery.flush();
            return copyFoodWhenSynchronized(outbox.withOutbox, () => api.copyFoodLogs(payload));
        },
        onSuccess: async (response) => {
            copyOperationRef.current = null;
            setCopySource(null);
            const noun = response.copied_count === 1 ? 'entry' : 'entries';
            setCopySuccessMessage(
                `${response.copied_count} ${noun} copied to ${formatDateOnlyForDisplay(response.target_date)}.`
            );
            triggerHapticFeedback(user?.haptics_enabled, 'success');
            await invalidateLogQueries([response.target_date]);
        },
        onError: (error) => {
            if (!(error instanceof OfflineMutationConflict)) reportClientOperationFailure('food_copy', error);
        }
    });

    const updateFood = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: () => {
            if (!editEntry) throw new Error('Choose a food entry to edit.');

            if (findFailedFood(outbox.mutations, { ...localTarget(editEntry), date: selectedDate })) throw new Error('Resolve the failed queued changes before saving a correction.');

            const payload: FoodLogUpdatePayload = {
                name: editName.trim(),
                meal_period: editMeal
            };

            if (editAmountConfig && editAmountDirty && editAmount.trim()) {
                payload.servings_consumed = editAmountConfig.toServings(parseDecimalInput(editAmount));
            }
            const hasPreciseCalorieBasis = typeof editEntry.calories_per_serving_snapshot === 'number'
                && Number.isFinite(editEntry.calories_per_serving_snapshot);
            if (editCaloriesOverridden || (editAmountDirty && !hasPreciseCalorieBasis)) {
                payload.calories = Number(editCalories);
            }

            const queuedPayload = { ...localTarget(editEntry), date: selectedDate, update: payload };
            return executeOrQueueMutation({
                withOutbox: outbox.withOutbox,
                forceQueue: outbox.mutations.length > 0,
                operation: OFFLINE_MUTATION_OPERATIONS.UPDATE_FOOD_LOG,
                payload: queuedPayload,
                execute: (operationId) => api.updateFoodLog(editEntry.id, payload, operationId),
                enqueue
            });
        },
        onSuccess: async () => {
            setEditEntry(null);
            triggerHapticFeedback(user?.haptics_enabled, 'success');
            await invalidateLogQueries();
        },
        onError: (error) => {
            setEditError(getSafeActionErrorMessage(error, 'Unable to update food entry.'));
        }
    });

    function openCopy(source: FoodCopySource) {
        copyFood.reset();
        setCopySuccessMessage(null);
        setCopySource(source);
    }

    function requestDelete(entry: FoodLogEntry) {
        if (findFailedFood(outbox.mutations, { ...localTarget(entry), date: selectedDate })) openEditEntry(entry);
        else deleteRecovery.requestDelete(entry);
    }

    function openEditEntry(entry: FoodLogEntry) {
        setConfirmDiscard(false);
        discardFailed.reset();
        retryFailedFood.reset();
        const amountConfig = getFoodLogEditableAmount(entry);
        setEditEntry(entry);
        setEditName(entry.name);
        setEditCalories(String(entry.calories));
        setEditAmountDirty(false);
        setEditCaloriesOverridden(false);
        setEditMeal(entry.meal_period);
        setEditAmount(amountConfig ? String(amountConfig.amount) : '');
        setEditError(null);
        setIsEditMealSelectorOpen(false);
    }

    function handleEditAmountChange(nextAmount: string) {
        setEditAmount(nextAmount);
        const parsedAmount = parseDecimalInput(nextAmount);
        setEditAmountDirty(
            !nextAmount.trim()
            || !Number.isFinite(parsedAmount)
            || !editAmountConfig
            || Math.abs(parsedAmount - editAmountConfig.amount) > 0.000001
        );
        if (editCaloriesOverridden || !editEntry || !editAmountConfig) return;

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
        const servings = editAmountConfig.toServings(parsedAmount);
        const caloriesPerServing = editEntry.calories_per_serving_snapshot;
        if (typeof caloriesPerServing === 'number' && Number.isFinite(caloriesPerServing)) {
            setEditCalories(String(Math.round(servings * caloriesPerServing)));
        }
    }

    function handleSaveEdit() {
        if (failedCreation) { setEditError('Resolve the failed local entry before saving corrections.'); return; }
        if (!editName.trim()) {
            setEditError('Food name is required.');
            return;
        }

        if (!editCalories.trim()) {
            setEditError('Calories are required.');
            return;
        }
        const parsedCalories = Number(editCalories);
        if (!Number.isFinite(parsedCalories) || parsedCalories < 0) {
            setEditError('Calories must be a non-negative number.');
            return;
        }

        if (editAmountConfig) {
            const parsedAmount = parseDecimalInput(editAmount);
            if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
                setEditError('Amount must be a positive number.');
                return;
            }
        }

        setEditError(null);
        updateFood.mutate();
    }

    return (
        <FoodLogFrame embedded={embedded} canEditFood={canEditFood}>
            <AsyncStateBoundary
                state={foodState}
                resourceLabel="food log"
                loading={<FoodLogSkeleton />}
                empty={(
                    <FoodLogTimelineCard
                        title={embedded ? null : 'Meals'}
                        entries={deleteRecovery.visibleEntries}
                        disabled={!canEditFood}
                        copyDisabled={!isOnline || outbox.mutations.length > 0}
                        onEditEntry={openEditEntry}
                        onDeleteEntry={requestDelete}
                        onCopyMeal={(meal) => openCopy({ kind: 'meal', meal })}
                        onCopyDay={() => openCopy({ kind: 'day' })}
                    />
                )}
                onRetry={isOnline ? () => foodQuery.refetch() : undefined}
                retrying={foodQuery.isFetching}
            >
                <FoodLogTimelineCard
                    title={embedded ? null : 'Meals'}
                    entries={deleteRecovery.visibleEntries}
                    disabled={!canEditFood}
                    copyDisabled={!isOnline || outbox.mutations.length > 0}
                    onEditEntry={openEditEntry}
                    onDeleteEntry={requestDelete}
                    onCopyMeal={(meal) => openCopy({ kind: 'meal', meal })}
                    onCopyDay={() => openCopy({ kind: 'day' })}
                    onSaveMealAsRecipe={isOnline && outbox.mutations.length === 0 ? (meal, entries) => {
                        setRecipeSavedMessage(null);
                        setRecipeDraftMeal(meal);
                        setRecipeDraftEntries(entries);
                    } : undefined}
                />
            </AsyncStateBoundary>

            <AsyncStateBoundary
                state={foodDayState}
                resourceLabel="day status"
                loading={null}
                empty={null}
                onRetry={isOnline ? () => foodDayQuery.refetch() : undefined}
                retrying={foodDayQuery.isFetching}
            >
                {null}
            </AsyncStateBoundary>

            {recipeSavedMessage && (
                <AppText accessibilityLiveRegion="polite" variant="muted">{recipeSavedMessage}</AppText>
            )}
            {copySuccessMessage && (
                <AppText accessibilityLiveRegion="polite" variant="muted">{copySuccessMessage}</AppText>
            )}
            {deleteRecovery.pendingDelete && (
                <View accessibilityLiveRegion="polite" style={styles.noticeRow}>
                    <AppText style={styles.noticeText}>Deleted {deleteRecovery.pendingDelete.entry.name}.</AppText>
                    <AppButton
                        title="Undo"
                        variant="secondary"
                        leftIcon={<Ionicons name="arrow-undo-outline" size={18} color={theme.colors.onSurface} />}
                        onPress={() => deleteRecovery.undo(deleteRecovery.pendingDelete?.operationId)}
                    />
                </View>
            )}
            {deleteRecovery.failure && (
                <View accessibilityRole="alert" style={styles.noticeRow}>
                    <AppText style={[styles.noticeText, styles.error]}>{deleteRecovery.failure.message}</AppText>
                    <AppButton
                        title="Retry delete"
                        variant="secondary"
                        onPress={() => void deleteRecovery.retry(deleteRecovery.failure?.operationId)}
                    />
                </View>
            )}

            <AddFoodSheet
                visible={addFoodMeal !== undefined && canEditFood}
                date={selectedDate}
                initialMeal={addFoodMeal}
                returnTo="food-log"
                onClose={() => setAddFoodMeal(undefined)}
            />

            <CopyFoodSheet
                visible={copySource !== null}
                source={copySource}
                sourceDate={selectedDate}
                minDate={dateNavigation.minDate}
                maxDate={dateNavigation.maxDate}
                isSubmitting={copyFood.isPending}
                error={copyFood.error
                    ? getSafeActionErrorMessage(copyFood.error, 'Unable to copy food.')
                    : null}
                onRequestClose={() => {
                    if (copyFood.isPending) return;
                    setCopySource(null);
                }}
                onSubmit={(selection) => copyFood.mutate(selection)}
            />

            <SaveMealAsRecipeSheet
                visible={recipeDraftMeal !== null}
                date={selectedDate}
                meal={recipeDraftMeal}
                entries={recipeDraftEntries}
                onClose={() => {
                    setRecipeDraftMeal(null);
                    setRecipeDraftEntries([]);
                }}
                onSaved={(recipeName) => {
                    setRecipeDraftMeal(null);
                    setRecipeDraftEntries([]);
                    setRecipeSavedMessage(`${recipeName} saved to Recipes.`);
                }}
            />

            <BottomSheetModal
                visible={Boolean(editEntry)}
                revealFocusedInputOnFocus
                title="Edit food"
                description="Update this log entry snapshot."
                onRequestClose={() => {
                    setIsEditMealSelectorOpen(false);
                    setEditEntry(null);
                }}
            >
                {failedFood && <>
                    <AppButton title="Retry original change" disabled={retryFailedFood.isPending || discardFailed.isPending} variant="secondary" onPress={() => retryFailedFood.mutate()} />
                    {retryFailedFood.error && <AppText accessibilityRole="alert">Unable to retry. Your queued changes are still on this device.</AppText>}
                    <AppText accessibilityRole="alert">{failedCreation ? 'This local entry could not sync. Retry it in Settings > Offline changes, or discard it here before adding a corrected entry. A correction cannot pass the failed write.' : 'This entry has failed queued changes. Retry the original request or discard its queued changes before editing or deleting it. Saving another correction cannot pass the failed write.'}</AppText>
                    {confirmDiscard && <AppText>{failedCreation ? 'Discard this local entry and its pending edits? Other queued changes are kept. This does not delete any server record.' : 'Discard all queued edits and deletion for this entry? Other entries are kept. This does not delete or undo any server record; refresh when connected to see what reached the server.'}</AppText>}
                    <AppButton title={discardButtonLabel} disabled={discardFailed.isPending || retryFailedFood.isPending} variant="secondary" onPress={() => confirmDiscard ? discardFailed.mutate() : setConfirmDiscard(true)} />
                    {discardFailed.error && <AppText accessibilityRole="alert">Unable to discard this entry. Its sync state may have changed; close and reopen it to review.</AppText>}
                </>}
                <TextField label="Food name" value={editName} onChangeText={setEditName} />
                {editAmountConfig && (
                    <NumberStepperField
                        label="Amount"
                        value={editAmount}
                        onChangeText={handleEditAmountChange}
                        step={editAmountStep}
                        min={MINIMUM_FOOD_QUANTITY}
                        suffix={editAmountConfig.unitLabel}
                        helperText={`Use +/- ${editAmountStep} ${editAmountConfig.unitLabel}; type any positive decimal.`}
                    />
                )}
                <NumberStepperField
                    label="Calories"
                    value={editCalories}
                    onChangeText={(nextCalories) => {
                        setEditCalories(nextCalories);
                        setEditCaloriesOverridden(true);
                    }}
                    step={25}
                    min={0}
                    suffix="kcal"
                />
                <AppText variant="label">Meal</AppText>
                <OverlaySelect
                    accessibilityLabel="Select meal"
                    value={editMeal}
                    options={MEAL_SELECT_OPTIONS}
                    isOpen={isEditMealSelectorOpen}
                    onToggle={() => setIsEditMealSelectorOpen((current) => !current)}
                    onChange={(nextMeal) => {
                        setEditMeal(nextMeal);
                        setIsEditMealSelectorOpen(false);
                    }}
                />
                {(editError || updateFood.error) && (
                    <AppText accessibilityRole="alert" style={styles.error}>
                        {editError ?? getSafeActionErrorMessage(updateFood.error, 'Unable to update food entry.')}
                    </AppText>
                )}
                <View style={styles.row}>
                    <AppButton
                        title="Cancel"
                        variant="secondary"
                        leftIcon={<Ionicons name="close" size={18} color={theme.colors.text} />}
                        onPress={() => {
                            setIsEditMealSelectorOpen(false);
                            setEditEntry(null);
                        }}
                        style={styles.rowButton}
                    />
                    <AppButton
                        title={updateFood.isPending ? 'Saving...' : 'Save'}
                        disabled={updateFood.isPending || Boolean(failedFood)}
                        leftIcon={<Ionicons name="checkmark" size={18} color={theme.colors.onPrimary} />}
                        onPress={handleSaveEdit}
                        style={styles.rowButton}
                    />
                </View>
            </BottomSheetModal>
        </FoodLogFrame>
    );
}

function FoodLogFrame({ embedded, canEditFood, children }: { embedded: boolean; canEditFood: boolean; children: React.ReactNode }) {
    return <View style={frameStyles.root}>
        <TabScreen reserveFab={!embedded && canEditFood} contentWidth={embedded ? 'overview' : 'wide'} style={frameStyles.content}>
            {children}
        </TabScreen>
    </View>;
}

const frameStyles = StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    content: { paddingTop: 0 }
});

const FoodLogSkeleton: React.FC = () => (
    <View testID="food-log-loading" style={skeletonStyles.content}>
        <SkeletonBlock width="28%" height={30} />
        {[0, 1, 2, 3, 4, 5].map((row) => (
            <View key={row} style={skeletonStyles.row}>
                <SkeletonBlock width="40%" height={20} />
                <SkeletonBlock width={72} height={20} />
            </View>
        ))}
    </View>
);

const skeletonStyles = StyleSheet.create({
    content: {
        width: '100%',
        gap: spacing.md
    },
    row: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
    }
});

function createStyles(theme: AppTheme) {
    return StyleSheet.create({
        row: {
            flexDirection: 'row',
            gap: theme.spacing.md
        },
        rowButton: {
            flex: 1
        },
        error: {
            color: theme.colors.danger
        },
        noticeRow: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md
        },
        noticeText: {
            flex: 1,
            minWidth: 0
        }
    });
}
