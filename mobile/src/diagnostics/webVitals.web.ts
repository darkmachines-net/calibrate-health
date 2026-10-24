/** @file Privacy-safe browser performance observation and bounded web-vital aggregation. */

import type {
    ClientDiagnosticDurationBucket,
    ClientDiagnosticOperation,
    ClientDiagnosticOutcome,
    ClientDiagnosticRoute
} from '@calibrate/shared';
import {
    reportClientDiagnostic,
    type ClientDiagnosticSignal
} from './clientDiagnostics';

type WebVitalOperation = Extract<
    ClientDiagnosticOperation,
    'largest_contentful_paint' | 'interaction_to_next_paint' | 'cumulative_layout_shift'
>;

type WebVitalEntry = PerformanceEntry & {
    duration?: number;
    hadRecentInput?: boolean;
    interactionId?: number;
    value?: number;
};

export type LayoutShiftSample = Pick<WebVitalEntry, 'startTime'> & {
    hadRecentInput?: boolean;
    value?: number;
};

export type InteractionTimingSample = {
    duration?: number;
    interactionId?: number;
};

type WebVitalsObserverEnvironment = {
    createObserver(callback: PerformanceObserverCallback): PerformanceObserver;
    document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    getInteractionCount?(): number | null;
    window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
};

type ClsAccumulator = {
    lastEntryTime: number | null;
    maximumValue: number;
    sessionStartTime: number | null;
    sessionValue: number;
};

type InteractionAccumulator = {
    candidateDurations: Map<number, number>;
    maximumInteractionId: number | null;
    minimumInteractionId: number | null;
    syntheticFirstInputSeen: boolean;
};

const CLS_SESSION_GAP_MS = 1_000;
const CLS_SESSION_MAX_MS = 5_000;
const INTERACTION_ID_STEP = 7;
const MAX_INP_CANDIDATES = 10; // Match the bounded longest-interaction list used for INP selection.
const SYNTHETIC_FIRST_INPUT_ID = -1;

function getDurationBucket(milliseconds: number): ClientDiagnosticDurationBucket {
    if (milliseconds < 100) return 'under_100_ms';
    if (milliseconds <= 200) return '100_to_200_ms';
    if (milliseconds <= 500) return '200_to_500_ms';
    if (milliseconds < 1_000) return '500_ms_to_1_s';
    if (milliseconds <= 2_500) return '1_to_2_5_s';
    if (milliseconds <= 4_000) return '2_5_to_4_s';
    return '4_s_or_more';
}

function getWebVitalOutcome(operation: WebVitalOperation, value: number): ClientDiagnosticOutcome {
    if (operation === 'largest_contentful_paint') {
        if (value <= 2_500) return 'good';
        if (value <= 4_000) return 'needs_improvement';
        return 'poor';
    }
    if (operation === 'interaction_to_next_paint') {
        if (value <= 200) return 'good';
        if (value <= 500) return 'needs_improvement';
        return 'poor';
    }
    if (value <= 0.1) return 'good';
    if (value <= 0.25) return 'needs_improvement';
    return 'poor';
}

function addLayoutShiftEntries(accumulator: ClsAccumulator, entries: readonly LayoutShiftSample[]): void {
    for (const entry of entries) {
        const value = entry.value;
        if (
            entry.hadRecentInput
            || typeof value !== 'number'
            || !Number.isFinite(value)
            || value < 0
            || !Number.isFinite(entry.startTime)
        ) continue;

        const startsNewSession = accumulator.sessionStartTime === null
            || accumulator.lastEntryTime === null
            || entry.startTime - accumulator.lastEntryTime >= CLS_SESSION_GAP_MS
            || entry.startTime - accumulator.sessionStartTime >= CLS_SESSION_MAX_MS;
        if (startsNewSession) {
            accumulator.sessionStartTime = entry.startTime;
            accumulator.sessionValue = value;
        } else {
            accumulator.sessionValue += value;
        }
        accumulator.lastEntryTime = entry.startTime;
        accumulator.maximumValue = Math.max(accumulator.maximumValue, accumulator.sessionValue);
    }
}

/** Computes the maximum cumulative layout-shift session score from eligible samples. */
export function calculateMaximumClsSessionValue(entries: readonly LayoutShiftSample[]): number {
    const accumulator: ClsAccumulator = {
        lastEntryTime: null,
        maximumValue: 0,
        sessionStartTime: null,
        sessionValue: 0
    };
    addLayoutShiftEntries(accumulator, entries);
    return accumulator.maximumValue;
}

function createInteractionAccumulator(): InteractionAccumulator {
    return {
        candidateDurations: new Map<number, number>(),
        maximumInteractionId: null,
        minimumInteractionId: null,
        syntheticFirstInputSeen: false
    };
}

function addInteractionCount(accumulator: InteractionAccumulator, interactionId: number): boolean {
    if (!Number.isFinite(interactionId) || interactionId <= 0) return false;
    accumulator.minimumInteractionId = accumulator.minimumInteractionId === null
        ? interactionId
        : Math.min(accumulator.minimumInteractionId, interactionId);
    accumulator.maximumInteractionId = accumulator.maximumInteractionId === null
        ? interactionId
        : Math.max(accumulator.maximumInteractionId, interactionId);
    return true;
}

function addInteractionCountEntries(
    accumulator: InteractionAccumulator,
    entries: readonly InteractionTimingSample[]
): void {
    for (const entry of entries) {
        if (typeof entry.interactionId === 'number') {
            addInteractionCount(accumulator, entry.interactionId);
        }
    }
}

function addInteractionCandidate(
    accumulator: InteractionAccumulator,
    interactionId: number,
    duration: number
): void {
    const existingDuration = accumulator.candidateDurations.get(interactionId);
    if (existingDuration !== undefined) {
        if (duration > existingDuration) {
            accumulator.candidateDurations.set(interactionId, duration);
        }
        return;
    }
    if (accumulator.candidateDurations.size < MAX_INP_CANDIDATES) {
        accumulator.candidateDurations.set(interactionId, duration);
        return;
    }

    let shortestCandidateId: number | null = null;
    let shortestCandidateDuration = Number.POSITIVE_INFINITY;
    for (const [candidateId, candidateDuration] of accumulator.candidateDurations) {
        if (candidateDuration < shortestCandidateDuration) {
            shortestCandidateId = candidateId;
            shortestCandidateDuration = candidateDuration;
        }
    }
    if (shortestCandidateId !== null && duration > shortestCandidateDuration) {
        accumulator.candidateDurations.delete(shortestCandidateId);
        accumulator.candidateDurations.set(interactionId, duration);
    }
}

function addInteractionSample(
    accumulator: InteractionAccumulator,
    interactionId: number,
    duration: number,
    syntheticFirstInput = false
): void {
    if (!Number.isFinite(duration) || duration < 0) return;
    if (syntheticFirstInput) {
        accumulator.syntheticFirstInputSeen = true;
    } else if (!addInteractionCount(accumulator, interactionId)) {
        return;
    }
    addInteractionCandidate(accumulator, interactionId, duration);
}

function addInteractionEntries(
    accumulator: InteractionAccumulator,
    entries: readonly InteractionTimingSample[]
): void {
    for (const entry of entries) {
        if (typeof entry.duration !== 'number' || typeof entry.interactionId !== 'number') continue;
        addInteractionSample(accumulator, entry.interactionId, entry.duration);
    }
}

function addFirstInputEntries(
    accumulator: InteractionAccumulator,
    entries: readonly InteractionTimingSample[]
): void {
    const firstInput = entries[0];
    if (!firstInput || typeof firstInput.duration !== 'number') return;
    const interactionId = firstInput.interactionId;
    if (typeof interactionId === 'number' && Number.isFinite(interactionId) && interactionId > 0) {
        addInteractionSample(accumulator, interactionId, firstInput.duration);
        return;
    }
    addInteractionSample(accumulator, SYNTHETIC_FIRST_INPUT_ID, firstInput.duration, true);
}

function estimatedInteractionCount(accumulator: InteractionAccumulator): number {
    let count = accumulator.syntheticFirstInputSeen ? 1 : 0;
    if (
        accumulator.minimumInteractionId !== null
        && accumulator.maximumInteractionId !== null
    ) {
        count += (
            accumulator.maximumInteractionId - accumulator.minimumInteractionId
        ) / INTERACTION_ID_STEP + 1;
    }
    return count;
}

function selectInteractionToNextPaint(
    accumulator: InteractionAccumulator,
    nativeInteractionCount: number | null = null
): number | null {
    const durations = [...accumulator.candidateDurations.values()]
        .sort((left, right) => right - left);
    if (durations.length === 0) return null;
    const boundedNativeCount = typeof nativeInteractionCount === 'number'
        && Number.isFinite(nativeInteractionCount)
        && nativeInteractionCount >= 0
        ? Math.floor(nativeInteractionCount)
        : 0;
    const interactionCount = Math.max(estimatedInteractionCount(accumulator), boundedNativeCount);
    const percentileRank = Math.min(durations.length - 1, Math.floor(interactionCount / 50));
    return durations[percentileRank] ?? null;
}

/** Browser Event Timing approximation: bounded candidates plus native/polyfilled interaction count. */
export function calculateInteractionToNextPaint(entries: readonly InteractionTimingSample[]): number | null {
    const accumulator = createInteractionAccumulator();
    addInteractionEntries(accumulator, entries);
    return selectInteractionToNextPaint(accumulator);
}

/** Converts a valid nonnegative web-vital measurement into a bounded diagnostic signal. */
export function createWebVitalSignal(
    operation: WebVitalOperation,
    value: number,
    route: ClientDiagnosticRoute
): ClientDiagnosticSignal | null {
    if (!Number.isFinite(value) || value < 0) return null;
    return {
        event: 'web_vital',
        operation,
        route,
        outcome: getWebVitalOutcome(operation, value),
        duration_bucket: operation === 'cumulative_layout_shift'
            ? 'not_applicable'
            : getDurationBucket(value)
    };
}

/** Collapse browser navigation into a fixed registry category before anything is emitted. */
export function getClientDiagnosticRoute(pathname: string): ClientDiagnosticRoute {
    const path = pathname.split(/[?#]/u, 1)[0]?.toLowerCase() ?? '';
    if (path === '/onboarding' || path.startsWith('/onboarding/')) return 'onboarding';
    if (path === '/food-log' || path.startsWith('/food-log/') || path === '/today') return 'today';
    if (
        path === '/my-foods'
        || path.startsWith('/my-foods/')
        || path === '/saved-foods'
        || path.startsWith('/saved-foods/')
    ) return 'saved_foods';
    if (path === '/notifications' || path.startsWith('/notifications/')) return 'notifications';
    if (path === '/progress' || path.startsWith('/progress/') || path === '/weight-trend') return 'progress';
    return 'app_shell';
}

function defaultObserverEnvironment(): WebVitalsObserverEnvironment | null {
    if (
        typeof PerformanceObserver === 'undefined'
        || typeof document === 'undefined'
        || typeof window === 'undefined'
    ) return null;
    const runtimePerformance = typeof performance === 'undefined'
        ? null
        : performance as Performance & { interactionCount?: number };
    return {
        createObserver: (callback) => new PerformanceObserver(callback),
        document,
        getInteractionCount: () => {
            const count = runtimePerformance?.interactionCount;
            return typeof count === 'number' && Number.isFinite(count) && count >= 0
                ? count
                : null;
        },
        window
    };
}

/** Emit one terminal sample per metric/document; abruptly discarded pages may be omitted. */
export function observeClientWebVitals(
    route: ClientDiagnosticRoute,
    environment = defaultObserverEnvironment()
): (flushBeforeDisconnect?: boolean) => void {
    if (!environment) return () => undefined;
    const activeEnvironment: WebVitalsObserverEnvironment = environment;

    let lcp: number | null = null;
    const interactions = createInteractionAccumulator();
    const clsAccumulator: ClsAccumulator = {
        lastEntryTime: null,
        maximumValue: 0,
        sessionStartTime: null,
        sessionValue: 0
    };
    let disabled = false;
    let reported = false;
    const observers: Array<{
        observer: PerformanceObserver;
        onEntries: (entries: readonly WebVitalEntry[]) => void;
    }> = [];

    function observe(
        type: string,
        onEntries: (entries: readonly WebVitalEntry[]) => void,
        options: PerformanceObserverInit & { durationThreshold?: number } = { type, buffered: true }
    ): boolean {
        let observer: PerformanceObserver | null = null;
        try {
            observer = activeEnvironment.createObserver((entryList) => {
                onEntries(entryList.getEntries() as WebVitalEntry[]);
            });
            observer.observe(options);
            observers.push({ observer, onEntries });
            return true;
        } catch {
            observer?.disconnect();
            // Unsupported entry types must not affect the app shell.
            return false;
        }
    }

    observe('largest-contentful-paint', (entries) => {
        const latest = entries[entries.length - 1];
        if (latest && Number.isFinite(latest.startTime)) lcp = latest.startTime;
    });
    observe('event', (entries) => {
        addInteractionCountEntries(interactions, entries);
    }, { type: 'event', buffered: true, durationThreshold: 0 });
    observe('event', (entries) => {
        addInteractionEntries(interactions, entries);
    }, { type: 'event', buffered: true, durationThreshold: 40 });
    observe('first-input', (entries) => {
        addFirstInputEntries(interactions, entries);
    });
    const clsSupported = observe('layout-shift', (entries) => {
        addLayoutShiftEntries(clsAccumulator, entries);
    });

    function flush() {
        if (disabled || reported) return;
        reported = true;
        for (const registration of observers) {
            try {
                const records = registration.observer.takeRecords() as WebVitalEntry[];
                if (records.length > 0) registration.onEntries(records);
            } catch {
                // A broken observer must not block the remaining terminal samples.
            }
        }
        const inp = selectInteractionToNextPaint(
            interactions,
            activeEnvironment.getInteractionCount?.() ?? null
        );
        const signals = [
            lcp === null ? null : createWebVitalSignal('largest_contentful_paint', lcp, route),
            inp === null ? null : createWebVitalSignal('interaction_to_next_paint', inp, route),
            clsSupported
                ? createWebVitalSignal('cumulative_layout_shift', clsAccumulator.maximumValue, route)
                : null
        ];
        for (const signal of signals) {
            if (signal) void reportClientDiagnostic(signal);
        }
    }

    activeEnvironment.window.addEventListener('pagehide', flush);

    return (flushBeforeDisconnect = true) => {
        if (flushBeforeDisconnect) flush();
        else disabled = true;
        observers.forEach(({ observer }) => observer.disconnect());
        activeEnvironment.window.removeEventListener('pagehide', flush);
    };
}
