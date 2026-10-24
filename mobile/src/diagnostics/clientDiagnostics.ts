/** @file Bounded client diagnostics, provider-independent startup failures, and configured server transport. */

import { Platform } from 'react-native';
import { ApiError } from '@calibrate/api-client';
import {
    CLIENT_DIAGNOSTIC_DURATION_BUCKETS,
    CLIENT_DIAGNOSTIC_EVENTS,
    CLIENT_DIAGNOSTIC_OPERATIONS,
    CLIENT_DIAGNOSTIC_OUTCOMES,
    CLIENT_DIAGNOSTIC_ROUTES,
    isClientDiagnosticRequestId,
    type ClientDiagnosticInput,
    type ClientDiagnosticPlatform,
    type ClientDiagnosticResponse
} from '@calibrate/shared';
import release from '../../../shared/release.json';
import { MOBILE_CLIENT_IDENTITY } from '../config/nativeClient';

type SupportedClientDiagnosticPlatform = Extract<ClientDiagnosticPlatform, 'web' | 'android_phone' | 'ios'>;

export type ClientDiagnosticSignal = Omit<ClientDiagnosticInput, 'platform' | 'version'>;
export type ClientDiagnosticWireInput = ClientDiagnosticInput;

export type ClientDiagnosticReporter = (
    input: ClientDiagnosticWireInput
) => Promise<ClientDiagnosticResponse>;

type DeferredRootDiagnostic = {
    event: 'client_failure';
    operation: 'root_render';
    route: 'app_shell';
    outcome: 'failure';
    duration_bucket: 'not_applicable';
    request_id: string;
};

const EVENT_SET = new Set<string>(CLIENT_DIAGNOSTIC_EVENTS);
const OPERATION_SET = new Set<string>(CLIENT_DIAGNOSTIC_OPERATIONS);
const ROUTE_SET = new Set<string>(CLIENT_DIAGNOSTIC_ROUTES);
const OUTCOME_SET = new Set<string>(CLIENT_DIAGNOSTIC_OUTCOMES);
const DURATION_BUCKET_SET = new Set<string>(CLIENT_DIAGNOSTIC_DURATION_BUCKETS);

let activeReporter: ClientDiagnosticReporter | null = null;
let pendingRootDiagnostic: DeferredRootDiagnostic | null = null;

/** Register the confirmed server transport and replay one provider-independent root failure. */
export function registerClientDiagnosticReporter(reporter: ClientDiagnosticReporter): () => void {
    activeReporter = reporter;
    const pending = pendingRootDiagnostic;
    if (pending) {
        pendingRootDiagnostic = null;
        void reportClientDiagnostic(pending).then((acceptedRequestId) => {
            if (acceptedRequestId === null && pendingRootDiagnostic === null) {
                pendingRootDiagnostic = pending;
            }
        });
    }
    return () => {
        if (activeReporter === reporter) activeReporter = null;
    };
}

function getClientDiagnosticIdentity(): {
    platform: SupportedClientDiagnosticPlatform;
    version: string;
} | null {
    if (Platform.OS === 'web') {
        return { platform: 'web', version: release.server.version };
    }
    if (Platform.OS === 'android' || Platform.OS === 'ios') {
        return {
            platform: Platform.OS === 'ios' ? 'ios' : 'android_phone',
            version: MOBILE_CLIENT_IDENTITY.version
        };
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFixedClientDiagnosticSignal(value: unknown): value is ClientDiagnosticSignal {
    if (!isRecord(value)) return false;
    return typeof value.event === 'string'
        && EVENT_SET.has(value.event)
        && typeof value.operation === 'string'
        && OPERATION_SET.has(value.operation)
        && typeof value.route === 'string'
        && ROUTE_SET.has(value.route)
        && typeof value.outcome === 'string'
        && OUTCOME_SET.has(value.outcome)
        && typeof value.duration_bucket === 'string'
        && DURATION_BUCKET_SET.has(value.duration_bucket);
}

function toDeferredRootDiagnostic(value: ClientDiagnosticSignal): DeferredRootDiagnostic | null {
    if (
        value.event !== 'client_failure'
        || value.operation !== 'root_render'
        || value.route !== 'app_shell'
        || value.outcome !== 'failure'
        || value.duration_bucket !== 'not_applicable'
        || !isClientDiagnosticRequestId(value.request_id)
    ) return null;
    return {
        event: 'client_failure',
        operation: 'root_render',
        route: 'app_shell',
        outcome: 'failure',
        duration_bucket: 'not_applicable',
        request_id: value.request_id
    };
}

/** Best-effort diagnostics rebuild the exact wire shape so caller aliases and payloads cannot survive. */
export async function reportClientDiagnostic(signal: ClientDiagnosticSignal): Promise<string | null> {
    const identity = getClientDiagnosticIdentity();
    if (!identity || !isFixedClientDiagnosticSignal(signal)) return null;

    const reporter = activeReporter;
    if (!reporter) {
        const deferredRoot = toDeferredRootDiagnostic(signal);
        if (deferredRoot) pendingRootDiagnostic = deferredRoot;
        return null;
    }

    try {
        const requestId = isClientDiagnosticRequestId(signal.request_id) ? signal.request_id : undefined;
        const response = await reporter({
            event: signal.event,
            operation: signal.operation,
            route: signal.route,
            platform: identity.platform,
            version: identity.version,
            outcome: signal.outcome,
            duration_bucket: signal.duration_bucket,
            ...(requestId ? { request_id: requestId } : {})
        });
        return isClientDiagnosticRequestId(response.request_id) ? response.request_id : null;
    } catch {
        return null;
    }
}

/** ApiError is admitted only when its bounded token also matches the shared opaque-ID format. */
export function getClientDiagnosticRequestId(error: unknown): string | undefined {
    const requestId = error instanceof ApiError ? error.requestId : null;
    return isClientDiagnosticRequestId(requestId) ? requestId : undefined;
}
