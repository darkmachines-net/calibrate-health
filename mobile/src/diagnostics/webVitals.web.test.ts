/** @file Regression coverage for web Vitals web: privacy-safe client web vitals. */

import type { ClientDiagnosticSignal } from './clientDiagnostics';
import { reportClientDiagnostic } from './clientDiagnostics';
import {
    calculateInteractionToNextPaint,
    calculateMaximumClsSessionValue,
    createWebVitalSignal,
    getClientDiagnosticRoute,
    observeClientWebVitals
} from './webVitals.web';

jest.mock('./clientDiagnostics', () => ({
    reportClientDiagnostic: jest.fn(async () => null)
}));

const mockReportClientDiagnostic = reportClientDiagnostic as jest.MockedFunction<typeof reportClientDiagnostic>;

describe('privacy-safe client web vitals', () => {
    beforeEach(() => {
        mockReportClientDiagnostic.mockClear();
    });

    it('maps exact LCP and INP thresholds to server-accepted buckets', () => {
        expect(createWebVitalSignal('largest_contentful_paint', 2_500, 'today')).toEqual({
            event: 'web_vital',
            operation: 'largest_contentful_paint',
            route: 'today',
            outcome: 'good',
            duration_bucket: '1_to_2_5_s'
        });
        expect(createWebVitalSignal('largest_contentful_paint', 2_501, 'today')?.outcome)
            .toBe('needs_improvement');
        expect(createWebVitalSignal('interaction_to_next_paint', 200, 'today')).toEqual({
            event: 'web_vital',
            operation: 'interaction_to_next_paint',
            route: 'today',
            outcome: 'good',
            duration_bucket: '100_to_200_ms'
        });
        expect(createWebVitalSignal('interaction_to_next_paint', 201, 'today')?.outcome)
            .toBe('needs_improvement');
        expect(createWebVitalSignal('interaction_to_next_paint', 501, 'today')?.outcome)
            .toBe('poor');
    });

    it('uses CLS ratings without pretending the score is a duration', () => {
        expect(createWebVitalSignal('cumulative_layout_shift', 0.1, 'app_shell')).toEqual({
            event: 'web_vital',
            operation: 'cumulative_layout_shift',
            route: 'app_shell',
            outcome: 'good',
            duration_bucket: 'not_applicable'
        });
        expect(createWebVitalSignal('cumulative_layout_shift', 0.2, 'app_shell')?.outcome)
            .toBe('needs_improvement');
        expect(createWebVitalSignal('cumulative_layout_shift', 0.3, 'app_shell')?.outcome)
            .toBe('poor');
    });

    it('collapses pathnames and query strings to fixed route categories', () => {
        expect(getClientDiagnosticRoute('/onboarding?email=person@example.com')).toBe('onboarding');
        expect(getClientDiagnosticRoute('/food-log?food=Secret%20Meal')).toBe('today');
        expect(getClientDiagnosticRoute('/my-foods?query=person@example.com')).toBe('saved_foods');
        expect(getClientDiagnosticRoute('/notifications?cursor=private')).toBe('notifications');
        expect(getClientDiagnosticRoute('/weight-trend#private')).toBe('progress');
        expect(getClientDiagnosticRoute('/unknown/private/health/path')).toBe('app_shell');
    });

    it('uses the maximum CLS session window instead of the page-lifetime sum', () => {
        expect(calculateMaximumClsSessionValue([
            { startTime: 0, value: 0.12 },
            { startTime: 800, value: 0.1 },
            { startTime: 1_901, value: 0.3 }
        ])).toBeCloseTo(0.3);
        expect(calculateMaximumClsSessionValue([
            { startTime: 0, value: 0.1 },
            { startTime: 900, value: 0.1 },
            { startTime: 1_800, value: 0.1 },
            { startTime: 2_700, value: 0.1 },
            { startTime: 3_600, value: 0.1 },
            { startTime: 4_500, value: 0.1 },
            { startTime: 5_400, value: 0.4 }
        ])).toBeCloseTo(0.6);
    });

    it('starts new CLS sessions at the exact gap and window boundaries', () => {
        const exactGapValue = calculateMaximumClsSessionValue([
            { startTime: 0, value: 0.15 },
            { startTime: 1_000, value: 0.15 }
        ]);
        const exactWindowValue = calculateMaximumClsSessionValue([
            { startTime: 0, value: 0.02 },
            { startTime: 900, value: 0.02 },
            { startTime: 1_800, value: 0.02 },
            { startTime: 2_700, value: 0.02 },
            { startTime: 3_600, value: 0.02 },
            { startTime: 4_500, value: 0.02 },
            { startTime: 5_000, value: 0.14 }
        ]);

        expect(exactGapValue).toBeCloseTo(0.15);
        expect(exactWindowValue).toBeCloseTo(0.14);
        expect(createWebVitalSignal('cumulative_layout_shift', exactGapValue, 'today')?.outcome)
            .toBe('needs_improvement');
        expect(createWebVitalSignal('cumulative_layout_shift', exactWindowValue, 'today')?.outcome)
            .toBe('needs_improvement');
    });

    it('selects the high-percentile per-interaction duration for INP', () => {
        const interactions = Array.from({ length: 50 }, (_, index) => ({
            interactionId: (index + 1) * 7,
            duration: 100
        }));
        interactions[0].duration = 1_000;
        interactions[1].duration = 400;

        expect(calculateInteractionToNextPaint(interactions.slice(0, 49))).toBe(1_000);
        expect(calculateInteractionToNextPaint([
            ...interactions,
            { interactionId: 14, duration: 450 },
            { interactionId: 7, duration: 800 }
        ])).toBe(450);
    });

    it('retains late worst interactions after the bounded candidate list fills', () => {
        const earlyInteractions = Array.from({ length: 1_000 }, (_, index) => ({
            interactionId: (index + 1) * 7,
            duration: 40
        }));
        const lateWorstInteractions = Array.from({ length: 60 }, (_, index) => ({
            interactionId: (index + 1_001) * 7,
            duration: 600
        }));

        expect(calculateInteractionToNextPaint([
            ...earlyInteractions,
            ...lateWorstInteractions
        ])).toBe(600);
    });

    it('seeds a sub-40ms INP from buffered first-input without exposing target details', () => {
        const callbacks = new Map<string, PerformanceObserverCallback>();
        let pagehide: EventListener | null = null;
        const environment = {
            createObserver: jest.fn((callback: PerformanceObserverCallback) => ({
                observe: jest.fn((options: PerformanceObserverInit) => {
                    if (options.type) callbacks.set(options.type, callback);
                }),
                disconnect: jest.fn()
            } as unknown as PerformanceObserver)),
            document: {
                visibilityState: 'visible' as DocumentVisibilityState,
                addEventListener: jest.fn(),
                removeEventListener: jest.fn()
            },
            window: {
                addEventListener: jest.fn((_type: string, listener: EventListener) => {
                    pagehide = listener;
                }),
                removeEventListener: jest.fn()
            }
        };
        const cleanup = observeClientWebVitals('today', environment);
        const firstInput = callbacks.get('first-input');
        const entryList = {
            getEntries: () => [{
                duration: 32,
                interactionId: 7,
                target: 'private-button-person@example.com'
            }]
        } as unknown as PerformanceObserverEntryList;

        expect(firstInput).toBeDefined();
        firstInput?.(entryList, {} as PerformanceObserver);
        expect(pagehide).not.toBeNull();
        (pagehide as unknown as EventListener)(new Event('pagehide'));
        cleanup();

        const signals = mockReportClientDiagnostic.mock.calls.map(([signal]) => signal);
        expect(signals.filter((signal) => signal.operation === 'interaction_to_next_paint')).toEqual([{
            event: 'web_vital',
            operation: 'interaction_to_next_paint',
            route: 'today',
            outcome: 'good',
            duration_bucket: 'under_100_ms'
        }]);
        expect(JSON.stringify(signals)).not.toContain('private-button-person@example.com');
        expect(JSON.stringify(signals)).not.toContain('32');
    });

    it('uses count-only fast interactions when selecting the INP percentile', () => {
        const registrations: Array<{
            callback: PerformanceObserverCallback;
            options: PerformanceObserverInit & { durationThreshold?: number };
        }> = [];
        let pagehide: EventListener | null = null;
        const environment = {
            createObserver: jest.fn((callback: PerformanceObserverCallback) => ({
                observe: jest.fn((options: PerformanceObserverInit & { durationThreshold?: number }) => {
                    registrations.push({ callback, options });
                }),
                disconnect: jest.fn()
            } as unknown as PerformanceObserver)),
            document: {
                visibilityState: 'visible' as DocumentVisibilityState,
                addEventListener: jest.fn(),
                removeEventListener: jest.fn()
            },
            window: {
                addEventListener: jest.fn((_type: string, listener: EventListener) => {
                    pagehide = listener;
                }),
                removeEventListener: jest.fn()
            }
        };
        const cleanup = observeClientWebVitals('today', environment);
        const countRegistration = registrations.find(({ options }) => (
            options.type === 'event' && options.durationThreshold === 0
        ));
        const candidateRegistration = registrations.find(({ options }) => (
            options.type === 'event' && options.durationThreshold === 40
        ));
        const firstInputRegistration = registrations.find(({ options }) => options.type === 'first-input');
        const entryList = (entries: Array<Record<string, unknown>>) => ({
            getEntries: () => entries
        } as unknown as PerformanceObserverEntryList);
        const observer = {} as PerformanceObserver;

        expect(countRegistration).toBeDefined();
        expect(candidateRegistration).toBeDefined();
        expect(firstInputRegistration).toBeDefined();
        firstInputRegistration?.callback(entryList([{
            duration: 32,
            interactionId: 7,
            target: 'private-first-input'
        }]), observer);
        candidateRegistration?.callback(entryList([
            { duration: 700, interactionId: 14, target: 'private-slow-outlier' },
            { duration: 300, interactionId: 21, target: 'private-second-outlier' }
        ]), observer);
        countRegistration?.callback(entryList(Array.from({ length: 98 }, (_, index) => ({
            duration: 24,
            interactionId: (index + 1) * 7,
            target: `private-fast-${index}`
        }))), observer);
        expect(pagehide).not.toBeNull();
        (pagehide as unknown as EventListener)(new Event('pagehide'));
        cleanup();

        const signals = mockReportClientDiagnostic.mock.calls.map(([signal]) => signal);
        expect(signals.filter((signal) => signal.operation === 'interaction_to_next_paint')).toEqual([{
            event: 'web_vital',
            operation: 'interaction_to_next_paint',
            route: 'today',
            outcome: 'needs_improvement',
            duration_bucket: '200_to_500_ms'
        }]);
        const serializedSignals = JSON.stringify(signals);
        expect(serializedSignals).not.toContain('private-');
        expect(serializedSignals).not.toContain('700');
        expect(serializedSignals).not.toContain('300');
        expect(serializedSignals).not.toContain('24');
    });

    it('reports one finalized fixed tuple per metric and ignores repeated flushes', () => {
        const callbacks: PerformanceObserverCallback[] = [];
        const documentListeners = new Map<string, EventListener>();
        const windowListeners = new Map<string, EventListener>();
        const environment = {
            createObserver: jest.fn((callback: PerformanceObserverCallback) => {
                callbacks.push(callback);
                return {
                    observe: jest.fn(),
                    disconnect: jest.fn()
                } as unknown as PerformanceObserver;
            }),
            document: {
                visibilityState: 'visible' as DocumentVisibilityState,
                addEventListener: jest.fn((type: string, listener: EventListener) => {
                    documentListeners.set(type, listener);
                }),
                removeEventListener: jest.fn()
            },
            window: {
                addEventListener: jest.fn((type: string, listener: EventListener) => {
                    windowListeners.set(type, listener);
                }),
                removeEventListener: jest.fn()
            }
        };
        const cleanup = observeClientWebVitals('today', environment);
        const observer = {} as PerformanceObserver;
        type TestWebVitalEntry = Partial<PerformanceEntry> & {
            duration?: number;
            hadRecentInput?: boolean;
            interactionId?: number;
            value?: number;
        };
        const entryList = (entries: TestWebVitalEntry[]) => ({
            getEntries: () => entries
        } as PerformanceObserverEntryList);

        callbacks[0](entryList([{ startTime: 2_600 }]), observer);
        callbacks[2](entryList([{ duration: 220, interactionId: 7 }]), observer);
        callbacks[4](entryList([{ startTime: 100, value: 0.12, hadRecentInput: false }]), observer);
        windowListeners.get('pagehide')?.(new Event('pagehide'));
        windowListeners.get('pagehide')?.(new Event('pagehide'));
        cleanup();

        expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(3);
        const signals = mockReportClientDiagnostic.mock.calls.map(([signal]) => signal);
        expect(signals).toEqual<ClientDiagnosticSignal[]>([
            {
                event: 'web_vital',
                operation: 'largest_contentful_paint',
                route: 'today',
                outcome: 'needs_improvement',
                duration_bucket: '2_5_to_4_s'
            },
            {
                event: 'web_vital',
                operation: 'interaction_to_next_paint',
                route: 'today',
                outcome: 'needs_improvement',
                duration_bucket: '200_to_500_ms'
            },
            {
                event: 'web_vital',
                operation: 'cumulative_layout_shift',
                route: 'today',
                outcome: 'needs_improvement',
                duration_bucket: 'not_applicable'
            }
        ]);
        expect(JSON.stringify(signals)).not.toContain('2600');
        expect(JSON.stringify(signals)).not.toContain('0.12');
    });

    it('does not report a synthetic good CLS when layout-shift entries are unsupported', () => {
        let pagehide: EventListener | null = null;
        const environment = {
            createObserver: jest.fn(() => ({
                observe: jest.fn((options: PerformanceObserverInit) => {
                    if (options.type === 'layout-shift') throw new Error('unsupported');
                }),
                disconnect: jest.fn()
            } as unknown as PerformanceObserver)),
            document: {
                visibilityState: 'visible' as DocumentVisibilityState,
                addEventListener: jest.fn(),
                removeEventListener: jest.fn()
            },
            window: {
                addEventListener: jest.fn((_type: string, listener: EventListener) => {
                    pagehide = listener;
                }),
                removeEventListener: jest.fn()
            }
        };
        const cleanup = observeClientWebVitals('app_shell', environment);

        expect(pagehide).not.toBeNull();
        (pagehide as unknown as EventListener)(new Event('pagehide'));
        cleanup();

        expect(mockReportClientDiagnostic).not.toHaveBeenCalled();
    });
});
