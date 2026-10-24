/** @file weight Trend Parameters: Versioned Weight Trend v2 parameter manifest. */

/**
 * Versioned Weight Trend v2 parameter manifest.
 *
 * Model behavior must be reproducible from this object. Any numeric change requires
 * a model-version bump and a regenerated tuning report that passes the release gates.
 */
export const WEIGHT_TREND_PARAMETER_MANIFEST = {
    manifestVersion: 1,
    modelVersion: 2,
    confidence: {
        level: 0.95,
        zScore: 1.96
    },
    measurement: {
        defaultStdKg: 0.9,
        minimumStdKg: 0.25,
        maximumStdKg: 3.5,
        shrinkagePoints: 10
    },
    filter: {
        initialRateStdKgPerDay: 0.15,
        rateProcessStdKgPerDaySqrtDay: 0.007,
        minimumVariance: 1e-10,
        huberK: 2.5,
        segmentResetDays: 14
    },
    currentRate: {
        estimand: 'latest_local_velocity_state',
        sufficientEvidencePoints: 3,
        sufficientEvidenceSpanDays: 7
    },
    calibrationWindowAverageRate: {
        estimand: 'robust_average_rate_over_exact_uninterrupted_window',
        defaultWindowDays: 28,
        minimumWindowDays: 7,
        maximumWindowDays: 42,
        minimumResidualStdKg: 0.02
    },
    legacySummary: {
        recentWindowPoints: 14,
        lowVolatilityStdKg: 0.5,
        mediumVolatilityStdKg: 1.2,
        steadyRateKgPerWeek: 0.05
    }
} as const;

/**
 * Fingerprint of the approved v2 numeric parameters, excluding manifest/model versions.
 * Keep this baseline pinned while evaluating a candidate; numeric changes pass governance
 * only after the candidate model version is greater than this approved version.
 */
export const WEIGHT_TREND_APPROVED_NUMERIC_PARAMETER_BASELINE = {
    modelVersion: 2,
    sha256: '848378b772e64d0e40cfa8974a26ec5bc798b77cc6fdc785bd83462b7199c195'
} as const;

export type WeightTrendParameterManifest = typeof WEIGHT_TREND_PARAMETER_MANIFEST;
