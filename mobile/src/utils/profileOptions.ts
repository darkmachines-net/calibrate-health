/** @file Shared profile form options for sex, activity, and measurement units. */

import {
    ACTIVITY_LEVELS,
    HEIGHT_UNITS,
    SEX_VALUES,
    WEIGHT_UNITS,
    type ActivityLevel,
    type HeightUnit,
    type Sex,
    type WeightUnit
} from '@calibrate/shared';

export const SEX_OPTIONS: Array<{ value: Sex; label: string; icon: 'male' | 'female' }> = [
    { value: SEX_VALUES.MALE, label: 'Male', icon: 'male' },
    { value: SEX_VALUES.FEMALE, label: 'Female', icon: 'female' }
];

export const ACTIVITY_OPTIONS: Array<{ value: ActivityLevel; label: string; description: string }> = [
    { value: ACTIVITY_LEVELS.SEDENTARY, label: 'Mostly sitting', description: 'Most of your day is seated, with little regular exercise.' },
    { value: ACTIVITY_LEVELS.LIGHT, label: 'Lightly active', description: 'Some walking or light exercise during a typical week.' },
    { value: ACTIVITY_LEVELS.MODERATE, label: 'Moderately active', description: 'Regular exercise and movement throughout your week.' },
    { value: ACTIVITY_LEVELS.ACTIVE, label: 'Active', description: 'Frequent exercise or a physically demanding daily routine.' },
    { value: ACTIVITY_LEVELS.VERY_ACTIVE, label: 'Very active', description: 'Strenuous training combined with a highly physical routine.' }
];

export const WEIGHT_UNIT_OPTIONS: Array<{ value: WeightUnit; label: string }> = [
    { value: WEIGHT_UNITS.KG, label: 'kg' },
    { value: WEIGHT_UNITS.LB, label: 'lb' }
];

export const HEIGHT_UNIT_OPTIONS: Array<{ value: HeightUnit; label: 'cm' | 'ft/in' }> = [
    { value: HEIGHT_UNITS.CM, label: 'cm' },
    { value: HEIGHT_UNITS.FT_IN, label: 'ft/in' }
];
