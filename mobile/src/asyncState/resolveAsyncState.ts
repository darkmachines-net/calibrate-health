/** @file resolve Async State: Resolve one query into exactly one presentation state. Cached empty data is never treated as a verified empty result after a failure or while offline. */

export const ASYNC_RESOURCE_STATES = {
    LOADING: 'loading',
    CONTENT: 'content',
    EMPTY: 'empty',
    ERROR: 'error',
    STALE: 'stale',
    DEGRADED: 'degraded'
} as const;

type AsyncResourceStateKind = typeof ASYNC_RESOURCE_STATES[keyof typeof ASYNC_RESOURCE_STATES];

export type AsyncQuerySnapshot<T> = {
    data: T | undefined;
    status: 'pending' | 'error' | 'success';
    fetchStatus?: 'fetching' | 'paused' | 'idle';
    error?: unknown;
    dataUpdatedAt?: number;
    isPlaceholderData?: boolean;
};

export type AsyncResourceState = {
    kind: AsyncResourceStateKind;
    error: unknown | null;
    /** Distinguishes an uncached connection pause from an ordinary request failure. */
    terminalReason?: 'offline';
};

type ResolveAsyncResourceStateOptions<T> = {
    isEmpty(data: T): boolean;
    isOnline?: boolean;
};

/**
 * Resolve one query into exactly one presentation state. Cached empty data is
 * never treated as a verified empty result after a failure or while offline.
 */
export function resolveAsyncResourceState<T>(
    query: AsyncQuerySnapshot<T>,
    { isEmpty, isOnline = true }: ResolveAsyncResourceStateOptions<T>
): AsyncResourceState {
    const hasNonEmptyData = query.data !== undefined && !isEmpty(query.data);
    const hasUsableData = !query.isPlaceholderData && hasNonEmptyData && (
        query.status === 'success' || (query.dataUpdatedAt ?? 0) > 0
    );
    const hasVerifiedEmpty = !query.isPlaceholderData
        && query.status === 'success'
        && query.data !== undefined
        && isEmpty(query.data);
    const isOffline = !isOnline || query.fetchStatus === 'paused';
    const hasFailed = query.status === 'error' || query.error != null;

    if (hasUsableData && isOffline) {
        return { kind: ASYNC_RESOURCE_STATES.STALE, error: query.error ?? null };
    }
    if (hasUsableData && hasFailed) {
        return { kind: ASYNC_RESOURCE_STATES.DEGRADED, error: query.error ?? null };
    }
    if (!hasUsableData && query.status === 'pending' && !isOffline) {
        return { kind: ASYNC_RESOURCE_STATES.LOADING, error: null };
    }
    if (!hasUsableData && isOffline) {
        return {
            kind: ASYNC_RESOURCE_STATES.ERROR,
            error: query.error ?? null,
            terminalReason: 'offline'
        };
    }
    if (!hasUsableData && hasFailed) {
        return { kind: ASYNC_RESOURCE_STATES.ERROR, error: query.error ?? null };
    }
    if (hasVerifiedEmpty) {
        return { kind: ASYNC_RESOURCE_STATES.EMPTY, error: null };
    }
    if (hasUsableData) {
        return { kind: ASYNC_RESOURCE_STATES.CONTENT, error: null };
    }

    return { kind: ASYNC_RESOURCE_STATES.LOADING, error: null };
}

/** Uses null as the empty-resource predicate for asynchronous query presentation. */
export const isNullResource = <T>(value: T | null): boolean => value === null;
/** Keeps resources with valid data out of the empty-state branch regardless of their value. */
export const isNeverEmpty = (): false => false;
