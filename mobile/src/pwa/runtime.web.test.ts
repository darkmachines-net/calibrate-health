/** @file Regression coverage for runtime web: browser PWA runtime. */

import {
    BACK_ONLINE_NOTICE_MS,
    createPwaRuntime,
    PWA_NETWORK_STATES,
    PWA_UPDATE_STATES,
    type PwaEnvironment,
    type PwaRegistration,
    type PwaServiceWorkerContainer,
    type PwaWorker
} from './runtime.web';

type FakeEnvironment = PwaEnvironment & {
    emitWindow(type: 'online' | 'offline'): void;
    emitControllerChange(): void;
    runTimers(): void;
    register: jest.Mock;
    reload: jest.Mock;
};

type FakeWorker = PwaWorker & {
    postMessage: jest.Mock;
    setState(state: string): void;
};

function createWorker(initialState = 'installed'): FakeWorker {
    const stateChangeListeners = new Set<() => void>();
    const errorListeners = new Set<() => void>();
    return {
        state: initialState,
        postMessage: jest.fn(),
        addEventListener: (type, listener) => {
            (type === 'statechange' ? stateChangeListeners : errorListeners).add(listener);
        },
        removeEventListener: (type, listener) => {
            (type === 'statechange' ? stateChangeListeners : errorListeners).delete(listener);
        },
        setState(state) {
            this.state = state;
            stateChangeListeners.forEach((listener) => listener());
        }
    };
}

function createRegistration(
    waiting: PwaWorker | null = null,
    installing: PwaWorker | null = null
): PwaRegistration {
    const updateFound = new Set<() => void>();
    return {
        waiting,
        installing,
        update: jest.fn().mockResolvedValue(undefined),
        addEventListener: (_type, listener) => updateFound.add(listener),
        removeEventListener: (_type, listener) => updateFound.delete(listener)
    };
}

function createEnvironment(options: {
    production?: boolean;
    online?: boolean;
    registration?: PwaRegistration;
} = {}): FakeEnvironment {
    let online = options.online ?? true;
    const windowListeners = { online: new Set<() => void>(), offline: new Set<() => void>() };
    const controllerListeners = new Set<() => void>();
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const registration = options.registration ?? createRegistration();
    const register = jest.fn().mockResolvedValue(registration);
    const serviceWorker: PwaServiceWorkerContainer = {
        controller: createWorker(),
        register,
        addEventListener: (_type, listener) => controllerListeners.add(listener),
        removeEventListener: (_type, listener) => controllerListeners.delete(listener)
    };
    const reload = jest.fn();

    return {
        production: options.production ?? true,
        isOnline: () => online,
        addWindowListener: (type, listener) => {
            windowListeners[type].add(listener);
            return () => windowListeners[type].delete(listener);
        },
        getServiceWorker: () => serviceWorker,
        setTimer: (listener) => {
            const id = nextTimer++;
            timers.set(id, listener);
            return id;
        },
        clearTimer: (timer) => timers.delete(timer as number),
        reload,
        register,
        emitWindow(type) {
            online = type === 'online';
            windowListeners[type].forEach((listener) => listener());
        },
        emitControllerChange() {
            controllerListeners.forEach((listener) => listener());
        },
        runTimers() {
            const pending = [...timers.values()];
            timers.clear();
            pending.forEach((listener) => listener());
        }
    };
}

async function flushRegistration() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('browser PWA runtime', () => {
    it('keeps the offline state visible until reconnect and clears the back-online state after its timer', () => {
        const environment = createEnvironment();
        const runtime = createPwaRuntime(environment);
        const unsubscribe = runtime.subscribe(jest.fn());

        environment.emitWindow('offline');
        expect(runtime.getSnapshot().network).toBe(PWA_NETWORK_STATES.OFFLINE);
        environment.runTimers();
        expect(runtime.getSnapshot().network).toBe(PWA_NETWORK_STATES.OFFLINE);

        environment.emitWindow('online');
        expect(runtime.getSnapshot().network).toBe(PWA_NETWORK_STATES.BACK_ONLINE);
        expect(BACK_ONLINE_NOTICE_MS).toBeGreaterThanOrEqual(3_000);
        environment.runTimers();
        expect(runtime.getSnapshot().network).toBe(PWA_NETWORK_STATES.ONLINE);

        unsubscribe();
        runtime.dispose();
    });

    it('registers the service worker only in production', async () => {
        const development = createEnvironment({ production: false });
        const developmentRuntime = createPwaRuntime(development);
        developmentRuntime.subscribe(jest.fn());
        await flushRegistration();
        expect(development.register).not.toHaveBeenCalled();

        const production = createEnvironment({ production: true });
        const productionRuntime = createPwaRuntime(production);
        productionRuntime.subscribe(jest.fn());
        await flushRegistration();
        expect(production.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });

        developmentRuntime.dispose();
        productionRuntime.dispose();
    });

    it('offers an installed update and reloads exactly once after it takes control', async () => {
        const waiting = createWorker();
        const environment = createEnvironment({ registration: createRegistration(waiting) });
        const runtime = createPwaRuntime(environment);
        runtime.subscribe(jest.fn());
        await flushRegistration();

        expect(runtime.getSnapshot().update).toBe(PWA_UPDATE_STATES.READY);
        runtime.applyUpdate();
        expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(runtime.getSnapshot().update).toBe(PWA_UPDATE_STATES.APPLYING);

        environment.emitControllerChange();
        environment.emitControllerChange();
        expect(environment.reload).toHaveBeenCalledTimes(1);
        runtime.dispose();
    });

    it('keeps the installed worker available while registration.waiting catches up', async () => {
        const installing = createWorker('installing');
        const environment = createEnvironment({
            registration: createRegistration(null, installing)
        });
        const runtime = createPwaRuntime(environment);
        runtime.subscribe(jest.fn());
        await flushRegistration();

        installing.setState('installed');
        expect(runtime.getSnapshot().update).toBe(PWA_UPDATE_STATES.READY);

        runtime.applyUpdate();
        expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(runtime.getSnapshot().update).toBe(PWA_UPDATE_STATES.APPLYING);

        installing.setState('activated');
        expect(environment.reload).toHaveBeenCalledTimes(1);
        runtime.dispose();
    });

    it('surfaces registration failure and recovers through the retry action', async () => {
        const waiting = createWorker();
        const recoveredRegistration = createRegistration(waiting);
        const environment = createEnvironment();
        environment.register
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(recoveredRegistration);
        const runtime = createPwaRuntime(environment);
        runtime.subscribe(jest.fn());
        await flushRegistration();
        expect(runtime.getSnapshot()).toMatchObject({
            update: PWA_UPDATE_STATES.ERROR,
            updateError: expect.stringMatching(/try again/i)
        });

        await runtime.retryUpdate();
        expect(runtime.getSnapshot()).toMatchObject({
            update: PWA_UPDATE_STATES.READY,
            updateError: null
        });
        expect(environment.register).toHaveBeenCalledTimes(2);
        runtime.dispose();
    });
});
