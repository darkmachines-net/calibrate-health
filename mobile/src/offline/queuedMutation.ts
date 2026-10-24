/** @file Lossless queued request serialization and stable mutation identity validation. */

export const OUTBOX_MUTATION_STATES = {
    PENDING: 'pending',
    REPLAYING: 'replaying',
    FAILED: 'failed'
} as const;

export type OutboxMutationState = typeof OUTBOX_MUTATION_STATES[keyof typeof OUTBOX_MUTATION_STATES];

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type QueuedMutation = {
    sequence: number;
    id: string;
    namespace: string;
    operation: string;
    payload: JsonValue;
    state: OutboxMutationState;
    attemptCount: number;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
};

export type NewQueuedMutation = {
    id?: string;
    operation: string;
    payload: unknown;
};

function assertJsonValue(value: unknown, ancestors: Set<object>): asserts value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (Number.isFinite(value)) return;
        throw new Error('Queued mutation payload numbers must be finite.');
    }
    if (typeof value !== 'object') {
        throw new Error('Queued mutation payload must contain only JSON values.');
    }
    if (ancestors.has(value)) {
        throw new Error('Queued mutation payload cannot contain circular references.');
    }

    ancestors.add(value);
    if (Array.isArray(value)) {
        value.forEach((item) => assertJsonValue(item, ancestors));
    } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error('Queued mutation payload objects must be plain JSON objects.');
        }
        Object.values(value).forEach((item) => assertJsonValue(item, ancestors));
    }
    ancestors.delete(value);
}

/** Serializes only lossless JSON so a replay sees exactly what the user queued. */
export function serializeMutationPayload(payload: unknown): string {
    assertJsonValue(payload, new Set());
    return JSON.stringify(payload);
}

/** Parses and validates stored JSON mutation data, rejecting unsupported values before replay. */
export function parseMutationPayload(serialized: string): JsonValue {
    const payload: unknown = JSON.parse(serialized);
    assertJsonValue(payload, new Set());
    return payload;
}

/** Keeps offline writes isolated when one installation changes account or server. */
export function createOutboxNamespace(serverUrl: string, userId: string | number): string {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Outbox namespaces require an http or https server URL.');
    }

    const normalizedUserId = String(userId).trim();
    if (!normalizedUserId) {
        throw new Error('Outbox namespaces require an authenticated user ID.');
    }

    return `${url.origin.toLowerCase()}::user:${encodeURIComponent(normalizedUserId)}`;
}
