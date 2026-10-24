/** @file Regression coverage for provider web: Health Connect localhost web fixture. */

import {
    getHealthConnectWebFixtureForHost,
    isHealthConnectWebFixtureHost,
    resolveHealthConnectWebFixture,
    type HealthConnectWebFixture
} from './provider.web';

describe('Health Connect localhost web fixture', () => {
    it('guards the seam and maps browser evidence states without changing the default web boundary', () => {
        const denied: HealthConnectWebFixture = { state: 'denied' };

        expect(isHealthConnectWebFixtureHost('localhost')).toBe(true);
        expect(isHealthConnectWebFixtureHost('127.0.0.1')).toBe(true);
        expect(isHealthConnectWebFixtureHost('calibrate.example')).toBe(false);
        expect(getHealthConnectWebFixtureForHost('calibrate.example', denied)).toBeNull();
        expect(getHealthConnectWebFixtureForHost('localhost', { state: 'unknown' })).toBeNull();
        expect(getHealthConnectWebFixtureForHost('localhost', denied)).toBe(denied);

        expect(resolveHealthConnectWebFixture(null)).toMatchObject({
            connected: false,
            connection: { availability: 'not_android', initialized: false, grantedFeatures: [] }
        });
        expect(resolveHealthConnectWebFixture(denied)).toMatchObject({
            connected: true,
            connection: { availability: 'available', initialized: true, grantedFeatures: [] }
        });
        expect(resolveHealthConnectWebFixture({ state: 'syncing' })).toMatchObject({
            connected: true,
            isSyncing: true
        });
        expect(resolveHealthConnectWebFixture({ state: 'stale' }).lastSuccessfulSyncAt)
            .toBe('2000-01-01T00:00:00.000Z');
        expect(resolveHealthConnectWebFixture({ state: 'empty' }).lastSuccessfulSyncAt).toBeNull();
        expect(resolveHealthConnectWebFixture({ state: 'failed_sync' }).syncError)
            .toMatch(/could not sync/i);
    });
});