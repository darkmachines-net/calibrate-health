/** @file Regression coverage for context: barcode return context. */

import { MEAL_PERIODS } from '@calibrate/shared';
import {
    BARCODE_RESUME_STEPS,
    BARCODE_RETURN_DESTINATIONS,
    getBarcodeResumePath,
    parseBarcodeResumeContext,
    parseBarcodeWorkflowContext,
    serializeBarcodeWorkflowContext,
    type BarcodeResumeContext,
    type BarcodeWorkflowContext
} from './context';

const defaults: BarcodeWorkflowContext = {
    date: '2026-08-09',
    meal: MEAL_PERIODS.BREAKFAST,
    returnTo: BARCODE_RETURN_DESTINATIONS.TODAY
};

describe('barcode return context', () => {
    it('parses the intended local date, meal, and return destination from route values', () => {
        expect(parseBarcodeWorkflowContext({
            date: ['2026-08-07', '2026-08-08'],
            meal: MEAL_PERIODS.EVENING_SNACK,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG
        }, defaults)).toEqual({
            date: '2026-08-07',
            meal: MEAL_PERIODS.EVENING_SNACK,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG
        });
    });

    it('falls back without allowing rollover dates or unrecognized navigation values', () => {
        expect(parseBarcodeWorkflowContext({
            date: '2026-02-31',
            meal: 'MIDNIGHT_SNACK',
            returnTo: '/private/provider/route'
        }, defaults)).toEqual(defaults);
    });

    it.each(Object.values(BARCODE_RESUME_STEPS))(
        'round-trips date, meal, and return destination through the %s transition',
        (resumeStep) => {
            const resume: BarcodeResumeContext = {
                date: '2026-08-02',
                meal: MEAL_PERIODS.LUNCH,
                returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
                resumeStep,
                barcode: '012345678905'
            };
            const serialized = serializeBarcodeWorkflowContext(resume, resume);

            expect(parseBarcodeResumeContext(serialized, {
                ...defaults,
                resumeStep: BARCODE_RESUME_STEPS.SCAN
            })).toEqual(resume);
        }
    );

    it('builds a purpose-bound encoded resume path for authentication detours', () => {
        expect(getBarcodeResumePath({
            date: '2026-08-02',
            meal: MEAL_PERIODS.AFTERNOON_SNACK,
            returnTo: BARCODE_RETURN_DESTINATIONS.FOOD_LOG,
            resumeStep: BARCODE_RESUME_STEPS.AUTH,
            barcode: '012345678905'
        })).toBe(
            '/barcode?date=2026-08-02&meal=AFTERNOON_SNACK&returnTo=food-log'
            + '&barcodeResume=auth&barcode=012345678905'
        );
    });
});
