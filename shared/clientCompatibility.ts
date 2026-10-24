/** @file Native client identity parsing and minimum-version compatibility checks. */

import type { MobileDevicePlatform } from './domain';
export type { MobileDevicePlatform } from './domain';

export const NATIVE_CLIENT_HEADERS = {
    PLATFORM: 'x-calibrate-client-platform',
    VERSION: 'x-calibrate-client-version',
    MINIMUM_VERSION: 'x-calibrate-minimum-client-version'
} as const;

export const CLIENT_UPGRADE_REQUIRED_CODE = 'CLIENT_UPGRADE_REQUIRED';

export type NativeClientIdentity = {
    platform: MobileDevicePlatform;
    version: string;
};

export type ClientUpgradeRequirement = {
    code: typeof CLIENT_UPGRADE_REQUIRED_CODE;
    platform: MobileDevicePlatform;
    current_version: string | null;
    minimum_supported_version: string;
    message: string;
    retryable: false;
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compare the numeric SemVer core; debug/internal suffixes remain compatible with their release version. */
export function compareClientVersions(left: string, right: string): number | null {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);
    if (!leftParts || !rightParts) return null;
    for (let index = 0; index < leftParts.length; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) return difference;
    }
    return 0;
}

/** Narrow untrusted platform metadata to Android phone, iOS or Wear OS. */
export function isMobileDevicePlatform(value: unknown): value is MobileDevicePlatform {
    return value === 'android_phone' || value === 'ios' || value === 'wear_os';
}

/** Validate the complete structured upgrade response before clients act on untrusted version metadata. */
export function isClientUpgradeRequirement(value: unknown): value is ClientUpgradeRequirement {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<ClientUpgradeRequirement>;
    const currentVersionValid = record.current_version === null
        || (typeof record.current_version === 'string'
            && record.current_version.length <= 64
            && compareClientVersions(record.current_version, record.current_version) === 0);
    const minimumVersionValid = typeof record.minimum_supported_version === 'string'
        && record.minimum_supported_version.length <= 64
        && compareClientVersions(record.minimum_supported_version, record.minimum_supported_version) === 0;
    return record.code === CLIENT_UPGRADE_REQUIRED_CODE
        && isMobileDevicePlatform(record.platform)
        && currentVersionValid
        && minimumVersionValid
        && typeof record.message === 'string' && record.message.length > 0 && record.message.length <= 240
        && record.retryable === false;
}

function parseVersion(value: string): [number, number, number] | null {
    const match = value.trim().match(VERSION_PATTERN);
    if (!match) return null;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
    return parts.every(Number.isSafeInteger) ? parts : null;
}
