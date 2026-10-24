/** @file Barcode camera, permission, lookup, and manual-entry state transitions. */

export const BARCODE_PERMISSION_STATES = {
    CHECKING: 'checking',
    FIRST_REQUEST: 'first-request',
    DENIED: 'denied',
    PERMANENTLY_DENIED: 'permanently-denied',
    UNAVAILABLE: 'unavailable',
    GRANTED: 'granted'
} as const;

export type BarcodePermissionState =
    (typeof BARCODE_PERMISSION_STATES)[keyof typeof BARCODE_PERMISSION_STATES];

export type BarcodePermissionSnapshot = {
    permission: { granted: boolean; canAskAgain: boolean } | null;
    hasRequestedPermission: boolean;
    isCameraAvailable?: boolean | null;
};

/** Resolve camera capability separately from permission so manual entry is always reachable. */
export function resolveBarcodePermissionState(
    snapshot: BarcodePermissionSnapshot
): BarcodePermissionState {
    if (snapshot.isCameraAvailable === false) return BARCODE_PERMISSION_STATES.UNAVAILABLE;
    if (!snapshot.permission) return BARCODE_PERMISSION_STATES.CHECKING;
    if (snapshot.permission.granted) return BARCODE_PERMISSION_STATES.GRANTED;
    if (!snapshot.permission.canAskAgain) return BARCODE_PERMISSION_STATES.PERMANENTLY_DENIED;
    if (!snapshot.hasRequestedPermission) return BARCODE_PERMISSION_STATES.FIRST_REQUEST;
    return BARCODE_PERMISSION_STATES.DENIED;
}

export const BARCODE_LOOKUP_STATES = {
    IDLE: 'idle',
    SEARCHING: 'searching',
    RESULT: 'result',
    NO_RESULT: 'no-result',
    OFFLINE: 'offline',
    AUTH_REQUIRED: 'auth-required',
    ERROR: 'error'
} as const;

type BarcodeLookupFailureKind =
    | 'offline'
    | 'authentication'
    | 'rate-limited'
    | 'provider-unavailable'
    | 'unknown';

export type BarcodeLookupFailure = {
    kind: BarcodeLookupFailureKind;
    message: string;
    canRetry: boolean;
};

export type BarcodeLookupState =
    | { kind: typeof BARCODE_LOOKUP_STATES.IDLE }
    | { kind: typeof BARCODE_LOOKUP_STATES.SEARCHING; barcode: string }
    | { kind: typeof BARCODE_LOOKUP_STATES.RESULT; barcode: string; resultCount: number }
    | { kind: typeof BARCODE_LOOKUP_STATES.NO_RESULT; barcode: string }
    | { kind: typeof BARCODE_LOOKUP_STATES.OFFLINE; barcode: string; failure: BarcodeLookupFailure }
    | { kind: typeof BARCODE_LOOKUP_STATES.AUTH_REQUIRED; barcode: string; failure: BarcodeLookupFailure }
    | { kind: typeof BARCODE_LOOKUP_STATES.ERROR; barcode: string; failure: BarcodeLookupFailure };

export type BarcodeLookupSnapshot = {
    barcode: string | null;
    isOnline: boolean;
    status: 'idle' | 'pending' | 'success' | 'error';
    resultCount: number;
    error?: unknown;
    fetchStatus?: 'fetching' | 'paused' | 'idle';
};

function errorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return null;
    const responseStatus = (response as { status?: unknown }).status;
    return typeof responseStatus === 'number' && Number.isFinite(responseStatus)
        ? responseStatus
        : null;
}

function looksLikeConnectivityFailure(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    const message = error instanceof Error ? error.message : '';
    return /network|fetch|timed out|connect|offline/i.test(message);
}

/** Classify provider/transport failures without ever returning gateway or exception text. */
export function getBarcodeLookupFailure(
    error: unknown,
    options: { isOnline?: boolean } = {}
): BarcodeLookupFailure {
    if (options.isOnline === false) {
        return {
            kind: 'offline',
            message: 'Connect to the internet to look up this barcode.',
            canRetry: false
        };
    }
    if (looksLikeConnectivityFailure(error)) {
        return {
            kind: 'offline',
            message: 'Barcode lookup could not reach food providers. Check your connection and try again.',
            canRetry: true
        };
    }

    const status = errorStatus(error);
    if (status === 401) {
        return {
            kind: 'authentication',
            message: 'Your session expired. Sign in again to continue.',
            canRetry: false
        };
    }
    if (status === 429) {
        return {
            kind: 'rate-limited',
            message: 'Too many barcode lookups were sent. Try again shortly.',
            canRetry: true
        };
    }
    if (status !== null && status >= 500) {
        return {
            kind: 'provider-unavailable',
            message: 'Food providers are unavailable right now. Try again in a moment.',
            canRetry: true
        };
    }
    return {
        kind: 'unknown',
        message: 'Barcode lookup failed. Try again or use Search foods.',
        canRetry: true
    };
}

/** Resolve exactly one lookup state, keeping verified results usable after connectivity changes. */
export function resolveBarcodeLookupState(snapshot: BarcodeLookupSnapshot): BarcodeLookupState {
    if (!snapshot.barcode) return { kind: BARCODE_LOOKUP_STATES.IDLE };
    const barcode = snapshot.barcode;
    if (snapshot.status === 'success' && snapshot.resultCount > 0) {
        return { kind: BARCODE_LOOKUP_STATES.RESULT, barcode, resultCount: snapshot.resultCount };
    }
    if (!snapshot.isOnline || snapshot.fetchStatus === 'paused') {
        return {
            kind: BARCODE_LOOKUP_STATES.OFFLINE,
            barcode,
            failure: getBarcodeLookupFailure(snapshot.error, { isOnline: false })
        };
    }
    if (snapshot.status === 'pending') {
        return { kind: BARCODE_LOOKUP_STATES.SEARCHING, barcode };
    }
    if (snapshot.status === 'error') {
        const failure = getBarcodeLookupFailure(snapshot.error, { isOnline: snapshot.isOnline });
        if (failure.kind === 'offline') {
            return { kind: BARCODE_LOOKUP_STATES.OFFLINE, barcode, failure };
        }
        if (failure.kind === 'authentication') {
            return { kind: BARCODE_LOOKUP_STATES.AUTH_REQUIRED, barcode, failure };
        }
        return { kind: BARCODE_LOOKUP_STATES.ERROR, barcode, failure };
    }
    if (snapshot.status === 'success') {
        return { kind: BARCODE_LOOKUP_STATES.NO_RESULT, barcode };
    }
    return { kind: BARCODE_LOOKUP_STATES.IDLE };
}
