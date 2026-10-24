/** @file Regression coverage for web Vitals lifecycle web: client Web Vitals page lifecycle. */

import { reportClientDiagnostic } from './clientDiagnostics';
import { observeClientWebVitals } from './webVitals.web';

jest.mock('./clientDiagnostics', () => ({
    reportClientDiagnostic: jest.fn(async () => null)
}));

const mockReportClientDiagnostic = reportClientDiagnostic as jest.MockedFunction<typeof reportClientDiagnostic>;

describe('client Web Vitals page lifecycle', () => {
    beforeEach(() => {
        mockReportClientDiagnostic.mockClear();
    });

    it('emits one late final tuple per metric on pagehide and never on intermediate visibility', () => {
        const registrations: Array<{
            callback: PerformanceObserverCallback;
            options: PerformanceObserverInit & { durationThreshold?: number };
        }> = [];
        const windowListeners = new Map<string, EventListener>();
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
                addEventListener: jest.fn((type: string, listener: EventListener) => {
                    windowListeners.set(type, listener);
                }),
                removeEventListener: jest.fn()
            }
        };
        const cleanup = observeClientWebVitals('today', environment);
        const candidateRegistration = registrations.find(({ options }) => (
            options.type === 'event' && options.durationThreshold === 40
        ));
        const firstInputRegistration = registrations.find(({ options }) => options.type === 'first-input');
        const clsRegistration = registrations.find(({ options }) => options.type === 'layout-shift');
        const observer = {} as PerformanceObserver;
        const entryList = (entries: Array<Record<string, unknown>>) => ({
            getEntries: () => entries
        } as unknown as PerformanceObserverEntryList);

        firstInputRegistration?.callback(entryList([{
            duration: 100,
            interactionId: 7,
            target: 'private-first-target'
        }]), observer);
        clsRegistration?.callback(entryList([{
            startTime: 100,
            value: 0.05,
            hadRecentInput: false,
            sources: ['private-layout-source']
        }]), observer);

        expect(environment.document.addEventListener).not.toHaveBeenCalled();
        expect(mockReportClientDiagnostic).not.toHaveBeenCalled();

        candidateRegistration?.callback(entryList([{
            duration: 700,
            interactionId: 14,
            target: 'private-late-target'
        }]), observer);
        clsRegistration?.callback(entryList([{
            startTime: 2_000,
            value: 0.3,
            hadRecentInput: false,
            sources: ['private-late-layout-source']
        }]), observer);
        expect(mockReportClientDiagnostic).not.toHaveBeenCalled();

        const pagehide = windowListeners.get('pagehide');
        expect(pagehide).toBeDefined();
        pagehide?.(new Event('pagehide'));
        pagehide?.(new Event('pagehide'));
        cleanup();

        const signals = mockReportClientDiagnostic.mock.calls.map(([signal]) => signal);
        expect(signals).toEqual([
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
        expect(serializedSignals).not.toContain('private-');
        expect(serializedSignals).not.toContain('700');
        expect(serializedSignals).not.toContain('0.3');
    });
});
