/** @file Weight evidence, maintenance range defaults, and goal-completion rules shared by clients and the server. */
import { isPolicyWeight, MAX_WEIGHT_GRAMS, MIN_WEIGHT_GRAMS } from './caloriePolicy';

export type MaintenanceRange = { target_weight_grams: number; lower_weight_grams: number; upper_weight_grams: number };
export type MaintenanceRangeStatus = 'within_range' | 'above_range' | 'below_range';
export const GOAL_TREND_MAX_AGE_DAYS = 7;

/** Return the standard one-sided distance in grams for a new maintenance range. */
export function defaultMaintenanceDistance(unit: 'KG' | 'LB'): number {
    return unit === 'LB' ? Math.round(2 * 453.59237) : 1000;
}

/** Suggest bounds in canonical grams for the chosen unit, clipping to the supported weight limits. */
export function defaultMaintenanceRange(target: number, unit: 'KG' | 'LB'): MaintenanceRange {
    const offset = defaultMaintenanceDistance(unit);
    return {
        target_weight_grams: target,
        lower_weight_grams: Math.max(MIN_WEIGHT_GRAMS, target - offset),
        upper_weight_grams: Math.min(MAX_WEIGHT_GRAMS, target + offset)
    };
}

/** Validate both absolute bounds and their ordering against the selected target. */
export function isMaintenanceRange(target: unknown, lower: unknown, upper: unknown): boolean {
    return isPolicyWeight(target) && isPolicyWeight(lower) && isPolicyWeight(upper) && lower < target && target < upper;
}

/** Classify a sufficient trend midpoint against inclusive bounds in canonical grams. */
export function assessMaintenanceRange(weight: number, range: MaintenanceRange): MaintenanceRangeStatus {
    if (weight > range.upper_weight_grams) return 'above_range';
    if (weight < range.lower_weight_grams) return 'below_range';
    return 'within_range';
}

/** Check direction-aware achievement. Zero is ongoing maintenance. */
export function reachesGoal(weight: number, target: number, deficit: number): boolean {
    if (deficit > 0) return weight <= target;
    return deficit < 0 && weight >= target;
}
