/** @file use Log Date Navigation: Native counterpart to the PWA local-day navigation model. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { addDaysToDateOnly, clampDateOnly, formatDateOnlyForDisplay, getLocalDateForTimestamp } from '../utils/dates';
import { useCurrentLocalDate } from './useCurrentLocalDate';

export type LogDateNavigation = {
    selectedDate: string;
    selectedDateLabel: string;
    today: string;
    minDate: string;
    maxDate: string;
    isToday: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    goToPreviousDate: () => void;
    goToNextDate: () => void;
    goToToday: () => void;
    setDate: (date: string) => void;
};

/**
 * Shared log-day bounds. Clock updates preserve the selected day and any open drafts.
 */
export function useLogDateNavigation(initialDate?: string | null): LogDateNavigation {
    const { api, user } = useAuth();
    const timezone = user?.timezone || 'UTC';
    const today = useCurrentLocalDate(timezone);
    const trackingHistoryQuery = useQuery({
        queryKey: ['mobile-tracking-history'],
        queryFn: () => api.getTrackingHistory(),
        enabled: Boolean(user)
    });
    const minDate = useMemo(
        () => trackingHistoryQuery.data?.tracking_start_date
            ?? getLocalDateForTimestamp(user?.created_at, timezone)
            ?? today,
        [timezone, today, trackingHistoryQuery.data?.tracking_start_date, user?.created_at]
    );
    const maxDate = today;
    const [selectedDate, setSelectedDate] = useState(initialDate || today);

    useEffect(() => {
        setSelectedDate((current) => clampDateOnly(current, minDate, maxDate));
    }, [maxDate, minDate]);

    const effectiveDate = clampDateOnly(selectedDate, minDate, maxDate);
    const setDate = useCallback((date: string) => {
        setSelectedDate(clampDateOnly(date, minDate, maxDate));
    }, [maxDate, minDate]);

    const goToPreviousDate = useCallback(() => {
        setDate(addDaysToDateOnly(effectiveDate, -1));
    }, [effectiveDate, setDate]);

    const goToNextDate = useCallback(() => {
        setDate(addDaysToDateOnly(effectiveDate, 1));
    }, [effectiveDate, setDate]);

    const goToToday = useCallback(() => {
        setDate(maxDate);
    }, [maxDate, setDate]);

    return {
        selectedDate: effectiveDate,
        selectedDateLabel: formatDateOnlyForDisplay(effectiveDate),
        today,
        minDate,
        maxDate,
        isToday: effectiveDate === maxDate,
        canGoBack: effectiveDate > minDate,
        canGoForward: effectiveDate < maxDate,
        goToPreviousDate,
        goToNextDate,
        goToToday,
        setDate
    };
}
