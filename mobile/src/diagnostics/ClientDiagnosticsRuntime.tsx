/** @file Routes diagnostics through the configured auth client after session initialization. */

import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { registerClientDiagnosticReporter } from './clientDiagnostics';

/**
 * Keep diagnostics bound to the configured backend in the current auth context.
 * Bootstrap failures remain local until session initialization finishes.
 */
export function ClientDiagnosticsRuntime() {
    const { api, isLoading } = useAuth();

    useEffect(() => {
        if (isLoading) return undefined;
        return registerClientDiagnosticReporter((input) => api.reportClientDiagnostic(input));
    }, [api, isLoading]);

    return null;
}
