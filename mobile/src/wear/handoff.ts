/** @file Lazy native Wear handoffs with allowlisted destinations and pairing context checks. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Href } from 'expo-router';
import type { WearPairingMessage } from '@calibrate/wear-pairing';
import {
    readStoredWearPairing,
    WEAR_PAIRING_PATHS,
    WEAR_PAIRING_PROTOCOL_VERSION,
    type StoredWearPairing
} from './pairing';

const HANDOFF_STORAGE_PREFIX = '@calibrate/wear/handoffs/v1';
const MAX_PENDING_HANDOFFS = 10;
const MAX_MESSAGE_ID_LENGTH = 128;
const MAX_NODE_ID_LENGTH = 256;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type WearHandoff = {
    messageId: string;
    nodeId: string;
    serverOrigin: string;
    userId: number;
    destination: 'food_log' | 'privacy' | 'account_deletion';
    localDate: string | null;
    receivedAt: number;
};

type WearHandoffPayload = Pick<WearHandoff, 'serverOrigin' | 'userId' | 'destination' | 'localDate'>;

type WearInboxTransport = {
    listMessages(): WearPairingMessage[];
    acknowledgeMessages(messageIds: string[]): void;
};

type HandoffStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

/** Resolve lazily so Expo Go, web, and Jest never require the Android bridge. */
function getNativeTransport(): WearInboxTransport | null {
    try {
        return (require('@calibrate/wear-pairing') as { default?: WearInboxTransport | null }).default ?? null;
    } catch {
        return null;
    }
}

function canonicalOrigin(value: string): string | null {
    try {
        const origin = new URL(value).origin;
        return origin === value ? origin : null;
    } catch {
        return null;
    }
}

function accountScope(serverOrigin: string, userId: number): string {
    return `${encodeURIComponent(new URL(serverOrigin).origin)}/${userId}`;
}

function storageKey(serverOrigin: string, userId: number): string {
    return `${HANDOFF_STORAGE_PREFIX}/${accountScope(serverOrigin, userId)}`;
}

function isDateOnly(value: unknown): value is string {
    if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

/** Reject extra keys so future watch payload changes require an explicit phone upgrade. */
export function parseWearHandoffPayload(payload: string): WearHandoffPayload | null {
    try {
        const parsed = JSON.parse(payload) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const value = parsed as Record<string, unknown>;
        const baseKeys = ['protocol_version', 'server_origin', 'user_id', 'destination'];
        const allowedKeys = new Set([...baseKeys, 'local_date']);
        if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
        if (value.protocol_version !== WEAR_PAIRING_PROTOCOL_VERSION) return null;
        if (!Number.isSafeInteger(value.user_id) || (value.user_id as number) <= 0) return null;
        if (typeof value.server_origin !== 'string') return null;
        const serverOrigin = canonicalOrigin(value.server_origin);
        if (!serverOrigin) return null;
        const expectedKeys = value.destination === 'food_log' ? [...baseKeys, 'local_date'] : baseKeys;
        if (Object.keys(value).length !== expectedKeys.length) return null;
        if (expectedKeys.some((key) => !(key in value))) return null;
        if (value.destination === 'food_log') {
            if (!isDateOnly(value.local_date)) return null;
            return {
                serverOrigin,
                userId: value.user_id as number,
                destination: 'food_log',
                localDate: value.local_date
            };
        }
        if (value.destination !== 'privacy' && value.destination !== 'account_deletion') return null;
        return {
            serverOrigin,
            userId: value.user_id as number,
            destination: value.destination,
            localDate: null
        };
    } catch {
        return null;
    }
}

function isStoredHandoff(value: unknown, serverOrigin: string, userId: number): value is WearHandoff {
    if (!value || typeof value !== 'object') return false;
    const handoff = value as Partial<WearHandoff>;
    return typeof handoff.messageId === 'string' && handoff.messageId.length >= 1 &&
        handoff.messageId.length <= MAX_MESSAGE_ID_LENGTH
        && typeof handoff.nodeId === 'string' && handoff.nodeId.length >= 1 &&
        handoff.nodeId.length <= MAX_NODE_ID_LENGTH
        && handoff.serverOrigin === serverOrigin
        && handoff.userId === userId
        && (
            (handoff.destination === 'food_log' && isDateOnly(handoff.localDate)) ||
            ((handoff.destination === 'privacy' || handoff.destination === 'account_deletion') &&
                handoff.localDate === null)
        )
        && typeof handoff.receivedAt === 'number' && Number.isFinite(handoff.receivedAt) && handoff.receivedAt > 0;
}

async function readPendingHandoffs(
    serverOrigin: string,
    userId: number,
    storage: HandoffStorage = AsyncStorage
): Promise<WearHandoff[]> {
    const key = storageKey(serverOrigin, userId);
    const raw = await storage.getItem(key);
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        await storage.removeItem(key);
        return [];
    }
    if (!Array.isArray(parsed)) {
        await storage.removeItem(key);
        return [];
    }
    const handoffs = parsed.filter((value): value is WearHandoff =>
        isStoredHandoff(value, serverOrigin, userId)
    );
    if (handoffs.length !== parsed.length) {
        if (handoffs.length === 0) await storage.removeItem(key);
        else await storage.setItem(key, JSON.stringify(handoffs));
    }
    return handoffs;
}

/** Reads pending watch handoffs scoped to the normalized server origin and account. */
export async function getPendingWearHandoffs(
    serverOrigin: string,
    userId: number
): Promise<WearHandoff[]> {
    const origin = new URL(serverOrigin).origin;
    return readPendingHandoffs(origin, userId);
}

/** Removes handled watch message IDs from account-scoped storage, deleting the key when empty. */
export async function markWearHandoffsHandled(
    serverOrigin: string,
    userId: number,
    messageIds: string[]
): Promise<void> {
    const origin = new URL(serverOrigin).origin;
    const handled = new Set(messageIds);
    const remaining = (await readPendingHandoffs(origin, userId))
        .filter((handoff) => !handled.has(handoff.messageId));
    const key = storageKey(origin, userId);
    if (remaining.length === 0) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, JSON.stringify(remaining));
}

/**
 * Route one distinct intent at a time while coalescing repeated taps for that same destination.
 * This prevents a later legal handoff from discarding an earlier food-log request (and vice versa).
 */
export function selectNextWearHandoffBatch(handoffs: WearHandoff[]): {
    handoff: WearHandoff;
    messageIds: string[];
} | null {
    if (handoffs.length === 0) return null;
    const handoff = handoffs.reduce((earliest, candidate) => {
        if (candidate.receivedAt < earliest.receivedAt) return candidate;
        if (candidate.receivedAt === earliest.receivedAt && candidate.messageId < earliest.messageId) return candidate;
        return earliest;
    });
    const messageIds = handoffs
        .filter((candidate) =>
            candidate.destination === handoff.destination && candidate.localDate === handoff.localDate
        )
        .map(({ messageId }) => messageId);
    return { handoff, messageIds };
}

/** Remove account-scoped phone handoffs during account deletion or explicit unpairing. */
export async function clearWearHandoffStorage(serverOrigin: string, userId: number): Promise<void> {
    await AsyncStorage.removeItem(storageKey(new URL(serverOrigin).origin, userId));
}

/**
 * Correlate handoffs with the current account's durable pairing, persist them,
 * and only then acknowledge the native inbox entries.
 */
export async function processWearHandoffInbox(options: {
    serverOrigin: string;
    userId: number;
    transport?: WearInboxTransport | null;
    storage?: HandoffStorage;
    readPairing?: (serverOrigin: string, userId: number) => Promise<StoredWearPairing | null>;
}): Promise<{ persisted: number; errors: string[] }> {
    const transport = options.transport === undefined ? getNativeTransport() : options.transport;
    if (!transport) return { persisted: 0, errors: [] };
    const storage = options.storage ?? AsyncStorage;
    const origin = new URL(options.serverOrigin).origin;
    const pairing = await (options.readPairing ?? readStoredWearPairing)(origin, options.userId);
    const existing = await readPendingHandoffs(origin, options.userId, storage);
    const byMessageId = new Map(existing.map((handoff) => [handoff.messageId, handoff]));
    const acknowledge: string[] = [];
    const errors: string[] = [];
    let persisted = 0;

    for (const message of transport.listMessages()) {
        if (message.path !== WEAR_PAIRING_PATHS.CONTINUE_ON_PHONE) continue;
        const payload = parseWearHandoffPayload(message.payload);
        if (!payload) {
            errors.push('A watch sent an unsupported phone handoff.');
            acknowledge.push(message.id);
            continue;
        }
        // A valid handoff for another signed-in scope remains durable in the native inbox.
        if (payload.serverOrigin !== origin || payload.userId !== options.userId || !pairing) continue;
        if (message.nodeId !== pairing.nodeId) {
            errors.push('A phone handoff came from a watch that is not paired to this account.');
            acknowledge.push(message.id);
            continue;
        }
        if (
            typeof message.id !== 'string' || message.id.length < 1 || message.id.length > MAX_MESSAGE_ID_LENGTH ||
            typeof message.receivedAt !== 'number' || !Number.isFinite(message.receivedAt) || message.receivedAt <= 0
        ) {
            errors.push('A watch sent invalid phone handoff metadata.');
            acknowledge.push(message.id);
            continue;
        }
        if (!byMessageId.has(message.id)) {
            byMessageId.set(message.id, {
                messageId: message.id,
                nodeId: message.nodeId,
                ...payload,
                receivedAt: message.receivedAt
            });
            persisted += 1;
        }
        acknowledge.push(message.id);
    }

    if (persisted > 0) {
        const bounded = [...byMessageId.values()]
            .sort((left, right) => left.receivedAt - right.receivedAt)
            .slice(-MAX_PENDING_HANDOFFS);
        await storage.setItem(storageKey(origin, options.userId), JSON.stringify(bounded));
    }
    // If the durable write throws, execution never reaches this acknowledgement.
    transport.acknowledgeMessages(acknowledge);
    return { persisted, errors };
}

/** Maps a dated food-log handoff to its app route, returning null for unsupported destinations. */
export function getWearHandoffHref(handoff: WearHandoff): Href | null {
    if (handoff.destination !== 'food_log' || handoff.localDate === null) return null;
    return {
        pathname: '/log',
        params: { date: handoff.localDate }
    };
}

/** Legal handoffs are restricted to fixed public paths on the already-bound account server. */
export function getWearHandoffPublicUrl(handoff: WearHandoff): string | null {
    if (handoff.destination === 'privacy') return `${handoff.serverOrigin}/privacy`;
    if (handoff.destination === 'account_deletion') return `${handoff.serverOrigin}/account-deletion`;
    return null;
}
