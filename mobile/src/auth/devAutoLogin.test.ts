/** @file Regression coverage for dev Auto Login: development auto-login. */

import { ApiError } from '@calibrate/api-client';
import {
    DEV_TEST_EMAIL,
    DEV_TEST_PASSWORD,
    restoreBrowserDevelopmentSession,
    shouldDevAutoLogin
} from './devAutoLogin';

describe('development auto-login', () => {
    it('allows only development servers on local or private-network hosts', () => {
        expect(shouldDevAutoLogin('http://localhost:3000', true)).toBe(true);
        expect(shouldDevAutoLogin('http://10.0.2.2:3000', true)).toBe(true);
        expect(shouldDevAutoLogin('http://192.168.1.20:3000', true)).toBe(true);
        expect(shouldDevAutoLogin('https://calibratehealth.app', true)).toBe(false);
        expect(shouldDevAutoLogin('http://localhost:3000', false)).toBe(false);
        expect(shouldDevAutoLogin('http://localhost:3000', true, false)).toBe(false);
        expect(shouldDevAutoLogin('not a URL', true)).toBe(false);
    });

    it('keeps an existing browser session without submitting test credentials', async () => {
        const payload = { user: { id: 7 } } as never;
        const api = {
            getMe: jest.fn(async () => payload),
            loginBrowser: jest.fn()
        };

        await expect(restoreBrowserDevelopmentSession(api, 'http://localhost:3000', {
            isDevelopment: true
        }))
            .resolves.toBe(payload);
        expect(api.loginBrowser).not.toHaveBeenCalled();
    });

    it('logs into the seeded user after a local development 401', async () => {
        const payload = { user: { id: 7 } } as never;
        const api = {
            getMe: jest.fn(async () => {
                throw new ApiError('Not authenticated', 401, null);
            }),
            loginBrowser: jest.fn(async () => payload)
        };

        await expect(restoreBrowserDevelopmentSession(api, 'http://localhost:3000', {
            isDevelopment: true
        }))
            .resolves.toBe(payload);
        expect(api.loginBrowser).toHaveBeenCalledWith({
            email: DEV_TEST_EMAIL,
            password: DEV_TEST_PASSWORD
        });
    });

    it.each([
        ['a production build', 'http://localhost:3000', false],
        ['a remote server', 'https://calibratehealth.app', true]
    ])('does not submit test credentials to %s', async (_label, serverUrl, isDevelopment) => {
        const api = {
            getMe: jest.fn(async () => {
                throw new ApiError('Not authenticated', 401, null);
            }),
            loginBrowser: jest.fn()
        };

        await expect(restoreBrowserDevelopmentSession(api, serverUrl, { isDevelopment }))
            .rejects.toMatchObject({ status: 401 });
        expect(api.loginBrowser).not.toHaveBeenCalled();
    });

    it('waits for a local backend to become ready before restoring the seeded session', async () => {
        const payload = { user: { id: 7 } } as never;
        const getMe = jest.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockRejectedValueOnce(new ApiError('Starting', 503, null))
            .mockRejectedValueOnce(new ApiError('Not authenticated', 401, null));
        const api = {
            getMe,
            loginBrowser: jest.fn(async () => payload)
        };
        const wait = jest.fn(async () => undefined);

        await expect(restoreBrowserDevelopmentSession(api, 'http://localhost:3000', {
            isDevelopment: true,
            retryDelaysMs: [10, 20, 30],
            wait
        })).resolves.toBe(payload);
        expect(wait).toHaveBeenNthCalledWith(1, 10);
        expect(wait).toHaveBeenNthCalledWith(2, 20);
        expect(api.loginBrowser).toHaveBeenCalledTimes(1);
    });

    it('does not retry invalid seeded credentials', async () => {
        const api = {
            getMe: jest.fn(async () => {
                throw new ApiError('Not authenticated', 401, null);
            }),
            loginBrowser: jest.fn(async () => {
                throw new ApiError('Invalid email or password', 401, null);
            })
        };
        const wait = jest.fn(async () => undefined);

        await expect(restoreBrowserDevelopmentSession(api, 'http://localhost:3000', {
            isDevelopment: true,
            retryDelaysMs: [10],
            wait
        })).rejects.toMatchObject({ status: 401 });
        expect(wait).not.toHaveBeenCalled();
    });
});
