/** @file Deterministic development-session eligibility restricted to trusted local backend origins. */

import {
    ApiError,
    type BrowserAuthResponse,
    type CalibrateApiClient
} from '@calibrate/api-client';
import { isLocalServerHostname } from '../config/server';

export const DEV_TEST_EMAIL = 'test@calibratehealth.app';
export const DEV_TEST_PASSWORD = 'password123';

/** Keep deterministic test credentials confined to local development servers. */
export function shouldDevAutoLogin(
    serverUrl: string,
    isDevelopment = __DEV__,
    isEnabled = process.env.EXPO_PUBLIC_CALIBRATE_AUTO_LOGIN_TEST_USER !== 'false'
): boolean {
    if (!isDevelopment || !isEnabled) return false;

    try {
        return isLocalServerHostname(new URL(serverUrl).hostname);
    } catch {
        return false;
    }
}

type BrowserSessionClient = Pick<CalibrateApiClient, 'getMe' | 'loginBrowser'>;

// Cover the normal backend/Prisma startup window without leaving the auth shell waiting indefinitely.
const DEV_SESSION_RETRY_DELAYS_MS = [250, 500, 750, 1_000, 1_000, 1_000, 1_000] as const;

type BrowserDevelopmentSessionOptions = {
    isDevelopment?: boolean;
    retryDelaysMs?: readonly number[];
    wait?: (delayMs: number) => Promise<void>;
};

function isTransientSessionBootstrapError(error: unknown): boolean {
    if (!(error instanceof ApiError)) return true;
    return error.status === 408 || error.status === 429 || error.status >= 500;
}

/** Restore a cookie session, falling back to the seeded user only after a local dev 401. */
export async function restoreBrowserDevelopmentSession(
    api: BrowserSessionClient,
    serverUrl: string,
    options: BrowserDevelopmentSessionOptions = {}
): Promise<BrowserAuthResponse> {
    const isDevelopment = options.isDevelopment ?? __DEV__;
    const canUseSeededUser = shouldDevAutoLogin(serverUrl, isDevelopment);
    const retryDelaysMs = options.retryDelaysMs ?? DEV_SESSION_RETRY_DELAYS_MS;
    const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    }));

    for (let attempt = 0; ; attempt += 1) {
        try {
            try {
                return await api.getMe();
            } catch (error) {
                if (!(error instanceof ApiError) || error.status !== 401 || !canUseSeededUser) {
                    throw error;
                }

                return await api.loginBrowser({
                    email: DEV_TEST_EMAIL,
                    password: DEV_TEST_PASSWORD
                });
            }
        } catch (error) {
            const retryDelay = retryDelaysMs[attempt];
            if (!canUseSeededUser || retryDelay === undefined || !isTransientSessionBootstrapError(error)) {
                throw error;
            }
            await wait(retryDelay);
        }
    }
}
