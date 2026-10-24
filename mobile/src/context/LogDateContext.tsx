/** @file Log Date Context: Shares the selected log day between the app shell and the visible Today screen. */

import React, { createContext, useContext } from 'react';
import type { LogDateNavigation } from '../hooks/useLogDateNavigation';

const LogDateContext = createContext<LogDateNavigation | null>(null);

/**
 * Shares the selected log day between the app shell and the visible Today screen.
 */
export const LogDateProvider: React.FC<{ value: LogDateNavigation; children: React.ReactNode }> = ({ value, children }) => (
    <LogDateContext.Provider value={value}>{children}</LogDateContext.Provider>
);

/** Reads shared log-date navigation and throws when used outside its provider. */
export function useSharedLogDateNavigation(): LogDateNavigation {
    const value = useContext(LogDateContext);
    if (!value) {
        throw new Error('useSharedLogDateNavigation must be used inside LogDateProvider');
    }
    return value;
}
