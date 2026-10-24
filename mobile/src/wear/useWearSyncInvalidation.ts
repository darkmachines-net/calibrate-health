/** @file use Wear Sync Invalidation: Notify only the exact paired node after committed Android mutations and retry durable sends on foreground. */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { hasFullAccountAccess } from '../auth/accountAccess';
import { flushWearSyncInvalidation, queueWearSyncInvalidation } from './syncInvalidation';

function wasQueuedOffline(value: unknown): boolean {
    return Boolean(value && typeof value === 'object' && (value as { disposition?: unknown }).disposition === 'queued');
}

/** Notify only the exact paired node after committed Android mutations and retry durable sends on foreground. */
export function useWearSyncInvalidation(enabled = true): void {
    const queryClient = useQueryClient();
    const { serverUrl, user } = useAuth();

    useEffect(() => {
        if (!enabled || !user || !hasFullAccountAccess(user)) return;
        let active = true;
        const notify = () => {
            if (!active) return;
            void queueWearSyncInvalidation({ serverOrigin: serverUrl, userId: user.id });
        };
        const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
            if (
                event.type === 'updated'
                && event.action.type === 'success'
                && !wasQueuedOffline(event.mutation.state.data)
            ) notify();
        });
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') {
                void flushWearSyncInvalidation({ serverOrigin: serverUrl, userId: user.id });
            }
        });
        void flushWearSyncInvalidation({ serverOrigin: serverUrl, userId: user.id });
        return () => {
            active = false;
            unsubscribe();
            subscription.remove();
        };
    }, [enabled, queryClient, serverUrl, user]);
}
