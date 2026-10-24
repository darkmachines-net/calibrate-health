import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, Linking, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';
import type { FoodLogCreatePayload, MyFoodSummary, RecentFoodSummary } from '@calibrate/api-client';
import { AppActionRow } from './AppActionRow';
import { AppButton } from './AppButton';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from './AsyncStateBoundary';
import { AppText } from './AppText';
import { BottomSheetModal } from './BottomSheetModal';
import { TABLET_LAYOUT_BREAKPOINT } from '../layout/adaptiveLayout';
import { FoodSelectionEditor, type FoodSelectionSubmitRequest } from './FoodSelectionEditor';
import { KeyboardAwareScrollView } from './KeyboardAwareScrollView';
import { OverlaySelect } from './OverlaySelect';
import { SegmentedControl } from './SegmentedControl';
import { TextField } from './TextField';
import { useAuth } from '../auth/AuthContext';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { getProviderAttribution, type ProviderAttribution } from '../barcode/workflow';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { queuedFoodDayStatus } from '../offline/foodDayIntent';
import type { QueuedMutation } from '../offline/queuedMutation';
import { useOfflineOutbox } from '../offline/provider';
import { foodDayQueryKey, useFoodDayStatus } from './FoodTrackingStatus';
import { foodDayRangeQueryRoot } from '../food/calendar';
import { formatDateOnlyForDisplay } from '../utils/dates';
import { formatCalories, formatMealPeriod } from '../utils/format';
import { triggerHapticFeedback } from '../utils/haptics';
import { MEAL_OPTIONS, MEAL_SELECT_OPTIONS } from '../utils/meals';
import { selectQuickRecentFoods } from '../utils/myFoods';
import { getFoodLogAmountText } from '../food/foodLogAmount';
import {
    createMyFoodSelection,
    createProviderFoodSelection,
    createRecentFoodSelection,
    isRecentFoodSelectionReady,
    type FoodLogSelection
} from '../food/foodLogSelection';
import {
    calculateFoodServing,
    getDefaultFoodMeasureQuantity,
    getPreferredFoodMeasureIndex,
    normalizeSearchedFoodItem,
    type SearchedFoodItem
} from '../food/serving';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { confirmDiscardChanges } from './confirmDiscardChanges';
import { getCachedSavedFoods } from '../savedFoods/cachedFoods';
import { ASYNC_RESOURCE_STATES, type AsyncResourceState } from '../asyncState/resolveAsyncState';

type AddFoodReturnTo = 'today' | 'food-log';

type AddFoodSheetProps = {
    visible: boolean;
    date: string;
    initialMeal?: MealPeriod | null;
    returnTo?: AddFoodReturnTo;
    onClose: () => void;
    onLogged?: () => void;
};

type AddFoodMode = 'quick' | 'search';
type FoodBrowseRow =
    | { kind: 'header'; key: string; title: string }
    | {
          kind: 'selection';
          key: string;
          title: string;
          subtitle: string;
          selection: FoodLogSelection;
          disabled?: boolean;
          disabledReason?: string;
      };

const DEFAULT_ADD_FOOD_MODE: AddFoodMode = 'search';
const ADD_FOOD_MODES: Array<{ value: AddFoodMode; label: string }> = [
    { value: 'quick', label: 'Quick' },
    { value: 'search', label: 'Search' }
];
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_WORKSPACE_BLUR_DELAY_MS = 150; // Keeps mobile-web results mounted through input blur and the following press.
const MINIMUM_SEARCH_LENGTH = 2;
const DEFAULT_RECENT_LIMIT = 8;
const DEFAULT_PINNED_LIMIT = 8;
const ADD_FOOD_SHEET_HEIGHT = '92%';

export function usesCompactAddFoodLayout(viewportWidth: number): boolean {
    return viewportWidth < TABLET_LAYOUT_BREAKPOINT;
}

function describeSearchedFood(item: SearchedFoodItem): string {
    const preferredIndex = getPreferredFoodMeasureIndex(item);
    const measure = preferredIndex === null ? null : item.measures[preferredIndex];
    const defaultQuantity = getDefaultFoodMeasureQuantity(item, measure ?? null);
    const calculation = measure ? calculateFoodServing(item, measure, defaultQuantity) : null;
    return [
        item.brand,
        measure ? measure.label : 'No usable serving unit',
        calculation ? formatCalories(calculation.calories) : 'Calories unavailable'
    ].filter(Boolean).join(' | ');
}

function describeMyFood(item: MyFoodSummary): string {
    const kind = item.type === 'RECIPE' ? 'Recipe' : 'Saved food';
    return `${kind} | ${formatCalories(item.calories_per_serving)} per serving`;
}

function describeRecentFood(item: RecentFoodSummary, currentMyFood?: MyFoodSummary): string {
    const capturedAmount = getFoodLogAmountText(item);
    const amountText = capturedAmount ? ` | ${capturedAmount}` : '';
    if (currentMyFood) {
        return `${formatCalories(currentMyFood.calories_per_serving)} per serving${amountText} | logged ${item.times_logged}x`;
    }
    return `${formatCalories(item.calories)}${amountText} | logged ${item.times_logged}x`;
}

function getDefaultMealPeriodForTime(now: Date): MealPeriod {
    const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
    if (minutesSinceMidnight >= 21 * 60) return MEAL_PERIODS.EVENING_SNACK;
    if (minutesSinceMidnight >= 16 * 60 + 30) return MEAL_PERIODS.DINNER;
    if (minutesSinceMidnight >= 14 * 60) return MEAL_PERIODS.AFTERNOON_SNACK;
    if (minutesSinceMidnight >= 11 * 60 + 30) return MEAL_PERIODS.LUNCH;
    if (minutesSinceMidnight >= 9 * 60) return MEAL_PERIODS.MORNING_SNACK;
    return MEAL_PERIODS.BREAKFAST;
}

function errorMessage(error: unknown, fallback: string): string | null {
    if (!error) return null;
    return getSafeActionErrorMessage(error, fallback);
}

function appendSection(rows: FoodBrowseRow[], title: string, items: FoodBrowseRow[]): void {
    if (items.length === 0) return;
    rows.push({ kind: 'header', key: `header:${title}`, title }, ...items);
}

export const AddFoodSheet: React.FC<AddFoodSheetProps> = ({
    visible,
    date,
    initialMeal,
    returnTo = 'today',
    onClose,
    onLogged
}) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { width: viewportWidth, fontScale } = useWindowDimensions();
    const isOnline = useOnlineStatus();
    const { api, user } = useAuth();
    const { enqueue, withOutbox, mutations = [] } = useOfflineOutbox();
    const queryClient = useQueryClient();
    const foodDayQuery = useFoodDayStatus(date, visible);
    const [mode, setMode] = useState<AddFoodMode>(DEFAULT_ADD_FOOD_MODE);
    const [meal, setMeal] = useState<MealPeriod>(initialMeal ?? getDefaultMealPeriodForTime(new Date()));
    const [quickCalories, setQuickCalories] = useState('');
    const [quickName, setQuickName] = useState('');
    const [query, setQuery] = useState('');
    const [requestedQuery, setRequestedQuery] = useState('');
    const [selection, setSelection] = useState<FoodLogSelection | null>(null);
    const [isMealSelectorOpen, setIsMealSelectorOpen] = useState(false);
    const [isSearchFieldFocused, setIsSearchFieldFocused] = useState(false);
    const searchBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const normalizedQuery = query.trim();
    const isMobileSearchWorkspace = usesCompactAddFoodLayout(viewportWidth)
        && mode === 'search'
        && isSearchFieldFocused
        && selection === null;
    const usesEdgeToEdgeSheetContent = Platform.OS === 'web'
        || (Platform.OS === 'android' && isMobileSearchWorkspace);

    useEffect(() => () => {
        if (searchBlurTimeoutRef.current) clearTimeout(searchBlurTimeoutRef.current);
    }, []);

    useEffect(() => {
        if (!visible || mode !== 'search' || normalizedQuery.length < MINIMUM_SEARCH_LENGTH) {
            setRequestedQuery('');
            return;
        }
        const timeout = setTimeout(() => setRequestedQuery(normalizedQuery), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timeout);
    }, [mode, normalizedQuery, visible]);

    const recentFoodsQuery = useQuery({
        queryKey: ['mobile-recent-foods', meal, requestedQuery || 'browse'],
        queryFn: () => api.getRecentFoods({
            q: requestedQuery || undefined,
            limit: DEFAULT_RECENT_LIMIT,
            meal_period: meal
        }),
        enabled: visible && mode === 'search'
    });
    const providerSearchQuery = useQuery({
        queryKey: ['mobile-food-search', requestedQuery],
        queryFn: () => api.searchFood(requestedQuery),
        enabled: visible && mode === 'search' && requestedQuery.length >= MINIMUM_SEARCH_LENGTH
    });
    const myFoodsQuery = useQuery({
        queryKey: ['mobile-my-foods'],
        queryFn: () => api.getMyFoods(),
        enabled: visible && mode === 'search'
    });
    const recentFoodsState = useAsyncResourceState(recentFoodsQuery, (data) => data.items.length === 0);
    const providerSearchState = useAsyncResourceState(providerSearchQuery, (data) => data.items.length === 0);
    const savedFoods = useMemo(() => isOnline
        ? myFoodsQuery.data ?? []
        : getCachedSavedFoods(queryClient, myFoodsQuery.data, myFoodsQuery.dataUpdatedAt),
    [isOnline, myFoodsQuery.data, myFoodsQuery.dataUpdatedAt, queryClient]);
    const myFoodsState = useAsyncResourceState({
        ...myFoodsQuery,
        data: savedFoods.length > 0 ? savedFoods : myFoodsQuery.data,
        dataUpdatedAt: savedFoods.length > 0 ? Math.max(1, myFoodsQuery.dataUpdatedAt) : myFoodsQuery.dataUpdatedAt
    }, (data) => data.length === 0);

    const createFoodLog = useCallback(async (payload: FoodLogCreatePayload) => {
        const savedFood = savedFoods.find(food => food.id === payload.my_food_id);
        const queuedPayload = savedFood ? { ...payload, localSnapshot: {
            name: savedFood.name,
            calories: Math.round(savedFood.calories_per_serving * (payload.servings_consumed ?? 1)),
            calories_per_serving_snapshot: savedFood.calories_per_serving,
            serving_size_quantity_snapshot: savedFood.serving_size_quantity,
            serving_unit_label_snapshot: savedFood.serving_unit_label
        } } : payload;
        const day = foodDayQuery.data;
        const submit = async (write: (operation: string, payload: unknown, operationId?: string) => Promise<unknown>, mustQueue: boolean, pending: readonly QueuedMutation[], recordControl?: (operation: string, payload: unknown, id: string) => Promise<void>) => {
            const status = queuedFoodDayStatus(pending, payload.date, day?.status);
            if (!status) throw new Error('Day status is unavailable. Try again.');
            if (status === 'PAUSED') throw new Error('Resume tracking before adding food.');
            // Reopening and its dependent food write share one dispatch lock, including queued fallback.
            if (status !== 'OPEN') {
                const reopenPayload = { date: payload.date, status: 'OPEN' as const };
                const reopened = await executeOrQueueMutation({
                    forceQueue: mustQueue,
                    recordControl,
                    operation: OFFLINE_MUTATION_OPERATIONS.SET_FOOD_DAY_STATUS,
                    payload: reopenPayload,
                    execute: (operationId) => api.setFoodDayStatus(reopenPayload, operationId),
                    enqueue: write
                });
                if (reopened.disposition === 'queued') {
                    await write(OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG, queuedPayload);
                    return;
                }
                queryClient.setQueryData(foodDayQueryKey(payload.date), reopened.value);
            }
            return executeOrQueueMutation({
                forceQueue: mustQueue,
                operation: OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG,
                payload: queuedPayload,
                execute: (operationId) => api.createFoodLog(payload, operationId),
                enqueue: write
            });
        };
        return withOutbox ? withOutbox(submit) : submit(enqueue, mutations.length > 0, mutations);
    }, [api, enqueue, withOutbox, foodDayQuery.data, queryClient, savedFoods, mutations]);

    async function invalidateLogQueries() {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['mobile-food', date] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-food-day', date] }),
            queryClient.invalidateQueries({ queryKey: foodDayRangeQueryRoot }),
            queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey }),
            queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-recent-foods'] }),
            queryClient.invalidateQueries({ queryKey: ['mobile-in-app-notifications'] })
        ]);
    }

    async function confirmLogged(closeAfterLogging: boolean) {
        triggerHapticFeedback(user?.haptics_enabled, 'success');
        onLogged?.();
        if (closeAfterLogging) onClose();
        await invalidateLogQueries();
    }

    const logFood = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: async (request: FoodSelectionSubmitRequest) => {
            await createFoodLog(request.payload);
            return request.closeAfterLogging;
        },
        onSuccess: async (closeAfterLogging) => {
            setSelection(null);
            setQuickCalories('');
            setQuickName('');
            await confirmLogged(closeAfterLogging);
        }
    });

    const { reset: resetLogFood } = logFood;
    useEffect(() => {
        if (!visible) return;
        const requestedMeal = initialMeal && MEAL_OPTIONS.includes(initialMeal)
            ? initialMeal
            : getDefaultMealPeriodForTime(new Date());
        setMode(DEFAULT_ADD_FOOD_MODE);
        setMeal(requestedMeal);
        setQuickCalories('');
        setQuickName('');
        setQuery('');
        setRequestedQuery('');
        setSelection(null);
        setIsMealSelectorOpen(false);
        setIsSearchFieldFocused(false);
        resetLogFood();
    }, [initialMeal, resetLogFood, visible]);

    const providerData = requestedQuery === normalizedQuery ? providerSearchQuery.data : undefined;
    const recentData = requestedQuery === normalizedQuery
        ? recentFoodsQuery.data
        : undefined;
    const providerResults = useMemo(
        () => (providerData?.items ?? [])
            .map(normalizeSearchedFoodItem)
            .filter((item): item is SearchedFoodItem => item !== null),
        [providerData?.items]
    );
    const searchRows = useMemo(() => {
        const rows: FoodBrowseRow[] = [];
        const recentFoods = recentData?.items ?? [];
        const createRecentRow = (item: RecentFoodSummary): FoodBrowseRow => {
            const currentMyFood = savedFoods.find((savedFood) => savedFood.id === item.my_food_id);
            const isReady = isRecentFoodSelectionReady(item, currentMyFood, myFoodsQuery.isSuccess);
            const unavailableMessage = myFoodsQuery.isError
                ? 'Saved food could not be loaded.'
                : 'Loading saved food...';
            return {
                kind: 'selection',
                key: `recent:${item.id}`,
                title: item.name,
                subtitle: isReady ? describeRecentFood(item, currentMyFood) : unavailableMessage,
                selection: createRecentFoodSelection(item, currentMyFood),
                disabled: !isReady,
                disabledReason: isReady ? undefined : unavailableMessage
            };
        };
        if (normalizedQuery.length === 0) {
            const pinnedFoods = savedFoods.filter((item) => item.is_pinned).slice(0, DEFAULT_PINNED_LIMIT);
            const recentWithoutPinned = selectQuickRecentFoods(recentFoods, pinnedFoods, DEFAULT_RECENT_LIMIT);
            appendSection(rows, 'Pinned', pinnedFoods.map((item) => ({
                kind: 'selection' as const,
                key: `pinned:${item.id}`,
                title: item.name,
                subtitle: describeMyFood(item),
                selection: createMyFoodSelection(item)
            })));
            appendSection(rows, 'Recent', recentWithoutPinned.map(createRecentRow));
            return rows;
        }
        if (normalizedQuery.length < MINIMUM_SEARCH_LENGTH || requestedQuery !== normalizedQuery) return rows;

        const recentMyFoodIds = new Set(recentFoods.flatMap((item) => item.my_food_id === null ? [] : [item.my_food_id]));
        const matchingSaved = savedFoods.filter((item) => (
            item.name.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())
            && !recentMyFoodIds.has(item.id)
        ));
        appendSection(rows, 'Recent matches', recentFoods.map(createRecentRow));
        appendSection(rows, 'Saved matches', matchingSaved.map((item) => ({
            kind: 'selection' as const,
            key: `saved:${item.id}`,
            title: item.name,
            subtitle: describeMyFood(item),
            selection: createMyFoodSelection(item)
        })));
        appendSection(rows, 'Food results', providerResults.map((item) => ({
            kind: 'selection' as const,
            key: `provider:${item.source ?? 'food'}:${item.id}`,
            title: item.name,
            subtitle: describeSearchedFood(item),
            selection: createProviderFoodSelection(item)
        })));
        return rows;
    }, [
        myFoodsQuery.isError,
        myFoodsQuery.isSuccess,
        normalizedQuery,
        providerResults,
        recentData?.items,
        requestedQuery,
        savedFoods
    ]);

    const activeAttribution = getProviderAttribution(providerData?.provider, providerData?.attribution);
    const isWaitingForSearch = normalizedQuery.length >= MINIMUM_SEARCH_LENGTH && requestedQuery !== normalizedQuery;
    const isSearchLoading = isWaitingForSearch
        || (requestedQuery === normalizedQuery && (providerSearchQuery.isFetching || recentFoodsQuery.isFetching));
    const mutationError = errorMessage(logFood.error, 'Food could not be added. Try again.');
    const hasUnsavedDraft = Boolean(selection || quickCalories.trim() || quickName.trim());
    const canAddQuickEntry = quickCalories.trim().length > 0
        && Number.isFinite(Number(quickCalories))
        && Number(quickCalories) >= 0;

    /** Leave the sheet for barcode capture without silently discarding a food draft. */
    async function openBarcodeScanner() {
        if (hasUnsavedDraft && !await confirmDiscardChanges()) return;
        onClose();
        router.push({ pathname: '/barcode', params: { date, meal, returnTo } });
    }

    /** Leave the sheet for the saved-food library without silently discarding a food draft. */
    async function openSavedFoods() {
        if (hasUnsavedDraft && !await confirmDiscardChanges()) return;
        onClose();
        router.push('/my-foods');
    }

    function submitQuick(closeAfterLogging: boolean) {
        if (!canAddQuickEntry) return;
        logFood.mutate({
            closeAfterLogging,
            payload: {
                date,
                meal_period: meal,
                name: quickName.trim() || 'Quick entry',
                calories: Math.round(Number(quickCalories))
            }
        });
    }

    function focusSearchField() {
        if (searchBlurTimeoutRef.current) clearTimeout(searchBlurTimeoutRef.current);
        searchBlurTimeoutRef.current = null;
        setIsSearchFieldFocused(true);
    }

    function blurSearchField() {
        if (searchBlurTimeoutRef.current) clearTimeout(searchBlurTimeoutRef.current);
        searchBlurTimeoutRef.current = setTimeout(() => {
            searchBlurTimeoutRef.current = null;
            setIsSearchFieldFocused(false);
        }, SEARCH_WORKSPACE_BLUR_DELAY_MS);
    }

    function selectMode(nextMode: AddFoodMode) {
        Keyboard.dismiss();
        setMode(nextMode);
        setSelection(null);
        setIsMealSelectorOpen(false);
        setIsSearchFieldFocused(false);
        logFood.reset();
    }

    function renderBrowseRow({ item }: { item: FoodBrowseRow }) {
        if (item.kind === 'header') {
            return <AppText style={styles.listHeader} variant="label">{item.title}</AppText>;
        }
        return (
            <FoodActionRow
                title={item.title}
                subtitle={item.subtitle}
                disabled={logFood.isPending || item.disabled}
                disabledReason={item.disabledReason}
                onPress={() => {
                    Keyboard.dismiss();
                    logFood.reset();
                    setIsSearchFieldFocused(false);
                    setSelection(item.selection);
                }}
            />
        );
    }

    function renderSelectionEditor() {
        if (!selection) return null;
        const selectionAttribution = selection.kind === 'provider'
            ? getProviderAttribution(selection.item.source ?? undefined, providerData?.attribution)
            : null;
        return (
            <KeyboardAwareScrollView
                style={styles.flex}
                contentContainerStyle={styles.editorContent}
                revealFocusedInputOnFocus
                keyboardShouldPersistTaps="handled"
            >
                {selectionAttribution && renderProviderAttribution(selectionAttribution)}
                <FoodSelectionEditor
                    selection={selection}
                    date={date}
                    meal={meal}
                    isSubmitting={logFood.isPending}
                    error={mutationError}
                    onCancel={() => {
                        setSelection(null);
                        logFood.reset();
                    }}
                    onSubmit={(request) => logFood.mutate(request)}
                />
            </KeyboardAwareScrollView>
        );
    }

    function renderProviderAttribution(attribution: ProviderAttribution) {
        return (
            <AppText
                accessibilityRole={attribution.url ? 'link' : undefined}
                accessibilityHint={attribution.url ? 'Opens the food provider website.' : undefined}
                onPress={attribution.url ? () => void Linking.openURL(attribution.url!) : undefined}
                style={attribution.url ? styles.attributionLink : undefined}
                variant="caption"
            >
                {attribution.text}
            </AppText>
        );
    }

    function renderSearchEmpty(): React.ReactElement | null {
        const providerSearchIsActive = requestedQuery === normalizedQuery
            && requestedQuery.length >= MINIMUM_SEARCH_LENGTH;
        const relevantStates = providerSearchIsActive
            ? [recentFoodsState, myFoodsState, providerSearchState]
            : [recentFoodsState, myFoodsState];
        if (relevantStates.some((state) => state.kind === ASYNC_RESOURCE_STATES.ERROR)) return null;

        let message = 'Pinned and recent foods will appear here after you log them.';
        if (normalizedQuery.length === 1) message = 'Type at least 2 characters to search.';
        if (
            isSearchLoading
            || relevantStates.some((state) => state.kind === ASYNC_RESOURCE_STATES.LOADING)
        ) {
            message = normalizedQuery.length >= MINIMUM_SEARCH_LENGTH
                ? 'Searching foods...'
                : 'Loading pinned and recent foods...';
        }
        if (
            normalizedQuery.length >= MINIMUM_SEARCH_LENGTH
            && !isSearchLoading
            && relevantStates.every((state) => state.kind !== ASYNC_RESOURCE_STATES.LOADING)
            && requestedQuery === normalizedQuery
        ) {
            message = 'No matching foods found.';
        }
        return <AppText style={styles.emptyMessage} variant="muted">{message}</AppText>;
    }

    function renderResourceFeedback(
        state: AsyncResourceState,
        resourceLabel: string,
        retrying: boolean,
        onRetry: () => unknown
    ) {
        if (
            state.kind !== ASYNC_RESOURCE_STATES.ERROR
            && state.kind !== ASYNC_RESOURCE_STATES.STALE
            && state.kind !== ASYNC_RESOURCE_STATES.DEGRADED
        ) return null;

        return (
            <AsyncStateBoundary
                state={state}
                resourceLabel={resourceLabel}
                loading={null}
                empty={null}
                onRetry={isOnline ? onRetry : undefined}
                retrying={retrying}
            >
                {null}
            </AsyncStateBoundary>
        );
    }

    function renderSearchFeedback() {
        const providerSearchIsActive = requestedQuery === normalizedQuery
            && requestedQuery.length >= MINIMUM_SEARCH_LENGTH;
        return (
            <>
                {renderResourceFeedback(
                    recentFoodsState,
                    'recent foods',
                    recentFoodsQuery.isFetching,
                    () => recentFoodsQuery.refetch()
                )}
                {renderResourceFeedback(
                    myFoodsState,
                    'saved foods',
                    myFoodsQuery.isFetching,
                    () => myFoodsQuery.refetch()
                )}
                {providerSearchIsActive && renderResourceFeedback(
                    providerSearchState,
                    'food search',
                    providerSearchQuery.isFetching,
                    () => providerSearchQuery.refetch()
                )}
            </>
        );
    }

    function renderSearchFooter() {
        if (!activeAttribution && !isSearchLoading) return null;
        return (
            <View style={styles.listFooter}>
                {isSearchLoading && searchRows.length > 0 && <AppText variant="muted">Updating results...</AppText>}
                {activeAttribution && renderProviderAttribution(activeAttribution)}
            </View>
        );
    }

    /** Render the compact library shortcut beside searchable mode labels. */
    function renderSavedFoodsAction() {
        return (
            <AppButton
                title="Saved foods"
                variant="ghost"
                leftIcon={<Ionicons name="bookmark-outline" size={18} color={theme.colors.onSurface} />}
                onPress={() => void openSavedFoods()}
                style={styles.savedFoodsLink}
            />
        );
    }

    function renderModeContent() {
        if (mode === 'quick') {
            return (
                <KeyboardAwareScrollView
                    style={styles.flex}
                    contentContainerStyle={styles.formContent}
                    keyboardShouldPersistTaps="handled"
                >
                    <TextField
                        label="Calories"
                        value={quickCalories}
                        onChangeText={setQuickCalories}
                        autoFocus
                        keyboardType="decimal-pad"
                        placeholder="0"
                        editable={!logFood.isPending}
                    />
                    <TextField
                        label="Food name (optional)"
                        value={quickName}
                        onChangeText={setQuickName}
                        placeholder="Quick entry"
                        editable={!logFood.isPending}
                    />
                    {!canAddQuickEntry && quickCalories.trim().length > 0 && (
                        <AppText accessibilityRole="alert" style={styles.error}>Calories must be zero or greater.</AppText>
                    )}
                    {mutationError && <AppText accessibilityRole="alert" style={styles.error}>{mutationError}</AppText>}
                    <View style={[styles.actions, fontScale >= 1.3 && styles.actionsStacked]}>
                        <AppButton
                            title={logFood.isPending ? 'Adding...' : 'Add another'}
                            variant="secondary"
                            disabled={!canAddQuickEntry || logFood.isPending}
                            leftIcon={<Ionicons name="add" size={18} color={theme.colors.onSurface} />}
                            onPress={() => submitQuick(false)}
                            style={styles.actionButton}
                        />
                        <AppButton
                            title={logFood.isPending ? 'Adding...' : 'Add & close'}
                            disabled={!canAddQuickEntry || logFood.isPending}
                            leftIcon={<Ionicons name="checkmark" size={18} color={theme.colors.onPrimary} />}
                            onPress={() => submitQuick(true)}
                            style={styles.actionButton}
                        />
                    </View>
                </KeyboardAwareScrollView>
            );
        }

        if (mode === 'search') {
            return (
                <View style={styles.flex}>
                    {!isMobileSearchWorkspace && (
                        <View style={styles.modeFieldHeader}>
                            <AppText variant="label">Search foods</AppText>
                            {renderSavedFoodsAction()}
                        </View>
                    )}
                    <View style={styles.searchControls}>
                        <TextField
                            label="Search foods"
                            hideLabel
                            value={query}
                            placeholder="Search food name or brand"
                            onChangeText={(value) => {
                                setQuery(value);
                                setSelection(null);
                                logFood.reset();
                            }}
                            onFocus={focusSearchField}
                            onBlur={blurSearchField}
                            returnKeyType="search"
                            editable={!logFood.isPending}
                            onSubmitEditing={() => {
                                if (normalizedQuery.length >= MINIMUM_SEARCH_LENGTH) {
                                    setRequestedQuery(normalizedQuery);
                                }
                            }}
                            containerStyle={styles.searchField}
                        />
                        {!isMobileSearchWorkspace && (
                            <AppButton
                                title="Scan"
                                variant="secondary"
                                disabled={logFood.isPending}
                                leftIcon={<Ionicons name="barcode-outline" size={18} color={theme.colors.onSurface} />}
                                onPress={() => void openBarcodeScanner()}
                                style={styles.scanButton}
                            />
                        )}
                    </View>
                    {selection ? renderSelectionEditor() : (
                        <FlatList
                            testID="food-search-results"
                            tabIndex={Platform.OS === 'web' ? 0 : undefined}
                            data={searchRows}
                            keyExtractor={(item) => item.key}
                            renderItem={renderBrowseRow}
                            ListHeaderComponent={renderSearchFeedback}
                            ListEmptyComponent={renderSearchEmpty}
                            ListFooterComponent={renderSearchFooter}
                            contentContainerStyle={styles.resultsContent}
                            keyboardDismissMode="none"
                            keyboardShouldPersistTaps="always"
                            showsVerticalScrollIndicator
                            style={styles.resultsList}
                        />
                    )}
                </View>
            );
        }

        return null;
    }

    return (
        <BottomSheetModal
            visible={visible}
            accessibilityLabel="Add food"
            title={isMobileSearchWorkspace ? undefined : 'Add food'}
            description={isMobileSearchWorkspace ? undefined : `${formatDateOnlyForDisplay(date)} | ${formatMealPeriod(meal)}`}
            maxHeight={ADD_FOOD_SHEET_HEIGHT}
            size="wide"
            showCloseButton
            scrollable={false}
            dismissDisabled={logFood.isPending}
            isDirty={hasUnsavedDraft}
            confirmDismiss={confirmDiscardChanges}
            onRequestClose={onClose}
            contentStyle={usesEdgeToEdgeSheetContent ? styles.edgeToEdgeSheetContent : undefined}
        >
            {(foodDayQuery.data?.status === 'COMPLETE' || foodDayQuery.data?.status === 'INCOMPLETE') && (
                <AppText variant="muted" style={isMobileSearchWorkspace ? styles.reopenNotice : undefined}>
                    Adding food reopens this day so you can complete it again.
                </AppText>
            )}
            {!isMobileSearchWorkspace && (
                <>
                    <View style={styles.mealControl}>
                        <AppText variant="label">Meal</AppText>
                        <OverlaySelect
                            accessibilityLabel="Select meal"
                            value={meal}
                            options={MEAL_SELECT_OPTIONS}
                            isOpen={isMealSelectorOpen}
                            onToggle={() => setIsMealSelectorOpen((current) => !current)}
                            onChange={(nextMeal) => {
                                setMeal(nextMeal);
                                setIsMealSelectorOpen(false);
                            }}
                        />
                    </View>
                    <SegmentedControl accessibilityLabel="Add food method" options={ADD_FOOD_MODES} value={mode} onChange={selectMode} />
                </>
            )}
            <View style={styles.modeContent}>{renderModeContent()}</View>
        </BottomSheetModal>
    );
};

type FoodActionRowProps = {
    title: string;
    subtitle: string;
    disabled?: boolean;
    disabledReason?: string;
    onPress: () => void;
};

const FoodActionRow: React.FC<FoodActionRowProps> = ({
    title,
    subtitle,
    disabled,
    disabledReason,
    onPress
}) => {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    return (
        <AppActionRow
            accessibilityRole="button"
            accessibilityLabel={`Choose amount for ${title}`}
            accessibilityHint={disabled ? disabledReason : undefined}
            accessibilityState={{ disabled: Boolean(disabled) }}
            disabled={disabled}
            onPress={onPress}
            contentStyle={styles.foodRow}
        >
            <View style={styles.foodText}>
                <AppText variant="body" numberOfLines={1}>{title}</AppText>
                <AppText variant="caption" numberOfLines={2}>{subtitle}</AppText>
            </View>
            <View style={styles.rowIcon}>
                <Ionicons name="chevron-forward" size={18} color={theme.colors.onSurfaceVariant} />
            </View>
        </AppActionRow>
    );
};

const createStyles = (theme: AppTheme) => StyleSheet.create({
    reopenNotice: { marginHorizontal: spacing.lg, marginTop: spacing.sm },
    flex: {
        flex: 1,
        minHeight: 0
    },
    mealControl: {
        gap: spacing.sm
    },
    modeContent: {
        flex: 1,
        minHeight: 0
    },
    edgeToEdgeSheetContent: {
        // The focused Android workspace already ends above the software keyboard.
        paddingBottom: 0
    },
    savedFoodsLink: {
        flexShrink: 0,
        paddingHorizontal: spacing.sm
    },
    modeFieldHeader: {
        minHeight: theme.interaction.minimumTouchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.sm
    },
    formContent: {
        gap: spacing.md,
        paddingBottom: spacing.md
    },
    editorContent: {
        gap: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing.md
    },
    searchControls: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.sm,
        paddingBottom: spacing.sm
    },
    searchField: {
        flex: 1
    },
    scanButton: {
        minWidth: 104
    },
    resultsList: {
        flex: 1,
        minHeight: 0
    },
    resultsContent: {
        gap: spacing.sm,
        paddingBottom: spacing.lg
    },
    listHeader: {
        paddingTop: spacing.sm
    },
    listFooter: {
        gap: spacing.sm,
        paddingTop: spacing.sm
    },
    emptyMessage: {
        paddingVertical: spacing.lg
    },
    foodRow: {
        minHeight: 64,
        borderRadius: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderBottomColor: theme.colors.outlineVariant,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingVertical: spacing.md
    },
    foodText: {
        flex: 1,
        minWidth: 0,
        gap: spacing.xs
    },
    rowIcon: {
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md
    },
    actionsStacked: { flexDirection: 'column' },
    actionButton: {
        flex: 1,
        minWidth: Platform.OS === 'web' ? 'auto' : 0
    },
    disabled: {
        opacity: 0.45
    },
    pressed: {
        opacity: 0.82
    },
    error: {
        color: theme.colors.danger
    },
    attributionLink: {
        color: theme.colors.primary,
        textDecorationLine: 'underline'
    }
});
