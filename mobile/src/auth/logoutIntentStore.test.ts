/** @file Regression coverage for logout Intent Store: retains native revocation through outage/restart, then erases token material while keeping explicit sign-out. */

import { createLogoutIntentStore } from './logoutIntentStore';

function setup(browser = false, values = new Map<string, string>(), revoke = jest.fn<Promise<unknown>, [string, string?]>(async () => undefined)) {
    const storage = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); }, remove: async (key: string) => { values.delete(key); } };
    return { values, revoke, store: createLogoutIntentStore(storage, revoke, browser) };
}
const SERVER = 'https://health.example';

it('retains native revocation through outage/restart, then erases token material while keeping explicit sign-out', async () => {
    const first = setup();
    await first.store.beginExplicitLogout(SERVER, 'old-refresh');
    first.revoke.mockRejectedValueOnce(new TypeError('Offline'));
    await expect(first.store.flushExplicitLogout(SERVER)).rejects.toThrow('Offline');
    const restarted = setup(false, first.values, first.revoke);
    expect(await restarted.store.hasExplicitLogout(SERVER)).toBe(true);
    await restarted.store.flushExplicitLogout(SERVER);
    expect(first.revoke).toHaveBeenLastCalledWith(SERVER, 'old-refresh');
    expect([...first.values.values()]).toEqual(['{"signedOut":true,"pending":false}']);
    await restarted.store.flushExplicitLogout(SERVER);
    expect(first.revoke).toHaveBeenCalledTimes(2);
    expect(await restarted.store.hasExplicitLogout(SERVER)).toBe(true);
    await restarted.store.finishExplicitLogin(SERVER);
    expect(await restarted.store.hasExplicitLogout(SERVER)).toBe(false);
});

it('stores only a boolean browser intent and never native credential material', async () => {
    const { store, values, revoke } = setup(true);
    await store.beginExplicitLogout(SERVER, 'must-not-store');
    expect([...values.values()]).toEqual(['{"signedOut":true,"pending":true}']);
    await store.flushExplicitLogout(SERVER);
    expect(revoke).toHaveBeenCalledWith(SERVER);
});

it('isolates servers and leaves independent account data untouched', async () => {
    const { store, values, revoke } = setup();
    values.set('unrelated-data', 'keep');
    await store.beginExplicitLogout(SERVER, 'first');
    await store.beginExplicitLogout('https://other.example', 'second');
    await store.flushExplicitLogout(SERVER);
    await store.finishExplicitLogin(SERVER);
    expect(await store.hasExplicitLogout('https://other.example')).toBe(true);
    expect(values.get('unrelated-data')).toBe('keep');
    expect(revoke).toHaveBeenCalledTimes(1);
});

it('serializes repeated recovery before completing a new explicit login', async () => {
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const revoke = jest.fn<Promise<unknown>, [string, string?]>(() => new Promise<void>(resolve => { finish = resolve; started(); }));
    const { store } = setup(true, new Map(), revoke);
    await store.beginExplicitLogout(SERVER);
    const first = store.flushExplicitLogout(SERVER);
    await ready;
    const second = store.flushExplicitLogout(SERVER);
    const login = store.finishExplicitLogin(SERVER);
    finish();
    await Promise.all([first, second, login]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await store.hasExplicitLogout(SERVER)).toBe(false);
});

it('revokes a late rotated native token without marking a replacement account signed out', async () => {
    const { store, revoke, values } = setup();
    await store.beginExplicitLogout(SERVER, 'old');
    await store.flushExplicitLogout(SERVER);
    await store.finishExplicitLogin(SERVER);
    await store.enqueueRevocation(SERVER, 'late-rotated');
    expect(await store.hasExplicitLogout(SERVER)).toBe(false);
    revoke.mockRejectedValueOnce(new TypeError('Offline'));
    await expect(store.flushExplicitLogout(SERVER)).rejects.toThrow('Offline');
    const restarted = setup(false, values, revoke);
    expect(await restarted.store.hasExplicitLogout(SERVER)).toBe(false);
    await restarted.store.flushExplicitLogout(SERVER);
    expect(revoke).toHaveBeenLastCalledWith(SERVER, 'late-rotated');
    expect(values.size).toBe(0);
});


it.each([true, false])('revokes and remains signed out when persistent intent writes fail (browser=%s)', async browser => {
    const revoke = jest.fn<Promise<unknown>, [string, string?]>(async () => undefined);
    const store = createLogoutIntentStore({ get: async () => null, set: async () => { throw new Error('Full'); }, remove: async () => { throw new Error('Full'); } }, revoke, browser);
    await expect(store.beginExplicitLogout(SERVER, 'refresh')).rejects.toThrow('Full');
    expect(await store.hasExplicitLogout(SERVER)).toBe(true);
    revoke.mockRejectedValueOnce(new TypeError('Offline'));
    await expect(store.flushExplicitLogout(SERVER)).rejects.toThrow('Offline');
    expect(await store.hasExplicitLogout(SERVER)).toBe(true);
    await store.flushExplicitLogout(SERVER);
    expect(revoke).toHaveBeenLastCalledWith(...(browser ? [SERVER] : [SERVER, 'refresh']));
    await store.flushExplicitLogout(SERVER);
    expect(revoke).toHaveBeenCalledTimes(2);
});

it('does not overwrite unreadable durable intent and still revokes the active native token', async () => {
    const set = jest.fn(async () => undefined), revoke = jest.fn(async () => undefined);
    const store = createLogoutIntentStore({ get: async () => { throw new Error('Blocked'); }, set, remove: async () => undefined }, revoke, false);
    await expect(store.beginExplicitLogout(SERVER, 'active')).rejects.toThrow('could not be read');
    await store.flushExplicitLogout(SERVER);
    expect(revoke).toHaveBeenCalledWith(SERVER, 'active');
    expect(set).not.toHaveBeenCalled();
});
