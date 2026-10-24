/** @file Native server selection, origin validation, and fixed browser-origin configuration. */

import { Platform } from 'react-native';
import type { ClientConfigResponse } from '@calibrate/api-client';
import { compareClientVersions } from '@calibrate/shared/clientCompatibility';
import {
    CLIENT_SERVER_COMPATIBILITY_STATUSES,
    formatMajorVersion,
    formatMinorVersion,
    getClientServerCompatibilityMismatch,
    type ClientServerCompatibilityMismatch
} from '@calibrate/shared/releaseCompatibility';
import { CALIBRATE_HOSTED_ORIGIN } from '@calibrate/shared/product';
import release from '../../../shared/release.json';

export const HOSTED_SERVER_URL = CALIBRATE_HOSTED_ORIGIN;
const ANDROID_EMULATOR_SERVER_URL = 'http://10.0.2.2:3000';
const IOS_SIMULATOR_SERVER_URL = 'http://127.0.0.1:3000';
const LOCAL_WEB_BACKEND_PORT = '3000';
const MOBILE_API_VERSION = release.server.api.current;

const SERVER_CONNECTION_TIMEOUT_MS = 8000; // Fails quickly enough to keep sign-in setup responsive on bad LAN addresses.

export type ServerUrlResult =
    | { ok: true; url: string }
    | { ok: false; message: string };

export type ServerConnectionResult =
    | {
          ok: true;
          url: string;
          config: ClientConfigResponse;
          message: string;
      }
    | {
          ok: false;
          url: string | null;
          code: 'invalid_url' | 'unreachable' | 'not_calibrate' | 'incompatible';
          message: string;
          mismatch?: ClientServerCompatibilityMismatch;
      };

export type ServerConnectionState = {
    status: 'idle' | 'testing' | 'connected' | 'error';
    testedInput: string | null;
    testedUrl: string | null;
    message: string;
};

export const INITIAL_SERVER_CONNECTION_STATE: ServerConnectionState = {
    status: 'idle',
    testedInput: null,
    testedUrl: null,
    message: 'Test the connection before signing in.'
};

const hasExplicitScheme = (value: string): boolean => /^[a-z][a-z\d+.-]*:\/\//i.test(value);

/** Allow cleartext HTTP only for emulator, loopback, and private-network development hosts. */
export function isLocalServerHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    if (
        normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '10.0.2.2'
        || normalized === '::1'
        || normalized === '[::1]'
        || normalized.endsWith('.local')
    ) {
        return true;
    }
    if (normalized.startsWith('192.168.') || normalized.startsWith('10.')) return true;
    return /^172\.(1[6-9]|2\d|3[01])\./.test(normalized);
}

/**
 * Parse a user-entered server address into the API origin.
 *
 * Scheme-less public hosts default to HTTPS, while local development hosts default to HTTP.
 */
export function parseServerUrl(
    value: string,
    options: { allowInsecureLocalHttp?: boolean } = {}
): ServerUrlResult {
    const trimmed = value.trim();
    if (!trimmed) {
        return { ok: false, message: 'Enter a Calibrate server URL.' };
    }

    try {
        const explicitScheme = hasExplicitScheme(trimmed);
        const url = new URL(explicitScheme ? trimmed : `https://${trimmed}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return { ok: false, message: 'Use an http or https server URL.' };
        }
        if (url.username || url.password) {
            return { ok: false, message: 'Server URLs cannot include a username or password.' };
        }

        const isLocalHost = isLocalServerHostname(url.hostname);
        const allowInsecureLocalHttp = options.allowInsecureLocalHttp ?? __DEV__;
        if (!explicitScheme && isLocalHost && allowInsecureLocalHttp) {
            url.protocol = 'http:';
        }
        if (url.protocol === 'http:' && (!isLocalHost || !allowInsecureLocalHttp)) {
            return {
                ok: false,
                message: 'Use HTTPS for this server. HTTP is available only in local development builds.'
            };
        }

        return { ok: true, url: url.origin };
    } catch {
        return { ok: false, message: 'Enter a valid Calibrate server URL.' };
    }
}

/** Allow local Expo sessions on physical devices to point at a LAN backend without code edits. */
export function getConfiguredServerUrl(value = process.env.EXPO_PUBLIC_CALIBRATE_SERVER_URL): string | null {
    if (!value) return null;
    return normalizeServerUrl(value);
}

/** An explicit development target follows the active checkout instead of stale persisted server state. */
export function resolveInitialServerUrl(
    storedServerUrl: string | null,
    configuredServerUrl: string | null,
    fallbackServerUrl: string,
    isDevelopment: boolean
): string {
    if (isDevelopment && configuredServerUrl) return configuredServerUrl;
    return storedServerUrl ?? fallbackServerUrl;
}

/** Keep the Expo dev server and local API on separate ports while preserving same-origin web exports. */
export function resolveDefaultWebServerUrl(
    location: Pick<URL, 'hostname' | 'origin' | 'protocol'>,
    isDevelopment: boolean
): string {
    if (!isDevelopment || !isLocalServerHostname(location.hostname)) return location.origin;

    const backendUrl = new URL(location.origin);
    backendUrl.port = LOCAL_WEB_BACKEND_PORT;
    return backendUrl.origin;
}

/** Production web sessions are bound to the origin that served the app. */
export function resolveBrowserServerUrl(
    location: Pick<URL, 'hostname' | 'origin' | 'protocol'> | null,
    configuredServerUrl: string | null,
    isDevelopment: boolean
): string {
    if (isDevelopment && configuredServerUrl) return configuredServerUrl;
    if (location) return resolveDefaultWebServerUrl(location, isDevelopment);
    return configuredServerUrl ?? HOSTED_SERVER_URL;
}

/** Resolve simulator loopback per native platform; physical devices can use an explicit LAN URL. */
export function resolveDefaultNativeServerUrl(
    platform: string,
    configuredServerUrl: string | null,
    isDevelopment: boolean
): string {
    if (configuredServerUrl) return configuredServerUrl;
    if (!isDevelopment) return HOSTED_SERVER_URL;
    if (platform === 'android') return ANDROID_EMULATOR_SERVER_URL;
    if (platform === 'ios') return IOS_SIMULATOR_SERVER_URL;
    return HOSTED_SERVER_URL;
}

/** Default to an explicit env value, hosted production, or platform-specific simulator loopback. */
export function getDefaultServerUrl(): string {
    const configuredServerUrl = getConfiguredServerUrl();
    // Production web exports use their serving origin for HttpOnly cookie sessions.
    // Local Expo development may target a separately configured backend port.
    if (Platform.OS === 'web') {
        const location = typeof window !== 'undefined' && window.location.origin ? window.location : null;
        return resolveBrowserServerUrl(location, configuredServerUrl, __DEV__);
    }
    return resolveDefaultNativeServerUrl(Platform.OS, configuredServerUrl, __DEV__);
}

/** Normalize self-hosted server input so API calls can safely append versioned paths. */
export function normalizeServerUrl(
    value: string,
    options: { allowInsecureLocalHttp?: boolean } = {}
): string | null {
    const result = parseServerUrl(value, options);
    return result.ok ? result.url : null;
}

const isClientConfigResponse = (value: unknown): value is ClientConfigResponse => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<ClientConfigResponse>;
    return record.api_version === 1
        && Boolean(record.api_versions && Array.isArray(record.api_versions.supported))
        && typeof record.min_supported_mobile_version === 'string'
        && typeof record.min_supported_wear_version === 'string'
        && typeof record.server_version === 'string';
};

/** Check the version document before credentials or persisted server state are changed. */
export async function testCalibrateServerConnection(
    value: string,
    options: {
        fetchImpl?: typeof fetch;
        mobileVersion?: string | null;
        clientServerVersion?: string | null;
        timeoutMs?: number;
    } = {}
): Promise<ServerConnectionResult> {
    const parsed = parseServerUrl(value);
    if (!parsed.ok) {
        return { ok: false, url: null, code: 'invalid_url', message: parsed.message };
    }

    // Some browser hosts require Window to remain fetch's receiver.
    const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? SERVER_CONNECTION_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetchImpl(`${parsed.url}/api/v1/client-config`, {
            method: 'GET',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal
        });
    } catch {
        return {
            ok: false,
            url: parsed.url,
            code: 'unreachable',
            message: 'Could not reach this server. Check the address, network, and whether Calibrate is running.'
        };
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        return {
            ok: false,
            url: parsed.url,
            code: response.status === 404 ? 'not_calibrate' : 'unreachable',
            message: response.status === 404
                ? 'This server does not expose the Calibrate v1 API. Update the server and try again.'
                : `The server responded with HTTP ${response.status}. Check its Calibrate configuration.`
        };
    }

    const body = await response.json().catch(() => null);
    if (!isClientConfigResponse(body)) {
        return {
            ok: false,
            url: parsed.url,
            code: 'not_calibrate',
            message: 'The response was not a compatible Calibrate server document.'
        };
    }
    if (!body.api_versions.supported.includes(MOBILE_API_VERSION)) {
        return {
            ok: false,
            url: parsed.url,
            code: 'incompatible',
            message: 'This server does not support the Calibrate v1 mobile API.'
        };
    }

    const clientServerVersion = options.clientServerVersion;
    const mismatch = clientServerVersion
        ? getClientServerCompatibilityMismatch(clientServerVersion, body.server_version)
        : null;
    if (mismatch) {
        const clientMajorVersion = formatMajorVersion(mismatch.clientVersion) ?? mismatch.clientVersion;
        const serverMajorVersion = formatMajorVersion(mismatch.serverVersion) ?? mismatch.serverVersion;
        const clientMinorVersion = formatMinorVersion(mismatch.clientVersion) ?? mismatch.clientVersion;
        let message = `Calibrate client ${mismatch.clientVersion} is incompatible with server ${mismatch.serverVersion}.`;
        if (mismatch.status === CLIENT_SERVER_COMPATIBILITY_STATUSES.SERVER_BEHIND) {
            if (clientMajorVersion === serverMajorVersion) {
                message = `This Calibrate update requires server ${clientMinorVersion} or a newer ${clientMajorVersion} release, but this server is ${mismatch.serverVersion}. Update the server first.`;
            } else {
                message = `This Calibrate update requires server major version ${clientMajorVersion}, but this server is ${mismatch.serverVersion}. Update the server first.`;
            }
        } else if (mismatch.status === CLIENT_SERVER_COMPATIBILITY_STATUSES.CLIENT_BEHIND) {
            message = `This server requires a Calibrate client for major version ${serverMajorVersion}, but this client targets ${clientMajorVersion}. Update Calibrate first.`;
        }
        return {
            ok: false,
            url: parsed.url,
            code: 'incompatible',
            message,
            mismatch
        };
    }

    const mobileVersion = options.mobileVersion;
    const versionComparison = mobileVersion
        ? compareClientVersions(mobileVersion, body.min_supported_mobile_version)
        : null;
    if (mobileVersion && (versionComparison === null || versionComparison < 0)) {
        return {
            ok: false,
            url: parsed.url,
            code: 'incompatible',
            message: `This server requires Calibrate ${body.min_supported_mobile_version} or newer.`
        };
    }

    return {
        ok: true,
        url: parsed.url,
        config: body,
        message: `Connected to Calibrate ${body.server_version} (API v1).`
    };
}
