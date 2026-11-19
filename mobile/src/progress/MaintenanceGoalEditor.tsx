/** @file Goal setup and maintenance reviews with one estimated maintenance budget and versioned saving. */
import { useEffect, useId, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, Switch, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, type GoalChange, type GoalStatus } from '@calibrate/api-client';
import { defaultMaintenanceDistance, isMaintenanceRange, isPolicyWeight } from '@calibrate/shared';
import { useAuth } from '../auth/AuthContext';
import { AppText } from '../components/AppText';
import { useOnlineStatus } from '../components/AsyncStateBoundary';
import { BottomSheetModal } from '../components/BottomSheetModal';
import { GoalDailyChangeSelect } from '../components/GoalDailyChangeSelect';
import { GOAL_TYPE_LABEL, GoalTypeSelector } from '../components/GoalTypeSelector';
import { TextField } from '../components/TextField';
import { TabScreen } from '../components/TabScreen';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { useConfirmDiscardNavigation } from '../hooks/useConfirmDiscardNavigation';
import { usePendingWeightMutation } from '../offline/usePendingWeightMutation';
import { interaction, spacing, useAppTheme } from '../theme';
import { gramsToDisplayWeight } from '../utils/bodyMeasurements';
import { formatWeightUnit } from '../utils/format';
import type { GoalMode } from '../utils/goals';
import { normalizeWeightInputText, parseWeightInput, weightInputToCanonicalGrams } from '../weightEntry/input';
import { refreshGoalViews } from './useGoalStatus';
import { useOfflineOutbox } from '../offline/provider';
import { MaintenanceRangeFields } from './MaintenanceRangeFields';
import { centeredMaintenanceRange, displayMaintenanceDistance, distanceFromInput, recenterMaintenanceRange, suggestSymmetricDistance } from './maintenanceRange';
import { GoalFormActions } from './GoalFormActions';
import { getGoalWeightIssue } from './goalWeightValidation';

export type GoalEditorIntent = 'new' | 'return' | 'edit' | 'reset' | 'budget' | 'enable' | 'pause';
export type GoalEditorOptions = { status: GoalStatus; intent: GoalEditorIntent; initialMode?: GoalMode };
type Range = NonNullable<GoalStatus['maintenance']>['range'];

const TITLES: Record<Exclude<GoalEditorIntent, 'new'>, string> = {
    return: 'Review return to target', edit: 'Edit maintenance range', reset: 'Adjust maintenance target',
    budget: 'Review calorie budget', enable: 'Start calorie tracking', pause: 'Turn off calorie tracking'
};

function displayRange(range: Range, unit: GoalStatus['weight_unit']) {
    const label = formatWeightUnit(unit);
    return `${gramsToDisplayWeight(range.lower_weight_grams, unit)} to ${gramsToDisplayWeight(range.upper_weight_grams, unit)} ${label}`;
}

/** Hold the reviewed snapshot through edits and refetches. Guard page departures and reuse the mutation ID on uncertain retries. */
export function MaintenanceGoalEditor({ status: currentStatus, intent, initialMode, onClose }: GoalEditorOptions & { onClose: () => void }) {
    const [status] = useState(currentStatus);
    const theme = useAppTheme();
    const { api, pendingReconnection, recheckClientCompatibility } = useAuth();
    const client = useQueryClient();
    const online = useOnlineStatus();
    const pendingWeight = usePendingWeightMutation();
    const { mutations, withOutbox } = useOfflineOutbox();
    const pendingChanges = pendingWeight || (mutations?.length ?? 0) > 0;
    const unit = status.weight_unit;
    const unitLabel = formatWeightUnit(unit);
    const showWeight = (weight: number | null) => gramsToDisplayWeight(weight, unit);
    const fromInput = (input: string, original?: number) => {
        if (original !== undefined && input === showWeight(original)) return original;
        const value = parseWeightInput(input);
        return value === null ? 0 : weightInputToCanonicalGrams(value, unit);
    };
    const previous = status.maintenance?.range;
    const editing = !!previous && ['edit', 'reset', 'budget', 'enable', 'pause'].includes(intent);
    const choosingDirection = intent === 'new';
    const starting = status.starting_weight_grams ?? 0;
    const completedTarget = status.goal?.completed_on ? status.goal.target_weight_grams : undefined;
    const resumeRange = choosingDirection && completedTarget !== undefined ? status.recovery_range : null;
    const baseTarget = resumeRange?.target_weight_grams ?? previous?.target_weight_grams ?? completedTarget ?? starting;
    const [mode, setMode] = useState<GoalMode>(() => {
        if (intent === 'return') return status.maintenance?.status === 'above_range' ? 'lose' : 'gain';
        if (choosingDirection) return initialMode ?? 'lose';
        return 'maintain';
    });
    const [maintenanceTarget, setMaintenanceTarget] = useState(() => {
        if (intent === 'reset' && status.trend) return showWeight(status.trend.weight_grams);
        return showWeight(baseTarget);
    });
    const [directionalTarget, setDirectionalTarget] = useState(() => intent === 'return' ? showWeight(baseTarget) : '');
    const savedRange = resumeRange ?? (editing && status.maintenance?.status !== 'range_required' ? previous : undefined);
    const defaultDistance = defaultMaintenanceDistance(unit);
    const lowerDistance = savedRange ? savedRange.target_weight_grams - savedRange.lower_weight_grams : defaultDistance;
    const upperDistance = savedRange ? savedRange.upper_weight_grams - savedRange.target_weight_grams : defaultDistance;
    const [distanceDraft, setDistanceDraft] = useState<string | null>(null);
    const keepUnevenRange = savedRange !== undefined && lowerDistance !== upperDistance && distanceDraft === null;
    const [maintenanceTracking, setMaintenanceTracking] = useState(intent === 'enable' || (editing && intent !== 'pause' && status.tracking));
    const [paceChoice, setPaceChoice] = useState<number | null>(null);
    const [stale, setStale] = useState(false);
    const ticket = useRef<{ key: string; operationId: string } | null>(null);
    const maintaining = mode === 'maintain';
    const target = maintaining ? maintenanceTarget : directionalTarget;
    const setTarget = maintaining ? setMaintenanceTarget : setDirectionalTarget;
    const tracking = !maintaining || maintenanceTracking;
    const center = fromInput(target, maintaining || intent === 'return' ? baseTarget : undefined);
    const originalDistance = displayMaintenanceDistance(lowerDistance, unit);
    const distance = distanceDraft ?? originalDistance;
    const distanceGrams = distanceDraft === null ? lowerDistance : distanceFromInput(distanceDraft, unit);
    const range = keepUnevenRange ? recenterMaintenanceRange(savedRange, center) : centeredMaintenanceRange(center, distanceGrams);
    const validRange = isMaintenanceRange(center, range.lower_weight_grams, range.upper_weight_grams);
    const currentWeightLabel = `${showWeight(starting)} ${unitLabel}`;
    const errorId = useId();
    const weightError = getGoalWeightIssue({ mode, starting, target: center, targetEntered: target !== '', unit,
        range: maintaining ? range : null, invalidDistance: distanceGrams === 0, requireStartingWeight: !editing });
    const showRange = maintaining &&
        (status.maintenance?.status === 'range_required' || !['budget', 'enable', 'pause'].includes(intent));
    const showBudget = tracking && maintaining;
    const budget = status.budget_options.find(option => option.offset_kcal === 0)?.target_kcal;
    const budgetRequired = showBudget && (!editing || intent === 'enable' || intent === 'budget');
    const budgetUnavailable = 'The maintenance budget is unavailable with your current profile.';
    let trackingDescription = 'By default, calorie tracking is disabled for a Maintenance goal. Turn it on to continue counting calories.';
    if (tracking) {
        trackingDescription = budget == null ? budgetUnavailable :
            `Calorie tracking will be enabled with an estimated maintenance budget of ${budget.toLocaleString()} kcal/day.`;
    }
    const direction = mode === 'gain' ? -1 : 1;
    const suggestedPace = direction * (intent === 'return' ? 250 : 500);
    const defaultPace = status.pace_options.find(option =>
        option.dailyDeficit === suggestedPace && option.available && option.dailyCalorieTarget != null
    )?.dailyDeficit ?? null;
    const pace = maintaining ? null : paceChoice ?? defaultPace;
    const directionalBudget = status.pace_options.find(option => option.dailyDeficit === pace && option.available)?.dailyCalorieTarget;
    let blockingMessage = weightError?.message;
    if (!blockingMessage && (!online || pendingChanges)) blockingMessage = 'Connect and sync your saved tracking changes before updating your goal.';
    if (!blockingMessage && budgetRequired && budget == null) blockingMessage = 'Turn off calorie tracking or update your profile to estimate a maintenance budget.';
    if (!blockingMessage && !maintaining && directionalBudget == null) blockingMessage = 'Choose an available calorie pace before saving.';
    const canSave = !blockingMessage && !stale;
    const draft = JSON.stringify([mode, maintenanceTarget, directionalTarget, distanceDraft, maintenanceTracking, pace]);
    const initialDraft = useRef(draft);
    const isDirty = choosingDirection && draft !== initialDraft.current;
    const save = useMutation({
        mutationFn: async () => {
            if (pendingReconnection && !await recheckClientCompatibility()) throw new Error('Reconnect to the same account before saving.');
            const payload: GoalChange = {
                expected_version: status.expected_version, target_weight_grams: center,
                ...(maintaining ? range : {}),
                ...(!editing ? { daily_deficit: maintaining ? 0 : pace!, tracking } : {}),
                ...(editing && (intent === 'enable' || intent === 'pause') ? { tracking } : {}),
                ...(intent === 'budget' ? { offset_kcal: 0 } : {}),
                ...(intent === 'return' ? { return_to_target: true } : {})
            };
            const key = JSON.stringify(payload);
            if (ticket.current?.key !== key) ticket.current = { key, operationId: randomUUID() };
            const { operationId } = ticket.current;
            return withOutbox((_enqueue, mustQueue) => {
                if (mustQueue) throw new Error('Sync your saved tracking changes before updating your goal.');
                return editing && status.goal
                    ? api.editMaintenanceGoal(status.goal.id, payload, operationId)
                    : api.transitionGoal(payload, operationId);
            });
        },
        onSuccess: async () => {
            await refreshGoalViews(client);
            if (choosingDirection) allowNavigation(onClose);
            else onClose();
        },
        onError: async error => {
            if (error instanceof ApiError && error.code === 'GOAL_PLAN_CHANGED') {
                setStale(true);
                await refreshGoalViews(client);
            }
        }
    });
    const { allowNavigation, requestNavigation } = useConfirmDiscardNavigation(
        isDirty, choosingDirection && save.isPending
    );
    useEffect(() => {
        // Android Back can change tabs without removing a route from the navigator.
        if (Platform.OS !== 'android' || !choosingDirection || (!isDirty && !save.isPending)) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            void requestNavigation(onClose);
            return true;
        });
        return () => subscription.remove();
    }, [choosingDirection, isDirty, onClose, requestNavigation, save.isPending]);
    const targetField = <TextField label={`Target weight (${unitLabel})`} value={target} required={choosingDirection}
        placeholder={choosingDirection ? 'Enter a target weight' : undefined}
        keyboardType="decimal-pad" editable={!save.isPending && intent !== 'return'}
        externalError={weightError?.target ? { id: errorId, message: weightError.message } : undefined}
        onChangeText={value => setTarget(normalizeWeightInputText(value))} />;
    const staleMessage = choosingDirection ? 'Your plan changed. Reopen goal setup to review the current settings.'
        : 'Your plan changed. Close this review and open it again to see the current settings.';
    const form = <View style={styles.form}>
        {choosingDirection && <View style={styles.goalType}>
            <AppText variant="section" accessibilityRole="header" aria-level={2}>{GOAL_TYPE_LABEL}</AppText>
            <GoalTypeSelector value={mode}
                disabled={save.isPending} onChange={value => {
                    if (value === mode) return;
                    setMode(value);
                    setPaceChoice(null);
                }} />
        </View>}
        {(choosingDirection || !maintaining) && isPolicyWeight(starting) && <AppText>Starting from {currentWeightLabel}</AppText>}
        {!maintaining && targetField}
        {showRange && <>
            {editing && previous && <AppText variant="muted">
                Current target {showWeight(previous.target_weight_grams)} {unitLabel}
                {status.maintenance?.status !== 'range_required' ? ` (${displayRange(previous, unit)})` : ''}.
            </AppText>}
            <MaintenanceRangeFields range={range} valid={validRange} unit={unit} targetField={targetField} distance={distance}
                onDistanceChange={setDistanceDraft} disabled={save.isPending}
                distanceError={weightError?.range ? { id: errorId, message: weightError.message } : undefined}
                onUseCenteredRange={keepUnevenRange ? () => setDistanceDraft(suggestSymmetricDistance(Math.max(lowerDistance, upperDistance), unit)) : undefined} />
        </>}
        {!editing && maintaining && <View style={styles.trackingRow}>
            <View style={styles.trackingCopy}>
                <AppText variant="label">Track calories</AppText>
                <AppText variant="muted">{trackingDescription}</AppText>
            </View>
            <View style={styles.trackingSwitchSlot}>
                <Switch accessibilityLabel="Track calories" value={maintenanceTracking} onValueChange={setMaintenanceTracking}
                    disabled={save.isPending} trackColor={{ false: theme.colors.controlTrack, true: theme.colors.primaryContainer }}
                    thumbColor={tracking ? theme.colors.primary : theme.colors.surface} />
            </View>
        </View>}
        {!maintaining && !status.tracking && <AppText variant="muted">Calorie tracking will resume when you save this goal.</AppText>}
        {(intent === 'pause' || intent === 'enable') && <AppText variant="muted">
            {tracking ? 'Calorie tracking will turn on today.' : 'Calorie tracking will turn off today. Saved food entries stay in your history.'}
        </AppText>}
        {editing && showBudget && <View style={{ gap: spacing.sm }}>
            <AppText variant="label">Estimated maintenance budget</AppText>
            {budget == null ? <AppText variant="muted">{budgetUnavailable}</AppText> :
                <AppText>{budget.toLocaleString()} kcal/day</AppText>}
        </View>}
        {!maintaining && <GoalDailyChangeSelect label={mode === 'gain' ? 'Calorie Surplus' : 'Calorie Deficit'} goalMode={mode}
            planOptions={status.pace_options} value={pace === null ? '' : String(Math.abs(pace))}
            onChange={value => setPaceChoice(direction * Number(value))} disabled={save.isPending} />}
    </View>;
    const saveMessage = blockingMessage ?? (stale ? staleMessage : save.error &&
        getSafeActionErrorMessage(save.error, 'Could not confirm your change. Retry to check the same request.'));
    const actions = <GoalFormActions error={saveMessage} errorId={errorId} title={choosingDirection ? 'Save goal' : 'Confirm change'}
        disabled={!canSave || save.isPending} busy={save.isPending} onPress={() => save.mutate()} />;
    if (choosingDirection) return <TabScreen contentWidth="form" testID="goal-setup-page" footer={actions}>
        {form}
    </TabScreen>;
    return <BottomSheetModal visible title={TITLES[intent]} showCloseButton pinHeader={showRange}
        onRequestClose={onClose} dismissDisabled={save.isPending}>
        <View style={styles.form}>{form}{actions}</View>
    </BottomSheetModal>;
}

// Reserve room around the platform switch without stretching its track independently of its thumb.
const styles = StyleSheet.create({
    form: { gap: spacing.md },
    goalType: { gap: spacing.sm },
    trackingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
    trackingCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    trackingSwitchSlot: { minWidth: interaction.minimumTouchTarget, minHeight: interaction.minimumTouchTarget,
        alignItems: 'center', justifyContent: 'center' }
});
