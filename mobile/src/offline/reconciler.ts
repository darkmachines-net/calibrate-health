/** @file Ordered offline replay, bounded retry scheduling, and account-scoped acknowledgement reconciliation. */

import type { FoodLogDay, FoodTrackingPause } from '@calibrate/api-client';
import { recordFoodDayReceipt, recordCurrentPauseReceipt } from './foodDayReceipts';
import { withMutationLock } from './mutationLock';
import type { OutboxStore } from './outbox';
import type { QueuedMutation } from './queuedMutation';
import { isRetryableMutationError } from './retryability';

type CurrentControlState = { day?: Pick<FoodLogDay, 'date' | 'status'>; pause?: FoodTrackingPause };
export type QueuedMutationExecutor = (mutation: QueuedMutation) => Promise<void | { currentControl: CurrentControlState }>;

export const OUTBOX_RETRY_BASE_DELAY_MS = 5_000;
export const OUTBOX_RETRY_MAX_DELAY_MS = 15 * 60_000;
const OUTBOX_RETRY_MIN_JITTER_BASIS_POINTS = 7_500;
const OUTBOX_RETRY_JITTER_RANGE_BASIS_POINTS = 2_501;

export type ReconcileResult = {
    replayed: number;
    replayedOperations: string[];
    failedMutation: QueuedMutation | null;
    deferredMutation: QueuedMutation | null;
    retryAfterMs: number | null;
};

/** Calculate a deterministic jittered exponential delay capped at fifteen minutes. */
export function getOutboxRetryDelayMs(attemptCount: number, mutationId = ''): number {
    const normalizedAttemptCount = Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
    const exponent = Math.min(normalizedAttemptCount - 1, 20);
    const cappedDelay = Math.min(OUTBOX_RETRY_MAX_DELAY_MS, OUTBOX_RETRY_BASE_DELAY_MS * (2 ** exponent));
    let hash = 2_166_136_261;
    for (let index = 0; index < mutationId.length; index += 1) {
        hash ^= mutationId.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    const jitterBasisPoints = OUTBOX_RETRY_MIN_JITTER_BASIS_POINTS
        + (hash % OUTBOX_RETRY_JITTER_RANGE_BASIS_POINTS);
    return Math.floor((cappedDelay * jitterBasisPoints) / 10_000);
}

function describeReplayError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return 'Mutation replay failed without an error message.';
}

/** Replays one namespace in insertion order and never runs two reconciliation loops at once. */
export class OutboxReconciler {
    private activeReconciliation: Promise<ReconcileResult> | null = null;

    /** Binds ordered storage and the mutation executor, optionally coordinating a shared namespace lock. */
    constructor(
        private readonly outbox: OutboxStore,
        private readonly executeMutation: QueuedMutationExecutor,
        private readonly namespace?: string
    ) {}

    /** Coalesces concurrent reconciliation calls and requires safe namespace ownership before replay. */
    reconcile(): Promise<ReconcileResult> {
        if (this.activeReconciliation) return this.activeReconciliation;

        const run = () => this.runReconciliation();
        const reconciliation = (this.namespace ? withMutationLock(this.namespace, async exclusive => {
            if (!exclusive) throw new Error('Safe synchronization requires browser Web Locks. Open this server in a supported secure browser context. Saved changes remain on this device.');
            return run();
        }) : run()).finally(() => {
            if (this.activeReconciliation === reconciliation) {
                this.activeReconciliation = null;
            }
        });
        this.activeReconciliation = reconciliation;
        return reconciliation;
    }

    /** Requeues selected failures before starting the same serialized reconciliation process. */
    async retryFailed(id?: string): Promise<ReconcileResult> {
        await this.outbox.retryFailed(id);
        return this.reconcile();
    }

    private async runReconciliation(): Promise<ReconcileResult> {
        await this.outbox.recoverInterrupted();
        let replayed = 0;
        const replayedOperations: string[] = [];

        while (true) {
            const mutation = await this.outbox.claimNext();
            if (!mutation) {
                return {
                    replayed,
                    replayedOperations,
                    failedMutation: null,
                    deferredMutation: null,
                    retryAfterMs: null
                };
            }

            try {
                const result = await this.executeMutation(mutation);
                if (this.namespace && (mutation.operation.startsWith('food-day.') || mutation.operation.startsWith('food-tracking-pause.'))) {
                    if (!result?.currentControl) throw new Error('Current tracking state was not verified after replay.');
                    const { day, pause } = result.currentControl;
                    // Cached idempotency responses prove the request was accepted, not that its old state is current.
                    if (pause) await recordCurrentPauseReceipt(this.namespace, pause, 'server-read:replay:' + mutation.id);
                    if (day) await recordFoodDayReceipt(this.namespace, 'food-day.set-status', { date: day.date, status: day.status }, 'server-read:replay:' + mutation.id);
                }
                await this.outbox.complete(mutation.id);
                replayed += 1;
                replayedOperations.push(mutation.operation);
            } catch (error) {
                if (isRetryableMutationError(error)) {
                    const deferredMutation = await this.outbox.defer(mutation.id, describeReplayError(error));
                    return {
                        replayed,
                        replayedOperations,
                        failedMutation: null,
                        deferredMutation,
                        retryAfterMs: getOutboxRetryDelayMs(deferredMutation.attemptCount, deferredMutation.id)
                    };
                }
                const failedMutation = await this.outbox.fail(mutation.id, describeReplayError(error));
                return {
                    replayed,
                    replayedOperations,
                    failedMutation,
                    deferredMutation: null,
                    retryAfterMs: null
                };
            }
        }
    }
}
