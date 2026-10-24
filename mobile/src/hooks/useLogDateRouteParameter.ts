/** @file Consumes each changed route date once so later date browsing stays under user control. */

import { useEffect, useRef } from 'react';

/** A route date is a navigation intent, not a constraint on subsequent date browsing. */
export function useLogDateRouteParameter(date: string | undefined, setDate: (date: string) => void) {
    const handledDate = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (date === handledDate.current) return;
        handledDate.current = date;
        if (date) setDate(date);
    }, [date, setDate]);
}
