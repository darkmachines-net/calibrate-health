/** @file storage Scope: Canonicalize a Calibrate origin before using it as a consent/checkpoint namespace. */

/** Canonicalize a Calibrate origin before using it as a consent/checkpoint namespace. */
export function canonicalHealthConnectServerIdentity(serverUrl: string): string {
    try {
        const url = new URL(serverUrl);
        return url.origin.toLowerCase();
    } catch {
        return serverUrl.trim().replace(/\/+$/, '').toLowerCase();
    }
}
/** Combines canonical server identity and account ID into an isolated Health Connect storage scope. */
export function healthConnectAccountScope(serverUrl: string, userId: number): string {
    return `${encodeURIComponent(canonicalHealthConnectServerIdentity(serverUrl))}/${userId}`;
}
