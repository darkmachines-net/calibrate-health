/** @file mutation Lock: Native writes share one JS runtime; direct attempts and enqueue decisions use the same namespace lock. */

const pending = new Map<string, Promise<unknown>>();
/** Native writes share one JS runtime; direct attempts and enqueue decisions use the same namespace lock. */
export function withMutationLock<T>(namespace: string, work: (exclusive: boolean) => Promise<T>): Promise<T> {
    const result = (pending.get(namespace) ?? Promise.resolve()).then(() => work(true));
    const settled = result.catch(() => undefined);
    pending.set(namespace, settled);
    void settled.then(() => { if (pending.get(namespace) === settled) pending.delete(namespace); });
    return result;
}
