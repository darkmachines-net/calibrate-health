/** @file Regression coverage for query Online Manager native: native Query connectivity. */

jest.mock('@react-native-community/netinfo', () => ({
    __esModule: true,
    default: { addEventListener: jest.fn(() => jest.fn()) }
}));
import { onlineManager } from '@tanstack/react-query';
import {
    configureQueryOnlineManager,
    isNativeNetworkOnline
} from './queryOnlineManager.native';

describe('native Query connectivity', () => {
    afterEach(() => {
        onlineManager.setEventListener(() => () => undefined);
        onlineManager.setOnline(true);
    });

    it('maps native connection and reachability transitions into React Query state', () => {
        let listener: ((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void)
            | undefined;
        const unsubscribe = jest.fn();
        const cleanup = configureQueryOnlineManager({
            addEventListener: (nextListener) => {
                listener = nextListener;
                return unsubscribe;
            }
        });

        expect(isNativeNetworkOnline({ isConnected: true, isInternetReachable: null })).toBe(true);
        listener?.({ isConnected: false, isInternetReachable: false });
        expect(onlineManager.isOnline()).toBe(false);
        listener?.({ isConnected: true, isInternetReachable: true });
        expect(onlineManager.isOnline()).toBe(true);
        listener?.({ isConnected: true, isInternetReachable: false });
        expect(onlineManager.isOnline()).toBe(false);

        cleanup();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});