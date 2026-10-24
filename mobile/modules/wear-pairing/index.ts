/** @file Typed Expo native-module boundary for Wear discovery, pairing messages, and phone/watch coordination. */

import { requireOptionalNativeModule } from 'expo-modules-core';

export type WearNode = {
    id: string;
    displayName: string;
    isNearby: boolean;
};

export type WearPairingMessage = {
    id: string;
    nodeId: string;
    path: string;
    payload: string;
    receivedAt: number;
};

type CalibrateWearPairingModule = {
    getPairingNodes(): Promise<WearNode[]>;
    sendMessage(nodeId: string, path: string, payload: string): Promise<number>;
    prepareNetworkRelay(nodeId: string, serverOrigin: string, requestId: string, expiresAtEpochMs: number): void;
    commitNetworkRelay(nodeId: string, serverOrigin: string, requestId: string): void;
    restoreNetworkRelay(nodeId: string, serverOrigin: string): void;
    clearPendingNetworkRelay(nodeId: string, serverOrigin: string, requestId: string): void;
    clearNetworkRelay(nodeId: string, serverOrigin: string): void;
    listMessages(): WearPairingMessage[];
    acknowledgeMessages(messageIds: string[]): void;
};

export default requireOptionalNativeModule<CalibrateWearPairingModule>('CalibrateWearPairing');
