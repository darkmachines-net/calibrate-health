/** @file Regression coverage for use Native Push Registration web: Expo browser push registration. */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useAuth } from '../auth/AuthContext';
import {
    cleanupBrowserPushBeforeSessionChange,
    type BrowserPushEnvironment
} from '../notifications/browserPush.web';
import { NATIVE_PUSH_STATES } from '../notifications/workflow';
import {
    NativePushRegistrationProvider,
    useNativePushRegistration
} from './useNativePushRegistration.web';

jest.mock('../auth/AuthContext', () => ({ useAuth: jest.fn() }));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

function createSubscription(endpoint = 'https://push.example/subscription') {
    return {
        endpoint,
        unsubscribe: jest.fn(async () => true),
        toJSON: () => ({
            endpoint,
            expirationTime: null,
            keys: { p256dh: 'public-key', auth: 'auth-secret' }
        })
    } as unknown as PushSubscription;
}

function createHarness(options: {
    permission?: NotificationPermission;
    subscription?: PushSubscription | null;
    webPush?: boolean;
    registrationError?: Error;
} = {}) {
    let permission = options.permission ?? 'default';
    let subscription = options.subscription ?? null;
    let messageListener: ((message: unknown) => void) | null = null;
    const createdSubscription = createSubscription('https://push.example/created');
    const subscribe = jest.fn(async () => {
        subscription = createdSubscription;
        return createdSubscription;
    });
    const registration = {
        pushManager: {
            getSubscription: jest.fn(async () => subscription),
            subscribe
        }
    } as unknown as ServiceWorkerRegistration;
    const environment: BrowserPushEnvironment = {
        isSupported: () => true,
        getPermission: () => permission,
        requestPermission: jest.fn(async () => {
            permission = 'granted';
            return permission;
        }),
        getRegistration: jest.fn(async () => registration),
        decodeApplicationServerKey: jest.fn(() => new Uint8Array([1, 2, 3])),
        addMessageListener: jest.fn((listener) => {
            messageListener = listener;
            return () => { messageListener = null; };
        })
    };
    const api = {
        getClientConfig: jest.fn(async () => ({ capabilities: { web_push: options.webPush ?? true } })),
        getBrowserPushPublicKey: jest.fn(async () => ({ publicKey: 'AQID' })),
        registerBrowserPushSubscription: options.registrationError
            ? jest.fn(async () => { throw options.registrationError; })
            : jest.fn(async () => ({ ok: true as const })),
        unregisterBrowserPushSubscription: jest.fn(async () => ({ ok: true as const }))
    };
    mockUseAuth.mockReturnValue({ api, isLoading: false, user: { id: 7 } } as unknown as ReturnType<typeof useAuth>);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <NativePushRegistrationProvider environment={environment}>{children}</NativePushRegistrationProvider>
    );
    return { api, createdSubscription, environment, getMessageListener: () => messageListener, subscribe, wrapper };
}

describe('Expo browser push registration', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('waits for a user gesture before prompting and creating an endpoint', async () => {
        const harness = createHarness();
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });
        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.PERMISSION_REQUIRED));
        expect(harness.environment.requestPermission).not.toHaveBeenCalled();
        expect(harness.subscribe).not.toHaveBeenCalled();

        await act(async () => result.current.requestPermission());

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));
        expect(harness.environment.requestPermission).toHaveBeenCalledTimes(1);
        expect(harness.subscribe).toHaveBeenCalledWith({
            userVisibleOnly: true,
            applicationServerKey: new Uint8Array([1, 2, 3])
        });
        expect(harness.api.registerBrowserPushSubscription).toHaveBeenCalledWith({
            endpoint: 'https://push.example/created',
            expirationTime: null,
            keys: { p256dh: 'public-key', auth: 'auth-secret' }
        });
        unmount();
    });

    it('repairs an existing granted endpoint without prompting', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));
        expect(harness.environment.requestPermission).not.toHaveBeenCalled();
        expect(harness.subscribe).not.toHaveBeenCalled();
        expect(harness.api.registerBrowserPushSubscription).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('preserves an existing endpoint while cookie-session hydration is in progress', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        mockUseAuth.mockReturnValue({
            api: harness.api,
            isLoading: true,
            user: null
        } as unknown as ReturnType<typeof useAuth>);
        const rendered = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });

        await waitFor(() => expect(rendered.result.current.state).toBe(NATIVE_PUSH_STATES.CHECKING));
        expect(existing.unsubscribe).not.toHaveBeenCalled();

        mockUseAuth.mockReturnValue({
            api: harness.api,
            isLoading: false,
            user: { id: 7 }
        } as unknown as ReturnType<typeof useAuth>);
        rendered.rerender({});

        await waitFor(() => expect(rendered.result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));
        expect(existing.unsubscribe).not.toHaveBeenCalled();
        rendered.unmount();
    });

    it('supports an existing endpoint on a compatible server that predates web-push discovery', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        harness.api.getClientConfig.mockResolvedValue({ capabilities: {} } as never);
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));
        expect(harness.api.registerBrowserPushSubscription).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('surfaces an operator-disabled browser capability without requesting permission', async () => {
        const harness = createHarness({ webPush: false });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.DISABLED));
        expect(harness.environment.requestPermission).not.toHaveBeenCalled();
        expect(harness.api.getBrowserPushPublicKey).not.toHaveBeenCalled();
        unmount();
    });

    it('removes a newly-created local endpoint when the server save fails', async () => {
        const harness = createHarness({ registrationError: new Error('unreachable') });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });
        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.PERMISSION_REQUIRED));

        await act(async () => result.current.requestPermission());

        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.ERROR));
        expect(harness.createdSubscription.unsubscribe).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('removes server ownership and the browser endpoint before a session changes', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });
        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));

        await act(async () => cleanupBrowserPushBeforeSessionChange());

        expect(harness.api.unregisterBrowserPushSubscription).toHaveBeenCalledWith(existing.endpoint);
        expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
        expect(result.current.state).toBe(NATIVE_PUSH_STATES.SIGNED_OUT);
        unmount();
    });

    it('lets the user disable a registered endpoint without revoking browser permission', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });
        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));

        await act(async () => result.current.disableRegistration());

        expect(harness.api.unregisterBrowserPushSubscription).toHaveBeenCalledWith(existing.endpoint);
        expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
        expect(result.current.state).toBe(NATIVE_PUSH_STATES.PERMISSION_REQUIRED);
        unmount();
    });

    it('re-registers a browser-rotated endpoint reported by the service worker', async () => {
        const existing = createSubscription();
        const harness = createHarness({ permission: 'granted', subscription: existing });
        const { result, unmount } = renderHook(() => useNativePushRegistration(), { wrapper: harness.wrapper });
        await waitFor(() => expect(result.current.state).toBe(NATIVE_PUSH_STATES.REGISTERED));
        harness.api.registerBrowserPushSubscription.mockClear();

        await act(async () => {
            harness.getMessageListener()?.({
                type: 'CALIBRATE_PUSH_SUBSCRIPTION_CHANGED',
                oldEndpoint: 'https://push.example/old'
            });
        });

        await waitFor(() => expect(harness.api.registerBrowserPushSubscription).toHaveBeenCalledTimes(1));
        expect(harness.api.unregisterBrowserPushSubscription).toHaveBeenCalledWith('https://push.example/old');
        unmount();
    });
});
