/** @file Regression coverage for mutation Lock web: requires durable queueing when cross-tab locks are unavailable. */

import { withMutationLock } from './mutationLock.web';

it('requires durable queueing when cross-tab locks are unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    try { await expect(withMutationLock('account', async exclusive => exclusive)).resolves.toBe(false); }
    finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); }
});

it('holds the origin/account-specific Web Lock through the entire dispatch', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let held = false;
    const request = jest.fn(async (_key: string, work: () => Promise<boolean>) => { held = true; try { return await work(); } finally { held = false; } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request } } });
    try {
        await expect(withMutationLock('https://health.example::user:7', async exclusive => { expect(held).toBe(true); return exclusive; })).resolves.toBe(true);
        expect(request).toHaveBeenCalledWith('calibrate.outbox.dispatch.https://health.example::user:7', expect.any(Function));
        expect(held).toBe(false);
    } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else Reflect.deleteProperty(globalThis, 'navigator'); }
});
