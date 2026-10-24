/** @file use Tracking Queries: Filters queued tracking mutations to the active account and canonical server namespace. */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FoodLogEntry, MetricEntry } from '@calibrate/api-client';
import { useAuth } from '../auth/AuthContext';
import { useOfflineOutbox } from './provider';
import { createOutboxNamespace, type QueuedMutation } from './queuedMutation';
import { projectFood, projectMetrics, hasActiveFoodMutation, preserveFoodReceiptIdentities, type LocalEntry } from './trackingProjection';
const EMPTY: QueuedMutation[] = [];
/** Filters queued tracking mutations to the active account and canonical server namespace. */
export function useScopedTrackingMutations() {
    const { serverUrl, user } = useAuth();
    const { mutations = EMPTY } = useOfflineOutbox();
    const namespace = serverUrl && user ? createOutboxNamespace(serverUrl, user.id) : null;
    return useMemo(() => mutations.filter(mutation => mutation.namespace === namespace), [mutations, namespace]);
}

/** Loads dated food entries while projecting queued edits and preventing stale requests from replacing local intent. */
export function useTrackingFood(date: string) {
    const { api } = useAuth();
    const mutations = useScopedTrackingMutations();
    const queryClient = useQueryClient();
    const cached = queryClient.getQueryData<FoodLogEntry[]>(['mobile-food', date]);
    const pending = hasActiveFoodMutation(mutations, date, cached);
    useEffect(() => { if (pending) void queryClient.cancelQueries({ queryKey: ['mobile-food', date] }); }, [pending, queryClient, date]);
    const query = useQuery({ queryKey: ['mobile-food', date], queryFn: async () => {
        const previous = queryClient.getQueryData<(FoodLogEntry & LocalEntry)[]>(['mobile-food', date]);
        if (pending) return previous ?? [];
        const fresh = await api.getFoodLog(date);
        return preserveFoodReceiptIdentities(fresh, queryClient.getQueryData<(FoodLogEntry & LocalEntry)[]>(['mobile-food', date]));
    }, enabled: !pending });
    const data = useMemo(() => projectFood(query.data, mutations, date), [query.data, mutations, date]);
    return { ...query, data, ...(data ? { isPending: false, isLoading: false, dataUpdatedAt: Math.max(1, query.dataUpdatedAt) } : {}) };
}

/** Loads weight entries while projecting queued edits and canceling stale requests during active mutations. */
export function useTrackingMetrics(enabled = true) {
    const { api } = useAuth();
    const mutations = useScopedTrackingMutations();
    const pending = mutations.some(m => m.operation.startsWith('metric.') && m.state !== 'failed');
    const queryClient = useQueryClient();
    useEffect(() => { if (pending) void queryClient.cancelQueries({ queryKey: ['mobile-metrics'] }); }, [pending, queryClient]);
    const query = useQuery({ queryKey: ['mobile-metrics'], queryFn: () => pending ? Promise.resolve(queryClient.getQueryData<MetricEntry[]>(['mobile-metrics']) ?? []) : api.getMetrics(), enabled: enabled && !pending });
    const data = useMemo(() => projectMetrics(query.data, mutations), [query.data, mutations]);
    return { ...query, data, ...(data ? { isPending: false, isLoading: false, dataUpdatedAt: Math.max(1, query.dataUpdatedAt) } : {}) };
}
