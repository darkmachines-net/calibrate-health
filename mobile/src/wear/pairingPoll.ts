/** @file pairing Poll: Drain delayed watch handshake messages until pairing reaches a terminal state. */

import type { StoredWearPairing } from './pairing';

export type WearPairingInboxCheck = {
    processed: number;
    paired: StoredWearPairing | null;
    errors: string[];
};

export type WearPairingPollResult = WearPairingInboxCheck & {
    timedOut: boolean;
    cancelled: boolean;
};

type WearPairingPollOptions = {
    processInbox: () => Promise<WearPairingInboxCheck>;
    isActive?: () => boolean;
    onProgress?: (result: WearPairingInboxCheck) => void;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    intervalMs?: number;
    timeoutMs?: number;
};

// Keep native inbox reads responsive without leaving an unbounded background loop.
const PAIRING_POLL_INTERVAL_MS = 500;
// Allow a background phone relay plus one mixed-version direct failover to finish pairing.
const PAIRING_POLL_TIMEOUT_MS = 75_000;

function waitFor(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Drain delayed watch handshake messages until pairing reaches a terminal state. */
export async function pollWearPairingInbox(
    options: WearPairingPollOptions
): Promise<WearPairingPollResult> {
    const isActive = options.isActive ?? (() => true);
    const wait = options.wait ?? waitFor;
    const now = options.now ?? Date.now;
    const intervalMs = options.intervalMs ?? PAIRING_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? PAIRING_POLL_TIMEOUT_MS;
    const deadline = now() + timeoutMs;
    let processed = 0;

    while (isActive()) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
            return { processed, paired: null, errors: [], timedOut: true, cancelled: false };
        }

        await wait(Math.min(intervalMs, remainingMs));
        if (!isActive()) {
            return { processed, paired: null, errors: [], timedOut: false, cancelled: true };
        }
        if (now() >= deadline) {
            return { processed, paired: null, errors: [], timedOut: true, cancelled: false };
        }

        const result = await options.processInbox();
        processed += result.processed;
        options.onProgress?.(result);
        if (result.paired || result.errors.length > 0) {
            return {
                ...result,
                processed,
                timedOut: false,
                cancelled: false
            };
        }
    }

    return { processed, paired: null, errors: [], timedOut: false, cancelled: true };
}
