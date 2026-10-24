/** @file Failed Change Recovery Panel: Explicit recovery is available for every failed mutation kind, including legacy/unknown requests. */

import { useAuth } from '../auth/AuthContext';
import { formatWeightUnit } from '../utils/format';
import { useState } from 'react';
import { View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { useOfflineOutbox } from './provider';
import { failedMutationDiscardIds } from './failedMutationRecovery';
import { describePendingChange } from './pendingChangePresentation';
import type { QueuedMutation } from './queuedMutation';

/** Explicit recovery is available for every failed mutation kind, including legacy/unknown requests. */
export function FailedMutationRecovery({ mutation, onRecovered }: { mutation: QueuedMutation; onRecovered?: () => void }) {
    const outbox = useOfflineOutbox();
    const { user } = useAuth();
    const [confirming, setConfirming] = useState(false);
    const recovery = useMutation({
        networkMode: 'always',
        mutationFn: async (discard: boolean) => {
            if (discard) await outbox.discardFailedMutation(mutation.id);
            else await outbox.retryFailed(mutation.id);
        },
        onSuccess: () => { setConfirming(false); onRecovered?.(); }
    });
    let affected: string[] = [];
    try { affected = failedMutationDiscardIds(outbox.mutations, mutation.id); } catch { /* Stale state is rejected by the durable transaction. */ }
    return <View style={{ gap: 8 }}>
        <AppText accessibilityRole="alert">A saved change failed. Related corrections cannot synchronize until you retry the original request or explicitly discard its queued changes. Nothing is discarded automatically.</AppText>
        <AppButton title="Retry original request" disabled={recovery.isPending} variant="secondary" onPress={() => recovery.mutate(false)} />
        {confirming && <>
            <AppText>Discard the following queued changes? This does not undo anything that reached the server. Other changes and accounts are kept.</AppText>
            {outbox.mutations.filter(row => affected.includes(row.id)).map(row => {
                const description = describePendingChange(row, formatWeightUnit(user?.weight_unit));
                return <View key={row.id}><AppText>{description.title}</AppText>{description.details.map((detail, index) => <AppText key={index}>{detail}</AppText>)}</View>;
            })}
        </>}
        <AppButton title={confirming ? 'Confirm discard related changes' : 'Discard related queued changes'} disabled={recovery.isPending || affected.length === 0} variant="secondary" onPress={() => { if (confirming) recovery.mutate(true); else setConfirming(true); }} />
        {recovery.error && <AppText accessibilityRole="alert">Recovery could not finish. Your changes remain on this device; review their current state and try again.</AppText>}
    </View>;
}
