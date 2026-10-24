/** @file Phone-side Wear discovery, account/server-bound pairing, and retained connection lifecycle. */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WearPairingCredentialResponse } from '@calibrate/api-client';
import * as Crypto from 'expo-crypto';
import type {
    WearNode,
    WearPairingMessage
} from '@calibrate/wear-pairing';

export const WEAR_PAIRING_PROTOCOL_VERSION = 1;
export const WEAR_PAIRING_PATHS = {
    HELLO: '/calibrate/v1/pair/hello',
    CREDENTIAL: '/calibrate/v1/pair/credential',
    RESULT: '/calibrate/v1/pair/result',
    SYNC_INVALIDATE: '/calibrate/v1/sync/invalidate',
    CONTINUE_ON_PHONE: '/calibrate/v1/continue-on-phone',
    ACCOUNT_DISCONNECT: '/calibrate/v1/account/disconnect',
    ACCOUNT_DISCONNECT_RESULT: '/calibrate/v1/account/disconnect-result'
} as const;

type PairingHello = {
    requestId: string;
    serverOrigin: string;
    expiresAt: string;
    watchDeviceId: string;
    watchDeviceName: string | null;
    watchPublicKeySpki: string;
};

export type StoredWearPairing = {
    nodeId: string;
    watchDeviceId: string;
    watchDeviceName: string | null;
    serverOrigin: string;
    pairedAt: string;
};

export type PendingWearPairing = {
    requestId: string;
    nodeId: string;
    serverOrigin: string;
    userId: number;
    issuedAt: string;
    expiresAt: string;
    watchDeviceId: string | null;
};

type WearPairingTransport = {
    getPairingNodes(): Promise<WearNode[]>;
    sendMessage(nodeId: string, path: string, payload: string): Promise<number>;
    listMessages(): WearPairingMessage[];
    acknowledgeMessages(messageIds: string[]): void;
    prepareNetworkRelay?(nodeId: string, serverOrigin: string, requestId: string, expiresAtEpochMs: number): void;
    commitNetworkRelay?(nodeId: string, serverOrigin: string, requestId: string): void;
    restoreNetworkRelay?(nodeId: string, serverOrigin: string): void;
    clearPendingNetworkRelay?(nodeId: string, serverOrigin: string, requestId: string): void;
    clearNetworkRelay?(nodeId: string, serverOrigin: string): void;
};

/** Resolve lazily so Expo Go/web/Jest can render settings without the Android module installed. */
function getNativeTransport(): WearPairingTransport | null {
    try {
        return (require('@calibrate/wear-pairing') as { default?: WearPairingTransport | null }).default ?? null;
    } catch {
        return null;
    }
}

type PairingApi = {
    issueWearPairingCredential(payload: {
        server_origin: string;
        watch_device_id: string;
        watch_device_name?: string;
        protocol_version: 1;
        watch_public_key_spki: string;
    }): Promise<WearPairingCredentialResponse>;
};

const PAIRING_STORAGE_PREFIX = '@calibrate/wear/pairings/v1';
const PENDING_STORAGE_PREFIX = '@calibrate/wear/pending/v1';
const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_NAME_LENGTH = 120;
const MAX_PUBLIC_KEY_LENGTH = 2048;
const ACCOUNT_DISCONNECT_ACK_TIMEOUT_MS = 8_000;
const ACCOUNT_DISCONNECT_ACK_POLL_MS = 100;
const MESSAGE_CLOCK_SKEW_MS = 30_000;

const WEAR_PAIRING_FALLBACK_MESSAGE =
    'Unable to check for a Wear OS watch. Confirm Bluetooth and Google Play services are available, then try again.';

/** Convert native Play Services failures into actionable copy without exposing implementation details. */
export function getWearPairingErrorMessage(error: unknown): string {
    if (!(error instanceof Error) || !error.message.trim()) return WEAR_PAIRING_FALLBACK_MESSAGE;
    const message = error.message.trim();
    if (/Wearable\.API is not available|statusCode=API_UNAVAILABLE|ApiException:\s*17/i.test(message)) {
        return 'Wear OS pairing is unavailable on this phone. Pair a Wear OS watch in Android and update Google Play services, then try again.';
    }
    if (/Call to function|Caused by:|com\.google\.android\.gms|\bjava\.[a-z]/i.test(message)) {
        return WEAR_PAIRING_FALLBACK_MESSAGE;
    }
    return WEAR_PAIRING_FALLBACK_MESSAGE;
}

function accountScope(serverOrigin: string, userId: number): string {
    return `${encodeURIComponent(new URL(serverOrigin).origin)}/${userId}`;
}

function scopedStorageKey(serverOrigin: string, userId: number): string {
    return `${PAIRING_STORAGE_PREFIX}/${accountScope(serverOrigin, userId)}`;
}

function pendingStorageKey(serverOrigin: string, userId: number): string {
    return `${PENDING_STORAGE_PREFIX}/${accountScope(serverOrigin, userId)}`;
}

function requiredText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/** Accept only the minimal watch hello shape needed to mint a server-bound one-time credential. */
export function parsePairingHello(payload: string): PairingHello | null {
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (parsed.protocol_version !== WEAR_PAIRING_PROTOCOL_VERSION) return null;
        const requestId = requiredText(parsed.request_id, MAX_REQUEST_ID_LENGTH);
        const serverOrigin = requiredText(parsed.server_origin, 2048);
        const expiresAt = requiredText(parsed.expires_at, 64);
        const watchDeviceId = requiredText(parsed.watch_device_id, MAX_DEVICE_ID_LENGTH);
        const watchPublicKeySpki = requiredText(parsed.watch_public_key_spki, MAX_PUBLIC_KEY_LENGTH);
        const watchDeviceName = parsed.watch_device_name == null
            ? null
            : requiredText(parsed.watch_device_name, MAX_DEVICE_NAME_LENGTH);
        if (
            !requestId || !serverOrigin || !expiresAt ||
            new URL(serverOrigin).origin !== serverOrigin ||
            !Number.isFinite(new Date(expiresAt).getTime()) ||
            !watchDeviceId || !watchPublicKeySpki
        ) return null;
        if (parsed.watch_device_name != null && watchDeviceName === null) return null;
        return { requestId, serverOrigin, expiresAt, watchDeviceId, watchDeviceName, watchPublicKeySpki };
    } catch {
        return null;
    }
}

type WearPairingResult = {
    requestId: string;
    serverOrigin: string;
    watchDeviceId: string;
} & (
    | { ok: true; watchDeviceName: string | null }
    | { ok: false; message: string }
);

function parsePairingResult(payload: string): WearPairingResult | null {
    try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (
            typeof parsed.ok !== 'boolean'
            || parsed.protocol_version !== WEAR_PAIRING_PROTOCOL_VERSION
        ) return null;
        const watchDeviceId = requiredText(parsed.watch_device_id, MAX_DEVICE_ID_LENGTH);
        const requestId = requiredText(parsed.request_id, MAX_REQUEST_ID_LENGTH);
        const serverOrigin = requiredText(parsed.server_origin, 2048);
        if (!requestId || !watchDeviceId || !serverOrigin || new URL(serverOrigin).origin !== serverOrigin) return null;
        if (!parsed.ok) {
            const message = requiredText(parsed.message, 180);
            return message ? { ok: false, requestId, watchDeviceId, serverOrigin, message } : null;
        }
        const watchDeviceName = parsed.watch_device_name == null
            ? null
            : requiredText(parsed.watch_device_name, MAX_DEVICE_NAME_LENGTH);
        if (parsed.watch_device_name != null && watchDeviceName === null) return null;
        return { ok: true, requestId, watchDeviceId, watchDeviceName, serverOrigin };
    } catch {
        return null;
    }
}

function isStoredWearPairing(value: unknown, serverOrigin: string): value is StoredWearPairing {
    if (!value || typeof value !== 'object') return false;
    const pairing = value as Partial<StoredWearPairing>;
    return requiredText(pairing.nodeId, 256) !== null
        && requiredText(pairing.watchDeviceId, MAX_DEVICE_ID_LENGTH) !== null
        && (pairing.watchDeviceName === null || requiredText(pairing.watchDeviceName, MAX_DEVICE_NAME_LENGTH) !== null)
        && pairing.serverOrigin === new URL(serverOrigin).origin
        && typeof pairing.pairedAt === 'string'
        && Number.isFinite(new Date(pairing.pairedAt).getTime());
}

/** Loads valid account-scoped pairing state and restores native relay authorization for older pairings. */
export async function readStoredWearPairing(
    serverOrigin: string,
    userId: number
): Promise<StoredWearPairing | null> {
    const key = scopedStorageKey(serverOrigin, userId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (isStoredWearPairing(parsed, serverOrigin)) {
            // Backfill native relay authorization for pairings created before phone relaying existed.
            try {
                getNativeTransport()?.restoreNetworkRelay?.(parsed.nodeId, parsed.serverOrigin);
            } catch {
                // The stored pairing remains usable through the watch's bounded direct fallback.
            }
            return parsed;
        }
        await AsyncStorage.removeItem(key);
        return null;
    } catch {
        await AsyncStorage.removeItem(key);
        return null;
    }
}

/** Remove both completed and in-flight pairing metadata for exactly one server account. */
export async function clearWearPairingStorage(serverOrigin: string, userId: number): Promise<void> {
    const origin = new URL(serverOrigin).origin;
    const [pairing, pending] = await Promise.all([
        readStoredWearPairing(origin, userId).catch(() => null),
        readPendingWearPairing(origin, userId).catch(() => null)
    ]);
    const transport = getNativeTransport();
    const results = await Promise.allSettled([
        AsyncStorage.removeItem(scopedStorageKey(origin, userId)),
        AsyncStorage.removeItem(pendingStorageKey(origin, userId)),
        Promise.resolve().then(() => {
            if (pending) {
                transport?.clearPendingNetworkRelay?.(
                    pending.nodeId,
                    pending.serverOrigin,
                    pending.requestId
                );
            }
            if (pairing) transport?.clearNetworkRelay?.(pairing.nodeId, pairing.serverOrigin);
        })
    ]);
    if (results.some(({ status }) => status === 'rejected')) {
        throw new Error('Phone-side Wear pairing state could not be cleared.');
    }
}

export type WearAccountDisconnectAck = {
    requestId: string;
    serverOrigin: string;
    userId: number;
    watchDeviceId: string;
};

/** Accept only a positive, minimal cleanup result; delivery alone is never an acknowledgement. */
export function parseWearAccountDisconnectAck(payload: string): WearAccountDisconnectAck | null {
    try {
        const parsed = JSON.parse(payload) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const value = parsed as Record<string, unknown>;
        const expectedKeys = new Set([
            'kind', 'request_id', 'protocol_version', 'server_origin', 'user_id', 'watch_device_id', 'ok'
        ]);
        if (Object.keys(value).length !== expectedKeys.size) return null;
        if (Object.keys(value).some((key) => !expectedKeys.has(key))) return null;
        if (
            value.kind !== 'watch_account_disconnected' ||
            value.protocol_version !== WEAR_PAIRING_PROTOCOL_VERSION ||
            value.ok !== true
        ) return null;
        const requestId = requiredText(value.request_id, MAX_REQUEST_ID_LENGTH);
        const serverOrigin = requiredText(value.server_origin, 2_048);
        const watchDeviceId = requiredText(value.watch_device_id, MAX_DEVICE_ID_LENGTH);
        if (
            !requestId || !serverOrigin || new URL(serverOrigin).origin !== serverOrigin ||
            !Number.isSafeInteger(value.user_id) || (value.user_id as number) <= 0 || !watchDeviceId
        ) return null;
        return { requestId, serverOrigin, userId: value.user_id as number, watchDeviceId };
    } catch {
        return null;
    }
}

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Ask the exact paired node to erase its account and require its correlated positive cleanup ACK. */
export async function sendWearAccountDisconnect(options: {
    pairing: StoredWearPairing;
    userId: number;
    transport?: Pick<WearPairingTransport, 'sendMessage' | 'listMessages' | 'acknowledgeMessages'> | null;
    nowEpochMs?: number;
    requestId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<void> {
    const transport = options.transport === undefined ? getNativeTransport() : options.transport;
    if (!transport) throw new Error('Paired watch was unreachable. Disconnect Calibrate on the watch.');
    const issuedAtEpochMs = options.nowEpochMs ?? Date.now();
    const requestId = options.requestId ?? Crypto.randomUUID();
    if (!requiredText(requestId, MAX_REQUEST_ID_LENGTH)) throw new Error('Invalid watch cleanup request ID.');
    await transport.sendMessage(
        options.pairing.nodeId,
        WEAR_PAIRING_PATHS.ACCOUNT_DISCONNECT,
        JSON.stringify({
            kind: 'phone_account_deleted',
            request_id: requestId,
            protocol_version: WEAR_PAIRING_PROTOCOL_VERSION,
            server_origin: options.pairing.serverOrigin,
            user_id: options.userId,
            watch_device_id: options.pairing.watchDeviceId,
            issued_at_epoch_ms: issuedAtEpochMs
        })
    );

    const timeoutMs = options.timeoutMs ?? ACCOUNT_DISCONNECT_ACK_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? ACCOUNT_DISCONNECT_ACK_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    do {
        const nowEpochMs = Date.now();
        for (const message of transport.listMessages()) {
            if (message.path !== WEAR_PAIRING_PATHS.ACCOUNT_DISCONNECT_RESULT) continue;
            const ack = parseWearAccountDisconnectAck(message.payload);
            if (
                !ack || message.nodeId !== options.pairing.nodeId ||
                ack.requestId !== requestId || ack.serverOrigin !== options.pairing.serverOrigin ||
                ack.userId !== options.userId || ack.watchDeviceId !== options.pairing.watchDeviceId ||
                typeof message.id !== 'string' || message.id.length < 1 || message.id.length > MAX_REQUEST_ID_LENGTH ||
                typeof message.receivedAt !== 'number' || !Number.isFinite(message.receivedAt) ||
                message.receivedAt < issuedAtEpochMs - MESSAGE_CLOCK_SKEW_MS ||
                message.receivedAt > nowEpochMs + MESSAGE_CLOCK_SKEW_MS
            ) continue;
            transport.acknowledgeMessages([message.id]);
            return;
        }
        if (Date.now() < deadline) await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);

    throw new Error('Watch cleanup was not confirmed. Disconnect Calibrate on the watch.');
}

async function readPendingWearPairing(serverOrigin: string, userId: number): Promise<PendingWearPairing | null> {
    const key = pendingStorageKey(serverOrigin, userId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PendingWearPairing;
        if (
            parsed.userId !== userId ||
            parsed.serverOrigin !== new URL(serverOrigin).origin ||
            !requiredText(parsed.requestId, MAX_REQUEST_ID_LENGTH) ||
            !requiredText(parsed.nodeId, 256) ||
            !(parsed.watchDeviceId === null || requiredText(parsed.watchDeviceId, MAX_DEVICE_ID_LENGTH)) ||
            !Number.isFinite(new Date(parsed.issuedAt).getTime()) ||
            new Date(parsed.issuedAt) >= new Date(parsed.expiresAt) ||
            !Number.isFinite(new Date(parsed.expiresAt).getTime())
        ) throw new Error('Invalid pending pairing');
        return parsed;
    } catch {
        await AsyncStorage.removeItem(key);
        return null;
    }
}

/** Start a phone-owned request so a delayed watch hello cannot bind to a different account/server. */
export async function startWearPairing(options: {
    node: WearNode;
    serverOrigin: string;
    userId: number;
    transport?: WearPairingTransport | null;
    now?: Date;
    requestId?: string;
}): Promise<PendingWearPairing> {
    const transport = options.transport === undefined ? getNativeTransport() : options.transport;
    if (!transport) throw new Error('Wear pairing requires a native Android build.');
    const now = options.now ?? new Date();
    const origin = new URL(options.serverOrigin).origin;
    const existing = options.requestId === undefined
        ? await readPendingWearPairing(origin, options.userId)
        : null;
    const reusable = existing &&
        existing.nodeId === options.node.id &&
        existing.serverOrigin === origin &&
        new Date(existing.expiresAt) > now
        ? existing
        : null;
    const requestId = reusable?.requestId ?? options.requestId ?? Crypto.randomUUID();
    if (!requiredText(requestId, MAX_REQUEST_ID_LENGTH)) throw new Error('Invalid Wear pairing request ID.');
    const pending: PendingWearPairing = reusable ?? {
        requestId,
        nodeId: options.node.id,
        serverOrigin: origin,
        userId: options.userId,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PAIRING_REQUEST_TTL_MS).toISOString(),
        watchDeviceId: null
    };
    await AsyncStorage.setItem(pendingStorageKey(pending.serverOrigin, pending.userId), JSON.stringify(pending));
    try {
        transport.prepareNetworkRelay?.(
            pending.nodeId,
            pending.serverOrigin,
            pending.requestId,
            new Date(pending.expiresAt).getTime()
        );
        await transport.sendMessage(pending.nodeId, WEAR_PAIRING_PATHS.HELLO, JSON.stringify({
            kind: 'phone_pairing_invite',
            request_id: pending.requestId,
            protocol_version: WEAR_PAIRING_PROTOCOL_VERSION,
            server_origin: pending.serverOrigin,
            issued_at: pending.issuedAt,
            expires_at: pending.expiresAt
        }));
    } catch (error) {
        await AsyncStorage.removeItem(pendingStorageKey(pending.serverOrigin, pending.userId));
        transport.clearPendingNetworkRelay?.(
            pending.nodeId,
            pending.serverOrigin,
            pending.requestId
        );
        throw error;
    }
    return pending;
}

/** Process only inbox messages delivered by the matching signed Wear app; never transfer phone tokens. */
export async function processWearPairingInbox(options: {
    api: PairingApi;
    serverOrigin: string;
    userId: number;
    transport?: WearPairingTransport | null;
    now?: Date;
}): Promise<{ processed: number; paired: StoredWearPairing | null; errors: string[] }> {
    const transport = options.transport === undefined ? getNativeTransport() : options.transport;
    if (!transport) return { processed: 0, paired: null, errors: ['Wear pairing requires a native Android build.'] };
    const messages = transport.listMessages();
    const errors: string[] = [];
    const acknowledgedMessageIds: string[] = [];
    let processed = 0;
    let paired: StoredWearPairing | null = null;
    const origin = new URL(options.serverOrigin).origin;
    let pending = await readPendingWearPairing(origin, options.userId);

    for (const message of messages) {
        if (message.path === WEAR_PAIRING_PATHS.HELLO) {
            const hello = parsePairingHello(message.payload);
            if (!hello) {
                errors.push('A watch sent an unsupported pairing request. Update both apps and try again.');
                acknowledgedMessageIds.push(message.id);
                continue;
            }
            const now = options.now ?? new Date();
            if (
                !pending ||
                pending.requestId !== hello.requestId ||
                pending.nodeId !== message.nodeId ||
                pending.serverOrigin !== origin ||
                hello.serverOrigin !== origin ||
                hello.expiresAt !== pending.expiresAt ||
                new Date(pending.expiresAt) <= now ||
                new Date(hello.expiresAt) <= now ||
                message.receivedAt < now.getTime() - PAIRING_REQUEST_TTL_MS
            ) {
                errors.push('A stale or mismatched watch pairing request was ignored. Start pairing again.');
                acknowledgedMessageIds.push(message.id);
                continue;
            }
            try {
                const credential = await options.api.issueWearPairingCredential({
                    server_origin: origin,
                    watch_device_id: hello.watchDeviceId,
                    ...(hello.watchDeviceName ? { watch_device_name: hello.watchDeviceName } : {}),
                    protocol_version: WEAR_PAIRING_PROTOCOL_VERSION,
                    watch_public_key_spki: hello.watchPublicKeySpki
                });
                await transport.sendMessage(
                    message.nodeId,
                    WEAR_PAIRING_PATHS.CREDENTIAL,
                    JSON.stringify({
                        request_id: hello.requestId,
                        ...credential
                    })
                );
                pending = { ...pending, watchDeviceId: hello.watchDeviceId };
                await AsyncStorage.setItem(
                    pendingStorageKey(origin, options.userId),
                    JSON.stringify(pending)
                );
                // Persist result correlation before removing the durable native hello.
                processed += 1;
                acknowledgedMessageIds.push(message.id);
            } catch {
                errors.push('Unable to create a watch pairing credential.');
            }
            continue;
        }
        if (message.path === WEAR_PAIRING_PATHS.RESULT) {
            const result = parsePairingResult(message.payload);
            if (
                !result || !pending ||
                result.requestId !== pending.requestId ||
                message.nodeId !== pending.nodeId ||
                result.watchDeviceId !== pending.watchDeviceId ||
                result.serverOrigin !== origin
            ) {
                errors.push('A watch reported a pairing result for a different Calibrate server.');
                acknowledgedMessageIds.push(message.id);
                continue;
            }
            if (!result.ok) {
                await AsyncStorage.removeItem(pendingStorageKey(origin, options.userId));
                transport.clearPendingNetworkRelay?.(
                    pending.nodeId,
                    pending.serverOrigin,
                    pending.requestId
                );
                pending = null;
                processed += 1;
                errors.push(result.message);
                acknowledgedMessageIds.push(message.id);
                continue;
            }
            const completedPairing: StoredWearPairing = {
                watchDeviceId: result.watchDeviceId,
                watchDeviceName: result.watchDeviceName,
                serverOrigin: result.serverOrigin,
                nodeId: message.nodeId,
                pairedAt: (options.now ?? new Date()).toISOString()
            };
            try {
                transport.commitNetworkRelay?.(
                    pending.nodeId,
                    pending.serverOrigin,
                    pending.requestId
                );
            } catch {
                errors.push('The phone could not activate its watch network relay. Keep both apps open and try again.');
                continue;
            }
            paired = completedPairing;
            await AsyncStorage.setItem(scopedStorageKey(result.serverOrigin, options.userId), JSON.stringify(completedPairing));
            await AsyncStorage.removeItem(pendingStorageKey(origin, options.userId));
            pending = null;
            processed += 1;
            acknowledgedMessageIds.push(message.id);
        }
    }
    transport.acknowledgeMessages(acknowledgedMessageIds);
    return { processed, paired, errors };
}

/** Lists reachable watch pairing nodes or returns an empty list when native transport is unavailable. */
export async function getReachableWearNodes(
    transport: WearPairingTransport | null = getNativeTransport()
): Promise<WearNode[]> {
    return transport ? transport.getPairingNodes() : [];
}
