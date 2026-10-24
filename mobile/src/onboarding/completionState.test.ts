/** @file Regression coverage for completion State: onboarding measurements and completion. */

import { ACTIVITY_LEVELS, HEIGHT_UNITS, WEIGHT_UNITS } from '@calibrate/shared';
import type { UserClientPayload } from '@calibrate/api-client';
import {
    buildOnboardingCompleteData, buildCaloriePlanDraft, changeHeightUnit, changeWeightUnit,
    createInitialOnboardingForm, editHeight, editWeight, isOnboardingFormState,
    validateOnboardingStep, type OnboardingFormState
} from './completionState';

const METRIC_DEVICE = { languageTag: 'en-CA', regionCode: 'CA', measurementSystem: 'metric' } as const;
const USER = { weight_unit: 'KG', height_unit: 'CM', timezone: 'UTC', date_of_birth: null,
    sex: null, activity_level: null, height_mm: null } as UserClientPayload;
const FORM: OnboardingFormState = {
    ...createInitialOnboardingForm(USER, METRIC_DEVICE),
    weightUnit: WEIGHT_UNITS.KG, heightUnit: HEIGHT_UNITS.CM, timezone: 'America/Los_Angeles',
    dateOfBirth: '1990-04-12', sex: 'FEMALE', activityLevel: ACTIVITY_LEVELS.MODERATE,
    currentWeight: '80', targetWeight: '76', goalMode: 'lose', dailyChangeAbs: '500',
    heightCm: '180', heightFeet: '', heightInches: '',
    currentWeightGrams: 80000, targetWeightGrams: 76000, heightMillimeters: 1800
};

describe('onboarding measurements and completion', () => {
    it('starts with no inferred sex, activity, goal direction or pace', () => {
        expect(createInitialOnboardingForm(USER, METRIC_DEVICE)).toEqual(expect.objectContaining({
            sex: null, activityLevel: null, goalMode: null, dailyChangeAbs: '',
            currentWeightGrams: null, heightMillimeters: null
        }));
    });
    it('builds one canonical payload for atomic completion', () => {
        expect(buildOnboardingCompleteData(FORM)).toEqual({
            weight_unit: 'KG', height_unit: 'CM', timezone: 'America/Los_Angeles',
            date_of_birth: '1990-04-12', sex: 'FEMALE', height_mm: 1800, activity_level: 'MODERATE',
            current_weight_grams: 80000, target_weight_grams: 76000, daily_deficit: 500
        });
    });
    it('converts both weights without accumulating rounded display drift', () => {
        let form = changeWeightUnit(FORM, 'LB');
        expect(form.currentWeight).toBe('176.4');
        expect(form.targetWeight).toBe('167.6');
        expect(buildOnboardingCompleteData(form).current_weight_grams).toBe(80000);
        expect(buildCaloriePlanDraft(form)?.weight).toEqual({ unit: 'KG', value: 80 });
        for (let index = 0; index < 5; index += 1) {
            form = changeWeightUnit(changeWeightUnit(form, 'KG'), 'LB');
        }
        expect(form.currentWeightGrams).toBe(80000);
        expect(changeWeightUnit(form, 'KG').currentWeight).toBe('80');
        form = editWeight(form, 'currentWeight', '180');
        expect(form.currentWeightGrams).toBe(81647);
    });
    it('converts height without losing millimeters or carrying twelve inches', () => {
        const imperial = changeHeightUnit(FORM, 'FT_IN');
        expect(imperial).toEqual(expect.objectContaining({ heightFeet: '5', heightInches: '11', heightMillimeters: 1800 }));
        expect(buildCaloriePlanDraft(imperial)?.height).toEqual({ unit: 'CM', centimeters: 180 });
        expect(buildOnboardingCompleteData(imperial).height_mm).toBe(1800);
        expect(changeHeightUnit(imperial, 'CM').heightCm).toBe('180');
        expect(changeHeightUnit({ ...FORM, heightMillimeters: 1828 }, 'FT_IN').heightInches).toBe('0');
    });
    it('retains canonical policy-boundary measurements through display rounding', () => {
        const minimum = changeHeightUnit(changeWeightUnit({
            ...FORM, currentWeight: '25', currentWeightGrams: 25000,
            heightCm: '100', heightMillimeters: 1000
        }, 'LB'), 'FT_IN');
        expect(validateOnboardingStep(minimum, 'about')).toEqual({});
        expect(minimum.currentWeightGrams).toBe(25000);
        expect(minimum.heightMillimeters).toBe(1000);
    });
    it('keeps empty measurements empty and handles incomplete and localized decimals', () => {
        const empty = createInitialOnboardingForm(USER, METRIC_DEVICE);
        expect(changeWeightUnit(empty, 'LB').currentWeight).toBe('');
        expect(changeHeightUnit(empty, 'FT_IN').heightFeet).toBe('');
        expect(editWeight(empty, 'currentWeight', '80,2').currentWeightGrams).toBe(80200);
        expect(editWeight(FORM, 'currentWeight', '.').currentWeightGrams).toBeNull();
        const partial = editHeight(FORM, 'heightCm', '.');
        expect(changeHeightUnit(partial, 'FT_IN')).toBe(partial);
        expect(editHeight(FORM, 'heightCm', '180,5').heightMillimeters).toBe(1805);
    });
    it('requires integer feet/inches within a foot and accepts an omitted zero inches', () => {
        const form = changeHeightUnit(FORM, 'FT_IN');
        expect(editHeight(form, 'heightInches', '12').heightMillimeters).toBeNull();
        expect(editHeight(form, 'heightFeet', '5.5').heightMillimeters).toBeNull();
        expect(editHeight(form, 'heightInches', '').heightMillimeters).toBe(1524);
    });
    it('derives maintenance target from current weight and preserves signed gain deficits', () => {
        expect(buildOnboardingCompleteData({ ...FORM, goalMode: 'maintain', targetWeight: '', targetWeightGrams: null, dailyChangeAbs: '' }))
            .toEqual(expect.objectContaining({ target_weight_grams: 80000, daily_deficit: 0 }));
        expect(buildOnboardingCompleteData({ ...FORM, goalMode: 'gain', targetWeight: '85', targetWeightGrams: 85000 }).daily_deficit).toBe(-500);
    });
    it('validates each required step and refuses inconsistent submission', () => {
        expect(validateOnboardingStep({ ...FORM, dateOfBirth: '2020-01-01', sex: null, timezone: 'not-a-zone' }, 'about'))
            .toEqual(expect.objectContaining({ dateOfBirth: expect.any(String), sex: expect.any(String), timezone: expect.any(String) }));
        expect(validateOnboardingStep({ ...FORM, activityLevel: null }, 'activity')).toHaveProperty('activityLevel');
        expect(validateOnboardingStep({ ...FORM, targetWeightGrams: 85000, dailyChangeAbs: '' }, 'plan'))
            .toEqual(expect.objectContaining({ targetWeight: expect.any(String), dailyChangeAbs: expect.any(String) }));
        expect(buildCaloriePlanDraft({ ...FORM, currentWeightGrams: null })).toBeNull();
        expect(() => buildOnboardingCompleteData({ ...FORM, goalMode: null })).toThrow();
    });
    it('accepts unfinished persisted text but rejects malformed state', () => {
        expect(isOnboardingFormState(editHeight(FORM, 'heightCm', '.'))).toBe(true);
        expect(isOnboardingFormState({ ...FORM, currentWeightGrams: '80000' })).toBe(false);
        expect(isOnboardingFormState({ ...FORM, heightUnit: 'M' })).toBe(false);
        expect(isOnboardingFormState({})).toBe(false);
    });
});
