/** @file Health Connect availability, permission, connection, and synchronization contracts. */

export const HEALTH_CONNECT_FEATURES = {
    STEPS: 'steps',
    ACTIVE_CALORIES: 'active_calories',
    TOTAL_CALORIES: 'total_calories',
    EXERCISE: 'exercise',
    WEIGHT: 'weight'
} as const;

export type HealthConnectFeature = (typeof HEALTH_CONNECT_FEATURES)[keyof typeof HEALTH_CONNECT_FEATURES];

export type HealthConnectAvailability =
    | 'available'
    | 'provider_update_required'
    | 'unsupported'
    | 'not_android';

export type HealthConnectConnection = {
    availability: HealthConnectAvailability;
    initialized: boolean;
    grantedFeatures: HealthConnectFeature[];
};
export type HealthConnectFeatureSelection = Record<HealthConnectFeature, boolean>;

export const DEFAULT_HEALTH_CONNECT_SELECTION: HealthConnectFeatureSelection = {
    steps: true,
    active_calories: true,
    total_calories: true,
    exercise: true,
    // Weight remains opt-in so connecting activity never silently imports body measurements.
    weight: false
};
