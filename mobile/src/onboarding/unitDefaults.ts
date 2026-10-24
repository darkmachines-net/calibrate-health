/** @file unit Defaults: Infers initial measurement units from the device measurement system or region. */

import { HEIGHT_UNITS, WEIGHT_UNITS, type HeightUnit, type WeightUnit } from '@calibrate/shared';
import type { UserClientPayload } from '@calibrate/api-client';
import type { DeviceLocale } from '../platform/deviceLocale';

export type OnboardingUnits = { weightUnit: WeightUnit; heightUnit: HeightUnit };
const METRIC_UNITS: OnboardingUnits = { weightUnit: WEIGHT_UNITS.KG, heightUnit: HEIGHT_UNITS.CM };
const IMPERIAL_UNITS: OnboardingUnits = { weightUnit: WEIGHT_UNITS.LB, heightUnit: HEIGHT_UNITS.FT_IN };
// Supported body measurements use pounds/feet for these region defaults; controls remain independent.
const IMPERIAL_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);

function localeRegion(languageTag: string | null): string | null {
    if (!languageTag) return null;
    try {
        return new Intl.Locale(languageTag.replace(/_/g, '-')).region ?? null;
    } catch {
        // Some native Intl implementations omit Locale; parse an explicit region without maximizing a language.
        const parts = languageTag.replace(/_/g, '-').split('-').slice(1);
        for (const part of parts) {
            if (part.length === 1) break;
            if (/^[a-z]{2}$/i.test(part)) return part.toUpperCase();
        }
        return null;
    }
}

/** Infers initial measurement units from the device measurement system or region. */
export function unitsForDeviceLocale(locale: DeviceLocale): OnboardingUnits {
    if (locale.measurementSystem === 'metric') return METRIC_UNITS;
    if (locale.measurementSystem === 'us' || locale.measurementSystem === 'uk') return IMPERIAL_UNITS;
    const region = locale.regionCode?.trim().toUpperCase() || localeRegion(locale.languageTag);
    return region && IMPERIAL_REGIONS.has(region) ? IMPERIAL_UNITS : METRIC_UNITS;
}

/** Preserves established profile units while using locale defaults for pristine accounts. */
export function resolveOnboardingUnits(user: UserClientPayload, locale: DeviceLocale): OnboardingUnits {
    const inferred = unitsForDeviceLocale(locale);
    const hasSavedProfile = Boolean(user.onboarding_completed_at || user.date_of_birth || user.sex || user.height_mm || user.activity_level);
    // The API has no preference-set marker: pristine KG/CM cannot be distinguished from an explicit metric choice.
    // Existing profiles/drafts keep both preferences; otherwise preserve each non-default preference independently.
    return {
        weightUnit: (hasSavedProfile || user.weight_unit === WEIGHT_UNITS.LB) ? user.weight_unit ?? inferred.weightUnit : inferred.weightUnit,
        heightUnit: (hasSavedProfile || user.height_unit === HEIGHT_UNITS.FT_IN) ? user.height_unit ?? inferred.heightUnit : inferred.heightUnit
    };
}
