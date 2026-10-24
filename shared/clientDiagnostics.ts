/** @file Bounded privacy-safe diagnostic event contracts and support correlation identifiers. */

export const CLIENT_DIAGNOSTIC_EVENTS = [
    'client_failure',
    'operation_failure',
    'degraded_result',
    'web_vital'
] as const;

export const CLIENT_DIAGNOSTIC_OPERATIONS = [
    'root_render',
    'onboarding_complete',
    'food_copy',
    'saved_foods_load',
    'notification_history_page',
    'weight_trend_load',
    'largest_contentful_paint',
    'interaction_to_next_paint',
    'cumulative_layout_shift'
] as const;

export const CLIENT_DIAGNOSTIC_ROUTES = [
    'app_shell',
    'onboarding',
    'today',
    'saved_foods',
    'notifications',
    'progress'
] as const;

export const CLIENT_DIAGNOSTIC_PLATFORMS = ['web', 'android_phone', 'ios', 'wear_os'] as const;

export const CLIENT_DIAGNOSTIC_REQUEST_ID_PATTERN = /^(?:[a-fA-F0-9]{16,64}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12})$/;

/** Recognize bounded opaque trace IDs that are safe to use for support correlation. */
export const isClientDiagnosticRequestId = (value: unknown): value is string =>
    typeof value === 'string' && CLIENT_DIAGNOSTIC_REQUEST_ID_PATTERN.test(value);

export const CLIENT_DIAGNOSTIC_OUTCOMES = [
    'failure',
    'degraded',
    'good',
    'needs_improvement',
    'poor'
] as const;

export const CLIENT_DIAGNOSTIC_DURATION_BUCKETS = [
    'not_applicable',
    'under_100_ms',
    '100_to_200_ms',
    '200_to_500_ms',
    '500_ms_to_1_s',
    '1_to_2_5_s',
    '2_5_to_4_s',
    '4_s_or_more'
] as const;

export type ClientDiagnosticEvent = (typeof CLIENT_DIAGNOSTIC_EVENTS)[number];
export type ClientDiagnosticOperation = (typeof CLIENT_DIAGNOSTIC_OPERATIONS)[number];
export type ClientDiagnosticRoute = (typeof CLIENT_DIAGNOSTIC_ROUTES)[number];
export type ClientDiagnosticPlatform = (typeof CLIENT_DIAGNOSTIC_PLATFORMS)[number];
export type ClientDiagnosticOutcome = (typeof CLIENT_DIAGNOSTIC_OUTCOMES)[number];
export type ClientDiagnosticDurationBucket = (typeof CLIENT_DIAGNOSTIC_DURATION_BUCKETS)[number];

export type ClientDiagnosticInput = {
    event: ClientDiagnosticEvent;
    operation: ClientDiagnosticOperation;
    route: ClientDiagnosticRoute;
    platform: ClientDiagnosticPlatform;
    version: string;
    outcome: ClientDiagnosticOutcome;
    duration_bucket: ClientDiagnosticDurationBucket;
    request_id?: string;
};

export type ClientDiagnosticResponse = {
    ok: true;
    request_id: string;
};
