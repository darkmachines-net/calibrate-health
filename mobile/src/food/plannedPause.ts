/** @file Tracking-pause intent and acknowledgement handling without treating planned state as server confirmation. */

import type { FoodTrackingPause } from '@calibrate/api-client';
import { dateOnlyToLocalDate, formatDateOnlyForDisplay, localDateToDateOnly } from '../utils/dates';

function isDateOnly(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && localDateToDateOnly(dateOnlyToLocalDate(value)) === value;
}

/** An expectation describes intent, never the effective end of a pause. */
export function getActivePausePlan(pause: FoodTrackingPause | undefined, today: string) {
    if (!pause?.active || pause.resumed_on !== null || !isDateOnly(pause.starts_on)
        || pause.starts_on > today
        || (pause.expected_resume_on !== null && (!isDateOnly(pause.expected_resume_on)
            || pause.expected_resume_on < pause.starts_on))) return null;
    return { startsOn: pause.starts_on, expectedResumeOn: pause.expected_resume_on };
}

export type ActivePausePlan = ReturnType<typeof getActivePausePlan>;

/** Identifies future dates inside the planned pause, excluding its expected resume date. */
export function isPlannedPauseDate(date: string, today: string, plan: ActivePausePlan): boolean {
    return Boolean(plan && date > today && date >= plan.startsOn
        && (plan.expectedResumeOn === null || date < plan.expectedResumeOn));
}

/** Chooses the resume month for pause browsing when it is in the future, otherwise today's month. */
export function getPauseBrowseMonth(today: string, plan: ActivePausePlan): string {
    const target = plan?.expectedResumeOn;
    return (target && target > today ? target : today).slice(0, 7);
}

/** Explains expected resumption without treating an elapsed expected date as an automatic resume. */
export function getPauseExpectationCopy(plan: ActivePausePlan, today: string): string | null {
    if (!plan) return null;
    if (plan.expectedResumeOn === null) return 'Until you resume';
    const date = formatDateOnlyForDisplay(plan.expectedResumeOn);
    if (plan.expectedResumeOn === today) return `Expected to resume today (${date}). Tracking is still paused.`;
    if (plan.expectedResumeOn < today) return `Expected resume date has passed (${date}). Tracking is still paused.`;
    return `Expected to resume ${date}`;
}
