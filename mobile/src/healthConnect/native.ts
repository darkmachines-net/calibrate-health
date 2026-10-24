/** @file Lazy Android Health Connect SDK boundary for availability, permissions, records, and aggregates. */

import { Platform } from 'react-native';
import type {
    AggregateResult,
    AggregateResultRecordType,
    GetChangesResults,
    Permission,
    ReadRecordsOptions,
    ReadRecordsResult,
    RecordType,
    RevokeAllPermissionsResponse
} from 'react-native-health-connect';
import { grantedFeaturesForPermissions, permissionsForSelection } from './permissions';
import type {
    HealthConnectAvailability,
    HealthConnectConnection,
    HealthConnectFeatureSelection
} from './types';

const HEALTH_CONNECT_PROVIDER_PACKAGE = 'com.google.android.apps.healthdata';
const SDK_PROVIDER_UPDATE_REQUIRED = 2;
const SDK_AVAILABLE = 3;

type NativeHealthConnect = typeof import('react-native-health-connect');
type HealthConnectTimeRangeFilter = ReadRecordsOptions['timeRangeFilter'];

let nativeModulePromise: Promise<NativeHealthConnect> | null = null;

async function loadNativeModule(): Promise<NativeHealthConnect> {
    if (!nativeModulePromise) {
        // Keep the Android bridge lazy for Jest/web. Metro's async-import transform resolves hoisted
        // workspace packages relative to the app root and misses this package's `src/index.tsx` entry.
        // A lazy CommonJS require uses Metro's normal package resolver without loading it off Android.
        nativeModulePromise = Promise.resolve(require('react-native-health-connect') as NativeHealthConnect);
    }
    return nativeModulePromise;
}

/** Maps Health Connect SDK availability codes into the supported connection states. */
export function mapSdkStatus(status: number): HealthConnectAvailability {
    if (status === SDK_AVAILABLE) return 'available';
    if (status === SDK_PROVIDER_UPDATE_REQUIRED) return 'provider_update_required';
    return 'unsupported';
}

/** Narrow platform adapter; UI and sync code should never import the third-party bridge directly. */
export async function getHealthConnectConnection(): Promise<HealthConnectConnection> {
    if (Platform.OS !== 'android') {
        return { availability: 'not_android', initialized: false, grantedFeatures: [] };
    }

    const native = await loadNativeModule();
    const availability = mapSdkStatus(await native.getSdkStatus(HEALTH_CONNECT_PROVIDER_PACKAGE));
    if (availability !== 'available') {
        return { availability, initialized: false, grantedFeatures: [] };
    }

    const initialized = await native.initialize(HEALTH_CONNECT_PROVIDER_PACKAGE);
    if (!initialized) return { availability, initialized: false, grantedFeatures: [] };
    const permissions = await native.getGrantedPermissions();
    return {
        availability,
        initialized: true,
        grantedFeatures: grantedFeaturesForPermissions(permissions as Permission[])
    };
}

/** Requests only the selected read permissions after initialization and returns actual granted features. */
export async function requestHealthConnectFeatures(
    selection: HealthConnectFeatureSelection
): Promise<HealthConnectConnection> {
    const connection = await getHealthConnectConnection();
    if (!connection.initialized) return connection;

    const native = await loadNativeModule();
    const permissions = await native.requestPermission(permissionsForSelection(selection));
    return {
        ...connection,
        grantedFeatures: grantedFeaturesForPermissions(permissions as Permission[])
    };
}

/** Reads Health Connect changes using an existing token or starts a feed for one record type. */
export async function getHealthConnectChanges(
    recordType: RecordType,
    changesToken?: string
): Promise<GetChangesResults> {
    const native = await loadNativeModule();
    return native.getChanges(changesToken ? { changesToken } : { recordTypes: [recordType] });
}

/** Reads one ascending page of native records within the supplied time interval. */
export async function readHealthConnectRecords<T extends RecordType>(
    recordType: T,
    timeRangeFilter: HealthConnectTimeRangeFilter,
    pageToken?: string
): Promise<ReadRecordsResult<T>> {
    const native = await loadNativeModule();
    const options: ReadRecordsOptions = {
        timeRangeFilter,
        ascendingOrder: true,
        pageSize: 500,
        ...(pageToken ? { pageToken } : {})
    };
    return native.readRecords(recordType, options);
}

/** Aggregates one supported Health Connect metric over the supplied time interval. */
export async function aggregateHealthConnectRecords<T extends AggregateResultRecordType>(
    recordType: T,
    timeRangeFilter: HealthConnectTimeRangeFilter
): Promise<AggregateResult<T>> {
    const native = await loadNativeModule();
    return native.aggregateRecord({ recordType, timeRangeFilter });
}

/** Opens the native Health Connect access-management screen. */
export async function openHealthConnectAccess(): Promise<void> {
    const native = await loadNativeModule();
    native.openHealthConnectSettings();
}

/** Revokes Health Connect permissions on Android and normalizes platform-specific revocation results. */
export async function disconnectHealthConnect(): Promise<RevokeAllPermissionsResponse | void> {
    if (Platform.OS !== 'android') return;
    const native = await loadNativeModule();
    const response = await native.revokeAllPermissions() as RevokeAllPermissionsResponse | boolean | void;
    return normalizeRevocationResponse(response, Platform.Version);
}

/** Normalize the bridge's legacy boolean response and Android 14 deferred-revocation behavior. */
export function normalizeRevocationResponse(
    response: RevokeAllPermissionsResponse | boolean | void,
    androidVersion: number | string
): RevokeAllPermissionsResponse | void {
    if (typeof response === 'boolean') {
        return {
            revoked: response,
            requiresRestart: response && Number(androidVersion) >= 34
        };
    }
    if (response?.revoked && response.requiresRestart === undefined && Number(androidVersion) >= 34) {
        return { ...response, requiresRestart: true };
    }
    return response;
}
