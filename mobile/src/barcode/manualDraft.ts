/** @file Temporary manual food-entry draft continuity across barcode navigation and recovery. */

import type { MealPeriod } from '@calibrate/shared';
import type { BarcodeReturnDestination } from './context';

export type BarcodeManualFoodDraftContext = Readonly<{
    ownerId: number;
    date: string;
    meal: MealPeriod;
    returnTo: BarcodeReturnDestination;
}>;

export type BarcodeManualFoodDraft = BarcodeManualFoodDraftContext & Readonly<{
    name: string;
    calories: string;
}>;

let pendingDraft: BarcodeManualFoodDraft | null = null;

/** Retains the manual-entry draft in memory while navigating through the barcode workflow. */
export function saveBarcodeManualFoodDraft(draft: BarcodeManualFoodDraft): void {
    pendingDraft = draft;
}

/** Returns a draft only when account, day, meal, and return destination match the active workflow. */
export function readBarcodeManualFoodDraft(
    context: BarcodeManualFoodDraftContext
): Pick<BarcodeManualFoodDraft, 'name' | 'calories'> | null {
    if (
        !pendingDraft
        || pendingDraft.ownerId !== context.ownerId
        || pendingDraft.date !== context.date
        || pendingDraft.meal !== context.meal
        || pendingDraft.returnTo !== context.returnTo
    ) return null;
    return { name: pendingDraft.name, calories: pendingDraft.calories };
}

/** Drops the in-memory manual barcode draft. */
export function clearBarcodeManualFoodDraft(): void {
    pendingDraft = null;
}
