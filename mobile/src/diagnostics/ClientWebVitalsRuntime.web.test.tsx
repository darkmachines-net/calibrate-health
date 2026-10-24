/** @file Regression coverage for Client Web Vitals Runtime web: ClientWebVitalsRuntime. */

import { render } from '@testing-library/react-native';
import { usePathname } from 'expo-router';
import { useAuth } from '../auth/AuthContext';
import {
    getClientDiagnosticRoute,
    observeClientWebVitals
} from './webVitals.web';
import { ClientWebVitalsRuntime } from './ClientWebVitalsRuntime.web';

jest.mock('expo-router', () => ({ usePathname: jest.fn() }));
jest.mock('../auth/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('./webVitals.web', () => ({
    getClientDiagnosticRoute: jest.fn((pathname: string) => pathname === '/today' ? 'today' : 'app_shell'),
    observeClientWebVitals: jest.fn(() => jest.fn())
}));

const mockUsePathname = usePathname as jest.MockedFunction<typeof usePathname>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockGetClientDiagnosticRoute = getClientDiagnosticRoute as jest.MockedFunction<
    typeof getClientDiagnosticRoute
>;
const mockObserveClientWebVitals = observeClientWebVitals as jest.MockedFunction<typeof observeClientWebVitals>;

function authState(isLoading: boolean, hasUser: boolean): ReturnType<typeof useAuth> {
    return {
        isLoading,
        user: hasUser ? { id: 'user-1' } : null
    } as ReturnType<typeof useAuth>;
}

describe('ClientWebVitalsRuntime', () => {
    beforeEach(() => {
        mockGetClientDiagnosticRoute.mockClear();
        mockObserveClientWebVitals.mockClear();
        mockUseAuth.mockReturnValue(authState(false, true));
    });

    it('starts one buffered observer for a direct Today document after auth confirmation', async () => {
        const cleanup = jest.fn();
        mockObserveClientWebVitals.mockReturnValue(cleanup);
        mockUsePathname.mockReturnValue('/today');
        mockUseAuth.mockReturnValue(authState(true, false));
        const view = await render(<ClientWebVitalsRuntime />);

        expect(mockGetClientDiagnosticRoute).toHaveBeenCalledWith('/today');
        expect(mockObserveClientWebVitals).not.toHaveBeenCalled();

        mockUseAuth.mockReturnValue(authState(false, true));
        await view.rerender(<ClientWebVitalsRuntime />);
        expect(mockObserveClientWebVitals).toHaveBeenCalledTimes(1);
        expect(mockObserveClientWebVitals).toHaveBeenCalledWith('today');

        mockUsePathname.mockReturnValue('/my-foods');
        await view.rerender(<ClientWebVitalsRuntime />);
        expect(mockGetClientDiagnosticRoute).toHaveBeenCalledTimes(1);
        expect(mockObserveClientWebVitals).toHaveBeenCalledTimes(1);

        await view.unmount();
        expect(cleanup).toHaveBeenCalledWith(false);
    });

    it('discards a partial sample when the authenticated session is lost', async () => {
        const cleanup = jest.fn();
        mockObserveClientWebVitals.mockReturnValue(cleanup);
        mockUsePathname.mockReturnValue('/today');
        mockUseAuth.mockReturnValue(authState(false, true));
        const view = await render(<ClientWebVitalsRuntime />);

        expect(mockObserveClientWebVitals).toHaveBeenCalledWith('today');
        mockUseAuth.mockReturnValue(authState(false, false));
        await view.rerender(<ClientWebVitalsRuntime />);

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith(false);
        await view.unmount();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('never observes a login document after an SPA transition to Today', async () => {
        mockUsePathname.mockReturnValue('/login');
        mockUseAuth.mockReturnValue(authState(true, false));
        const view = await render(<ClientWebVitalsRuntime />);

        expect(mockGetClientDiagnosticRoute).toHaveBeenCalledWith('/login');
        expect(mockObserveClientWebVitals).not.toHaveBeenCalled();

        mockUseAuth.mockReturnValue(authState(false, false));
        await view.rerender(<ClientWebVitalsRuntime />);
        mockUsePathname.mockReturnValue('/today');
        mockUseAuth.mockReturnValue(authState(false, true));
        await view.rerender(<ClientWebVitalsRuntime />);

        expect(mockGetClientDiagnosticRoute).toHaveBeenCalledTimes(1);
        expect(mockObserveClientWebVitals).not.toHaveBeenCalled();
    });
});
