/** @file Runtime client/server compatibility policy using independent native and server release identities. */

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const CLIENT_SERVER_COMPATIBILITY_STATUSES = {
    COMPATIBLE: 'compatible',
    CLIENT_BEHIND: 'client_behind',
    SERVER_BEHIND: 'server_behind',
    INVALID: 'invalid'
} as const;

export type ClientServerCompatibilityStatus =
    (typeof CLIENT_SERVER_COMPATIBILITY_STATUSES)[keyof typeof CLIENT_SERVER_COMPATIBILITY_STATUSES];

export type ClientServerCompatibilityMismatch = {
    clientVersion: string;
    serverVersion: string;
    status: Exclude<ClientServerCompatibilityStatus, 'compatible'>;
};

type CompatibilityVersion = readonly [major: string, minor: string];

function parseCompatibilityVersion(version: unknown): CompatibilityVersion | null {
    if (typeof version !== 'string') return null;
    const match = version.match(SEMVER_PATTERN);
    if (!match) return null;
    return [match[1], match[2]];
}

function compareNumericIdentifier(left: string, right: string): number {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function versionLabel(version: unknown): string {
    if (typeof version !== 'string') return 'unknown';
    if (!parseCompatibilityVersion(version) || version.length > 64) return 'invalid';
    return version;
}

/**
 * Compare client and server compatibility. Major versions must match; within
 * one major, the server minor must be at least the client minor.
 */
export function compareClientServerCompatibility(
    clientVersion: unknown,
    serverVersion: unknown
): ClientServerCompatibilityStatus {
    const client = parseCompatibilityVersion(clientVersion);
    const server = parseCompatibilityVersion(serverVersion);
    if (!client || !server) return CLIENT_SERVER_COMPATIBILITY_STATUSES.INVALID;

    const majorComparison = compareNumericIdentifier(client[0], server[0]);
    if (majorComparison < 0) return CLIENT_SERVER_COMPATIBILITY_STATUSES.CLIENT_BEHIND;
    if (majorComparison > 0) return CLIENT_SERVER_COMPATIBILITY_STATUSES.SERVER_BEHIND;

    const minorComparison = compareNumericIdentifier(client[1], server[1]);
    if (minorComparison > 0) return CLIENT_SERVER_COMPATIBILITY_STATUSES.SERVER_BEHIND;
    return CLIENT_SERVER_COMPATIBILITY_STATUSES.COMPATIBLE;
}

/** Return an actionable mismatch description, or null when the running bundle and server contract are compatible. */
export function getClientServerCompatibilityMismatch(
    clientVersion: unknown,
    serverVersion: unknown
): ClientServerCompatibilityMismatch | null {
    const status = compareClientServerCompatibility(clientVersion, serverVersion);
    if (status === CLIENT_SERVER_COMPATIBILITY_STATUSES.COMPATIBLE) return null;
    return {
        clientVersion: versionLabel(clientVersion),
        serverVersion: versionLabel(serverVersion),
        status
    };
}

/** Format a parseable version's major compatibility line, returning null for invalid metadata. */
export function formatMajorVersion(version: unknown): string | null {
    const parsedVersion = parseCompatibilityVersion(version);
    return parsedVersion ? `${parsedVersion[0]}.x` : null;
}

/** Format a parseable version's major/minor compatibility line without patch precision. */
export function formatMinorVersion(version: unknown): string | null {
    const parsedVersion = parseCompatibilityVersion(version);
    return parsedVersion ? `${parsedVersion[0]}.${parsedVersion[1]}.x` : null;
}
