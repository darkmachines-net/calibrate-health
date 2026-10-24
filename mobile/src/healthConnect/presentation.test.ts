/** @file Regression coverage for presentation: Health Connect presentation. */

import { DEFAULT_HEALTH_CONNECT_SELECTION } from './types';
import {
    formatHealthConnectFreshness,
    getHealthConnectPresentation,
    type HealthConnectPresentationInput
} from './presentation';

const NOW = new Date('2026-08-09T18:00:00.000Z');

function input(overrides: Partial<HealthConnectPresentationInput> = {}): HealthConnectPresentationInput {
    return {
        availability: 'available',
        connected: true,
        paused: false,
        isLoading: false,
        isSyncing: false,
        error: null,
        syncError: null,
        selection: DEFAULT_HEALTH_CONNECT_SELECTION,
        grantedFeatures: ['steps', 'active_calories', 'total_calories', 'exercise'],
        hasImportedActivity: true,
        lastSuccessfulSyncAt: '2026-08-09T17:30:00.000Z',
        now: NOW,
        ...overrides
    };
}

describe('Health Connect presentation', () => {
    it.each([
        {
            name: 'disconnected',
            overrides: { connected: false },
            state: 'disconnected',
            action: 'connect',
            actionLabel: 'Connect Health Connect'
        },
        {
            name: 'denied',
            overrides: { grantedFeatures: ['steps'] as const },
            state: 'denied',
            action: 'manage',
            actionLabel: 'Manage Health Connect'
        },
        {
            name: 'syncing',
            overrides: { isSyncing: true },
            state: 'syncing',
            action: 'manage',
            actionLabel: 'Manage Health Connect'
        },
        {
            name: 'stale',
            overrides: { lastSuccessfulSyncAt: '2026-08-09T10:00:00.000Z' },
            state: 'stale',
            action: 'manage',
            actionLabel: 'Manage Health Connect'
        },
        {
            name: 'empty',
            overrides: { hasImportedActivity: false, lastSuccessfulSyncAt: null },
            state: 'empty',
            action: 'manage',
            actionLabel: 'Manage Health Connect'
        },
        {
            name: 'failed sync',
            overrides: { syncError: 'Health activity could not sync. Try again from Health Connect settings.' },
            state: 'failed_sync',
            action: 'manage',
            actionLabel: 'Manage Health Connect'
        }
    ])('presents the $name state with one stable connection action', ({ overrides, state, action, actionLabel }) => {
        expect(getHealthConnectPresentation(input(overrides))).toMatchObject({ state, action, actionLabel });
    });

    it('treats any missing selected permission as denied and keeps imported history visible', () => {
        const presentation = getHealthConnectPresentation(input({
            grantedFeatures: ['steps', 'active_calories', 'total_calories'],
            hasImportedActivity: true
        }));

        expect(presentation.state).toBe('denied');
        expect(presentation.missingFeatures).toEqual(['exercise']);
        expect(presentation.shouldShowActivity).toBe(true);
    });

    it('keeps historical activity available after disconnecting', () => {
        expect(getHealthConnectPresentation(input({ connected: false, hasImportedActivity: true })))
            .toMatchObject({ state: 'disconnected', shouldShowActivity: true });
        expect(getHealthConnectPresentation(input({ connected: false, hasImportedActivity: false })))
            .toMatchObject({ state: 'disconnected', shouldShowActivity: false });
    });

    it('prioritizes permission, active sync, and failed-sync states before freshness', () => {
        expect(getHealthConnectPresentation(input({
            grantedFeatures: [],
            isSyncing: true,
            syncError: 'Previous failure',
            lastSuccessfulSyncAt: '2026-08-08T00:00:00.000Z'
        })).state).toBe('denied');
        expect(getHealthConnectPresentation(input({
            isSyncing: true,
            syncError: 'Previous failure',
            lastSuccessfulSyncAt: '2026-08-08T00:00:00.000Z'
        })).state).toBe('syncing');
        expect(getHealthConnectPresentation(input({
            syncError: 'Previous failure',
            lastSuccessfulSyncAt: '2026-08-08T00:00:00.000Z'
        })).state).toBe('failed_sync');
    });

    it('formats sync freshness without exposing raw timestamps', () => {
        expect(formatHealthConnectFreshness(null, NOW)).toBe('Not synced yet');
        expect(formatHealthConnectFreshness('2026-08-09T17:59:45.000Z', NOW)).toBe('Synced just now');
        expect(formatHealthConnectFreshness('2026-08-09T17:42:00.000Z', NOW)).toBe('Synced 18m ago');
        expect(formatHealthConnectFreshness('2026-08-09T14:00:00.000Z', NOW)).toBe('Synced 4h ago');
        expect(formatHealthConnectFreshness('not-a-date', NOW)).toBe('Sync time unavailable');
    });
});
