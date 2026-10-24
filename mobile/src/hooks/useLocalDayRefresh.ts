/** @file Refreshes day-sensitive server queries at the tab shell while preserving local editing state. */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { calibrationStatusQueryKey } from '../calibration/queryKeys';
import { foodDayRangeQueryRoot } from '../food/calendar';
import { foodTrackingPauseQueryKey } from '../food/queryKeys';

/** Refresh relative-day responses once at the tab shell, without clearing drafts or offline intent. */
export function useLocalDayRefresh(today: string) {
    const queryClient = useQueryClient();
    const previousDay = useRef(today);
    useEffect(() => {
        if (previousDay.current === today) return;
        previousDay.current = today;
        void Promise.all([
            ['mobile-food-day'],
            foodDayRangeQueryRoot,
            foodTrackingPauseQueryKey,
            calibrationStatusQueryKey,
            ['mobile-profile'],
            ['mobile-metrics-trend'],
            ['mobile-in-app-notifications']
        ].map(queryKey => queryClient.invalidateQueries({ queryKey })));
    }, [queryClient, today]);
}
