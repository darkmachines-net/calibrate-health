/** @file operation Diagnostics: Emit one fixed operation tuple; the unknown failure is used only to extract a bounded API request ID. */

import { useEffect, useRef } from 'react';
import type { ClientDiagnosticOperation, ClientDiagnosticRoute } from '@calibrate/shared';
import {
    getClientDiagnosticRequestId,
    reportClientDiagnostic
} from './clientDiagnostics';

type FeatureOperation = Extract<
    ClientDiagnosticOperation,
    | 'onboarding_complete'
    | 'food_copy'
    | 'saved_foods_load'
    | 'weight_trend_load'
>;

const FEATURE_OPERATION_ROUTES: Record<FeatureOperation, ClientDiagnosticRoute> = {
    onboarding_complete: 'onboarding',
    food_copy: 'today',
    saved_foods_load: 'saved_foods',
    weight_trend_load: 'progress'
};

/** Emit one fixed operation tuple; the unknown failure is used only to extract a bounded API request ID. */
export function reportClientOperationFailure(operation: FeatureOperation, error: unknown): void {
    const requestId = getClientDiagnosticRequestId(error);
    void reportClientDiagnostic({
        event: 'operation_failure',
        operation,
        route: FEATURE_OPERATION_ROUTES[operation],
        outcome: 'failure',
        duration_bucket: 'not_applicable',
        ...(requestId ? { request_id: requestId } : {})
    });
}

type QueryFailureDiagnostic = {
    operation: Extract<FeatureOperation, 'saved_foods_load' | 'weight_trend_load'>;
    isError: boolean;
    error: unknown;
    errorUpdatedAt: number;
};

/** React Query may rerender one failure several times; report each concrete failure transition once. */
export function useClientQueryFailureDiagnostic({
    operation,
    isError,
    error,
    errorUpdatedAt
}: QueryFailureDiagnostic): void {
    const lastOccurrence = useRef<string | number | null>(null);

    useEffect(() => {
        if (!isError || errorUpdatedAt <= 0) return;
        const requestId = getClientDiagnosticRequestId(error);
        const occurrence = requestId ?? errorUpdatedAt;
        if (lastOccurrence.current === occurrence) return;
        lastOccurrence.current = occurrence;
        reportClientOperationFailure(operation, error);
    }, [error, errorUpdatedAt, isError, operation]);
}

/** A successful response can intentionally degrade to scale readings when the trend model is unavailable. */
export function useWeightTrendDegradationDiagnostic(degraded: boolean, dataUpdatedAt: number): void {
    const lastReportedAt = useRef(0);

    useEffect(() => {
        if (!degraded || dataUpdatedAt <= 0 || lastReportedAt.current === dataUpdatedAt) return;
        lastReportedAt.current = dataUpdatedAt;
        void reportClientDiagnostic({
            event: 'degraded_result',
            operation: 'weight_trend_load',
            route: 'progress',
            outcome: 'degraded',
            duration_bucket: 'not_applicable'
        });
    }, [dataUpdatedAt, degraded]);
}
