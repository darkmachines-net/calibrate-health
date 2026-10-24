/** @file Goal Pace Sheet: Mounted per editor session so cancellation never carries a draft into another goal. */

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type GoalEntry, type GoalPaceRequest } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { BottomSheetModal } from '../components/BottomSheetModal';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { GoalDailyChangeSelect } from '../components/GoalDailyChangeSelect';
import { useOnlineStatus } from '../components/AsyncStateBoundary';
import { confirmDiscardChanges } from '../components/confirmDiscardChanges';
import { usePendingWeightMutation } from '../offline/usePendingWeightMutation';
import { getSafeActionErrorMessage } from '../errors/presentation';
import { invalidateProfilePlanningQueries } from '../caloriePlanning/queryInvalidation';
import { formatWeight } from '../utils/format';
import { getLocalDateForTimestamp } from '../utils/dates';
import { spacing } from '../theme';
/** Mounted per editor session so cancellation never carries a draft into another goal. */
export function GoalPaceSheet({ goal, onClose, onStartNewGoal }: {
    goal: GoalEntry;
    onClose: () => void;
    onStartNewGoal: () => void;
}) {
    const { api, user, pendingReconnection, recheckClientCompatibility } = useAuth();
    const client = useQueryClient();
    const online = useOnlineStatus();
    const pendingWeight = usePendingWeightMutation();
    const [value, setValue] = useState(String(Math.abs(goal.daily_deficit)));
    const [selectOpen, setSelectOpen] = useState(false);
    const [saved, setSaved] = useState(false);
    const [refreshFailed, setRefreshFailed] = useState(false);
    const ticket = useRef<{
        key: string;
        operationId: string;
        payload: GoalPaceRequest;
    } | null>(null);
    const submitting = useRef(false);
    // A refreshed version must initialize its own draft; unchanged refreshes keep edits.
    const [initializedVersion, setInitializedVersion] = useState<string | null>(null);
    const [baseline, setBaseline] = useState(value);
    async function verifyConnection() {
        if (pendingReconnection && !await recheckClientCompatibility()) {
            throw new Error('Reconnect to the same account before adjusting your pace.');
        }
    }
    const preview = useQuery({ queryKey: ['goal-pace-options', goal.id], queryFn: async () => {
        await verifyConnection();
        return api.getGoalPaceOptions();
    },
        staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false });
    useEffect(() => {
        if (preview.isSuccess && !preview.isFetching && preview.data.goal.id === goal.id &&
            initializedVersion !== preview.data.expected_plan_version) {
            const current = String(Math.abs(preview.data.goal.daily_deficit));
            setValue(current);
            setBaseline(current);
            setInitializedVersion(preview.data.expected_plan_version);
        }
    }, [goal.id, initializedVersion, preview.data, preview.isFetching, preview.isSuccess]);
    const deficit = Math.sign(goal.daily_deficit) * Number(value);
    const selected = preview.data?.planOptions.find(option => option.dailyDeficit === deficit);
    const fresh = online && preview.isSuccess && !preview.isFetching && preview.data.goal.id === goal.id;
    const canSave = initializedVersion !== null && initializedVersion === preview.data?.expected_plan_version && fresh && selected?.available === true && !pendingWeight && !saved;
    const dirty = !saved && value !== baseline;
    async function refreshViews() {
        try {
            await invalidateProfilePlanningQueries(client);
            await client.invalidateQueries({ queryKey: ['mobile-metrics-trend'] });
            const failed = ['mobile-goal', 'mobile-profile', 'mobile-calibration-status'].some(key => client.getQueryState([key])?.status === 'error');
            setRefreshFailed(failed);
            if (!failed)
                onClose();
        }
        catch {
            setRefreshFailed(true);
        }
    }
    const save = useMutation({
        mutationFn: async () => {
            await verifyConnection();
            const key = JSON.stringify([goal.id, deficit, preview.data!.expected_plan_version]);
            if (!ticket.current || ticket.current.key !== key)
                ticket.current = {
                    key, operationId: Crypto.randomUUID(),
                    payload: { daily_deficit: deficit, expected_plan_version: preview.data!.expected_plan_version }
                };
            return api.adjustGoalPace(goal.id, ticket.current.payload, ticket.current.operationId);
        },
        onSuccess: async (updated) => {
            setSaved(true);
            client.setQueryData(['mobile-goal'], updated);
            AccessibilityInfo.announceForAccessibility('Pace saved. Your goal and progress are unchanged.');
            await refreshViews();
        },
        onError: error => {
            if (error instanceof ApiError && error.status === 409) {
                ticket.current = null;
                // A conflict requires reviewing the authoritative pace before another save.
                setInitializedVersion(null);
                void preview.refetch();
            }
        },
        onSettled: () => { submitting.current = false; }
    });
    async function close() {
        if (!save.isPending && (!dirty || await confirmDiscardChanges()))
            onClose();
    }
    async function startNewGoal() {
        if (!save.isPending && (!dirty || await confirmDiscardChanges()))
            onStartNewGoal();
    }
    function submit() {
        if (!canSave || submitting.current || save.isPending)
            return;
        submitting.current = true;
        save.mutate();
    }
    return <BottomSheetModal visible title="Edit goal" accessibilityLabel="Edit goal" description="Keep your existing goal, starting weight, start date and progress." showCloseButton dismissDisabled={save.isPending} isDirty={dirty} confirmDismiss={confirmDiscardChanges} onRequestClose={onClose}>
        <View style={{ gap: spacing.md }}>
            <AppText>Start {formatWeight(goal.start_weight, user?.weight_unit)} | Goal {formatWeight(goal.target_weight, user?.weight_unit)} | Started {getLocalDateForTimestamp(goal.created_at, user?.timezone)}</AppText>
            <AppText variant="muted">Changes apply today. Completed days keep their saved comparison. Accepted calibration corrections remain in place and are checked for safety.</AppText>
            {preview.isFetching && <AppText>Checking your current plan...</AppText>}
            {(!online || pendingWeight) && <AppText accessibilityRole="alert">
                {pendingWeight ? 'Wait for the queued weight change to sync before adjusting your pace.' : 'Reconnect to check and save your pace.'}
            </AppText>}
            {preview.isError && <AppText accessibilityRole="alert">Unable to check your current plan. Retry before saving.</AppText>}
            {fresh && preview.data.goal.id === goal.id && <>
                <GoalDailyChangeSelect goalMode={goal.daily_deficit < 0 ? 'gain' : 'lose'} value={value} isOpen={selectOpen} onToggle={() => { if (!save.isPending && !saved)
            setSelectOpen(!selectOpen); }} onChange={next => { if (!save.isPending && !saved) {
            setValue(next);
            setSelectOpen(false);
        } }} planOptions={preview.data.planOptions}/>
                {selected?.dailyCalorieTarget != null && <AppText>New target: {selected.dailyCalorieTarget.toLocaleString()} kcal/day</AppText>}
            </>}
            {preview.data && preview.data.goal.id !== goal.id && <AppText accessibilityRole="alert">A new goal is active. Close and reopen to use the current goal.</AppText>}
            {save.error && !saved && <AppText accessibilityRole="alert">{getSafeActionErrorMessage(save.error, 'Unable to confirm the saved pace. Retry to check the same change.')}</AppText>}
            {saved && refreshFailed && <AppText accessibilityRole="alert">Pace saved. Some views could not refresh. Retry refresh to see the current plan.</AppText>}
            {saved ? <AppButton title="Retry refresh" onPress={() => void refreshViews()}/> : <>
                <AppButton title="Retry plan check" variant="secondary" disabled={!online || preview.isFetching || save.isPending} onPress={() => { ticket.current = null; void preview.refetch(); }}/>
                <AppButton title="Save pace" onPress={submit} disabled={!canSave} busy={save.isPending} busyLabel="Saving pace..."/>
            </>}
            <AppButton title="Cancel" variant="secondary" disabled={save.isPending} onPress={() => void close()}/>
            <AppText variant="muted">Want a different target? Start a new goal with your current weight and a new start date.</AppText>
            <AppButton title="Set a new goal" variant="secondary" disabled={save.isPending} onPress={() => void startNewGoal()}/>
        </View>
    </BottomSheetModal>;
}
