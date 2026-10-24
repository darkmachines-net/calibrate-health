/** @file query Online Manager: Treats unknown native connectivity as usable until a connection or reachability failure is confirmed. */

import React from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

type NativeNetworkState = Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>;

type NativeConnectivitySource = {
    addEventListener(listener: (state: NativeNetworkState) => void): () => void;
};

/** Treats unknown native connectivity as usable until a connection or reachability failure is confirmed. */
export function isNativeNetworkOnline(state: NativeNetworkState): boolean {
    return state.isConnected !== false && state.isInternetReachable !== false;
}

/** Drive React Query from native connection and reachability transitions. */
export function configureQueryOnlineManager(
    source: NativeConnectivitySource = NetInfo
): () => void {
    let unsubscribe: () => void = () => undefined;
    let subscribed = false;
    const stop = () => {
        if (!subscribed) return;
        subscribed = false;
        unsubscribe();
    };

    onlineManager.setEventListener((setOnline) => {
        unsubscribe = source.addEventListener((state) => setOnline(isNativeNetworkOnline(state)));
        subscribed = true;
        return stop;
    });

    return () => {
        stop();
        onlineManager.setEventListener(() => () => undefined);
    };
}

/** Installs the native connectivity listener for React Query and cleans it up on unmount. */
export function useQueryOnlineManager(): void {
    React.useEffect(() => configureQueryOnlineManager(), []);
}