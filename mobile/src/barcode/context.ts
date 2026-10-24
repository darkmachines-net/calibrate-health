/** @file Validated barcode route context for local date, meal period, and allowlisted return destinations. */

import { isDateOnly, MEAL_PERIODS, type MealPeriod } from '@calibrate/shared';

export const BARCODE_RETURN_DESTINATIONS = {
    TODAY: 'today',
    FOOD_LOG: 'food-log'
} as const;

export type BarcodeReturnDestination =
    (typeof BARCODE_RETURN_DESTINATIONS)[keyof typeof BARCODE_RETURN_DESTINATIONS];

export const BARCODE_RESUME_STEPS = {
    SCAN: 'scan',
    AUTH: 'auth',
    SETTINGS: 'settings',
    LOOKUP: 'lookup',
    SEARCH: 'search',
    MANUAL: 'manual',
    MANUAL_FOOD: 'manual-food',
    RESULT: 'result'
} as const;

export type BarcodeResumeStep = (typeof BARCODE_RESUME_STEPS)[keyof typeof BARCODE_RESUME_STEPS];

export type BarcodeWorkflowContext = {
    date: string;
    meal: MealPeriod;
    returnTo: BarcodeReturnDestination;
};

export type BarcodeResumeContext = BarcodeWorkflowContext & {
    resumeStep: BarcodeResumeStep;
    barcode?: string;
};

export type BarcodeWorkflowRouteParams = {
    date: string;
    meal: MealPeriod;
    returnTo: BarcodeReturnDestination;
    barcodeResume?: BarcodeResumeStep;
    barcode?: string;
};

type BarcodeWorkflowParamSource = {
    date?: unknown;
    meal?: unknown;
    returnTo?: unknown;
    barcodeResume?: unknown;
    barcode?: unknown;
};

const MEAL_VALUES = new Set<MealPeriod>(Object.values(MEAL_PERIODS));
const RETURN_DESTINATIONS = new Set<BarcodeReturnDestination>(Object.values(BARCODE_RETURN_DESTINATIONS));
const RESUME_STEPS = new Set<BarcodeResumeStep>(Object.values(BARCODE_RESUME_STEPS));

function firstString(value: unknown): string | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    return typeof candidate === 'string' ? candidate : null;
}

function isCalendarDateOnly(value: unknown): value is string {
    if (!isDateOnly(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMeal(value: unknown, fallback: MealPeriod): MealPeriod {
    const candidate = firstString(value);
    return candidate && MEAL_VALUES.has(candidate as MealPeriod) ? candidate as MealPeriod : fallback;
}

function parseReturnDestination(
    value: unknown,
    fallback: BarcodeReturnDestination
): BarcodeReturnDestination {
    const candidate = firstString(value);
    return candidate && RETURN_DESTINATIONS.has(candidate as BarcodeReturnDestination)
        ? candidate as BarcodeReturnDestination
        : fallback;
}

/** Parse the date, meal, and return destination at every barcode route boundary. */
export function parseBarcodeWorkflowContext(
    params: BarcodeWorkflowParamSource,
    defaults: BarcodeWorkflowContext
): BarcodeWorkflowContext {
    const date = firstString(params.date);
    return {
        date: isCalendarDateOnly(date) ? date : defaults.date,
        meal: parseMeal(params.meal, defaults.meal),
        returnTo: parseReturnDestination(params.returnTo, defaults.returnTo)
    };
}

/** Serialize only the durable navigation context shared by camera and camera-free paths. */
export function serializeBarcodeWorkflowContext(
    context: BarcodeWorkflowContext,
    resume?: Pick<BarcodeResumeContext, 'resumeStep'> & Partial<Pick<BarcodeResumeContext, 'barcode'>>
): BarcodeWorkflowRouteParams {
    const params: BarcodeWorkflowRouteParams = {
        date: context.date,
        meal: context.meal,
        returnTo: context.returnTo
    };
    if (resume) params.barcodeResume = resume.resumeStep;
    const barcode = resume?.barcode?.trim();
    if (barcode) params.barcode = barcode;
    return params;
}

/** Recover a transition-specific resume point without allowing malformed route values through. */
export function parseBarcodeResumeContext(
    params: BarcodeWorkflowParamSource,
    defaults: BarcodeResumeContext
): BarcodeResumeContext {
    const context = parseBarcodeWorkflowContext(params, defaults);
    const rawStep = firstString(params.barcodeResume);
    const resumeStep = rawStep && RESUME_STEPS.has(rawStep as BarcodeResumeStep)
        ? rawStep as BarcodeResumeStep
        : defaults.resumeStep;
    const barcode = firstString(params.barcode)?.trim() || defaults.barcode?.trim();
    return {
        ...context,
        resumeStep,
        ...(barcode ? { barcode } : {})
    };
}

/** Build a purpose-bound barcode return path suitable for auth and other temporary detours. */
export function getBarcodeResumePath(resume: BarcodeResumeContext): string {
    const params = serializeBarcodeWorkflowContext(resume, resume);
    const query = Object.entries(params)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    return `/barcode?${query}`;
}
