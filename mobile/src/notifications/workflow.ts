/** @file Native push registration eligibility, permission recovery, and server capability negotiation. */

const INTERNAL_ROUTE_ORIGIN = 'https://calibrate.invalid';

export const NATIVE_PUSH_STATES = {
    SIGNED_OUT: 'signed-out',
    CHECKING: 'checking',
    PERMISSION_REQUIRED: 'permission-required',
    BLOCKED: 'blocked',
    REGISTERING: 'registering',
    REGISTERED: 'registered',
    DISABLED: 'disabled',
    UNSUPPORTED: 'unsupported',
    ERROR: 'error'
} as const;

export type NativePushState = (typeof NATIVE_PUSH_STATES)[keyof typeof NATIVE_PUSH_STATES];

type NotificationRoute =
    | '/today'
    | '/progress'
    | { pathname: '/log' | '/weight'; params?: { date: string } };

export type NotificationAction = {
    label: string;
    href: NotificationRoute;
};

export type PushStatusPresentation = {
    message: string;
    action: 'request' | 'settings' | 'retry' | 'disable' | null;
    isError: boolean;
};

export type PushStatusTarget = 'android' | 'ios' | 'web';

/** Remote push is unavailable in Expo Go and outside the supported native targets. */
export function isNativePushEnvironmentSupported(appOwnership: string | null | undefined, platform: string): boolean {
    return appOwnership !== 'expo' && (platform === 'android' || platform === 'ios');
}

/** Maps the runtime platform to the push transport status target. */
export function getPushStatusTarget(platform: string): PushStatusTarget {
    if (platform === 'web') return 'web';
    return platform === 'ios' ? 'ios' : 'android';
}

/** Maps granted and retryable permission outcomes to the next native push state. */
export function getNotificationPermissionState(permission: {
    granted: boolean;
    canAskAgain: boolean;
}): NativePushState {
    if (permission.granted) return NATIVE_PUSH_STATES.REGISTERING;
    return permission.canAskAgain ? NATIVE_PUSH_STATES.PERMISSION_REQUIRED : NATIVE_PUSH_STATES.BLOCKED;
}

/** Keep permission/registration status copy and recovery actions consistent in Settings. */
export function getPushStatusPresentation(
    state: NativePushState,
    target: PushStatusTarget = 'android'
): PushStatusPresentation {
    if (target === 'web') {
        switch (state) {
            case NATIVE_PUSH_STATES.CHECKING:
                return { message: 'Checking browser notification access...', action: null, isError: false };
            case NATIVE_PUSH_STATES.PERMISSION_REQUIRED:
                return {
                    message: 'Enable notifications in this browser to receive your food and weight reminders.',
                    action: 'request',
                    isError: false
                };
            case NATIVE_PUSH_STATES.BLOCKED:
                return {
                    message: 'Notifications are blocked for this site. Allow them in browser site settings, then check again.',
                    action: 'settings',
                    isError: true
                };
            case NATIVE_PUSH_STATES.REGISTERING:
                return { message: 'Registering this browser for reminders...', action: null, isError: false };
            case NATIVE_PUSH_STATES.REGISTERED:
                return { message: 'Push reminders are ready in this browser.', action: 'disable', isError: false };
            case NATIVE_PUSH_STATES.UNSUPPORTED:
                return {
                    message: 'Push notifications are unavailable in this browser or browsing mode.',
                    action: null,
                    isError: false
                };
            case NATIVE_PUSH_STATES.DISABLED:
                return {
                    message: 'Browser push is disabled by this Calibrate server.',
                    action: null,
                    isError: false
                };
            case NATIVE_PUSH_STATES.ERROR:
                return {
                    message: 'Browser push registration failed. Check the server connection and try again.',
                    action: 'retry',
                    isError: true
                };
            default:
                return { message: 'Sign in to configure notifications.', action: null, isError: false };
        }
    }

    const platformLabel = target === 'ios' ? 'iOS' : 'Android';
    switch (state) {
        case NATIVE_PUSH_STATES.CHECKING:
            return { message: 'Checking notification access...', action: null, isError: false };
        case NATIVE_PUSH_STATES.PERMISSION_REQUIRED:
            return {
                message: 'Allow notifications on this device to receive enabled food and weight reminders.',
                action: 'request',
                isError: false
            };
        case NATIVE_PUSH_STATES.BLOCKED:
            return {
                message: `Notifications are blocked for Calibrate. Enable them in ${platformLabel} settings, then check again.`,
                action: 'settings',
                isError: true
            };
        case NATIVE_PUSH_STATES.REGISTERING:
            return { message: 'Registering this device for reminders...', action: null, isError: false };
        case NATIVE_PUSH_STATES.REGISTERED:
            return { message: 'Push reminders are ready on this device.', action: null, isError: false };
        case NATIVE_PUSH_STATES.UNSUPPORTED:
            return {
                message: `Remote push is unavailable in Expo Go. Use a native ${platformLabel} development or release build.`,
                action: null,
                isError: false
            };
        case NATIVE_PUSH_STATES.DISABLED:
            return {
                message: 'Native push is disabled by this Calibrate server.',
                action: null,
                isError: false
            };
        case NATIVE_PUSH_STATES.ERROR:
            return {
                message: 'Push registration failed. Check the server connection and try again.',
                action: 'retry',
                isError: true
            };
        default:
            return { message: 'Sign in to configure notifications.', action: null, isError: false };
    }
}

const isLocalDate = (value: string | undefined): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const withOptionalDate = (
    pathname: '/log' | '/weight',
    localDate?: string
): NotificationRoute => isLocalDate(localDate) ? { pathname, params: { date: localDate } } : { pathname };

/** Resolve only known relative app routes; absolute, protocol-relative, and malformed URLs stay in-app. */
export function getNotificationAction(actionUrl: unknown, localDate?: string): NotificationAction {
    const fallback: NotificationAction = { label: 'Open Calibrate', href: '/today' };
    if (typeof actionUrl !== 'string') return fallback;

    const candidate = actionUrl.trim();
    if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;

    let parsed: URL;
    try {
        parsed = new URL(candidate, INTERNAL_ROUTE_ORIGIN);
    } catch {
        return fallback;
    }
    if (parsed.origin !== INTERNAL_ROUTE_ORIGIN) return fallback;

    const pathname = parsed.pathname.replace(/\/$/, '') || '/';
    const quickAdd = parsed.searchParams.get('quickAdd')?.trim().toLowerCase();
    if (pathname === '/log' && quickAdd === 'weight') {
        return { label: 'Log weight', href: withOptionalDate('/weight', localDate) };
    }
    if (pathname === '/log' && quickAdd === 'food') {
        return { label: 'Log food', href: withOptionalDate('/log', localDate) };
    }

    switch (pathname) {
        case '/weight':
            return { label: 'Log weight', href: withOptionalDate('/weight', localDate) };
        case '/food':
        case '/log':
            return { label: 'Log food', href: withOptionalDate('/log', localDate) };
        case '/goal':
        case '/goals':
        case '/progress':
            return { label: 'Open goals', href: '/progress' };
        case '/':
        case '/dashboard':
        case '/today':
            return { label: 'Open Calibrate', href: '/today' };
        default:
            return fallback;
    }
}

/** Prefer a tapped notification action's URL, then the notification's default URL. */
export function getNotificationResponseActionUrl(
    data: unknown,
    actionIdentifier: string | null | undefined
): unknown {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as Record<string, unknown>;
    const actionUrls = record.actionUrls;
    if (actionIdentifier && actionUrls && typeof actionUrls === 'object') {
        const actionUrl = (actionUrls as Record<string, unknown>)[actionIdentifier];
        if (typeof actionUrl === 'string') return actionUrl;
    }
    return record.url;
}
