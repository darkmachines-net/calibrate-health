import { FailedMutationRecovery } from './FailedChangeRecoveryPanel';
import { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { useOfflineOutbox } from './provider';
import { AppNotice } from '../components/AppNotice';
import { AppText } from '../components/AppText';
import { AppButton } from '../components/AppButton';
import { BottomSheetModal } from '../components/BottomSheetModal';
import { formatWeightUnit } from '../utils/format';
import { useScopedTrackingMutations } from './useTrackingQueries';
import { describePendingChange } from './pendingChangePresentation';

/** Local continuity is independent of permission to resume server synchronization. */
export function OfflineWorkspaceStatus() {
    const { user, serverUrl, pendingReconnection, recheckClientCompatibility } = useAuth();
    const { reconcile } = useOfflineOutbox();
    const mutations = useScopedTrackingMutations();
    const queryClient = useQueryClient();
    const [retrying, setRetrying] = useState(false);
    const [reviewing, setReviewing] = useState(false);
    const scopeRef = useRef({ serverUrl, userId: user?.id });
    scopeRef.current = { serverUrl, userId: user?.id };
    const recoveryRef = useRef<() => void>(() => undefined);
    const userId = user?.id;
    useEffect(() => {
        if (userId === undefined || !pendingReconnection) {
            setRetrying(false);
            return;
        }
        let active = true;
        let running = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const retry = async () => {
            if (!active || running || !onlineManager.isOnline() || AppState.currentState === 'background') return;
            running = true;
            setRetrying(true);
            if (timer) clearTimeout(timer);
            try {
                if (await recheckClientCompatibility()) {
                    if (scopeRef.current.serverUrl !== serverUrl || scopeRef.current.userId !== userId) return;
                    await reconcile();
                    await queryClient.invalidateQueries();
                }
            } catch {
                // Unavailability preserves identity and queued writes; terminal rejection is handled by auth.
            } finally {
                running = false;
                if (active) {
                    setRetrying(false);
                    timer = setTimeout(() => void retry(), Math.min(60_000, 5_000 * 2 ** Math.min(attempts++, 4)));
                }
            }
        };
        recoveryRef.current = () => { void retry(); };
        timer = setTimeout(() => void retry(), 5_000);
        const unsubscribe = onlineManager.subscribe((online) => { if (online) void retry(); });
        const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void retry(); });
        return () => {
            active = false;
            if (timer) clearTimeout(timer);
            unsubscribe();
            subscription.remove();
            recoveryRef.current = () => undefined;
        };
    }, [serverUrl, pendingReconnection, queryClient, recheckClientCompatibility, reconcile, userId]);
    const hasFailure = mutations.some(row => row.state === 'failed');
    if (!user || (!pendingReconnection && mutations.length === 0)) return null;
    return <><AppNotice accessibilityLiveRegion="polite" testID="offline-workspace-status">
        <AppText variant="card">{pendingReconnection ? 'Pending reconnection' : 'Changes pending sync'}</AppText>
        <AppText>{hasFailure ? 'A saved change needs attention before synchronization can continue. Unrelated changes remain saved on this device. Open Review saved changes to recover.' : `Keep tracking on this device. ${mutations.length} pending changes will sync after your connection and account access are verified.`}</AppText>
        {mutations.length > 0 ? <AppButton title="Review saved changes" onPress={() => setReviewing(true)} /> : null}
        {pendingReconnection ? <AppButton title={retrying ? 'Reconnecting...' : 'Retry connection'} disabled={retrying} onPress={() => recoveryRef.current()} /> : null}
    </AppNotice>
        <BottomSheetModal visible={reviewing} onRequestClose={() => setReviewing(false)} title="Saved on this device" accessibilityLabel="Saved changes" showCloseButton>
            <AppText>These changes are saved locally in the order shown. Food and weight entries include these local changes. Server-calculated trends and targets update after reconnection.</AppText>
            {mutations.map((mutation) => {
                const description = describePendingChange(mutation, formatWeightUnit(user.weight_unit));
                return <View key={mutation.id} style={{ paddingVertical: 12 }}>
                    <AppText variant="card">{description.title}</AppText>
                    {description.details.map((detail, index) => <AppText key={index}>{detail}</AppText>)}
                    <AppText>{mutation.state === 'failed' ? 'Needs attention before synchronization' : 'Pending synchronization'}</AppText>
                    {mutation.state === 'failed' && <FailedMutationRecovery mutation={mutation} />}
                </View>;
            })}
            <AppText>You can edit or delete local entries in your tracking views. Changes synchronize in the order saved.</AppText>
        </BottomSheetModal>
    </>;
}
