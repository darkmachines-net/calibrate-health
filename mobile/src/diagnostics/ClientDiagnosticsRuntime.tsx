/** @file Client Diagnostics Runtime: Keep diagnostics bound to the same confirmed server as the current auth context. Bootstrap failures remain local because reporting to the hosted default could cross a self-host boundary. */

import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { registerClientDiagnosticReporter } from './clientDiagnostics';

/**
 * Keep diagnostics bound to the same confirmed server as the current auth context.
 * Bootstrap failures remain local because reporting to the hosted default could cross a self-host boundary.
 */
export function ClientDiagnosticsRuntime() {
    const { api, isLoading } = useAuth();

    useEffect(() => {
        if (isLoading) return undefined;
        return registerClientDiagnosticReporter((input) => api.reportClientDiagnostic(input));
    }, [api, isLoading]);

    return null;
}
