/** @file Canonical onboarding state initialization, unit conversion, validation, and completion payloads. */

import {
    ACTIVITY_LEVELS, HEIGHT_UNITS, WEIGHT_UNITS, SEX_VALUES,
    calculateCalendarAge, normalizeDateOfBirth, isPolicyHeight, isPolicyWeight,
    type ActivityLevel, type HeightUnit, type WeightUnit, type Sex
} from '@calibrate/shared';
import type { CaloriePlanOptionsRequest, OnboardingCompleteData, UserClientPayload } from '@calibrate/api-client';
import { type GoalMode, DAILY_GOAL_CHANGE_OPTIONS, getSignedDailyDeficit } from '../utils/goals';
import { getTodayDate } from '../utils/dates';
import { detectDeviceTimeZone, isValidIanaTimeZone, resolveOnboardingTimeZone } from '../utils/timezones';
import { formatDecimalInput, parseDecimalInput } from '../utils/numericInput';
import { getWeightPolicyError } from '../weightEntry/input';
import { getHeightPolicyError, heightInputToCanonicalMillimeters } from '../caloriePlanning/heightInput';
import type { OnboardingStepKey } from './steps';
import { getDeviceLocale, type DeviceLocale } from '../platform/deviceLocale';
import { resolveOnboardingUnits } from './unitDefaults';

const GRAMS_PER_KG = 1000;
const GRAMS_PER_LB = 453.59237;
const MM_PER_CM = 10;
const MM_PER_INCH = 25.4;
const INCHES_PER_FOOT = 12;
const MIN_ACCOUNT_AGE = 18; // Matches the account eligibility enforced by atomic onboarding.
const MAX_ACCOUNT_AGE = 120;

export type OnboardingFormState = {
    weightUnit: WeightUnit;
    heightUnit: HeightUnit;
    timezone: string;
    dateOfBirth: string;
    sex: Sex | null;
    activityLevel: ActivityLevel | null;
    currentWeight: string;
    targetWeight: string;
    goalMode: GoalMode | null;
    dailyChangeAbs: string;
    heightCm: string;
    heightFeet: string;
    heightInches: string;
    currentWeightGrams: number | null;
    targetWeightGrams: number | null;
    heightMillimeters: number | null;
};
export type OnboardingField = 'currentWeight' | 'height' | 'dateOfBirth' | 'sex' | 'timezone' | 'activityLevel' | 'goalMode' | 'targetWeight' | 'dailyChangeAbs';
export type OnboardingErrors = Partial<Record<OnboardingField, string>>;

function displayHeight(mm: number | null) {
    if (mm === null) return { heightCm: '', heightFeet: '', heightInches: '' };
    const inches = Math.round(mm / MM_PER_INCH);
    return {
        heightCm: formatDecimalInput(mm / MM_PER_CM, 1),
        heightFeet: String(Math.floor(inches / INCHES_PER_FOOT)),
        heightInches: String(inches % INCHES_PER_FOOT)
    };
}

/** Initializes onboarding fields from saved profile data with locale-aware units and timezone defaults. */
export function createInitialOnboardingForm(user: UserClientPayload, deviceLocale: DeviceLocale = getDeviceLocale()): OnboardingFormState {
    const hasProfile = Boolean(user.date_of_birth || user.sex || user.height_mm || user.activity_level);
    return {
        ...resolveOnboardingUnits(user, deviceLocale),
        timezone: resolveOnboardingTimeZone(user.timezone, detectDeviceTimeZone(), hasProfile),
        dateOfBirth: user.date_of_birth ?? '',
        sex: user.sex ?? null,
        activityLevel: user.activity_level ?? null,
        currentWeight: '', targetWeight: '', goalMode: null, dailyChangeAbs: '',
        ...displayHeight(user.height_mm ?? null),
        currentWeightGrams: null, targetWeightGrams: null, heightMillimeters: user.height_mm ?? null
    };
}

/** Keep raw editing text separate from quantities so rounded unit displays never become new measurements. */
export function editWeight(form: OnboardingFormState, field: 'currentWeight' | 'targetWeight', text: string): OnboardingFormState {
    const parsed = parseDecimalInput(text);
    const grams = Number.isFinite(parsed) ? Math.round(parsed * (form.weightUnit === WEIGHT_UNITS.LB ? GRAMS_PER_LB : GRAMS_PER_KG)) : null;
    return { ...form, [field]: text, [field === 'currentWeight' ? 'currentWeightGrams' : 'targetWeightGrams']: grams };
}

/** Changes display units using canonical grams so repeated conversions do not accumulate rounding drift. */
export function changeWeightUnit(form: OnboardingFormState, unit: WeightUnit): OnboardingFormState {
    if (unit === form.weightUnit) return form;
    const divisor = unit === WEIGHT_UNITS.LB ? GRAMS_PER_LB : GRAMS_PER_KG;
    return {
        ...form, weightUnit: unit,
        currentWeight: form.currentWeightGrams === null ? form.currentWeight : formatDecimalInput(form.currentWeightGrams / divisor, 1),
        targetWeight: form.targetWeightGrams === null ? form.targetWeight : formatDecimalInput(form.targetWeightGrams / divisor, 1)
    };
}

/** Updates a height field and recomputes canonical millimeters when the input is valid. */
export function editHeight(form: OnboardingFormState, field: 'heightCm' | 'heightFeet' | 'heightInches', text: string): OnboardingFormState {
    const next = { ...form, [field]: text };
    const mm = heightInputToCanonicalMillimeters({
        unit: next.heightUnit,
        centimeters: parseDecimalInput(next.heightCm),
        feet: parseDecimalInput(next.heightFeet),
        inches: next.heightInches.trim() ? parseDecimalInput(next.heightInches) : 0
    });
    return { ...next, heightMillimeters: mm };
}

/** Converts complete height input between unit systems while preserving incomplete text for correction. */
export function changeHeightUnit(form: OnboardingFormState, unit: HeightUnit): OnboardingFormState {
    if (unit === form.heightUnit) return form;
    // Incomplete input has no physical quantity to convert; let the user finish it first.
    const hasText = form.heightUnit === HEIGHT_UNITS.CM
        ? Boolean(form.heightCm.trim())
        : Boolean(form.heightFeet.trim() || form.heightInches.trim());
    if (form.heightMillimeters === null && hasText) return form;
    return { ...form, heightUnit: unit, ...displayHeight(form.heightMillimeters) };
}

/** Returns field-specific validation errors for the requested onboarding step. */
export function validateOnboardingStep(form: OnboardingFormState, step: OnboardingStepKey): OnboardingErrors {
    const errors: OnboardingErrors = {};
    if (step === 'about') {
        if (!isPolicyWeight(form.currentWeightGrams)) errors.currentWeight = getWeightPolicyError(form.weightUnit);
        if (!isPolicyHeight(form.heightMillimeters)) errors.height = getHeightPolicyError(form.heightUnit);
        const birthDate = normalizeDateOfBirth(form.dateOfBirth);
        const timezoneValid = isValidIanaTimeZone(form.timezone);
        const today = getTodayDate(timezoneValid ? form.timezone : 'UTC');
        if (!birthDate || birthDate !== form.dateOfBirth) {
            errors.dateOfBirth = 'Enter a valid date of birth.';
        } else {
            const age = calculateCalendarAge(birthDate, today);
            if (age < MIN_ACCOUNT_AGE) errors.dateOfBirth = 'Calibrate accounts require age 18 or older.';
            if (age > MAX_ACCOUNT_AGE) errors.dateOfBirth = 'Enter a date of birth within the past 120 years.';
        }
        if (!form.sex) errors.sex = 'Choose the sex used for your calorie estimate.';
        if (!timezoneValid) errors.timezone = 'Choose a valid time zone.';
    }
    if (step === 'activity' && !form.activityLevel) errors.activityLevel = 'Choose the activity level that best fits your typical week.';
    if (step === 'plan') {
        if (!form.goalMode) errors.goalMode = 'Choose Lose, Maintain, or Gain.';
        if (form.goalMode && form.goalMode !== 'maintain') {
            if (!isPolicyWeight(form.targetWeightGrams)) {
                errors.targetWeight = getWeightPolicyError(form.weightUnit);
            } else if (form.currentWeightGrams !== null) {
                if (form.goalMode === 'lose' && form.targetWeightGrams! >= form.currentWeightGrams) errors.targetWeight = 'Choose a target below your current weight.';
                if (form.goalMode === 'gain' && form.targetWeightGrams! <= form.currentWeightGrams) errors.targetWeight = 'Choose a target above your current weight.';
            }
            if (!DAILY_GOAL_CHANGE_OPTIONS.some((value) => String(value) === form.dailyChangeAbs)) errors.dailyChangeAbs = 'Choose an available pace.';
        }
    }
    return errors;
}

/** Builds a calorie-preview request only after required profile fields and activity level are valid. */
export function buildCaloriePlanDraft(form: OnboardingFormState): CaloriePlanOptionsRequest | null {
    if (Object.keys(validateOnboardingStep(form, 'about')).length || !form.activityLevel) return null;
    return {
        timezone: form.timezone.trim(), date_of_birth: form.dateOfBirth,
        sex: form.sex, activity_level: form.activityLevel,
        // Canonical quantities keep preview and completion identical after a rounded unit conversion.
        height: { unit: 'CM', centimeters: form.heightMillimeters! / MM_PER_CM },
        weight: { unit: WEIGHT_UNITS.KG, value: form.currentWeightGrams! / GRAMS_PER_KG }
    };
}

/** Validates every onboarding step and builds completion data from canonical measurements, throwing on incomplete input. */
export function buildOnboardingCompleteData(form: OnboardingFormState): OnboardingCompleteData {
    if (['about', 'activity', 'plan'].some((step) => Object.keys(validateOnboardingStep(form, step as OnboardingStepKey)).length)) {
        throw new Error('Complete the required onboarding details.');
    }
    return {
        weight_unit: form.weightUnit, height_unit: form.heightUnit,
        timezone: form.timezone.trim(), date_of_birth: form.dateOfBirth,
        sex: form.sex!, height_mm: form.heightMillimeters!, activity_level: form.activityLevel!,
        current_weight_grams: form.currentWeightGrams!,
        target_weight_grams: form.goalMode === 'maintain' ? form.currentWeightGrams! : form.targetWeightGrams!,
        daily_deficit: getSignedDailyDeficit(form.goalMode!, form.dailyChangeAbs)
    };
}

/** Validate persisted structure without rejecting a user's unfinished input. */
export function isOnboardingFormState(value: unknown): value is OnboardingFormState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const form = value as Record<string, unknown>;
    const textFields = ['timezone', 'dateOfBirth', 'currentWeight', 'targetWeight', 'dailyChangeAbs', 'heightCm', 'heightFeet', 'heightInches'];
    if (!textFields.every((key) => typeof form[key] === 'string')) return false;
    if (!['currentWeightGrams', 'targetWeightGrams', 'heightMillimeters'].every((key) => form[key] === null || (typeof form[key] === 'number' && Number.isSafeInteger(form[key])))) return false;
    return Object.values(WEIGHT_UNITS).includes(form.weightUnit as WeightUnit)
        && Object.values(HEIGHT_UNITS).includes(form.heightUnit as HeightUnit)
        && (form.sex === null || Object.values(SEX_VALUES).includes(form.sex as Sex))
        && (form.activityLevel === null || Object.values(ACTIVITY_LEVELS).includes(form.activityLevel as ActivityLevel))
        && (form.goalMode === null || ['lose', 'maintain', 'gain'].includes(form.goalMode as string));
}
