/** @file use Barcode Search Handoff: Consumes a barcode Search foods handoff once, after its target local date is active. */

import { useEffect, useRef } from 'react';
import type { MealPeriod } from '@calibrate/shared';
import { MEAL_OPTIONS } from '../utils/meals';

export type BarcodeSearchHandoffParams = {
    date?: string;
    meal?: string;
    openAddFood?: string;
};

type BarcodeSearchHandoffOptions = {
    params: BarcodeSearchHandoffParams;
    selectedDate: string;
    enabled: boolean;
    setDate: (date: string) => void;
    openSheet: (meal: MealPeriod | null) => void;
    scrubParams: (date: string) => void;
};

/** Consumes a barcode Search foods handoff once, after its target local date is active. */
export function useBarcodeSearchHandoff({
    params,
    selectedDate,
    enabled,
    setDate,
    openSheet,
    scrubParams
}: BarcodeSearchHandoffOptions): void {
    const handledRequestRef = useRef<string | null>(null);

    useEffect(() => {
        if (params.openAddFood !== 'true') {
            handledRequestRef.current = null;
            return;
        }
        const requestKey = `${params.date ?? ''}|${params.meal ?? ''}`;
        if (handledRequestRef.current === requestKey) return;
        const requestDate = typeof params.date === 'string' ? params.date : selectedDate;
        if (requestDate !== selectedDate) {
            setDate(requestDate);
            return;
        }
        if (!enabled) return;
        const requestedMeal = typeof params.meal === 'string' && MEAL_OPTIONS.includes(params.meal as MealPeriod)
            ? params.meal as MealPeriod
            : null;
        openSheet(requestedMeal);
        handledRequestRef.current = requestKey;
        scrubParams(requestDate);
    }, [
        enabled,
        openSheet,
        params.date,
        params.meal,
        params.openAddFood,
        scrubParams,
        selectedDate,
        setDate
    ]);
}
