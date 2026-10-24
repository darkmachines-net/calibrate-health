/** @file Client Web Vitals Runtime: Observe at most once, and only when the document itself opened on an authenticated route. */

import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import type { ClientDiagnosticRoute } from '@calibrate/shared';
import { useAuth } from '../auth/AuthContext';
import { getRouteByPath } from '../navigation/routeRegistry';
import { getClientDiagnosticRoute, observeClientWebVitals } from './webVitals.web';

type InitialDocumentRoute = {
    diagnosticRoute: ClientDiagnosticRoute;
    isAuthenticatedRoute: boolean;
};

/** Observe at most once, and only when the document itself opened on an authenticated route. */
export function ClientWebVitalsRuntime() {
    const pathname = usePathname();
    const { isLoading, user } = useAuth();
    const hasConfirmedUser = !isLoading && user !== null;
    const initialDocumentRoute = useRef<InitialDocumentRoute | null>(null);
    const hasObservedDocument = useRef(false);
    const cleanupRef = useRef<((flushBeforeDisconnect?: boolean) => void) | null>(null);

    if (initialDocumentRoute.current === null) {
        const match = getRouteByPath(pathname);
        initialDocumentRoute.current = {
            diagnosticRoute: getClientDiagnosticRoute(pathname),
            isAuthenticatedRoute: match?.definition.authClass === 'authenticated'
        };
    }

    useEffect(() => {
        const initialRoute = initialDocumentRoute.current;
        if (
            hasConfirmedUser
            && initialRoute?.isAuthenticatedRoute
            && !hasObservedDocument.current
        ) {
            hasObservedDocument.current = true;
            cleanupRef.current = observeClientWebVitals(initialRoute.diagnosticRoute);
            return;
        }
        if (!hasConfirmedUser && cleanupRef.current) {
            cleanupRef.current(false);
            cleanupRef.current = null;
        }
    }, [hasConfirmedUser]);

    useEffect(() => () => {
        cleanupRef.current?.(false);
        cleanupRef.current = null;
    }, []);

    return null;
}
