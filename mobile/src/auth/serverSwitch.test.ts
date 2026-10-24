/** @file Regression coverage for server Switch: confirmServerSwitch. */

import { authenticateAgainstConfirmedServer, confirmServerSwitch } from './serverSwitch';
import type { ServerConnectionResult } from '../config/server';

const failedConnection: ServerConnectionResult = {
    ok: false,
    url: 'https://new.example',
    code: 'unreachable',
    message: 'Could not connect.'
};

const successfulConnection: ServerConnectionResult = {
    ok: true,
    url: 'https://new.example',
    message: 'Connected.',
    config: {
        api_version: 1,
        api_versions: {
            current: 'v1',
            supported: ['v1'],
            legacy_alias: '/api',
            legacy_deprecation: 'none'
        },
        server_version: '1.0.0',
        hosted_origin: 'https://new.example',
        min_supported_mobile_version: '0.1.0',
        min_supported_wear_version: '0.1.0',
        capabilities: {
            self_hosted_server_url: true,
            native_push: true,
            health_connect_activity: true,
            wear_os_ready: false
        }
    }
};

describe('confirmServerSwitch', () => {
    it('preserves a working session and persisted URL when confirmation fails', async () => {
        const clearCurrentSession = jest.fn(async () => undefined);
        const persistServerUrl = jest.fn(async () => undefined);

        const result = await confirmServerSwitch({
            candidate: 'https://new.example',
            currentServerUrl: 'https://working.example',
            testConnection: async () => failedConnection,
            clearCurrentSession,
            persistServerUrl
        });

        expect(result).toBe(failedConnection);
        expect(clearCurrentSession).not.toHaveBeenCalled();
        expect(persistServerUrl).not.toHaveBeenCalled();
    });

    it('clears server-scoped credentials only after successful confirmation', async () => {
        const events: string[] = [];

        await confirmServerSwitch({
            candidate: 'https://new.example',
            currentServerUrl: 'https://working.example',
            testConnection: async () => {
                events.push('confirmed');
                return successfulConnection;
            },
            clearCurrentSession: async () => { events.push('cleared'); },
            persistServerUrl: async () => { events.push('persisted'); }
        });

        expect(events).toEqual(['confirmed', 'cleared', 'persisted']);
    });

    it('keeps the current session when re-confirming the same normalized server', async () => {
        const clearCurrentSession = jest.fn(async () => undefined);
        const persistServerUrl = jest.fn(async () => undefined);

        await confirmServerSwitch({
            candidate: 'https://new.example',
            currentServerUrl: 'https://new.example',
            testConnection: async () => successfulConnection,
            clearCurrentSession,
            persistServerUrl
        });

        expect(clearCurrentSession).not.toHaveBeenCalled();
        expect(persistServerUrl).toHaveBeenCalledWith('https://new.example');
    });
});

describe('authenticateAgainstConfirmedServer', () => {
    it('authenticates against the normalized URL returned by confirmation', async () => {
        const events: string[] = [];
        const authenticate = jest.fn(async (confirmedServerUrl: string) => {
            events.push(`authenticated:${confirmedServerUrl}`);
            return 'session';
        });

        const result = await authenticateAgainstConfirmedServer({
            candidate: 'https://new.example/',
            confirmServer: async (candidate) => {
                events.push(`confirmed:${candidate}`);
                return successfulConnection;
            },
            authenticate
        });

        expect(result).toBe('session');
        expect(events).toEqual([
            'confirmed:https://new.example/',
            'authenticated:https://new.example'
        ]);
        expect(authenticate).toHaveBeenCalledWith(successfulConnection.url);
    });

    it('does not send credentials when server confirmation fails', async () => {
        const authenticate = jest.fn(async () => 'session');

        const result = await authenticateAgainstConfirmedServer({
            candidate: 'https://new.example',
            confirmServer: async () => failedConnection,
            authenticate
        });

        expect(result).toBeNull();
        expect(authenticate).not.toHaveBeenCalled();
    });
});
