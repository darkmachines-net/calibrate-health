/** @file Calorie target safety bounds, age/date policy, and supported plan eligibility. */

import type { ActivityLevel, Sex } from './domain';

export const MAX_ELIGIBLE_AGE_YEARS = 120;
export const MIN_HEIGHT_MM = 1_000;
export const MAX_HEIGHT_MM = 2_500;
export const MIN_WEIGHT_GRAMS = 25_000;
export const MAX_WEIGHT_GRAMS = 400_000;
export const ABSOLUTE_MIN_TARGET_KCAL = 1_000;
export const CALORIE_POLICY_VERSION = 1;
export const SIGNED_DAILY_DEFICIT_OPTIONS = [-1_000, -750, -500, -250, 0, 250, 500, 750, 1_000] as const;

export type EligibilityStatus = 'unknown' | 'eligible' | 'invalid';
export type CaloriePlanStatus = 'unavailable' | 'available' | 'requires_review';
export type CaloriePlanReasonCode =
    | 'DATE_OF_BIRTH_REQUIRED' | 'DATE_OF_BIRTH_INVALID' | 'DATE_OF_BIRTH_IN_FUTURE'
    | 'AGE_OVER_120' | 'TIMEZONE_INVALID'
    | 'SEX_REQUIRED' | 'ACTIVITY_LEVEL_REQUIRED' | 'HEIGHT_REQUIRED' | 'HEIGHT_OUT_OF_RANGE'
    | 'LATEST_WEIGHT_REQUIRED' | 'WEIGHT_OUT_OF_RANGE' | 'GOAL_REQUIRED'
    | 'GOAL_WEIGHTS_OUT_OF_RANGE' | 'GOAL_DIRECTION_INVALID' | 'DAILY_DEFICIT_INVALID'
    | 'TARGET_BELOW_MINIMUM' | 'PLAN_REVISION_UNSAFE'
    | 'HISTORICAL_PLAN_REQUIRES_REVIEW' | 'SERVER_POLICY_UNAVAILABLE';

export type CalorieEligibility = {
    status: EligibilityStatus;
    reasonCode: CaloriePlanReasonCode | null;
    ageYears: number | null;
    localDate: string | null;
};

export type CaloriePlanOption = {
    dailyDeficit: number;
    available: boolean;
    dailyCalorieTarget: number | null;
    reasonCode: CaloriePlanReasonCode | null;
};

export type CaloriePlanEvaluation = {
    eligibility: CalorieEligibility;
    status: CaloriePlanStatus;
    reasonCode: CaloriePlanReasonCode | null;
    bmr: number | null;
    tdee: number | null;
    minimumDailyCalorieTarget: number | null;
    planOptions: CaloriePlanOption[];
    dailyCalorieTarget: number | null;
    baseDailyCalorieTarget: number | null;
    targetAdjustment: number | null;
    sourceWeightKg: number | null;
    deficit: number | null;
    missing: string[];
};

export type CaloriePolicyGoal = {
    startWeightGrams: number;
    targetWeightGrams: number;
    dailyDeficit: number;
    reviewStatus?: 'CLEAR' | 'REQUIRES_REVIEW' | null;
    reviewReason?: string | null;
};

export type CaloriePolicyProfile = {
    timezone?: string | null;
    dateOfBirth?: string | Date | null;
    sex?: Sex | null;
    heightMm?: number | null;
    activityLevel?: ActivityLevel | null;
};

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const allowedDeficits = new Set<number>(SIGNED_DAILY_DEFICIT_OPTIONS);
const activityMultipliers: Record<ActivityLevel, number> = {
    SEDENTARY: 1.2, LIGHT: 1.375, MODERATE: 1.55, ACTIVE: 1.725, VERY_ACTIVE: 1.9
};
const roundOneDecimal = (value: number): number => Math.round(value * 10) / 10;

/** Parse a date-only value without allowing JavaScript calendar rollover. */
export function normalizeDateOfBirth(value: unknown): string | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    if (typeof value !== 'string') return null;
    const match = DATE_ONLY_PATTERN.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

/** Resolve a local calendar date without falling back for an invalid IANA timezone. */
export function localDateInTimeZone(now: Date, timezone: unknown): string | null {
    if (typeof timezone !== 'string' || timezone.trim().length === 0 || Number.isNaN(now.getTime())) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(now);
        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        const day = parts.find((part) => part.type === 'day')?.value;
        return year && month && day ? `${year}-${month}-${day}` : null;
    } catch {
        return null;
    }
}

/** Calendar age for date-only values. Feb 29 birthdays advance on March 1 in non-leap years. */
export function calculateCalendarAge(dateOfBirth: string, localDate: string): number {
    const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
    const [currentYear, currentMonth, currentDay] = localDate.split('-').map(Number);
    let age = currentYear - birthYear;
    if (currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)) age -= 1;
    return age;
}

/** Resolve age eligibility against the account-local current date, preserving missing/invalid birth-date reasons. */
export function evaluateCalorieProfileEligibility(options: { dateOfBirth?: unknown; timezone?: unknown; now?: Date }): CalorieEligibility {
    if (options.dateOfBirth === undefined || options.dateOfBirth === null || options.dateOfBirth === '') {
        return { status: 'unknown', reasonCode: 'DATE_OF_BIRTH_REQUIRED', ageYears: null, localDate: null };
    }
    const dateOfBirth = normalizeDateOfBirth(options.dateOfBirth);
    if (!dateOfBirth) return { status: 'invalid', reasonCode: 'DATE_OF_BIRTH_INVALID', ageYears: null, localDate: null };
    const localDate = localDateInTimeZone(options.now ?? new Date(), options.timezone);
    if (!localDate) return { status: 'invalid', reasonCode: 'TIMEZONE_INVALID', ageYears: null, localDate: null };
    if (dateOfBirth > localDate) return { status: 'invalid', reasonCode: 'DATE_OF_BIRTH_IN_FUTURE', ageYears: null, localDate };
    const ageYears = calculateCalendarAge(dateOfBirth, localDate);
    if (ageYears > MAX_ELIGIBLE_AGE_YEARS) return { status: 'invalid', reasonCode: 'AGE_OVER_120', ageYears, localDate };
    return { status: 'eligible', reasonCode: null, ageYears, localDate };
}


/** Compute Mifflin-St Jeor resting calories from canonical grams/millimeters and age, rounded to one decimal. */
export function calculatePolicyBmr(sex: Sex, weightGrams: number, heightMm: number, ageYears: number): number {
    const base = 10 * (weightGrams / 1_000) + 6.25 * (heightMm / 10) - 5 * ageYears;
    return roundOneDecimal(sex === 'MALE' ? base + 5 : base - 161);
}

/** Apply the configured profile activity multiplier to BMR without incorporating imported exercise calories. */
export function calculatePolicyTdee(bmr: number, activityLevel: ActivityLevel): number {
    return roundOneDecimal(bmr * activityMultipliers[activityLevel]);
}

/** Round the greater of BMR and the absolute safety minimum upward to a whole-calorie target floor. */
export const minimumTargetForBmr = (bmr: number): number => Math.ceil(Math.max(bmr, ABSOLUTE_MIN_TARGET_KCAL));
/** Accept only integer gram weights inside the shared planning range. */
export const isPolicyWeight = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_WEIGHT_GRAMS && value <= MAX_WEIGHT_GRAMS;
/** Accept only integer millimeter heights inside the shared planning range. */
export const isPolicyHeight = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_HEIGHT_MM && value <= MAX_HEIGHT_MM;
/** Accept only the supported signed whole-calorie deficit/surplus choices, including maintenance. */
export const isPolicyDailyDeficit = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && allowedDeficits.has(value);

/** Return the first weight, deficit or direction violation, or null when the goal satisfies shared policy. */
export function validateGoalPolicy(goal: CaloriePolicyGoal): CaloriePlanReasonCode | null {
    if (!isPolicyWeight(goal.startWeightGrams) || !isPolicyWeight(goal.targetWeightGrams)) return 'GOAL_WEIGHTS_OUT_OF_RANGE';
    if (!isPolicyDailyDeficit(goal.dailyDeficit)) return 'DAILY_DEFICIT_INVALID';
    if ((goal.dailyDeficit > 0 && goal.startWeightGrams <= goal.targetWeightGrams) || (goal.dailyDeficit < 0 && goal.startWeightGrams >= goal.targetWeightGrams)) return 'GOAL_DIRECTION_INVALID';
    return null;
}

function prerequisitesReason(eligibility: CalorieEligibility, profile: CaloriePolicyProfile, weight: number | null | undefined): CaloriePlanReasonCode | null {
    if (eligibility.status !== 'eligible') return eligibility.reasonCode ?? 'SERVER_POLICY_UNAVAILABLE';
    if (!profile.sex) return 'SEX_REQUIRED';
    if (!profile.activityLevel) return 'ACTIVITY_LEVEL_REQUIRED';
    if (profile.heightMm === undefined || profile.heightMm === null) return 'HEIGHT_REQUIRED';
    if (!isPolicyHeight(profile.heightMm)) return 'HEIGHT_OUT_OF_RANGE';
    if (weight === undefined || weight === null) return 'LATEST_WEIGHT_REQUIRED';
    if (!isPolicyWeight(weight)) return 'WEIGHT_OUT_OF_RANGE';
    return null;
}

const prerequisiteReviewReasons = new Set<CaloriePlanReasonCode>([
    'DATE_OF_BIRTH_REQUIRED', 'DATE_OF_BIRTH_INVALID', 'DATE_OF_BIRTH_IN_FUTURE',
    'AGE_OVER_120', 'TIMEZONE_INVALID', 'SEX_REQUIRED', 'ACTIVITY_LEVEL_REQUIRED', 'HEIGHT_REQUIRED',
    'HEIGHT_OUT_OF_RANGE', 'LATEST_WEIGHT_REQUIRED', 'WEIGHT_OUT_OF_RANGE'
]);

function persistedGoalReviewReason(reason: string | null | undefined): CaloriePlanReasonCode {
    if (!reason || prerequisiteReviewReasons.has(reason as CaloriePlanReasonCode)) return 'HISTORICAL_PLAN_REQUIRES_REVIEW';
    return reason as CaloriePlanReasonCode;
}
function legacyMissing(reason: CaloriePlanReasonCode | null): string[] {
    if (!reason) return [];
    if (reason.startsWith('DATE_OF_BIRTH_') || reason.startsWith('AGE_') || reason === 'TIMEZONE_INVALID') return ['eligibility'];
    if (reason === 'SEX_REQUIRED') return ['sex'];
    if (reason === 'ACTIVITY_LEVEL_REQUIRED') return ['activity_level'];
    if (reason === 'HEIGHT_REQUIRED' || reason === 'HEIGHT_OUT_OF_RANGE') return ['height_mm'];
    if (reason === 'LATEST_WEIGHT_REQUIRED' || reason === 'WEIGHT_OUT_OF_RANGE') return ['latest_weight'];
    return [];
}

/** Build server-owned calorie-plan fields. Unsafe values become unavailable, never clamped. */
export function evaluateCaloriePlan(options: {
    profile: CaloriePolicyProfile;
    latestWeightGrams?: number | null;
    goal?: CaloriePolicyGoal | null;
    targetAdjustmentKcal?: number | null;
    revisionReviewStatus?: 'CLEAR' | 'REQUIRES_REVIEW' | null;
    revisionReviewReason?: string | null;
    now?: Date;
}): CaloriePlanEvaluation {
    const eligibility = evaluateCalorieProfileEligibility({ dateOfBirth: options.profile.dateOfBirth, timezone: options.profile.timezone, now: options.now });
    const prerequisiteReason = prerequisitesReason(eligibility, options.profile, options.latestWeightGrams);
    let bmr: number | null = null;
    let tdee: number | null = null;
    let minimumTarget: number | null = null;
    let planOptions: CaloriePlanOption[] = SIGNED_DAILY_DEFICIT_OPTIONS.map((dailyDeficit) => ({ dailyDeficit, available: false, dailyCalorieTarget: null, reasonCode: prerequisiteReason ?? 'SERVER_POLICY_UNAVAILABLE' }));
    if (!prerequisiteReason) {
        bmr = calculatePolicyBmr(options.profile.sex!, options.latestWeightGrams!, options.profile.heightMm!, eligibility.ageYears!);
        tdee = calculatePolicyTdee(bmr, options.profile.activityLevel!);
        minimumTarget = minimumTargetForBmr(bmr);
        planOptions = SIGNED_DAILY_DEFICIT_OPTIONS.map((dailyDeficit) => {
            const target = Math.round(tdee! - dailyDeficit);
            const available = target >= minimumTarget!;
            return { dailyDeficit, available, dailyCalorieTarget: available ? target : null, reasonCode: available ? null : 'TARGET_BELOW_MINIMUM' };
        });
    }
    const goal = options.goal ?? null;
    let status: CaloriePlanStatus = 'unavailable';
    let reasonCode: CaloriePlanReasonCode | null = prerequisiteReason ?? 'GOAL_REQUIRED';
    let baseDailyCalorieTarget: number | null = null;
    let dailyCalorieTarget: number | null = null;
    const targetAdjustment = options.targetAdjustmentKcal ?? 0;
    if (goal) {
        status = 'requires_review';
        reasonCode = prerequisiteReason ?? validateGoalPolicy(goal);
        if (!reasonCode && goal.reviewStatus === 'REQUIRES_REVIEW') reasonCode = persistedGoalReviewReason(goal.reviewReason);
        if (!reasonCode && options.revisionReviewStatus === 'REQUIRES_REVIEW') reasonCode = (options.revisionReviewReason as CaloriePlanReasonCode | null) ?? 'PLAN_REVISION_UNSAFE';
        if (!reasonCode) {
            const selected = planOptions.find((item) => item.dailyDeficit === goal.dailyDeficit);
            if (!selected?.available || selected.dailyCalorieTarget === null) reasonCode = selected?.reasonCode ?? 'DAILY_DEFICIT_INVALID';
            else if (!Number.isInteger(targetAdjustment)) reasonCode = 'PLAN_REVISION_UNSAFE';
            else {
                baseDailyCalorieTarget = selected.dailyCalorieTarget;
                const adjusted = Math.round(tdee! - goal.dailyDeficit + targetAdjustment);
                if (adjusted < minimumTarget!) reasonCode = 'PLAN_REVISION_UNSAFE';
                else { status = 'available'; reasonCode = null; dailyCalorieTarget = adjusted; }
            }
        }
    }
    return {
        eligibility, status, reasonCode, bmr, tdee, minimumDailyCalorieTarget: minimumTarget, planOptions,
        dailyCalorieTarget, baseDailyCalorieTarget,
        targetAdjustment: Number.isInteger(targetAdjustment) ? targetAdjustment : null,
        sourceWeightKg: isPolicyWeight(options.latestWeightGrams) ? roundOneDecimal(options.latestWeightGrams / 1_000) : null,
        deficit: goal && isPolicyDailyDeficit(goal.dailyDeficit) ? goal.dailyDeficit : null,
        missing: legacyMissing(prerequisiteReason)
    };
}

export type GoalProjection = {
    status: 'projected' | 'maintenance' | 'reached' | 'unavailable';
    projectedEndDate: string | null;
    reasonCode: CaloriePlanReasonCode | null;
};

/** Build a steady-rate projection from the configured deficit, never inferred TDEE. */
export function projectGoalEndDate(options: {
    planStatus: CaloriePlanStatus; planReasonCode: CaloriePlanReasonCode | null; localDate: string | null;
    currentWeightGrams: number | null; targetWeightGrams: number; dailyDeficit: number; weightUnit: 'KG' | 'LB';
}): GoalProjection {
    if (options.planStatus !== 'available' || !options.localDate || !isPolicyWeight(options.currentWeightGrams)) return { status: 'unavailable', projectedEndDate: null, reasonCode: options.planReasonCode ?? 'LATEST_WEIGHT_REQUIRED' };
    if (options.dailyDeficit === 0) return { status: 'maintenance', projectedEndDate: null, reasonCode: null };
    const direction = Math.sign(options.dailyDeficit);
    const remainingGrams = direction > 0 ? options.currentWeightGrams - options.targetWeightGrams : options.targetWeightGrams - options.currentWeightGrams;
    if (remainingGrams <= 0) return { status: 'reached', projectedEndDate: null, reasonCode: null };
    const remainingEnergy = options.weightUnit === 'LB'
        ? (remainingGrams / 453.59237) * 3_500
        : (remainingGrams / 1_000) * 7_700;
    const days = Math.ceil(remainingEnergy / Math.abs(options.dailyDeficit));
    const projected = new Date(`${options.localDate}T00:00:00.000Z`);
    projected.setUTCDate(projected.getUTCDate() + days);
    return { status: 'projected', projectedEndDate: projected.toISOString().slice(0, 10), reasonCode: null };
}
