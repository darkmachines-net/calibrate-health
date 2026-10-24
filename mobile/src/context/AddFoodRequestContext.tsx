/** @file Add Food Request Context: Keeps add-food intent outside the tab routes so the sheet opens on the already-mounted Today screen instead of during a navigation transition. */

import React, { createContext, useContext } from 'react';
import type { MealPeriod } from '@calibrate/shared';

export type AddFoodRequest = {
    id: number;
    date?: string;
    meal?: MealPeriod | null;
};

export type AddFoodRequestInput = Omit<AddFoodRequest, 'id'>;

export type AddFoodRequestContextValue = {
    request: AddFoodRequest | null;
    requestAddFood: (input?: AddFoodRequestInput) => void;
    consumeRequest: (id: number) => void;
};

const AddFoodRequestContext = createContext<AddFoodRequestContextValue | null>(null);

/**
 * Keeps add-food intent outside the tab routes so the sheet opens on the
 * already-mounted Today screen instead of during a navigation transition.
 */
export const AddFoodRequestProvider: React.FC<{
    value: AddFoodRequestContextValue;
    children: React.ReactNode;
}> = ({ value, children }) => (
    <AddFoodRequestContext.Provider value={value}>{children}</AddFoodRequestContext.Provider>
);

/** Reads shared add-food requests and throws when used outside the request provider. */
export function useAddFoodRequest(): AddFoodRequestContextValue {
    const value = useContext(AddFoodRequestContext);
    if (!value) {
        throw new Error('useAddFoodRequest must be used inside AddFoodRequestProvider');
    }
    return value;
}
