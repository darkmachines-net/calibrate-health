/** @file Barcode Screen: Coordinates camera permission, deduplicated barcode lookup, food selection, and offline-aware logging. */

import { queuedFoodDayStatus } from '../offline/foodDayIntent';
import type { QueuedMutation } from '../offline/queuedMutation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';
import type { FoodSearchResponse } from '@calibrate/api-client';
import { ASYNC_RESOURCE_STATES, isNeverEmpty } from '../asyncState/resolveAsyncState';
import { useAuth } from '../auth/AuthContext';
import { useServerSettings } from '../serverSettings/useServerSettings';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { AppButton } from '../components/AppButton';
import { AppSection } from '../components/AppSection';
import { AppText } from '../components/AppText';
import { AsyncStateBoundary, useAsyncResourceState, useOnlineStatus } from '../components/AsyncStateBoundary';
import {
    FoodSelectionEditor,
    type FoodSelectionSubmitRequest
} from '../components/FoodSelectionEditor';
import { useFoodDayStatus } from '../components/FoodTrackingStatus';
import { LoadingState } from '../components/LoadingState';
import { OverlaySelect } from '../components/OverlaySelect';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { createProviderFoodSelection, type FoodLogSelection } from '../food/foodLogSelection';
import { executeOrQueueMutation, OFFLINE_MUTATION_OPERATIONS } from '../offline/operations';
import { useOfflineOutbox } from '../offline/provider';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { getTodayDate } from '../utils/dates';
import { triggerHapticFeedback } from '../utils/haptics';
import { MEAL_SELECT_OPTIONS } from '../utils/meals';
import { BarcodeCamera } from './BarcodeCamera';
import { BarcodeManualFoodForm } from './BarcodeManualFoodForm';
import { BarcodeManualInput } from './BarcodeManualInput';
import { BarcodeRecoveryActions } from './BarcodeRecoveryActions';
import { BarcodeResultList } from './BarcodeResultList';
import { createBarcodeLoginDestination } from './authReturn';
import {
    clearBarcodeManualFoodDraft,
    readBarcodeManualFoodDraft,
    saveBarcodeManualFoodDraft
} from './manualDraft';
import {
    cameraPermissionCopy,
    isBarcodeCameraAvailable,
    openBarcodeCameraSettings
} from './cameraRuntime';
import {
    BARCODE_RESUME_STEPS,
    BARCODE_RETURN_DESTINATIONS,
    parseBarcodeResumeContext,
    parseBarcodeWorkflowContext,
    type BarcodeResumeContext,
    type BarcodeResumeStep,
    type BarcodeWorkflowRouteParams
} from './context';
import {
    BARCODE_LOOKUP_STATES,
    BARCODE_PERMISSION_STATES,
    resolveBarcodeLookupState,
    resolveBarcodePermissionState
} from './state';
import { useBarcodeCameraLifecycle } from './useBarcodeCameraLifecycle';
import {
    BarcodeRequestGate,
    BarcodeSubmissionGate,
    getProviderAttribution,
    normalizeBarcode,
    resolveBarcodeFoodCandidates,
    type BarcodeFormatHint
} from './workflow';

type BarcodeMode = 'scan' | 'manual-barcode' | 'manual-food';

function getInitialMode(resume: BarcodeResumeContext): BarcodeMode {
    if (resume.resumeStep === BARCODE_RESUME_STEPS.MANUAL) return 'manual-barcode';
    if (resume.resumeStep === BARCODE_RESUME_STEPS.MANUAL_FOOD) return 'manual-food';
    return 'scan';
}

/** Coordinates camera permission, deduplicated barcode lookup, food selection, and offline-aware logging. */
export default function BarcodeScreen() {
    const { nutritionLabelScanning } = useServerSettings();
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const routeParams = useLocalSearchParams<BarcodeWorkflowRouteParams>();
    const { api, user, isLoading: isAuthLoading, clearLocalSession } = useAuth();
    const { enqueue, withOutbox, mutations = [] } = useOfflineOutbox();
    const queryClient = useQueryClient();
    const isOnline = useOnlineStatus();
    const [permission, requestPermission, refreshPermission] = useCameraPermissions();
    const defaultContext = useMemo(() => ({
        date: getTodayDate(user?.timezone),
        meal: MEAL_PERIODS.BREAKFAST,
        returnTo: BARCODE_RETURN_DESTINATIONS.TODAY
    }), [user?.timezone]);
    const routeContext = parseBarcodeWorkflowContext(routeParams, defaultContext);
    const initialResumeRef = useRef<BarcodeResumeContext | null>(null);
    if (!initialResumeRef.current) {
        initialResumeRef.current = parseBarcodeResumeContext(routeParams, {
            ...routeContext,
            resumeStep: BARCODE_RESUME_STEPS.SCAN
        });
    }
    const initialResume = initialResumeRef.current;
    const initialBarcode = initialResume.barcode ? normalizeBarcode(initialResume.barcode) : null;
    const [mode, setMode] = useState<BarcodeMode>(() => getInitialMode(initialResume));
    const [barcode, setBarcode] = useState<string | null>(initialBarcode);
    const [manualBarcode, setManualBarcode] = useState(initialBarcode ?? '');
    const [manualFoodName, setManualFoodName] = useState('');
    const [manualFoodCalories, setManualFoodCalories] = useState('');
    const [manualBarcodeError, setManualBarcodeError] = useState<string | null>(null);
    const [cameraMessage, setCameraMessage] = useState<string | null>(null);
    const [scanError, setScanError] = useState<string | null>(null);
    const [hasRequestedPermission, setHasRequestedPermission] = useState(false);
    const [isCameraAvailable, setIsCameraAvailable] = useState<boolean | null>(null);
    const [meal, setMeal] = useState<MealPeriod>(routeContext.meal);
    const [selection, setSelection] = useState<FoodLogSelection | null>(null);
    const [lookupResult, setLookupResult] = useState<FoodSearchResponse | null>(null);
    const [isMealSelectorOpen, setIsMealSelectorOpen] = useState(false);
    const requestGate = useRef(new BarcodeRequestGate());
    const submissionGate = useRef(new BarcodeSubmissionGate());
    const activeBarcodeRef = useRef<string | null>(null);
    const resumedLookupRef = useRef(false);
    const manualDraftRestoredRef = useRef(false);
    const selectedDate = routeContext.date;

    useEffect(() => {
        if (mode !== 'manual-food' || !user) return;
        const context = {
            ownerId: user.id,
            date: selectedDate,
            meal,
            returnTo: routeContext.returnTo
        };
        if (!manualDraftRestoredRef.current) {
            manualDraftRestoredRef.current = true;
            const draft = readBarcodeManualFoodDraft(context);
            if (draft) {
                setManualFoodName(draft.name);
                setManualFoodCalories(draft.calories);
                return;
            }
        }
        saveBarcodeManualFoodDraft({
            ...context,
            name: manualFoodName,
            calories: manualFoodCalories
        });
    }, [manualFoodCalories, manualFoodName, meal, mode, routeContext.returnTo, selectedDate, user]);

    const foodDayQuery = useFoodDayStatus(selectedDate, Boolean(user));
    const foodDayState = useAsyncResourceState(foodDayQuery, isNeverEmpty);

    useEffect(() => {
        if (!user) return;
        let current = true;
        void isBarcodeCameraAvailable().then((available) => {
            if (current) setIsCameraAvailable(available);
        });
        return () => {
            current = false;
        };
    }, [user]);

    const candidates = barcode
        ? resolveBarcodeFoodCandidates(lookupResult?.items, barcode, lookupResult?.provider)
        : [];
    const lookup = useMutation({
        mutationFn: (lookupBarcode: string) => api.searchFood('', lookupBarcode),
        onSuccess: (response, lookedUpBarcode) => {
            if (activeBarcodeRef.current !== lookedUpBarcode) return;
            setLookupResult(response);
            const nextCandidates = resolveBarcodeFoodCandidates(
                response.items,
                lookedUpBarcode,
                response.provider
            );
            setSelection(nextCandidates.length === 1
                ? createProviderFoodSelection(nextCandidates[0])
                : null);
        },
        onSettled: () => requestGate.current.finish()
    });
    const logFood = useMutation({
        networkMode: 'always', // Persist local intent even when React Query knows the network is offline.
        mutationFn: ({ payload }: FoodSelectionSubmitRequest) => {
            const submit = (write: (operation: string, payload: unknown, operationId?: string) => Promise<unknown>, mustQueue: boolean, pending: readonly QueuedMutation[]) => {
                if (queuedFoodDayStatus(pending, payload.date, foodDayQuery.data?.status) !== 'OPEN') {
                    throw new Error('Backfill this day before adding food.');
                }
                return executeOrQueueMutation({
                    forceQueue: mustQueue,
                    operation: OFFLINE_MUTATION_OPERATIONS.CREATE_FOOD_LOG,
                    payload,
                    execute: (operationId) => api.createFoodLog(payload, operationId),
                    enqueue: write
                });
            };
            return withOutbox ? withOutbox(submit) : submit(enqueue, mutations.length > 0, mutations);
        },
        onError: () => submissionGate.current.fail(),
        onSuccess: async (_result, request) => {
            submissionGate.current.complete();
            clearBarcodeManualFoodDraft();
            triggerHapticFeedback(user?.haptics_enabled, 'success');
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['mobile-food', selectedDate] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-food-day', selectedDate] }),
                queryClient.invalidateQueries({ queryKey: calibrationStatusQueryKey }),
                queryClient.invalidateQueries({ queryKey: ['mobile-profile'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-recent-foods'] }),
                queryClient.invalidateQueries({ queryKey: ['mobile-in-app-notifications'] })
            ]);
            if (!request.closeAfterLogging) {
                resetScanner();
                return;
            }
            navigateToReturn();
        }
    });

    function startLookup(rawBarcode: string, formatHint?: BarcodeFormatHint) {
        const decision = requestGate.current.start(rawBarcode, formatHint);
        if (decision.kind === 'duplicate') return;
        if (decision.kind === 'invalid') {
            if (mode === 'manual-barcode') setManualBarcodeError(decision.message);
            else setScanError(decision.message);
            return;
        }
        setScanError(null);
        setManualBarcodeError(null);
        setManualBarcode(decision.barcode);
        setSelection(null);
        setLookupResult(null);
        activeBarcodeRef.current = decision.barcode;
        setBarcode(decision.barcode);
        lookup.reset();
        lookup.mutate(decision.barcode);
    }

    function handleBarcodeScanned(result: BarcodeScanningResult) {
        startLookup(result.data, result.type as BarcodeFormatHint);
    }

    useEffect(() => {
        if (
            !user
            || resumedLookupRef.current
            || initialResume.resumeStep !== BARCODE_RESUME_STEPS.LOOKUP
            || !initialBarcode
        ) return;
        resumedLookupRef.current = true;
        startLookup(initialBarcode);
    });

    const permissionState = resolveBarcodePermissionState({
        permission,
        hasRequestedPermission,
        isCameraAvailable
    });
    const cameraObscured = mode !== 'scan'
        || barcode !== null
        || permissionState !== BARCODE_PERMISSION_STATES.GRANTED;
    const isCameraActive = useBarcodeCameraLifecycle(cameraObscured);
    const lookupState = resolveBarcodeLookupState({
        barcode,
        isOnline,
        status: lookup.status,
        fetchStatus: lookup.isPaused ? 'paused' : lookup.isPending ? 'fetching' : 'idle',
        resultCount: candidates.length,
        error: lookup.error
    });
    const providerAttribution = getProviderAttribution(lookupResult?.provider, lookupResult?.attribution);

    function resetScanner() {
        requestGate.current.reset();
        submissionGate.current.reset();
        activeBarcodeRef.current = null;
        setBarcode(null);
        setManualBarcode('');
        setManualFoodName('');
        setManualFoodCalories('');
        clearBarcodeManualFoodDraft();
        setManualBarcodeError(null);
        setScanError(null);
        setSelection(null);
        setLookupResult(null);
        setIsMealSelectorOpen(false);
        setMode('scan');
        lookup.reset();
        logFood.reset();
    }

    function retryLookup() {
        if (!barcode || !isOnline) return;
        setSelection(null);
        setLookupResult(null);
        activeBarcodeRef.current = barcode;
        lookup.reset();
        startLookup(barcode);
    }

    function submitFood(request: FoodSelectionSubmitRequest) {
        if (submissionGate.current.start() === 'duplicate') return;
        logFood.mutate(request);
    }

    function navigateToReturn() {
        router.replace({
            pathname: routeContext.returnTo === BARCODE_RETURN_DESTINATIONS.FOOD_LOG
                ? '/food-log'
                : '/today',
            params: { date: selectedDate }
        });
    }

    function scanNutritionLabel() {
        router.push({ pathname: '/nutrition-label', params: { from: 'barcode' } });
    }

    function searchFoods() {
        router.replace({
            pathname: routeContext.returnTo === BARCODE_RETURN_DESTINATIONS.FOOD_LOG
                ? '/food-log'
                : '/today',
            params: { date: selectedDate, meal, openAddFood: 'true' }
        });
    }

    function openManualFood() {
        submissionGate.current.reset();
        logFood.reset();
        clearBarcodeManualFoodDraft();
        manualDraftRestoredRef.current = false;
        setManualFoodName('');
        setManualFoodCalories('');
        setIsMealSelectorOpen(false);
        setMode('manual-food');
    }

    async function handlePermissionRequest() {
        setCameraMessage(null);
        setHasRequestedPermission(true);
        try {
            const nextPermission = await requestPermission();
            if (!nextPermission.granted) {
                setCameraMessage(nextPermission.canAskAgain
                    ? 'Camera permission was not granted. You can try again or enter the barcode.'
                    : cameraPermissionCopy.blockedMessage);
            }
        } catch {
            setCameraMessage('Unable to request camera permission. Try again or enter the barcode.');
        }
    }

    async function checkCameraPermission() {
        setCameraMessage(null);
        try {
            const nextPermission = await refreshPermission();
            if (!nextPermission.granted) setCameraMessage(cameraPermissionCopy.stillBlockedMessage);
        } catch {
            setCameraMessage('Unable to check camera permission. Try again.');
        }
    }

    async function handlePermanentPermission() {
        setCameraMessage(null);
        const opened = await openBarcodeCameraSettings();
        if (opened) {
            setCameraMessage(cameraPermissionCopy.openedSettingsMessage);
        } else if (cameraPermissionCopy.openSettingsError) {
            setCameraMessage(cameraPermissionCopy.openSettingsError);
        } else {
            await checkCameraPermission();
        }
    }

    function renderMealField() {
        return (
            <View style={styles.mealField}>
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
        );
    }

    if (isAuthLoading) return <LoadingState label="Restoring session..." />;
    if (!user) {
        let resumeStep: BarcodeResumeStep = BARCODE_RESUME_STEPS.SCAN;
        if (barcode) resumeStep = BARCODE_RESUME_STEPS.LOOKUP;
        else if (mode === 'manual-food') resumeStep = BARCODE_RESUME_STEPS.MANUAL_FOOD;
        else if (mode === 'manual-barcode') resumeStep = BARCODE_RESUME_STEPS.MANUAL;
        return <Redirect href={createBarcodeLoginDestination({
            ...routeContext,
            meal,
            resumeStep,
            ...(barcode ? { barcode } : {})
        })} />;
    }
    if (foodDayState.kind === ASYNC_RESOURCE_STATES.LOADING) {
        return <LoadingState label="Checking tracking status..." />;
    }
    if (foodDayState.kind === ASYNC_RESOURCE_STATES.ERROR) {
        return (
            <Screen contentWidth="form" safeTop>
                <AsyncStateBoundary
                    state={foodDayState}
                    resourceLabel="tracking status"
                    loading={<LoadingState label="Checking tracking status..." />}
                    empty={null}
                    onRetry={isOnline ? () => foodDayQuery.refetch() : undefined}
                    retrying={foodDayQuery.isFetching}
                >
                    {null}
                </AsyncStateBoundary>
            </Screen>
        );
    }
    const trackingStatusNotice = (
        foodDayState.kind === ASYNC_RESOURCE_STATES.STALE
        || foodDayState.kind === ASYNC_RESOURCE_STATES.DEGRADED
    ) ? (
        <AsyncStateBoundary
            state={foodDayState}
            resourceLabel="tracking status"
            loading={null}
            empty={null}
            onRetry={isOnline ? () => foodDayQuery.refetch() : undefined}
            retrying={foodDayQuery.isFetching}
        >
            {null}
        </AsyncStateBoundary>
    ) : null;
    if (foodDayQuery.data?.status !== 'OPEN') {
        return (
            <Screen contentWidth="form" safeTop>
                {trackingStatusNotice}
                <AppSection>
                    <SectionHeader
                        headingLevel={1}
                        title="Food logging is unavailable"
                        description="Resume tracking or backfill this day before adding food."
                    />
                    <AppButton title="Back to log" onPress={navigateToReturn} />
                </AppSection>
            </Screen>
        );
    }

    if (mode === 'manual-food') {
        return (
            <Screen contentWidth="form" safeTop>
                {trackingStatusNotice}
                <AppSection>
                    <SectionHeader
                        headingLevel={1}
                        title="Add food manually"
                        description="Enter calories when a barcode or food search is not useful."
                    />
                    {renderMealField()}
                    <BarcodeManualFoodForm
                        date={selectedDate}
                        meal={meal}
                        barcode={barcode}
                        isSubmitting={logFood.isPending}
                        error={logFood.error
                            ? getSafeActionErrorMessage(logFood.error, 'Food could not be added. Try again.')
                            : null}
                        name={manualFoodName}
                        calories={manualFoodCalories}
                        onNameChange={setManualFoodName}
                        onCaloriesChange={setManualFoodCalories}
                        onCancel={() => {
                            submissionGate.current.reset();
                            logFood.reset();
                            clearBarcodeManualFoodDraft();
                            setManualFoodName('');
                            setManualFoodCalories('');
                            setMode(barcode ? 'manual-barcode' : 'scan');
                        }}
                        onSubmit={submitFood}
                    />
                </AppSection>
            </Screen>
        );
    }

    if (mode === 'manual-barcode' && !barcode) {
        return (
            <Screen contentWidth="form" safeTop>
                {trackingStatusNotice}
                <AppSection>
                    <SectionHeader
                        headingLevel={1}
                        title="Enter barcode"
                        description="Use the EAN or UPC digits printed on the package."
                    />
                    <BarcodeManualInput
                        value={manualBarcode}
                        error={manualBarcodeError}
                        disabled={lookup.isPending}
                        onChange={(value) => {
                            setManualBarcode(value);
                            setManualBarcodeError(null);
                        }}
                        onSubmit={() => startLookup(manualBarcode)}
                        onCancel={permissionState === BARCODE_PERMISSION_STATES.GRANTED
                            ? () => {
                                setManualBarcodeError(null);
                                setMode('scan');
                            }
                            : undefined}
                    />
                    <BarcodeRecoveryActions onSearchFoods={searchFoods} onAddManually={openManualFood} onScanLabel={nutritionLabelScanning ? scanNutritionLabel : undefined} />
                    <AppButton title="Back to log" variant="ghost" onPress={navigateToReturn} />
                </AppSection>
            </Screen>
        );
    }

    if (!barcode && permissionState !== BARCODE_PERMISSION_STATES.GRANTED) {
        let title = 'Checking camera';
        let description = 'Checking whether this device can scan a barcode.';
        let permissionAction = null as React.ReactNode;
        if (permissionState === BARCODE_PERMISSION_STATES.FIRST_REQUEST) {
            title = 'Camera permission';
            description = 'Calibrate uses the camera only while this scanner is open.';
            permissionAction = <AppButton title="Allow camera" onPress={() => void handlePermissionRequest()} />;
        } else if (permissionState === BARCODE_PERMISSION_STATES.DENIED) {
            title = 'Camera access denied';
            description = 'Try the permission request again, or use a camera-free option.';
            permissionAction = (
                <AppButton title="Try camera permission again" onPress={() => void handlePermissionRequest()} />
            );
        } else if (permissionState === BARCODE_PERMISSION_STATES.PERMANENTLY_DENIED) {
            title = 'Camera access blocked';
            description = cameraPermissionCopy.blockedDescription;
            permissionAction = (
                <>
                    <AppButton
                        title={cameraPermissionCopy.settingsActionTitle}
                        accessibilityHint={cameraPermissionCopy.settingsActionHint}
                        onPress={() => void handlePermanentPermission()}
                    />
                    <AppButton
                        title="Check camera access"
                        variant="secondary"
                        onPress={() => void checkCameraPermission()}
                    />
                </>
            );
        } else if (permissionState === BARCODE_PERMISSION_STATES.UNAVAILABLE) {
            title = 'Camera unavailable';
            description = 'This device does not report a usable camera. You can still enter the barcode.';
        }
        return (
            <Screen contentWidth="form" safeTop>
                {trackingStatusNotice}
                <AppSection>
                    <SectionHeader headingLevel={1} title={title} description={description} />
                    {cameraMessage && (
                        <AppText accessibilityLiveRegion="polite" style={styles.permissionMessage}>
                            {cameraMessage}
                        </AppText>
                    )}
                    {permissionAction}
                    <AppButton title="Enter barcode" variant="secondary" onPress={() => setMode('manual-barcode')} />
                    <BarcodeRecoveryActions onSearchFoods={searchFoods} onAddManually={openManualFood} onScanLabel={nutritionLabelScanning ? scanNutritionLabel : undefined} />
                    <AppButton title="Back to log" variant="ghost" onPress={navigateToReturn} />
                </AppSection>
            </Screen>
        );
    }

    if (!barcode) {
        return (
            <Screen scroll={false} safeTop style={styles.scannerRoot}>
                {trackingStatusNotice}
                <BarcodeCamera
                    active={isCameraActive}
                    onBarcodeScanned={handleBarcodeScanned}
                    onCameraUnavailable={() => setIsCameraAvailable(false)}
                />
                <View style={styles.panel}>
                    <AppSection>
                        <SectionHeader
                            headingLevel={1}
                            title="Scan barcode"
                            description="Center the packaged-food barcode in the frame."
                        />
                        <AppText
                            accessibilityLiveRegion="polite"
                            accessibilityRole={scanError ? 'alert' : undefined}
                            style={scanError ? styles.error : undefined}
                            variant={scanError ? 'body' : 'muted'}
                        >
                            {scanError ?? 'Camera ready. Center an EAN or UPC barcode in the frame.'}
                        </AppText>
                        <AppButton title="Enter barcode" variant="secondary" onPress={() => setMode('manual-barcode')} />
                        <BarcodeRecoveryActions onSearchFoods={searchFoods} onAddManually={openManualFood} onScanLabel={nutritionLabelScanning ? scanNutritionLabel : undefined} />
                        <AppButton title="Back to log" variant="ghost" onPress={navigateToReturn} />
                    </AppSection>
                </View>
            </Screen>
        );
    }

    let statusMessage = 'Preparing barcode lookup...';
    if (lookupState.kind === BARCODE_LOOKUP_STATES.SEARCHING) statusMessage = 'Searching food providers...';
    else if (lookupState.kind === BARCODE_LOOKUP_STATES.NO_RESULT) {
        statusMessage = 'No food matched this barcode. Search foods or add it manually.';
    } else if (
        lookupState.kind === BARCODE_LOOKUP_STATES.OFFLINE
        || lookupState.kind === BARCODE_LOOKUP_STATES.AUTH_REQUIRED
        || lookupState.kind === BARCODE_LOOKUP_STATES.ERROR
    ) statusMessage = lookupState.failure.message;
    else if (lookupState.kind === BARCODE_LOOKUP_STATES.RESULT && candidates.length === 1) {
        statusMessage = `Found ${candidates[0].name}.`;
    } else if (lookupState.kind === BARCODE_LOOKUP_STATES.RESULT) {
        statusMessage = `Found ${candidates.length} possible matches. Choose the right food.`;
    }

    const lookupFailed = lookupState.kind === BARCODE_LOOKUP_STATES.NO_RESULT
        || lookupState.kind === BARCODE_LOOKUP_STATES.OFFLINE
        || lookupState.kind === BARCODE_LOOKUP_STATES.AUTH_REQUIRED
        || lookupState.kind === BARCODE_LOOKUP_STATES.ERROR;
    const canRetryLookup = isOnline && (
        lookupState.kind === BARCODE_LOOKUP_STATES.NO_RESULT
        || (lookupState.kind === BARCODE_LOOKUP_STATES.OFFLINE && lookupState.failure.canRetry)
        || (lookupState.kind === BARCODE_LOOKUP_STATES.ERROR && lookupState.failure.canRetry)
    );
    const statusIsAlert = lookupState.kind === BARCODE_LOOKUP_STATES.OFFLINE
        || lookupState.kind === BARCODE_LOOKUP_STATES.AUTH_REQUIRED
        || lookupState.kind === BARCODE_LOOKUP_STATES.ERROR;

    return (
        <Screen contentWidth="form" safeTop>
            {trackingStatusNotice}
            <AppSection>
                <SectionHeader
                    headingLevel={1}
                    title={`Barcode ${barcode}`}
                    description="Choose the food, then confirm its amount before logging."
                />
                <AppText
                    accessibilityLiveRegion="polite"
                    accessibilityRole={statusIsAlert ? 'alert' : undefined}
                    style={statusIsAlert ? styles.error : undefined}
                    variant={statusIsAlert ? 'body' : 'muted'}
                >
                    {statusMessage}
                </AppText>
                {providerAttribution && (
                    <AppText
                        accessibilityRole={providerAttribution.url ? 'link' : undefined}
                        accessibilityHint={providerAttribution.url ? 'Opens the food provider website.' : undefined}
                        onPress={providerAttribution.url
                            ? () => void Linking.openURL(providerAttribution.url!)
                            : undefined}
                        style={providerAttribution.url ? styles.attributionLink : undefined}
                        variant="caption"
                    >
                        {providerAttribution.text}
                    </AppText>
                )}
                {renderMealField()}
                {selection ? (
                    <FoodSelectionEditor
                        selection={selection}
                        date={selectedDate}
                        meal={meal}
                        isSubmitting={logFood.isPending}
                        error={logFood.error
                            ? getSafeActionErrorMessage(logFood.error, 'Food could not be added. Try again.')
                            : null}
                        onCancel={() => {
                            submissionGate.current.reset();
                            logFood.reset();
                            setSelection(null);
                        }}
                        onSubmit={submitFood}
                    />
                ) : (
                    <BarcodeResultList
                        candidates={candidates}
                        disabled={logFood.isPending}
                        onChoose={(candidate) => {
                            submissionGate.current.reset();
                            logFood.reset();
                            setSelection(createProviderFoodSelection(candidate));
                        }}
                    />
                )}
                {canRetryLookup && (
                    <AppButton title="Try lookup again" variant="secondary" onPress={retryLookup} />
                )}
                {lookupState.kind === BARCODE_LOOKUP_STATES.AUTH_REQUIRED && (
                    <AppButton title="Sign in again" onPress={() => void clearLocalSession()} />
                )}
                {nutritionLabelScanning && <AppButton title="Scan nutrition label" variant="secondary" disabled={logFood.isPending || lookup.isPending} onPress={scanNutritionLabel} />}
                {lookupFailed && (
                    <BarcodeRecoveryActions
                        disabled={logFood.isPending}
                        onSearchFoods={searchFoods}
                        onAddManually={openManualFood}
                    />
                )}
                <View style={styles.actions}>
                    <AppButton
                        title="Scan again"
                        variant="secondary"
                        disabled={lookup.isPending || logFood.isPending}
                        onPress={resetScanner}
                        style={styles.actionButton}
                    />
                    <AppButton
                        title="Back to log"
                        disabled={logFood.isPending}
                        onPress={navigateToReturn}
                        style={styles.actionButton}
                    />
                </View>
            </AppSection>
        </Screen>
    );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    scannerRoot: {
        paddingHorizontal: 0,
        paddingBottom: 0
    },
    panel: {
        padding: spacing.lg,
        backgroundColor: theme.colors.background
    },
    mealField: {
        gap: spacing.sm
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.md
    },
    actionButton: {
        flex: 1
    },
    error: {
        color: theme.colors.danger
    },
    permissionMessage: {
        color: theme.colors.onSurfaceVariant
    },
    attributionLink: {
        color: theme.colors.primary,
        textDecorationLine: 'underline'
    }
});
