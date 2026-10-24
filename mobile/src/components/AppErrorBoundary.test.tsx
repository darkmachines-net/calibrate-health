/** @file Regression coverage for App Error Boundary: AppErrorBoundary. */

import { useMemo } from 'react';
import { Platform, Text } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import release from '../../../shared/release.json';
import {
    registerClientDiagnosticReporter,
    type ClientDiagnosticWireInput
} from '../diagnostics/clientDiagnostics';
import { AppErrorBoundary, restartAppRuntime } from './AppErrorBoundary';

const ROOT_REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const SENSITIVE_FAILURE = 'person@example.com ate Secret Food at https://server.example/path?token=private';

jest.mock('expo-crypto', () => ({
    randomUUID: jest.fn(() => ROOT_REQUEST_ID)
}));

const AlwaysThrows = () => {
    const error = new Error(SENSITIVE_FAILURE);
    error.stack = `Error: ${SENSITIVE_FAILURE}\n    at private-health-route`;
    throw error;
};

const ThrowingRootRuntime = () => {
    useMemo(() => {
        throw new Error('Root theme hook failed before providers mounted');
    }, []);
    return null;
};

describe('AppErrorBoundary', () => {
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
        consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleError.mockRestore();
        jest.restoreAllMocks();
    });

    it('shows a stable support reference and emits only the fixed privacy-safe tuple', async () => {
        const reportDiagnostic = jest.fn(async () => 'different-response-id');
        const view = render(
            <AppErrorBoundary reportDiagnostic={reportDiagnostic}>
                <AlwaysThrows />
            </AppErrorBoundary>
        );

        expect(view.getByTestId('app-error-boundary')).toHaveProp(
            'accessibilityLabel',
            'Calibrate encountered an unexpected error'
        );
        expect(view.getByRole('header')).toHaveTextContent('Calibrate hit a snag');
        expect(view.getByLabelText('Calibrate')).toBeTruthy();
        expect(view.getByTestId('app-error-retry')).toHaveProp('accessibilityRole', 'button');
        expect(view.getByTestId('app-error-restart')).toHaveProp('accessibilityRole', 'button');
        expect(view.getByTestId('app-error-reference')).toHaveTextContent(
            `Support reference: ${ROOT_REQUEST_ID}. Include this reference when contacting Calibrate support.`
        );
        expect(view.getByTestId('app-error-detail')).toHaveTextContent(
            'Technical details are hidden to protect your privacy.'
        );
        expect(view.queryByText(SENSITIVE_FAILURE)).toBeNull();

        await waitFor(() => expect(reportDiagnostic).toHaveBeenCalledWith({
            event: 'client_failure',
            operation: 'root_render',
            route: 'app_shell',
            outcome: 'failure',
            duration_bucket: 'not_applicable',
            request_id: ROOT_REQUEST_ID
        }));

        const emittedPayload = JSON.stringify(reportDiagnostic.mock.calls);
        expect(emittedPayload).not.toContain(SENSITIVE_FAILURE);
        expect(emittedPayload).not.toContain('private-health-route');
        expect(view.getByTestId('app-error-reference')).not.toHaveTextContent('different-response-id');
        const appOwnedConsoleCalls = consoleError.mock.calls.filter(([first]) =>
            typeof first === 'string' && first.startsWith('[calibrate]')
        );
        expect(JSON.stringify(appOwnedConsoleCalls)).not.toContain(SENSITIVE_FAILURE);
        expect(appOwnedConsoleCalls).toEqual([]);
    });

    it('replays the default reporter support reference once after confirmed registration', async () => {
        jest.replaceProperty(Platform, 'OS', 'web');
        const view = render(
            <AppErrorBoundary>
                <AlwaysThrows />
            </AppErrorBoundary>
        );

        expect(view.getByTestId('app-error-reference')).toHaveTextContent(
            `Support reference: ${ROOT_REQUEST_ID}. Include this reference when contacting Calibrate support.`
        );

        const reporter = jest.fn(async (input: ClientDiagnosticWireInput) => ({
            ok: true as const,
            request_id: input.request_id!
        }));
        const unregister = registerClientDiagnosticReporter(reporter);
        await waitFor(() => expect(reporter).toHaveBeenCalledWith({
            event: 'client_failure',
            operation: 'root_render',
            route: 'app_shell',
            platform: 'web',
            version: release.server.version,
            outcome: 'failure',
            duration_bucket: 'not_applicable',
            request_id: ROOT_REQUEST_ID
        }));
        expect(reporter).toHaveBeenCalledTimes(1);
        unregister();

        const laterReporter = jest.fn(async (input: ClientDiagnosticWireInput) => ({
            ok: true as const,
            request_id: input.request_id!
        }));
        const unregisterLater = registerClientDiagnosticReporter(laterReporter);
        await Promise.resolve();
        expect(laterReporter).not.toHaveBeenCalled();
        unregisterLater();
    });

    it('catches a root-runtime hook failure before providers mount', async () => {
        const reportDiagnostic = jest.fn(async () => ROOT_REQUEST_ID);
        const view = render(
            <AppErrorBoundary reportDiagnostic={reportDiagnostic}>
                <ThrowingRootRuntime />
            </AppErrorBoundary>
        );

        expect(view.getByTestId('app-error-boundary')).toBeTruthy();
        expect(view.getByTestId('app-error-reference')).toHaveTextContent(
            `Support reference: ${ROOT_REQUEST_ID}. Include this reference when contacting Calibrate support.`
        );
        await waitFor(() => expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'root_render',
            request_id: ROOT_REQUEST_ID
        })));
    });

    it('keeps the support reference visible when delivery fails offline', async () => {
        const reportDiagnostic = jest.fn(async () => {
            throw new TypeError('network unavailable at https://private.example');
        });
        const view = render(
            <AppErrorBoundary reportDiagnostic={reportDiagnostic}>
                <AlwaysThrows />
            </AppErrorBoundary>
        );

        await waitFor(() => expect(reportDiagnostic).toHaveBeenCalledTimes(1));
        expect(view.getByTestId('app-error-reference')).toHaveTextContent(
            `Support reference: ${ROOT_REQUEST_ID}. Include this reference when contacting Calibrate support.`
        );
    });

    it('resets and remounts the app subtree without reloading the process', () => {
        let shouldThrow = true;
        const RecoverableChild = () => {
            if (shouldThrow) throw new Error('Recoverable failure');
            return <Text>Recovered app</Text>;
        };
        const view = render(
            <AppErrorBoundary>
                <RecoverableChild />
            </AppErrorBoundary>
        );

        shouldThrow = false;
        fireEvent.press(view.getByTestId('app-error-retry'));

        expect(view.getByText('Recovered app')).toBeTruthy();
        expect(view.queryByRole('alert')).toBeNull();
    });

    it('offers a full app restart when resetting is not enough', () => {
        const restartApp = jest.fn();
        const view = render(
            <AppErrorBoundary restartApp={restartApp}>
                <AlwaysThrows />
            </AppErrorBoundary>
        );

        fireEvent.press(view.getByTestId('app-error-restart'));

        expect(restartApp).toHaveBeenCalledTimes(1);
    });

    it('uses the browser reload host on web and the native host elsewhere', () => {
        const reloadWeb = jest.fn();
        const reloadNative = jest.fn();

        restartAppRuntime('web', reloadWeb, reloadNative);
        expect(reloadWeb).toHaveBeenCalledTimes(1);
        expect(reloadNative).not.toHaveBeenCalled();

        restartAppRuntime('android', reloadWeb, reloadNative);
        expect(reloadNative).toHaveBeenCalledTimes(1);
    });
});
