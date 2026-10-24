/** @file Regression coverage for unit Defaults: onboarding measurement defaults. */

import type { UserClientPayload } from '@calibrate/api-client';
import type { DeviceLocale } from '../platform/deviceLocale';
import { resolveOnboardingUnits, unitsForDeviceLocale } from './unitDefaults';
import { createInitialOnboardingForm } from './completionState';

const USER = { weight_unit: 'KG', height_unit: 'CM', timezone: 'UTC', date_of_birth: null,
    sex: null, activity_level: null, height_mm: null, onboarding_completed_at: null } as UserClientPayload;
const US: DeviceLocale = { languageTag: 'en-US', regionCode: null, measurementSystem: null };
const METRIC: DeviceLocale = { languageTag: 'en-US', regionCode: 'US', measurementSystem: 'metric' };
const METRIC_UNITS = { weightUnit: 'KG', heightUnit: 'CM' };
const IMPERIAL_UNITS = { weightUnit: 'LB', heightUnit: 'FT_IN' };

describe('onboarding measurement defaults', () => {
    it.each(['us', 'uk'] as const)('honors the explicit %s device preference before its region', (measurementSystem) => {
        expect(unitsForDeviceLocale({ languageTag: 'fr-FR', regionCode: 'FR', measurementSystem })).toEqual(IMPERIAL_UNITS);
        expect(unitsForDeviceLocale(METRIC)).toEqual(METRIC_UNITS);
    });

    it.each(['en-US', 'en-GB', 'en-LR', 'my-MM'])('uses imperial units for the %s region fallback', (languageTag) => {
        expect(unitsForDeviceLocale({ ...US, languageTag })).toEqual(IMPERIAL_UNITS);
    });

    it.each(['en-CA', 'fr-FR', 'zh-Hant-TW', 'en', null])('uses metric units for %s without inventing an English-language region', (languageTag) => {
        expect(unitsForDeviceLocale({ ...US, languageTag })).toEqual(METRIC_UNITS);
    });

    it('prefers a separately configured device region to the language region', () => {
        expect(unitsForDeviceLocale({ ...US, regionCode: 'CA' })).toEqual(METRIC_UNITS);
        expect(unitsForDeviceLocale({ ...US, languageTag: 'fr-FR', regionCode: 'US' })).toEqual(IMPERIAL_UNITS);
    });

    it('does not mistake backend KG/CM defaults for saved choices on a fresh account', () => {
        expect(createInitialOnboardingForm(USER, US)).toEqual(expect.objectContaining(IMPERIAL_UNITS));
        expect(createInitialOnboardingForm(USER, METRIC)).toEqual(expect.objectContaining(METRIC_UNITS));
    });

    it('keeps both preferences independently for an existing profile or completed account', () => {
        expect(resolveOnboardingUnits({ ...USER, sex: 'FEMALE', weight_unit: 'LB', height_unit: 'CM' }, US))
            .toEqual({ weightUnit: 'LB', heightUnit: 'CM' });
        expect(resolveOnboardingUnits({ ...USER, height_mm: 1680, weight_unit: 'KG', height_unit: 'FT_IN' }, METRIC))
            .toEqual({ weightUnit: 'KG', heightUnit: 'FT_IN' });
        expect(resolveOnboardingUnits({ ...USER, onboarding_completed_at: '2026-09-25T00:00:00Z' }, US)).toEqual(METRIC_UNITS);
    });

    it('preserves non-default saved choices independently before demographics are entered', () => {
        expect(resolveOnboardingUnits({ ...USER, weight_unit: 'LB' }, METRIC)).toEqual({ weightUnit: 'LB', heightUnit: 'CM' });
        expect(resolveOnboardingUnits({ ...USER, height_unit: 'FT_IN' }, METRIC)).toEqual({ weightUnit: 'KG', heightUnit: 'FT_IN' });
    });
});
