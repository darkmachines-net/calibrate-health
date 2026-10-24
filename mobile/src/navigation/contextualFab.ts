/** @file contextual Fab: Resolves the active primary tab from the final path segment, ignoring query strings and trailing slashes. */

import type { FoodLogDayStatus } from '@calibrate/api-client';

export type ContextualFabKind = 'add-food' | null;

/** Resolves the active primary tab from the final path segment, ignoring query strings and trailing slashes. */
export function getActiveTabRoute(pathname: string): 'today' | 'progress' | 'food-log' | null {
    const segments = pathname.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean);
    const route = segments[segments.length - 1];
    if (route === 'today' || route === 'progress' || route === 'food-log') return route;
    return null;
}

/** Offers the add-food floating action only for a loaded, open food-log day. */
export function resolveContextualFab(input: {
    pathname: string;
    foodDayStatus?: FoodLogDayStatus;
    foodDayStatusLoaded?: boolean;
}): ContextualFabKind {
    const activeRoute = getActiveTabRoute(input.pathname);
    if (activeRoute !== 'food-log') return null;
    if (!input.foodDayStatusLoaded || input.foodDayStatus !== 'OPEN') return null;
    return 'add-food';
}
