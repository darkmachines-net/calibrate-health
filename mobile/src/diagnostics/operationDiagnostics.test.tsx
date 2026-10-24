/** @file Regression coverage for operation Diagnostics: fixed client operation diagnostics. */

import { renderHook, waitFor } from '@testing-library/react-native';
import {
    reportClientDiagnostic,
    getClientDiagnosticRequestId
} from './clientDiagnostics';
import {
    reportClientOperationFailure,
    useClientQueryFailureDiagnostic,
    useWeightTrendDegradationDiagnostic
} from './operationDiagnostics';

jest.mock('./clientDiagnostics', () => ({
    reportClientDiagnostic: jest.fn(async () => null),
    getClientDiagnosticRequestId: jest.fn((error: { requestId?: string } | null) => error?.requestId)
}));

const mockReportClientDiagnostic = reportClientDiagnostic as jest.MockedFunction<typeof reportClientDiagnostic>;
const mockGetClientDiagnosticRequestId = getClientDiagnosticRequestId as jest.MockedFunction<
    typeof getClientDiagnosticRequestId
>;

describe('fixed client operation diagnostics', () => {
    beforeEach(() => {
        mockReportClientDiagnostic.mockClear();
        mockGetClientDiagnosticRequestId.mockClear();
    });

    it('emits only the registered operation tuple and bounded request ID', () => {
        const error = {
            requestId: 'abcdef0123456789',
            message: 'person@example.com copied Secret Food from https://private.example'
        };

        reportClientOperationFailure('food_copy', error);

        expect(mockReportClientDiagnostic).toHaveBeenCalledWith({
            event: 'operation_failure',
            operation: 'food_copy',
            route: 'today',
            outcome: 'failure',
            duration_bucket: 'not_applicable',
            request_id: 'abcdef0123456789'
        });
        expect(JSON.stringify(mockReportClientDiagnostic.mock.calls)).not.toContain(error.message);
    });

    it('does not duplicate one query failure across rerenders', async () => {
        const firstError = { requestId: '1111111111111111', message: 'private health payload' };
        const secondError = { requestId: '2222222222222222', message: 'private food payload' };
        const { rerender } = await renderHook(
            (props: { error: unknown; errorUpdatedAt: number }) => useClientQueryFailureDiagnostic({
                operation: 'saved_foods_load',
                isError: true,
                error: props.error,
                errorUpdatedAt: props.errorUpdatedAt
            }),
            { initialProps: { error: firstError, errorUpdatedAt: 100 } }
        );

        await waitFor(() => expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(1));
        await rerender({ error: firstError, errorUpdatedAt: 100 });
        expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(1);

        await rerender({ error: secondError, errorUpdatedAt: 200 });
        await waitFor(() => expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(2));
        expect(mockReportClientDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
            operation: 'saved_foods_load',
            request_id: '2222222222222222'
        }));
    });

    it('reports each degraded trend response once by data transition', async () => {
        const { rerender } = await renderHook(
            (props: { degraded: boolean; dataUpdatedAt: number }) =>
                useWeightTrendDegradationDiagnostic(props.degraded, props.dataUpdatedAt),
            { initialProps: { degraded: true, dataUpdatedAt: 100 } }
        );

        await waitFor(() => expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(1));
        await rerender({ degraded: true, dataUpdatedAt: 100 });
        expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(1);

        await rerender({ degraded: false, dataUpdatedAt: 200 });
        expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(1);
        await rerender({ degraded: true, dataUpdatedAt: 300 });
        await waitFor(() => expect(mockReportClientDiagnostic).toHaveBeenCalledTimes(2));
        expect(mockReportClientDiagnostic).toHaveBeenLastCalledWith({
            event: 'degraded_result',
            operation: 'weight_trend_load',
            route: 'progress',
            outcome: 'degraded',
            duration_bucket: 'not_applicable'
        });
    });
});
