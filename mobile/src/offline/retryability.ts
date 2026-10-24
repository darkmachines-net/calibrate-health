/** @file retryability: Honor explicit retryability before falling back to legacy HTTP and transport rules. */

/**
 * Classifies direct and replayed mutation failures using the server's retry envelope.
 */
import { ApiError } from '@calibrate/api-client';

/** Honor explicit retryability before falling back to legacy HTTP and transport rules. */
export function isRetryableMutationError(error: unknown): boolean {
    if (error instanceof ApiError) {
        if (typeof error.retryable === 'boolean') return error.retryable;
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    if (error instanceof TypeError) return true;
    if (!(error instanceof Error)) return false;
    return error.message.startsWith('Request timed out while connecting to ');
}
