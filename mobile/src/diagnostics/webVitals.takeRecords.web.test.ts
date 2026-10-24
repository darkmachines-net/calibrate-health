/** @file Regression coverage for web Vitals take Records web: client Web Vitals terminal record drain. */

import { reportClientDiagnostic } from './clientDiagnostics';
import { observeClientWebVitals } from './webVitals.web';

jest.mock('./clientDiagnostics', () => ({
    reportClientDiagnostic: jest.fn(async () => null)
}));

const mockReportClientDiagnostic = reportClientDiagnostic as jest.MockedFunction<typeof reportClientDiagnostic>;

describe('client Web Vitals terminal record drain', () => {
    beforeEach(() => {
        mockReportClientDiagnostic.mockClear();
    });

    it('drains queued late poor records before the one pagehide sample', () => {
        type Registration = {
            callback: PerformanceObserverCallback;
            options: (PerformanceObserverInit & { durationThreshold?: number }) | null;
            records: Array<Record<string, unknown>>;
            takeRecords: jest.Mock;
        };
        const registrations: Registration[] = [];
        let pagehide: EventListener | null = null;
        const environment = {
            createObserver: jest.fn((callback: PerformanceObserverCallback) => {
                const registration: Registration = {
                    callback,
                    options: null,
                    records: [],
                    takeRecords: jest.fn()
                };
                registration.takeRecords.mockImplementation(() => registration.records.splice(0));
                registrations.push(registration);
                return {
                    observe: jest.fn((options: PerformanceObserverInit & { durationThreshold?: number }) => {
                        registration.options = options;
                    }),
                    takeRecords: registration.takeRecords,
                    disconnect: jest.fn()
                } as unknown as PerformanceObserver;
            }),
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
        const lcp = registrations.find(({ options }) => options?.type === 'largest-contentful-paint');
        const candidate = registrations.find(({ options }) => (
            options?.type === 'event' && options.durationThreshold === 40
        ));
        const cls = registrations.find(({ options }) => options?.type === 'layout-shift');

        lcp?.records.push({
            startTime: 4_500,
            url: 'https://private.example/image?token=secret'
        });
        candidate?.records.push({
            duration: 700,
            interactionId: 7,
            target: 'private-button-person@example.com'
        });
        cls?.records.push({
            startTime: 100,
            value: 0.3,
            hadRecentInput: false,
            sources: ['private-layout-source']
        });

        expect(mockReportClientDiagnostic).not.toHaveBeenCalled();
        expect(pagehide).not.toBeNull();
        (pagehide as unknown as EventListener)(new Event('pagehide'));
        (pagehide as unknown as EventListener)(new Event('pagehide'));
        cleanup();

        expect(registrations.every(({ takeRecords }) => takeRecords.mock.calls.length === 1)).toBe(true);
        const signals = mockReportClientDiagnostic.mock.calls.map(([signal]) => signal);
        expect(signals).toEqual([
            {
                event: 'web_vital',
                operation: 'largest_contentful_paint',
                route: 'today',
                outcome: 'poor',
                duration_bucket: '4_s_or_more'
            },
            {
                event: 'web_vital',
                operation: 'interaction_to_next_paint',
                route: 'today',
                outcome: 'poor',
                duration_bucket: '500_ms_to_1_s'
            },
            {
                event: 'web_vital',
                operation: 'cumulative_layout_shift',
                route: 'today',
                outcome: 'poor',
                duration_bucket: 'not_applicable'
            }
        ]);
        const serializedSignals = JSON.stringify(signals);
        expect(serializedSignals).not.toContain('private');
        expect(serializedSignals).not.toContain('4500');
        expect(serializedSignals).not.toContain('700');
        expect(serializedSignals).not.toContain('0.3');
    });
});
