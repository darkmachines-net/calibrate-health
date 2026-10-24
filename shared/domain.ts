/** @file domain: Shared calorie-tracking domain constants used by web, mobile, and backend clients. */

/**
 * Shared calorie-tracking domain constants used by web, mobile, and backend clients.
 */
export const WEIGHT_UNITS = {
    KG: 'KG',
    LB: 'LB'
} as const;

export type WeightUnit = (typeof WEIGHT_UNITS)[keyof typeof WEIGHT_UNITS];

export const HEIGHT_UNITS = {
    CM: 'CM',
    FT_IN: 'FT_IN'
} as const;

export type HeightUnit = (typeof HEIGHT_UNITS)[keyof typeof HEIGHT_UNITS];

export const SEX_VALUES = {
    MALE: 'MALE',
    FEMALE: 'FEMALE'
} as const;

export type Sex = (typeof SEX_VALUES)[keyof typeof SEX_VALUES];

export const ACTIVITY_LEVELS = {
    SEDENTARY: 'SEDENTARY',
    LIGHT: 'LIGHT',
    MODERATE: 'MODERATE',
    ACTIVE: 'ACTIVE',
    VERY_ACTIVE: 'VERY_ACTIVE'
} as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[keyof typeof ACTIVITY_LEVELS];

/** Health Connect record kinds persisted by the server reconciliation layer. */
export const ACTIVITY_RECORD_TYPES = {
    STEPS: 'STEPS',
    ACTIVE_CALORIES: 'ACTIVE_CALORIES',
    TOTAL_CALORIES: 'TOTAL_CALORIES',
    EXERCISE_SESSION: 'EXERCISE_SESSION',
    WEIGHT: 'WEIGHT'
} as const;

export type ActivityRecordType =
    (typeof ACTIVITY_RECORD_TYPES)[keyof typeof ACTIVITY_RECORD_TYPES];

export const MEAL_PERIODS = {
    BREAKFAST: 'BREAKFAST',
    MORNING_SNACK: 'MORNING_SNACK',
    LUNCH: 'LUNCH',
    AFTERNOON_SNACK: 'AFTERNOON_SNACK',
    DINNER: 'DINNER',
    EVENING_SNACK: 'EVENING_SNACK'
} as const;

export type MealPeriod = (typeof MEAL_PERIODS)[keyof typeof MEAL_PERIODS];

export const MOBILE_DEVICE_PLATFORMS = {
    ANDROID_PHONE: 'android_phone',
    IOS: 'ios',
    WEAR_OS: 'wear_os'
} as const;

export type MobileDevicePlatform =
    (typeof MOBILE_DEVICE_PLATFORMS)[keyof typeof MOBILE_DEVICE_PLATFORMS];

export const NATIVE_PUSH_PLATFORMS = {
    ANDROID: 'android',
    IOS: 'ios'
} as const;

export type NativePushPlatform =
    (typeof NATIVE_PUSH_PLATFORMS)[keyof typeof NATIVE_PUSH_PLATFORMS];

export const NATIVE_PUSH_PROVIDERS = {
    EXPO: 'expo'
} as const;

export type NativePushProvider =
    (typeof NATIVE_PUSH_PROVIDERS)[keyof typeof NATIVE_PUSH_PROVIDERS];
