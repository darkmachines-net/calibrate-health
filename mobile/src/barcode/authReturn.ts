/** @file Structured barcode continuation across authentication without accepting arbitrary return paths. */

import { MEAL_PERIODS } from '@calibrate/shared';
import {
    BARCODE_RESUME_STEPS,
    BARCODE_RETURN_DESTINATIONS,
    parseBarcodeResumeContext,
    serializeBarcodeWorkflowContext,
    type BarcodeResumeContext,
    type BarcodeWorkflowRouteParams
} from './context';
import { normalizeBarcode } from './workflow';

const BARCODE_AUTH_RETURN_MARKER = 'barcode';
const AUTH_DATE_SENTINEL = '1970-01-01';

export type BarcodeAuthReturnParams = Partial<BarcodeWorkflowRouteParams> & {
    barcodeAuthReturn?: string | string[];
};

export type BarcodeAuthDestination = {
    pathname: '/barcode';
    params: BarcodeWorkflowRouteParams;
};

function isSingleString(value: unknown): value is string {
    return typeof value === 'string';
}

/** Carry only structured barcode fields into auth; no caller-controlled path is accepted. */
export function createBarcodeLoginDestination(resume: BarcodeResumeContext) {
    return {
        pathname: '/(auth)/login' as const,
        params: {
            barcodeAuthReturn: BARCODE_AUTH_RETURN_MARKER,
            ...serializeBarcodeWorkflowContext(resume, resume)
        }
    };
}

/** Resolve a single allowlisted `/barcode` return and reject malformed or duplicated query values. */
export function resolveBarcodeAuthDestination(params: BarcodeAuthReturnParams): BarcodeAuthDestination | null {
    if (params.barcodeAuthReturn !== BARCODE_AUTH_RETURN_MARKER) return null;
    if (
        !isSingleString(params.date)
        || !isSingleString(params.meal)
        || !isSingleString(params.returnTo)
        || !isSingleString(params.barcodeResume)
        || (params.barcode !== undefined && !isSingleString(params.barcode))
    ) {
        return null;
    }

    const fallback: BarcodeResumeContext = {
        date: AUTH_DATE_SENTINEL,
        meal: MEAL_PERIODS.BREAKFAST,
        returnTo: BARCODE_RETURN_DESTINATIONS.TODAY,
        resumeStep: BARCODE_RESUME_STEPS.SCAN
    };
    const resume = parseBarcodeResumeContext(params, fallback);
    if (
        resume.date !== params.date
        || resume.meal !== params.meal
        || resume.returnTo !== params.returnTo
        || resume.resumeStep !== params.barcodeResume
    ) {
        return null;
    }

    if (params.barcode !== undefined) {
        const barcode = normalizeBarcode(params.barcode);
        if (!barcode || barcode !== params.barcode.trim()) return null;
        resume.barcode = barcode;
    }
    if (
        (resume.resumeStep === BARCODE_RESUME_STEPS.LOOKUP
            || resume.resumeStep === BARCODE_RESUME_STEPS.RESULT)
        && !resume.barcode
    ) {
        return null;
    }

    return {
        pathname: '/barcode',
        params: serializeBarcodeWorkflowContext(resume, resume)
    };
}
