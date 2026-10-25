/** @file Regression coverage for Client Diagnostics Runtime: ClientDiagnosticsRuntime. */

import { render } from '@testing-library/react-native';
import { useAuth } from '../auth/AuthContext';
import { registerClientDiagnosticReporter } from './clientDiagnostics';
import { ClientDiagnosticsRuntime } from './ClientDiagnosticsRuntime';

jest.mock('../auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('./clientDiagnostics', () => ({ registerClientDiagnosticReporter: jest.fn() }));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockRegisterClientDiagnosticReporter = registerClientDiagnosticReporter as jest.MockedFunction<
    typeof registerClientDiagnosticReporter
>;

function authState(isLoading: boolean, reportClientDiagnostic = jest.fn()): ReturnType<typeof useAuth> {
    return { api: { reportClientDiagnostic }, isLoading } as unknown as ReturnType<typeof useAuth>;
}

describe('ClientDiagnosticsRuntime', () => {
    beforeEach(() => {
        mockRegisterClientDiagnosticReporter.mockReset();
        mockRegisterClientDiagnosticReporter.mockReturnValue(jest.fn());
    });

    it('waits for auth hydration before binding diagnostics to the confirmed server', async () => {
        const reportClientDiagnostic = jest.fn();
        mockUseAuth.mockReturnValue(authState(true, reportClientDiagnostic));
        const view = await render(<ClientDiagnosticsRuntime />);

        expect(mockRegisterClientDiagnosticReporter).not.toHaveBeenCalled();

        mockUseAuth.mockReturnValue(authState(false, reportClientDiagnostic));
        await view.rerender(<ClientDiagnosticsRuntime />);

        expect(mockRegisterClientDiagnosticReporter).toHaveBeenCalledTimes(1);
        const reporter = mockRegisterClientDiagnosticReporter.mock.calls[0][0];
        const diagnostic: Parameters<typeof reporter>[0] = {
            event: 'client_failure',
            operation: 'root_render',
            route: 'app_shell',
            platform: 'web',
            version: '0.14.0',
            outcome: 'failure',
            duration_bucket: 'not_applicable'
        };
        reporter(diagnostic);
        expect(reportClientDiagnostic).toHaveBeenCalledWith(diagnostic);
    });
});
