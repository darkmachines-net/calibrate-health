/** @file use Offline Replay Executor: Creates a replay executor that checks current account ownership and reconciles successful query results. */

import { useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { saveOfflineWorkspace } from '../auth/offlineWorkspace';
import { createQueuedMutationExecutor } from './operations';
import { createOutboxNamespace } from './queuedMutation';
import { applyTrackingReceipt } from './trackingReceipts';

/** Creates a replay executor that checks current account ownership and reconciles successful query results. */
export function useOfflineReplayExecutor() {
    const { api, serverUrl, user } = useAuth();
    const client = useQueryClient();
    const scope = useRef({ serverUrl, user });
    scope.current = { serverUrl, user };
    return useMemo(() => createQueuedMutationExecutor(api, {
        isCurrent: mutation => Boolean(scope.current.user && mutation.namespace === createOutboxNamespace(scope.current.serverUrl, scope.current.user.id)),
        onApplied: async (mutation, response) => {
            const current = scope.current;
            if (!current.user || mutation.namespace !== createOutboxNamespace(current.serverUrl, current.user.id)) return;
            applyTrackingReceipt(client, mutation, response);
            await saveOfflineWorkspace(current.serverUrl, current.user, client);
        }
    }), [api, client]);
}
