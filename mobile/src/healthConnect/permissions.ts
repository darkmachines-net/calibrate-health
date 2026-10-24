/** @file permissions: Convert visible product settings into the least-privilege Health Connect request. */

import type { Permission } from 'react-native-health-connect';
import {
    DEFAULT_HEALTH_CONNECT_SELECTION,
    HEALTH_CONNECT_FEATURES,
    type HealthConnectFeature,
    type HealthConnectFeatureSelection
} from './types';

const HEALTH_CONNECT_RECORD_TYPES = {
    [HEALTH_CONNECT_FEATURES.STEPS]: 'Steps',
    [HEALTH_CONNECT_FEATURES.ACTIVE_CALORIES]: 'ActiveCaloriesBurned',
    [HEALTH_CONNECT_FEATURES.TOTAL_CALORIES]: 'TotalCaloriesBurned',
    [HEALTH_CONNECT_FEATURES.EXERCISE]: 'ExerciseSession',
    [HEALTH_CONNECT_FEATURES.WEIGHT]: 'Weight'
} as const;

type SupportedRecordType = (typeof HEALTH_CONNECT_RECORD_TYPES)[HealthConnectFeature];

/** Convert visible product settings into the least-privilege Health Connect request. */
export function permissionsForSelection(
    selection: HealthConnectFeatureSelection = DEFAULT_HEALTH_CONNECT_SELECTION
): Permission[] {
    return (Object.entries(selection) as Array<[HealthConnectFeature, boolean]>)
        .filter(([, enabled]) => enabled)
        .map(([feature]) => ({
            accessType: 'read' as const,
            recordType: HEALTH_CONNECT_RECORD_TYPES[feature]
        }));
}
/** Maps granted read permissions to supported feature choices. */
export function grantedFeaturesForPermissions(permissions: Permission[]): HealthConnectFeature[] {
    const grantedRecordTypes = new Set(
        permissions
            .filter((permission) => permission.accessType === 'read')
            .map((permission) => permission.recordType)
    );

    return (Object.entries(HEALTH_CONNECT_RECORD_TYPES) as Array<[HealthConnectFeature, SupportedRecordType]>)
        .filter(([, recordType]) => grantedRecordTypes.has(recordType))
        .map(([feature]) => feature);
}
