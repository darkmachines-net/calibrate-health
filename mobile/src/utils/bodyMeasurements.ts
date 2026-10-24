/** @file body Measurements: Formats canonical grams in the selected weight unit, returning blank for absent or zero values. */

import { WEIGHT_UNITS, type WeightUnit } from '@calibrate/shared';

const GRAMS_PER_KG = 1000;
const GRAMS_PER_LB = 453.59237;
const MM_PER_CM = 10;
const INCHES_PER_FOOT = 12;
const CM_PER_INCH = 2.54;

/** Formats canonical grams in the selected weight unit, returning blank for absent or zero values. */
export function gramsToDisplayWeight(grams: number | null, unit: WeightUnit): string {
    if (!grams) return '';
    const value = unit === WEIGHT_UNITS.LB ? grams / GRAMS_PER_LB : grams / GRAMS_PER_KG;
    return value.toFixed(1);
}

/** Formats millimeters as centimeters to one decimal place, returning blank when absent. */
export function millimetersToCentimeters(mm: number | null | undefined): string {
    return mm ? (mm / MM_PER_CM).toFixed(1) : '';
}

/** Converts millimeters into rounded whole feet and inches for imperial input. */
export function millimetersToFeetInches(mm: number | null | undefined): { feet: string; inches: string } {
    if (!mm) return { feet: '', inches: '' };
    const totalInches = Math.round((mm / MM_PER_CM) / CM_PER_INCH);
    return {
        feet: String(Math.floor(totalInches / INCHES_PER_FOOT)),
        inches: String(totalInches % INCHES_PER_FOOT)
    };
}
