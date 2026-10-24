/** @file presentation: Keep Activity and Settings aligned on permission, connection, and sync state copy. */

import {
    DEFAULT_HEALTH_CONNECT_SELECTION,
    type HealthConnectAvailability,
    type HealthConnectFeature,
    type HealthConnectFeatureSelection
} from './types';

const HEALTH_CONNECT_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // Flag foreground imports that have not succeeded for most of a waking day.

type HealthConnectPresentationState =
    | 'loading'
    | 'unavailable'
    | 'disconnected'
    | 'denied'
    | 'syncing'
    | 'stale'
    | 'empty'
    | 'failed_sync'
    | 'paused'
    | 'ready'
    | 'error';

type HealthConnectConnectionActionKind =
    | 'connect'
    | 'manage'
    | 'update_provider'
    | null;

export type HealthConnectPresentation = {
    state: HealthConnectPresentationState;
    message: string;
    tone: 'neutral' | 'positive' | 'caution' | 'danger';
    action: HealthConnectConnectionActionKind;
    actionLabel: string | null;
    shouldShowActivity: boolean;
    missingFeatures: HealthConnectFeature[];
};

export type HealthConnectPresentationInput = {
    availability: HealthConnectAvailability | null | undefined;
    connected: boolean;
    paused: boolean;
    isLoading: boolean;
    isSyncing: boolean;
    error: string | null;
    syncError: string | null;
    selection?: HealthConnectFeatureSelection;
    grantedFeatures?: readonly HealthConnectFeature[];
    hasImportedActivity?: boolean;
    lastSuccessfulSyncAt?: string | null;
    now?: Date;
};

function connectionAction(
    availability: HealthConnectAvailability | null | undefined,
    connected: boolean
): Pick<HealthConnectPresentation, 'action' | 'actionLabel'> {
    if (availability === 'provider_update_required') {
        return { action: 'update_provider', actionLabel: 'Update Health Connect' };
    }
    if (availability !== 'available') return { action: null, actionLabel: null };
    if (connected) return { action: 'manage', actionLabel: 'Manage Health Connect' };
    return { action: 'connect', actionLabel: 'Connect Health Connect' };
}

function isStale(value: string | null | undefined, now: Date): boolean {
    if (!value) return false;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return false;
    return now.getTime() - parsed.getTime() > HEALTH_CONNECT_STALE_AFTER_MS;
}

/** Keep Activity and Settings aligned on permission, connection, and sync state copy. */
export function getHealthConnectPresentation(
    input: HealthConnectPresentationInput
): HealthConnectPresentation {
    const selection = input.selection ?? DEFAULT_HEALTH_CONNECT_SELECTION;
    const granted = new Set(input.grantedFeatures ?? []);
    const enabledFeatures = (Object.entries(selection) as Array<[HealthConnectFeature, boolean]>)
        .filter(([, enabled]) => enabled)
        .map(([feature]) => feature);
    const missingFeatures = enabledFeatures.filter((feature) => !granted.has(feature));
    const hasImportedActivity = input.hasImportedActivity ?? false;
    const shouldShowActivity = input.connected || hasImportedActivity;
    const action = connectionAction(input.availability, input.connected);
    const result = (
        state: HealthConnectPresentationState,
        message: string,
        tone: HealthConnectPresentation['tone']
    ): HealthConnectPresentation => ({
        state,
        message,
        tone,
        ...action,
        shouldShowActivity,
        missingFeatures
    });

    if (input.isLoading) {
        return result('loading', 'Checking Health Connect...', 'neutral');
    }

    if (input.availability !== 'available') {
        switch (input.availability) {
            case 'provider_update_required':
                return result('unavailable', 'Update Health Connect before Calibrate can import activity.', 'caution');
            case 'not_android':
                return result('unavailable', 'Health Connect is available in the Calibrate Android app.', 'neutral');
            default:
                return result('unavailable', 'Health Connect is not available on this device.', 'neutral');
        }
    }

    if (input.error) return result('error', input.error, 'danger');

    if (!input.connected) {
        return result(
            'disconnected',
            'Connect Health Connect to import read-only activity from apps on this phone.',
            'neutral'
        );
    }

    if (missingFeatures.length > 0) {
        return result(
            'denied',
            'Health Connect access needs review. Allow the selected data types to resume imports.',
            'caution'
        );
    }

    if (input.isSyncing) return result('syncing', 'Syncing activity from Health Connect...', 'neutral');
    if (input.syncError) return result('failed_sync', input.syncError, 'danger');
    if (input.paused) return result('paused', 'Health Connect sync is paused.', 'caution');
    if (isStale(input.lastSuccessfulSyncAt, input.now ?? new Date())) {
        return result(
            'stale',
            'Health Connect has not synced recently. Activity from connected apps may still be arriving.',
            'caution'
        );
    }
    if (!hasImportedActivity) {
        return result(
            'empty',
            'Health Connect is connected. No imported activity is available yet.',
            'neutral'
        );
    }

    return result('ready', 'Health Connect is connected and activity is up to date.', 'positive');
}

/** Formats a synchronization timestamp into freshness copy, distinguishing missing and invalid timestamps. */
export function formatHealthConnectFreshness(value: string | null, now = new Date()): string {
    if (!value) return 'Not synced yet';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Sync time unavailable';

    const elapsedMinutes = Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60_000));
    if (elapsedMinutes < 1) return 'Synced just now';
    if (elapsedMinutes < 60) return `Synced ${elapsedMinutes}m ago`;
    const elapsedHours = Math.round(elapsedMinutes / 60);
    if (elapsedHours < 24) return `Synced ${elapsedHours}h ago`;
    return `Synced ${parsed.toLocaleDateString()}`;
}
