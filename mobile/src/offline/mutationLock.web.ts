/** @file mutation Lock: A browser without cross-tab Web Locks must enqueue instead of issuing unordered direct writes. */

/** A browser without cross-tab Web Locks must enqueue instead of issuing unordered direct writes. */
export function withMutationLock<T>(namespace: string, work: (exclusive: boolean) => Promise<T>): Promise<T> {
    return typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request('calibrate.outbox.dispatch.' + namespace, () => work(true))
        : work(false);
}
