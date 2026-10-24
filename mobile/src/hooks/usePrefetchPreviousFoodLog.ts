/** @file use Prefetch Previous Food Log: Warms the most likely adjacent food-log query without crossing the account's history boundary. */

import type { FoodLogEntry } from '@calibrate/api-client';
import { useScopedTrackingMutations } from '../offline/useTrackingQueries';
import { hasActiveFoodMutation, preserveFoodReceiptIdentities, type LocalEntry } from '../offline/trackingProjection';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { addDaysToDateOnly } from '../utils/dates';

/** Warms the most likely adjacent food-log query without crossing the account's history boundary. */
export function usePrefetchPreviousFoodLog(selectedDate: string, minDate: string): void {
    const { api } = useAuth();
    const queryClient = useQueryClient();
    const mutations = useScopedTrackingMutations();

    useEffect(() => {
        const previousDate = addDaysToDateOnly(selectedDate, -1);
        if (previousDate < minDate) return;

        if (!hasActiveFoodMutation(mutations, previousDate, queryClient.getQueryData<FoodLogEntry[]>(['mobile-food', previousDate]))) void queryClient.prefetchQuery({
            queryKey: ['mobile-food', previousDate],
            queryFn: async () => preserveFoodReceiptIdentities(await api.getFoodLog(previousDate), queryClient.getQueryData<(FoodLogEntry & LocalEntry)[]>(['mobile-food', previousDate]))
        });
        void queryClient.prefetchQuery({
            queryKey: ['mobile-food-day', previousDate],
            queryFn: () => api.getFoodDay(previousDate)
        });
    }, [api, minDate, queryClient, selectedDate, mutations]);
}
