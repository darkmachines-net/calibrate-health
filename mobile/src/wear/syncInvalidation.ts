/** @file Serialized phone-to-watch invalidation delivery that preserves newer pending account state. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
    readStoredWearPairing,
    WEAR_PAIRING_PATHS,
    WEAR_PAIRING_PROTOCOL_VERSION,
    type StoredWearPairing
} from './pairing';

const STORAGE_PREFIX = '@calibrate/wear/sync-invalidation/v1';
const INVALIDATION_TTL_MS = 10 * 60 * 1000;
const MAX_IDENTIFIER_LENGTH = 256;

type SyncInvalidationTransport = {
    sendMessage(nodeId: string, path: string, payload: string): Promise<number>;
};

type PendingWearSyncInvalidation = {
    invalidationId: string;
    nodeId: string;
    serverOrigin: string;
    userId: number;
    watchDeviceId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
};

export type WearSyncInvalidationResult = {
    status: 'sent' | 'pending' | 'unpaired' | 'unavailable';
    invalidationId: string | null;
};

type PairingReader = (serverOrigin: string, userId: number) => Promise<StoredWearPairing | null>;
type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

let serialWork: Promise<void> = Promise.resolve();

/** Serialize replacement/removal so a slower send cannot erase a newer level-triggered invalidation. */
function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = serialWork.then(work, work);
    serialWork = result.then(() => undefined, () => undefined);
    return result;
}

function nativeTransport(): SyncInvalidationTransport | null {
    try {
        return (require('@calibrate/wear-pairing') as { default?: SyncInvalidationTransport | null }).default ?? null;
    } catch {
        return null;
    }
}

function canonicalOrigin(value: string): string {
    const origin = new URL(value).origin;
    if (origin !== value) throw new Error('Wear sync invalidation requires a canonical server origin.');
    return origin;
}

function storageKey(serverOrigin: string, userId: number): string {
    return `${STORAGE_PREFIX}/${encodeURIComponent(serverOrigin)}/${userId}`;
}

function boundedText(value: unknown, maximum: number = MAX_IDENTIFIER_LENGTH): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function validPending(value: unknown, origin: string, userId: number): value is PendingWearSyncInvalidation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const pending = value as Partial<PendingWearSyncInvalidation>;
    return boundedText(pending.invalidationId, 128)
        && boundedText(pending.nodeId)
        && pending.serverOrigin === origin
        && pending.userId === userId
        && boundedText(pending.watchDeviceId, 128)
        && typeof pending.issuedAtEpochMs === 'number'
        && Number.isSafeInteger(pending.issuedAtEpochMs)
        && typeof pending.expiresAtEpochMs === 'number'
        && Number.isSafeInteger(pending.expiresAtEpochMs)
        && pending.issuedAtEpochMs > 0
        && pending.expiresAtEpochMs > pending.issuedAtEpochMs
        && pending.expiresAtEpochMs - pending.issuedAtEpochMs <= INVALIDATION_TTL_MS;
}

async function readPending(
    origin: string,
    userId: number,
    storage: Storage
): Promise<PendingWearSyncInvalidation | null> {
    const key = storageKey(origin, userId);
    const encoded = await storage.getItem(key);
    if (!encoded) return null;
    try {
        const value = JSON.parse(encoded) as unknown;
        if (validPending(value, origin, userId)) return value;
    } catch {
        // Invalid local coordination state is removed below and never sent.
    }
    await storage.removeItem(key);
    return null;
}

function payload(pending: PendingWearSyncInvalidation): string {
    return JSON.stringify({
        kind: 'sync_invalidation',
        protocol_version: WEAR_PAIRING_PROTOCOL_VERSION,
        invalidation_id: pending.invalidationId,
        server_origin: pending.serverOrigin,
        user_id: pending.userId,
        watch_device_id: pending.watchDeviceId,
        issued_at_epoch_ms: pending.issuedAtEpochMs,
        expires_at_epoch_ms: pending.expiresAtEpochMs
    });
}

function stillMatchesPairing(pending: PendingWearSyncInvalidation, pairing: StoredWearPairing): boolean {
    return pending.nodeId === pairing.nodeId
        && pending.serverOrigin === pairing.serverOrigin
        && pending.watchDeviceId === pairing.watchDeviceId;
}

async function deliver(
    pending: PendingWearSyncInvalidation,
    transport: SyncInvalidationTransport | null,
    storage: Storage
): Promise<WearSyncInvalidationResult> {
    if (!transport) return { status: 'unavailable', invalidationId: pending.invalidationId };
    try {
        await transport.sendMessage(pending.nodeId, WEAR_PAIRING_PATHS.SYNC_INVALIDATE, payload(pending));
        await storage.removeItem(storageKey(pending.serverOrigin, pending.userId));
        return { status: 'sent', invalidationId: pending.invalidationId };
    } catch {
        return { status: 'pending', invalidationId: pending.invalidationId };
    }
}

/**
 * Persist one coalescing, account-bound signal before sending it to the exact paired node.
 * The payload contains no health data; it only asks the watch to refresh from its server.
 */
export function queueWearSyncInvalidation(options: {
    serverOrigin: string;
    userId: number;
    transport?: SyncInvalidationTransport | null;
    storage?: Storage;
    readPairing?: PairingReader;
    nowEpochMs?: number;
    invalidationId?: string;
}): Promise<WearSyncInvalidationResult> {
    return serialize(async () => {
        const origin = canonicalOrigin(options.serverOrigin);
        if (!Number.isSafeInteger(options.userId) || options.userId <= 0) {
            throw new Error('Wear sync invalidation requires a valid account.');
        }
        const storage = options.storage ?? AsyncStorage;
        const pairing = await (options.readPairing ?? readStoredWearPairing)(origin, options.userId);
        if (!pairing) {
            await storage.removeItem(storageKey(origin, options.userId));
            return { status: 'unpaired', invalidationId: null };
        }
        const now = options.nowEpochMs ?? Date.now();
        const invalidationId = options.invalidationId ?? Crypto.randomUUID();
        if (!boundedText(invalidationId, 128) || !Number.isSafeInteger(now) || now <= 0) {
            throw new Error('Wear sync invalidation metadata is invalid.');
        }
        const pending: PendingWearSyncInvalidation = {
            invalidationId,
            nodeId: pairing.nodeId,
            serverOrigin: origin,
            userId: options.userId,
            watchDeviceId: pairing.watchDeviceId,
            issuedAtEpochMs: now,
            expiresAtEpochMs: now + INVALIDATION_TTL_MS
        };
        await storage.setItem(storageKey(origin, options.userId), JSON.stringify(pending));
        return deliver(
            pending,
            options.transport === undefined ? nativeTransport() : options.transport,
            storage
        );
    });
}

/** Retry the single bounded signal retained after a disconnected phone/watch send. */
export function flushWearSyncInvalidation(options: {
    serverOrigin: string;
    userId: number;
    transport?: SyncInvalidationTransport | null;
    storage?: Storage;
    readPairing?: PairingReader;
    nowEpochMs?: number;
}): Promise<WearSyncInvalidationResult> {
    return serialize(async () => {
        const origin = canonicalOrigin(options.serverOrigin);
        const storage = options.storage ?? AsyncStorage;
        const pending = await readPending(origin, options.userId, storage);
        if (!pending) return { status: 'unpaired', invalidationId: null };
        const pairing = await (options.readPairing ?? readStoredWearPairing)(origin, options.userId);
        const now = options.nowEpochMs ?? Date.now();
        if (!pairing || !stillMatchesPairing(pending, pairing) || pending.expiresAtEpochMs <= now) {
            await storage.removeItem(storageKey(origin, options.userId));
            return { status: 'unpaired', invalidationId: null };
        }
        return deliver(
            pending,
            options.transport === undefined ? nativeTransport() : options.transport,
            storage
        );
    });
}

/** Exposed only for account cleanup tests and future explicit unpair flows. */
export async function clearWearSyncInvalidation(serverOrigin: string, userId: number): Promise<void> {
    await AsyncStorage.removeItem(storageKey(canonicalOrigin(serverOrigin), userId));
}

export type { SyncInvalidationTransport };
